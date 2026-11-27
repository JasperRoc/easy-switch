use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
#[cfg(feature = "desktop")]
use std::path::Path;
use std::{collections::HashMap, path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{mpsc, oneshot},
    time::timeout,
};

#[derive(Clone)]
pub struct Worker {
    tx: mpsc::Sender<Call>,
}

struct Call {
    action: String,
    payload: Value,
    context: Value,
    reply: oneshot::Sender<Result<Value>>,
}

type Changed = Option<Box<dyn Fn() + Send + Sync>>;

struct Session {
    child: Child,
    input: ChildStdin,
    output: tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    id: u64,
}

#[derive(Clone)]
pub struct WorkerPaths {
    pub runtime: PathBuf,
    pub script: PathBuf,
    pub root: PathBuf,
    pub port: u16,
    pub resources: PathBuf,
}

impl WorkerPaths {
    #[cfg(feature = "desktop")]
    pub fn new(resources: &Path, root: PathBuf, port: u16) -> Self {
        let runtime = std::env::var_os("FLUID_TEST_NODE")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                resources.join(if cfg!(windows) {
                    "worker/node.exe"
                } else {
                    "worker/node"
                })
            });
        Self {
            runtime,
            script: resources.join("worker/desktop/worker.js"),
            root,
            port,
            resources: resources.to_owned(),
        }
    }

    fn spawn(&self) -> Result<Session> {
        let mut command = Command::new(&self.runtime);
        command
            .arg(&self.script)
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .env_remove("ELECTRON_RUN_AS_NODE")
            .env("SWITCH_HOME", &self.root)
            .env("SWITCH_PORT", self.port.to_string())
            .env("FLUID_RESOURCES", &self.resources)
            .env("FLUID_VERSION", env!("CARGO_PKG_VERSION"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command
            .spawn()
            .context("Unable to start the feature worker. Reinstall fluid.")?;
        let input = child.stdin.take().context("Missing worker input")?;
        let output = BufReader::new(child.stdout.take().context("Missing worker output")?).lines();
        Ok(Session {
            child,
            input,
            output,
            id: 0,
        })
    }

    pub async fn once(&self, action: &str, payload: Value) -> Result<Value> {
        let mut session = self.spawn()?;
        let result = session.call(action, payload, Value::Null).await;
        session.close().await;
        result
    }
}

impl Session {
    async fn write(&mut self, action: &str, payload: Value, context: Value) -> Result<u64> {
        self.id += 1;
        let mut bytes = serde_json::to_vec(
            &json!({"id": self.id, "action": action, "payload": payload, "context": context}),
        )?;
        bytes.push(b'\n');
        timeout(Duration::from_secs(20), self.input.write_all(&bytes)).await??;
        Ok(self.id)
    }

    async fn call(&mut self, action: &str, payload: Value, context: Value) -> Result<Value> {
        let id = self.write(action, payload, context).await?;
        timeout(Duration::from_secs(900), async {
            loop {
                let line = self
                    .output
                    .next_line()
                    .await?
                    .context("The feature worker closed before replying.")?;
                let response: Value = serde_json::from_str(&line)?;
                if response["id"].as_u64() == Some(id) {
                    return decode(response);
                }
                if response.get("id").is_some() {
                    return Err(anyhow!("Invalid feature worker reply."));
                }
            }
        })
        .await?
    }

    async fn close(mut self) {
        drop(self.input);
        if timeout(Duration::from_secs(3), self.child.wait())
            .await
            .is_err()
        {
            let _ = self.child.kill().await;
        }
    }
}

fn decode(mut response: Value) -> Result<Value> {
    if let Some(error) = response["error"].as_str() {
        return Err(anyhow!("{error}"));
    }
    Ok(response["value"].take())
}

async fn run_session(
    mut session: Session,
    first: Call,
    rx: &mut mpsc::Receiver<Call>,
    changed: &Changed,
) -> bool {
    let mut first = Some(first);
    let mut inflight = HashMap::<u64, oneshot::Sender<Result<Value>>>::new();
    let mut visible = false;
    let mut retained = false;
    let mut service = false;
    let idle = tokio::time::sleep(Duration::from_secs(5));
    tokio::pin!(idle);
    let watchdog = tokio::time::sleep(Duration::from_secs(900));
    tokio::pin!(watchdog);
    loop {
        let call = if first.is_some() {
            first.take()
        } else {
            tokio::select! {
                call = rx.recv(), if inflight.len() < 64 => call,
                line = session.output.next_line() => {
                    let Ok(Some(line)) = line else { break; };
                    let Ok(value) = serde_json::from_str::<Value>(&line) else { break; };
                    if let Some(reply) = value["id"].as_u64().and_then(|id| inflight.remove(&id)) {
                        let _ = reply.send(decode(value));
                        if inflight.is_empty() { idle.as_mut().reset(tokio::time::Instant::now() + Duration::from_secs(5)); }
                    } else if value.get("retained").is_some() {
                        retained = value["retained"] == true;
                        if !retained { idle.as_mut().reset(tokio::time::Instant::now() + Duration::from_secs(5)); }
                    } else if value["changed"] == true {
                        if let Some(changed) = changed { changed(); }
                    }
                    continue;
                }
                _ = &mut idle, if !visible && !retained && !service && inflight.is_empty() => {
                    session.close().await;
                    return false;
                }
                _ = &mut watchdog, if !inflight.is_empty() => break,
            }
        };
        let Some(call) = call else {
            session.close().await;
            return true;
        };
        if call.action == "suspend-worker" {
            session.close().await;
            let _ = call.reply.send(Ok(Value::Null));
            return false;
        }
        if call.action == "foreground" {
            visible = call.payload == true;
        }
        if call.action == "service-start" {
            service = true;
        }
        if inflight.is_empty() {
            watchdog
                .as_mut()
                .reset(tokio::time::Instant::now() + Duration::from_secs(900));
        }
        match session
            .write(&call.action, call.payload, call.context)
            .await
        {
            Ok(id) => {
                inflight.insert(id, call.reply);
            }
            Err(error) => {
                let _ = call.reply.send(Err(error));
                break;
            }
        }
    }
    for (_, reply) in inflight {
        let _ = reply.send(Err(anyhow!("The feature worker stopped before replying.")));
    }
    session.close().await;
    false
}

impl Worker {
    pub fn start(paths: WorkerPaths, changed: Changed) -> Self {
        let (tx, mut rx) = mpsc::channel::<Call>(32);
        tokio::spawn(async move {
            while let Some(call) = rx.recv().await {
                if call.action == "suspend-worker" {
                    let _ = call.reply.send(Ok(Value::Null));
                    continue;
                }
                let created = async {
                    let mut session = paths.spawn()?;
                    session.call("attach", Value::Null, Value::Null).await?;
                    Ok::<_, anyhow::Error>(session)
                }
                .await;
                let session = match created {
                    Ok(session) => session,
                    Err(error) => {
                        let _ = call.reply.send(Err(error));
                        continue;
                    }
                };
                if run_session(session, call, &mut rx, &changed).await {
                    break;
                }
            }
        });
        Self { tx }
    }

    pub async fn call(&self, action: &str, payload: Value, context: Value) -> Result<Value> {
        let (reply, response) = oneshot::channel();
        self.tx
            .send(Call {
                action: action.into(),
                payload,
                context,
                reply,
            })
            .await
            .context("Feature worker stopped.")?;
        response.await.context("Feature worker stopped.")?
    }
}
