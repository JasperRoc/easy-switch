use crate::{
    gateway::{Gateway, Mode},
    store,
    worker::{Worker, WorkerPaths},
};
use anyhow::{Context, Result};
use directories::BaseDirs;
use serde_json::Value;
use std::{
    net::TcpListener,
    path::PathBuf,
    sync::{atomic::Ordering, Arc},
    time::Duration,
};
use tokio::signal::unix::{signal, SignalKind};

pub fn run(renderer_preview: bool) -> Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;
    runtime.block_on(async {
        let root = std::env::var_os("SWITCH_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                BaseDirs::new()
                    .expect("missing home directory")
                    .home_dir()
                    .join(".fluid")
            });
        let port = std::env::var("SWITCH_PORT")
            .unwrap_or_else(|_| "18345".into())
            .parse::<u16>()?;
        let runtime = std::env::var_os("FLUID_NODE")
            .context("Missing service Node.js path.")?
            .into();
        let script = std::env::var_os("FLUID_WORKER")
            .context("Missing service worker path.")?
            .into();
        let listener = TcpListener::bind(("127.0.0.1", port))
            .context("The fluid routing port is already in use.")?;
        listener.set_nonblocking(true)?;
        let paths = WorkerPaths {
            runtime,
            script,
            root: root.clone(),
            port: listener.local_addr()?.port(),
            resources: PathBuf::new(),
        };
        let mut term = signal(SignalKind::terminate())?;
        let mut interrupt = signal(SignalKind::interrupt())?;
        if !renderer_preview {
            paths.once("service-init", Value::Null).await?;
        }
        let sync = store::read::<Value>(&root.join("sync.json")).unwrap_or_default();
        let worker = Worker::start(paths.clone(), None);
        let mode = if renderer_preview {
            Mode::Desktop
        } else {
            Mode::Service
        };
        let gateway = Arc::new(Gateway::new(
            root,
            worker.clone(),
            paths.clone(),
            mode,
            None,
        )?);
        if !renderer_preview && sync["enabled"] == true {
            worker
                .call("service-start", Value::Null, Value::Null)
                .await?;
        }
        gateway.enabled.store(true, Ordering::Release);
        let mut server = tokio::spawn(gateway.clone().listen(listener));
        let result = tokio::select! {
            result = &mut server => result?,
            _ = term.recv() => Ok(()),
            _ = interrupt.recv() => Ok(()),
        };
        gateway.enabled.store(false, Ordering::Release);
        gateway.cancel_routes(false);
        gateway.cancel_routes(true);
        gateway.stop.cancel();
        let _ = tokio::time::timeout(
            Duration::from_secs(5),
            worker.call("suspend-worker", Value::Null, Value::Null),
        )
        .await;
        if !renderer_preview {
            paths.once("service-stop", Value::Null).await?;
        }
        result
    })
}
