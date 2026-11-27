use super::{confirm, desktop, disarm_guard, root_dir, stop_routes, store, WorkerPaths};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    env, fs, io,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::Ordering,
    time::{Duration, Instant},
};
use tauri::AppHandle;

fn detached(file: &Path) -> Command {
    let mut command = Command::new(file);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000200);
    }
    command
}

fn wait_for_exit(pid: u32, seconds: u64) -> Result<()> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0},
            System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
        };
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        if handle.is_null() {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
                return Ok(());
            }
            return Err(error.into());
        }
        let status = unsafe { WaitForSingleObject(handle, seconds as u32 * 1000) };
        unsafe {
            CloseHandle(handle);
        }
        if status != WAIT_OBJECT_0 {
            bail!("The previous fluid process did not exit.");
        }
    }
    #[cfg(target_os = "macos")]
    {
        let end = Instant::now() + Duration::from_secs(seconds);
        loop {
            if unsafe { libc::kill(pid as i32, 0) } == -1
                && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
            {
                break;
            }
            if Instant::now() >= end {
                bail!("The previous fluid process did not exit.");
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    Ok(())
}

pub fn entry() -> Option<i32> {
    let action = env::args().nth(1)?;
    if !matches!(
        action.as_str(),
        "--apply-update" | "--cleanup" | "--uninstall-data"
    ) {
        return None;
    }
    let run = || -> Result<()> {
        if action == "--uninstall-data" {
            let executable = env::current_exe()?;
            let directory = executable.parent().context("Invalid install directory")?;
            let root = root_dir();
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            if root.exists() {
                let _lock = super::Instance::acquire(&root)
                    .context("Quit fluid before uninstalling.")?;
                let paths = WorkerPaths::new(directory, root, 18345);
                runtime.block_on(paths.once("uninstall-data", Value::Null))?;
            }
            set_autostart(false)?;
            return Ok(());
        }
        let file = PathBuf::from(env::args_os().nth(2).context("Missing maintenance job.")?);
        let job: Value = store::read(&file)?;
        let pid = job["parent"]
            .as_u64()
            .context("Missing previous process.")? as u32;
        wait_for_exit(pid, 60)?;
        if action == "--apply-update" {
            apply(&job)?;
        } else {
            cleanup(&job)?;
        }
        let _ = fs::remove_file(file);
        if action == "--cleanup" {
            if let Ok(helper) = env::current_exe() {
                #[cfg(target_os = "macos")]
                if let Some(directory) = helper.parent() {
                    let _ = fs::remove_dir_all(directory);
                }
                #[cfg(windows)]
                let _ = schedule_cleanup(&helper);
            }
        }
        Ok(())
    };
    if let Err(error) = run() {
        if action == "--apply-update" {
            if let Some(directory) = env::args_os()
                .nth(2)
                .and_then(|path| PathBuf::from(path).parent().map(Path::to_owned))
            {
                let _ = fs::write(directory.join("last-error.txt"), error.to_string());
            }
        }
        eprintln!("{error}");
        return Some(1);
    }
    Some(0)
}

pub fn reveal(path: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    detached(Path::new("/usr/bin/open"))
        .args(["-R", path])
        .spawn()?;
    #[cfg(windows)]
    detached(Path::new("explorer.exe"))
        .arg(format!("/select,{path}"))
        .spawn()?;
    Ok(())
}

#[cfg(windows)]
pub fn autostart_enabled() -> bool {
    let Ok(result) = detached(Path::new("reg.exe"))
        .args([
            "query",
            "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
            "/v",
            "fluid",
        ])
        .output()
    else {
        return false;
    };
    result.status.success()
}
#[cfg(target_os = "macos")]
fn login_item() -> PathBuf {
    directories::BaseDirs::new()
        .unwrap()
        .home_dir()
        .join("Library/LaunchAgents/io.github.jasperroc.fluid.plist")
}
#[cfg(target_os = "macos")]
pub fn autostart_enabled() -> bool {
    login_item().is_file()
}

pub fn migrate_autostart(root: &Path) -> Result<bool> {
    let preferences = store::read::<Value>(&root.join("desktop.json")).unwrap_or_default();
    if !autostart_enabled() && preferences["startAtLogin"] == true && cfg!(target_os = "macos") {
        set_autostart(true)?;
    }
    Ok(autostart_enabled())
}

pub fn set_autostart(enabled: bool) -> Result<()> {
    let key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    #[cfg(windows)]
    {
        let mut command = detached(Path::new("reg.exe"));
        if enabled {
            let exe = env::current_exe()?;
            let command_line = format!("\"{}\" --hidden", exe.display());
            command.args([
                "add",
                key,
                "/v",
                "fluid",
                "/t",
                "REG_SZ",
                "/d",
                &command_line,
                "/f",
            ]);
        } else {
            if !autostart_enabled() {
                return Ok(());
            }
            command.args(["delete", key, "/v", "fluid", "/f"]);
        }
        if !command.status()?.success() {
            bail!("Unable to change start at login.");
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = key;
        let file = login_item();
        if enabled {
            let exe = env::current_exe()?
                .to_string_lossy()
                .replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;");
            fs::create_dir_all(file.parent().unwrap())?;
            fs::write(
                &file,
                format!(
                    r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>io.github.jasperroc.fluid</string><key>ProgramArguments</key><array><string>{exe}</string><string>--hidden</string></array><key>RunAtLoad</key><true/></dict></plist>"#
                ),
            )?;
        } else if file.is_file() {
            fs::remove_file(file)?;
        }
    }
    Ok(())
}

fn field_path(job: &Value, field: &str) -> Result<PathBuf> {
    Ok(PathBuf::from(
        job[field].as_str().context("Invalid maintenance job.")?,
    ))
}

#[cfg(target_os = "macos")]
fn apply(job: &Value) -> Result<()> {
    let current = field_path(job, "current")?;
    let staged = field_path(job, "staged")?;
    let receipt = field_path(job, "receipt")?;
    let backup = current.with_extension(format!("backup-{}.app", uuid::Uuid::new_v4().simple()));
    let candidate = current.with_extension(format!("next-{}.app", uuid::Uuid::new_v4().simple()));
    let copied = detached(Path::new("/usr/bin/ditto"))
        .arg(&staged)
        .arg(&candidate)
        .status()?
        .success();
    if !copied {
        let _ = fs::remove_dir_all(&candidate);
        bail!("Unable to stage the macOS update.");
    }
    let verified = detached(Path::new("/usr/bin/codesign"))
        .args(["--verify", "--deep", "--strict"])
        .arg(&candidate)
        .status()?
        .success();
    if !verified {
        let _ = fs::remove_dir_all(&candidate);
        bail!("The staged macOS signature is invalid.");
    }
    fs::rename(&current, &backup)?;
    if let Err(error) = fs::rename(&candidate, &current) {
        fs::rename(&backup, &current)?;
        let _ = fs::remove_dir_all(&candidate);
        return Err(error.into());
    }
    let start = || detached(&current.join("Contents/MacOS/fluid")).spawn();
    let result =
        start().and_then(|mut child| wait_for_receipt(&mut child, &receipt, &job["token"]));
    if !matches!(result, Ok(true)) {
        fs::rename(&current, &candidate)?;
        fs::rename(&backup, &current)?;
        let _ = fs::remove_dir_all(&candidate);
        let error = "The update did not confirm startup. The previous version was restored.";
        if let Some(parent) = receipt.parent() {
            let _ = fs::write(parent.join("last-error.txt"), error);
        }
        let _ = fs::remove_file(&receipt);
        let _ = start();
        bail!(error);
    }
    fs::remove_dir_all(backup)?;
    if let Some(path) = job["archive"].as_str() {
        let _ = fs::remove_file(path);
    }
    if let Some(parent) = staged.parent() {
        let _ = fs::remove_dir_all(parent);
    }
    fs::remove_file(receipt)?;
    Ok(())
}
#[cfg(windows)]
fn apply(job: &Value) -> Result<()> {
    let current = field_path(job, "current")?;
    let installer = field_path(job, "staged")?;
    let receipt = field_path(job, "receipt")?;
    let directory = current
        .parent()
        .context("Missing installation directory.")?;
    let installation = fs::canonicalize(directory)?;
    let updates = fs::canonicalize(receipt.parent().context("Missing update directory.")?)?;
    if updates.starts_with(&installation) {
        bail!("The update files must be outside the installation directory.");
    }
    use std::os::windows::process::CommandExt;
    let installed = detached(&installer)
        .args(["/S", "/UPDATE"])
        .raw_arg(format!("/D={}", directory.display()))
        .status();
    if !installed.is_ok_and(|status| status.success()) {
        let error = "The Windows installer did not complete. Run the verified installer manually.";
        let _ = fs::write(updates.join("last-error.txt"), error);
        let _ = detached(&current).current_dir(directory).spawn();
        bail!(error);
    }
    let mut child = detached(&current)
        .current_dir(directory)
        .spawn()
        .context("Unable to launch the updated application.")?;
    if !wait_for_receipt(&mut child, &receipt, &job["token"])? {
        bail!("The updated Windows application did not confirm startup. Run the verified installer manually.");
    }
    fs::remove_file(receipt)?;
    let _ = fs::remove_file(installer);
    Ok(())
}

fn wait_for_receipt(
    child: &mut std::process::Child,
    receipt: &Path,
    token: &Value,
) -> io::Result<bool> {
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline {
        if store::read::<Value>(receipt)
            .is_ok_and(|value| value["ready"] == true && value["token"] == *token)
        {
            return Ok(true);
        }
        if child.try_wait()?.is_some() {
            return Ok(false);
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    let _ = child.kill();
    let _ = child.wait();
    Ok(false)
}

fn cleanup(job: &Value) -> Result<()> {
    let application = field_path(job, "application")?;
    #[cfg(target_os = "macos")]
    {
        if !application.ends_with("fluid.app") {
            bail!("Unexpected application path.");
        }
        fs::remove_dir_all(application)?;
    }
    #[cfg(windows)]
    {
        let uninstaller = application.join("uninstall.exe");
        if !detached(&uninstaller)
            .args(["/S", "/DELETEAPPDATA"])
            .status()?
            .success()
        {
            bail!("Windows uninstallation did not complete.");
        }
    }
    Ok(())
}

#[cfg(windows)]
fn schedule_cleanup(helper: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_DELAY_UNTIL_REBOOT};
    for path in [Some(helper), helper.parent()].into_iter().flatten() {
        let value: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            MoveFileExW(
                value.as_ptr(),
                std::ptr::null(),
                MOVEFILE_DELAY_UNTIL_REBOOT,
            );
        }
    }
    Ok(())
}

pub async fn install_update(app: AppHandle) -> Result<Value> {
    let state = desktop(&app);
    if state.gateway.active.load(Ordering::Relaxed) > 0
        && !confirm(
            "Install update?",
            "Installing interrupts requests in progress.",
        )
        .await
    {
        return Ok(Value::Null);
    }
    let staged = state
        .worker
        .call("take-update", Value::Null, state.gateway.context())
        .await?;
    let current = env::current_exe()?;
    let directory = state.root.join("updates");
    let receipt = directory.join("pending.json");
    let token = uuid::Uuid::new_v4().to_string();
    let version = staged["version"]
        .as_str()
        .context("Missing verified update.")?;
    let application = if cfg!(windows) {
        current.as_path()
    } else {
        let application = current
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
            .context("Run fluid from Applications before updating.")?;
        if !application.ends_with("fluid.app")
            || application.to_string_lossy().contains("/AppTranslocation/")
            || fs::symlink_metadata(application)?.file_type().is_symlink()
        {
            bail!("Move fluid to Applications before updating.");
        }
        application
    };
    let helper = directory.join(if cfg!(windows) {
        "apply-update.exe"
    } else {
        "apply-update"
    });
    fs::copy(&current, &helper)?;
    let descriptor = directory.join("install-native.json");
    store::atomic(
        &descriptor,
        &json!({"parent":std::process::id(),"current":application,"staged":staged["staged"],
        "archive":staged["archive"],"receipt":receipt,"token":token}),
    )?;
    if state.exiting.swap(true, Ordering::AcqRel) {
        bail!("fluid is closing.");
    }
    if let Err(error) = stop_routes(&state).await {
        state.exiting.store(false, Ordering::Release);
        return Err(error);
    }
    let handoff = (|| {
        store::atomic(
            &receipt,
            &json!({"version":version,"token":token,"ready":false,"executable":current}),
        )?;
        detached(&helper)
            .arg("--apply-update")
            .arg(descriptor)
            .spawn()?;
        Ok::<_, anyhow::Error>(())
    })();
    if let Err(error) = handoff {
        let _ = fs::remove_file(receipt);
        if state
            .worker
            .call("start", Value::Null, Value::Null)
            .await
            .is_ok()
        {
            state.gateway.enabled.store(true, Ordering::Release);
        }
        state.exiting.store(false, Ordering::Release);
        let _ = state
            .worker
            .call("update-failed", json!(error.to_string()), Value::Null)
            .await;
        return Err(error);
    }
    let _ = state
        .worker
        .call("suspend-worker", Value::Null, Value::Null)
        .await;
    state.gateway.stop.cancel();
    disarm_guard(&state).await;
    app.exit(0);
    Ok(Value::Null)
}

pub async fn uninstall(app: AppHandle) -> Result<Value> {
    if !confirm("Uninstall fluid?", "The application will restore your client settings and remove its saved providers and cache.").await { return Ok(Value::Null); }
    let state = desktop(&app);
    if state.exiting.swap(true, Ordering::AcqRel) {
        bail!("fluid is closing.");
    }
    if let Err(error) = stop_routes(&state).await {
        state.exiting.store(false, Ordering::Release);
        return Err(error);
    }
    let current = env::current_exe()?;
    if cfg!(windows) {
        let directory = current.parent().context("Invalid installation folder.")?;
        let temporary = env::temp_dir().join(format!(
            "fluid-uninstall-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir(&temporary)?;
        let helper = temporary.join("cleanup.exe");
        fs::copy(&current, &helper)?;
        let job = temporary.join("job.json");
        store::atomic(
            &job,
            &json!({"parent":std::process::id(),"application":directory}),
        )?;
        detached(&helper).arg("--cleanup").arg(job).spawn()?;
    } else {
        let application = current
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
            .context("Invalid application bundle.")?;
        if !application.ends_with("fluid.app") {
            bail!("Run the installed application before uninstalling.");
        }
        set_autostart(false)?;
        let directory = env::temp_dir().join(format!(
            "fluid-uninstall-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir(&directory)?;
        let worker = directory.join("cleanup");
        fs::copy(&current, &worker)?;
        let job = directory.join("job.json");
        store::atomic(
            &job,
            &json!({"parent":std::process::id(),"application":application}),
        )?;
        state
            .worker
            .call("uninstall-data", Value::Null, Value::Null)
            .await?;
        detached(&worker).arg("--cleanup").arg(job).spawn()?;
    }
    let _ = state
        .worker
        .call("suspend-worker", Value::Null, Value::Null)
        .await;
    state.gateway.stop.cancel();
    disarm_guard(&state).await;
    app.exit(0);
    Ok(Value::Null)
}
