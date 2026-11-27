#[path = "maintenance.rs"]
mod maintenance;

use crate::{
    gateway::{Gateway, Mode},
    store,
    worker::{Worker, WorkerPaths},
};
use anyhow::{bail, Context, Result};
use directories::BaseDirs;
use maintenance::{install_update, reveal, set_autostart, uninstall};
use notify::{Event, RecursiveMode, Watcher};
use serde_json::{json, Value};
use std::{
    env, fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard,
    },
    time::Duration,
};
use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

const SETTINGS: &str = "settings";
const TRAY: &str = "fluid";
const VERSION: &str = env!("CARGO_PKG_VERSION");

struct Desktop {
    root: PathBuf,
    paths: WorkerPaths,
    worker: Worker,
    gateway: Arc<Gateway>,
    startup: Mutex<String>,
    menu: Mutex<Vec<String>>,
    release: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
    sync_changed: tokio::sync::Notify,
    guard: Mutex<Option<std::process::Child>>,
    retained: AtomicBool,
    visible: AtomicBool,
    exiting: AtomicBool,
    ui_opening: AtomicBool,
    route_transition: tokio::sync::Mutex<()>,
    autostart: AtomicBool,
    pending_auth: Mutex<Option<(String, String)>>,
    _instance: Instance,
}

struct Instance(std::fs::File);
impl Instance {
    fn acquire(root: &Path) -> Result<Self> {
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join("desktop.lock"))?;
        file.try_lock()
            .context("Another fluid process is still running.")?;
        Ok(Self(file))
    }
}
impl Drop for Instance {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
fn desktop(app: &AppHandle) -> tauri::State<'_, Desktop> {
    app.state()
}
fn prefs(root: &Path) -> Value {
    store::read(&root.join("desktop.json")).unwrap_or_else(|_| json!({}))
}
fn client_root(root: &Path, claude: bool) -> PathBuf {
    if claude {
        root.join("claude")
    } else {
        root.to_path_buf()
    }
}
fn chinese(root: &Path) -> bool {
    prefs(root)["language"]
        .as_str()
        .is_some_and(|code| code.starts_with("zh"))
}

fn preferences_window(app: &AppHandle, tab: Option<&str>) {
    let Some(state) = app.try_state::<Desktop>() else {
        return;
    };
    if state.exiting.load(Ordering::Acquire) {
        return;
    }
    if let Some(window) = app.get_webview_window(SETTINGS) {
        if let Some(timer) = lock(&state.release).take() {
            timer.abort();
        }
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        #[cfg(target_os = "macos")]
        let _ = app.set_dock_visibility(true);
        bridge(&window, "show", None);
        if let Some(tab) = tab {
            bridge(&window, "tab", Some(tab));
        }
        set_foreground(app, true);
        return;
    }
    if state.ui_opening.swap(true, Ordering::AcqRel) {
        return;
    }
    let initial_tab = serde_json::to_string(&tab).unwrap_or_else(|_| "null".into());
    let mut builder =
        WebviewWindowBuilder::new(app, SETTINGS, WebviewUrl::App("desktop/index.html".into()))
            .title("fluid")
            .inner_size(960., 780.)
            .min_inner_size(780., 680.)
            .center()
            .visible(false)
            .devtools(false)
            .incognito(true)
            .disable_drag_drop_handler()
            .initialization_script(format!("window.fluidInitialTab={initial_tab};"))
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .on_navigation(|url| trusted_url(url))
            .on_page_load(|window, event| {
                if event.event() == tauri::webview::PageLoadEvent::Finished {
                    let _ = window.show();
                    let _ = window.set_focus();
                    set_foreground(window.app_handle(), true);
                    if let Some(view) = window.app_handle().get_webview_window(SETTINGS) {
                        bridge(&view, "change", None);
                    }
                }
            });
    if let Ok(icon) = Image::from_bytes(include_bytes!("../../../desktop/assets/icon.png")) {
        builder = match builder.icon(icon) {
            Ok(builder) => builder,
            Err(_) => {
                state.ui_opening.store(false, Ordering::Release);
                return;
            }
        };
    }
    if let Some(theme) = native_theme(&state.root) {
        builder = builder.theme(Some(theme));
    }
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .transparent(true)
            .effects(tauri::utils::config::WindowEffectsConfig {
                effects: vec![tauri::window::Effect::UnderWindowBackground],
                state: Some(tauri::window::EffectState::Active),
                ..Default::default()
            });
        let _ = app.set_dock_visibility(true);
    }
    match builder.build() {
        Ok(window) => {
            let app = app.clone();
            let view = window.clone();
            window.on_window_event(move |event| match event {
                WindowEvent::CloseRequested { api, .. }
                    if !desktop(&app).exiting.load(Ordering::Acquire) =>
                {
                    api.prevent_close();
                    let _ = view.hide();
                    #[cfg(target_os = "macos")]
                    let _ = app.set_dock_visibility(false);
                    set_foreground(&app, false);
                    release_when_idle(&app);
                }
                WindowEvent::Focused(true) => set_foreground(&app, true),
                WindowEvent::Focused(false) => {
                    // Some window managers finish minimizing after the focus event.
                    let app = app.clone();
                    let view = view.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(200)).await;
                        if view.is_minimized().unwrap_or(false) {
                            set_foreground(&app, false);
                        }
                    });
                }
                WindowEvent::Destroyed => {
                    desktop(&app).retained.store(false, Ordering::Release);
                    set_foreground(&app, false);
                }
                _ => {}
            });
        }
        Err(_) => notify_error("Unable to open the settings window."),
    }
    state.ui_opening.store(false, Ordering::Release);
}
#[cfg(target_os = "macos")]
fn application_menu(app: &AppHandle) -> Result<()> {
    let language = chinese(&desktop(app).root);
    let quit = MenuItem::with_id(
        app,
        "quit",
        if language {
            "退出 fluid"
        } else {
            "Quit fluid"
        },
        true,
        Some("Cmd+Q"),
    )?;
    let application = Submenu::with_items(
        app,
        "fluid",
        true,
        &[&PredefinedMenuItem::hide(app, None)?, &quit],
    )?;
    let edit = Submenu::with_items(
        app,
        if language { "编辑" } else { "Edit" },
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    app.set_menu(Menu::with_items(app, &[&application, &edit])?)?;
    Ok(())
}
fn native_theme(root: &Path) -> Option<tauri::Theme> {
    match prefs(root)["theme"].as_str() {
        Some("dark") => Some(tauri::Theme::Dark),
        Some("light") => Some(tauri::Theme::Light),
        _ => None,
    }
}
fn trusted_url(url: &tauri::Url) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost")
        || matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"))
        && url.path() == "/desktop/index.html"
}
fn bridge(window: &WebviewWindow, event: &str, payload: Option<&str>) {
    let event = serde_json::to_string(event).unwrap();
    let payload = serde_json::to_string(&payload).unwrap();
    let _ = window.eval(format!("window.fluidEvent?.({event},{payload})"));
}
fn set_foreground(app: &AppHandle, visible: bool) {
    let state = desktop(app);
    if state.visible.swap(visible, Ordering::AcqRel) == visible {
        return;
    }
    let worker = state.worker.clone();
    let context = state.gateway.context();
    tauri::async_runtime::spawn(async move {
        let _ = worker.call("foreground", json!(visible), context).await;
    });
}
fn release_when_idle(app: &AppHandle) {
    let state = desktop(app);
    let mut timer = lock(&state.release);
    if let Some(previous) = timer.take() {
        previous.abort();
    }
    if state.visible.load(Ordering::Acquire) || state.retained.load(Ordering::Acquire) {
        return;
    }
    let app = app.clone();
    *timer = Some(tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(12)).await;
        let dispatcher = app.clone();
        let _ = dispatcher.run_on_main_thread(move || {
            let state = desktop(&app);
            if !state.visible.load(Ordering::Acquire) && !state.retained.load(Ordering::Acquire) {
                if let Some(window) = app.get_webview_window(SETTINGS) {
                    let _ = window.destroy();
                }
            }
        });
    }));
}

#[cfg(target_os = "macos")]
fn tray_hidden(app: &AppHandle) -> bool {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSScreen;
    use objc2_foundation::NSIntersectsRect;

    app.tray_by_id(TRAY)
        .and_then(|tray| {
            tray.with_inner_tray_icon(|tray| {
                let mtm = MainThreadMarker::new().expect("tray callback runs on the main thread");
                let Some(item) = tray.ns_status_item() else {
                    return true;
                };
                let Some(window) = item.button(mtm).and_then(|button| button.window()) else {
                    return true;
                };
                !item.isVisible()
                    || !NSScreen::screens(mtm)
                        .iter()
                        .any(|screen| NSIntersectsRect(window.frame(), screen.frame()))
            })
            .ok()
        })
        .unwrap_or(true)
}

fn refresh_menu(app: &AppHandle) -> Result<()> {
    let state = desktop(app);
    let zh = chinese(&state.root);
    let claude = prefs(&state.root)["client"] == "claude";
    let codex_state = store::State::load(&state.root).ok();
    let claude_state = store::State::load(&state.root.join("claude")).ok();
    let codex = codex_state
        .as_ref()
        .and_then(|state| state.active.as_deref())
        .unwrap_or("—");
    let claude_name = claude_state
        .as_ref()
        .and_then(|state| state.active.as_deref())
        .unwrap_or("—");
    let menu = Menu::new(app)?;
    menu.append(&CheckMenuItem::with_id(
        app,
        "codex",
        format!("Codex · {codex}"),
        true,
        !claude,
        None::<&str>,
    )?)?;
    menu.append(&CheckMenuItem::with_id(
        app,
        "claude",
        format!("Claude · {claude_name}"),
        true,
        claude,
        None::<&str>,
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    let mut aliases = Vec::new();
    if let Some(selection) = if claude {
        claude_state.as_ref()
    } else {
        codex_state.as_ref()
    } {
        for alias in selection.ordered() {
            let id = format!("provider:{}", aliases.len());
            menu.append(&CheckMenuItem::with_id(
                app,
                id,
                alias,
                true,
                selection.active.as_deref() == Some(alias),
                None::<&str>,
            )?)?;
            aliases.push(alias.to_owned());
        }
    }
    *lock(&state.menu) = aliases;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    for (id, en, zh_text) in [
        ("show", "Open fluid", "打开 fluid"),
        ("settings", "Settings", "设置"),
        ("updates", "Check for updates", "检查更新"),
        ("quit", "Quit fluid", "退出 fluid"),
    ] {
        menu.append(&MenuItem::with_id(
            app,
            id,
            if zh { zh_text } else { en },
            true,
            None::<&str>,
        )?)?;
    }
    if let Some(tray) = app.tray_by_id(TRAY) {
        tray.set_tooltip(Some(format!(
            "fluid · {}",
            if claude { claude_name } else { codex }
        )))?;
        tray.set_menu(Some(menu))?;
    }
    Ok(())
}
fn watch_providers(app: &AppHandle) -> Result<notify::RecommendedWatcher> {
    let app = app.clone();
    let root = desktop(&app).root.clone();
    let app_for_callback = app.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
        let Ok(event) = event else {
            return;
        };
        if !(event.kind.is_create() || event.kind.is_modify() || event.kind.is_remove()) {
            return;
        }
        let names = event
            .paths
            .iter()
            .filter_map(|file| file.file_name()?.to_str());
        if names.clone().any(|name| name == "sync.json") {
            desktop(&app_for_callback).sync_changed.notify_one();
        }
        if !names
            .clone()
            .any(|name| matches!(name, "state.json" | "desktop.json"))
        {
            return;
        }
        let ui = app_for_callback.clone();
        let _ = app_for_callback.run_on_main_thread(move || {
            let _ = refresh_menu(&ui);
            if desktop(&ui).visible.load(Ordering::Acquire) {
                if let Some(window) = ui.get_webview_window(SETTINGS) {
                    bridge(&window, "change", None);
                }
            }
        });
    })?;
    watcher.watch(&root, RecursiveMode::NonRecursive)?;
    watcher.watch(&root.join("claude"), RecursiveMode::NonRecursive)?;
    Ok(watcher)
}

fn notify_error(message: &str) {
    rfd::MessageDialog::new()
        .set_title("fluid")
        .set_description(message)
        .set_level(rfd::MessageLevel::Error)
        .show();
}
async fn confirm(message: &'static str, detail: &'static str) -> bool {
    let dialog = rfd::AsyncMessageDialog::new()
        .set_title(message)
        .set_description(detail)
        .set_buttons(rfd::MessageButtons::OkCancel);
    dialog.show().await == rfd::MessageDialogResult::Ok
}

async fn stop_routes(state: &Desktop) -> Result<Value> {
    let _transition = state.route_transition.lock().await;
    let result = state
        .worker
        .call("stop", Value::Null, state.gateway.context())
        .await?;
    state.gateway.enabled.store(false, Ordering::Release);
    state.gateway.cancel_routes(false);
    state.gateway.cancel_routes(true);
    Ok(result)
}
async fn quit(app: AppHandle, ask: bool) {
    let state = desktop(&app);
    if state.exiting.swap(true, Ordering::AcqRel) {
        return;
    }
    if ask && state.gateway.active.load(Ordering::Relaxed) > 0 {
        let (title, detail) = if chinese(&state.root) {
            ("退出 fluid？", "退出会中断正在运行的请求。")
        } else {
            (
                "Quit fluid?",
                "Quitting interrupts requests in progress.",
            )
        };
        if !confirm(title, detail).await {
            state.exiting.store(false, Ordering::Release);
            return;
        }
    }
    let result = stop_routes(&state).await;
    if let Err(error) = result {
        state.exiting.store(false, Ordering::Release);
        notify_error(&error.to_string());
        return;
    }
    let _ = state
        .worker
        .call("suspend-worker", Value::Null, Value::Null)
        .await;
    state.gateway.stop.cancel();
    disarm_guard(&state).await;
    app.exit(0);
}
async fn disarm_guard(state: &Desktop) {
    let child = lock(&state.guard).take();
    if let Some(mut child) = child {
        if let Some(mut input) = child.stdin.take() {
            use std::io::Write;
            let _ = input.write_all(b"stop");
        }
        let _ = tauri::async_runtime::spawn_blocking(move || child.wait()).await;
    }
}
fn receipt(root: &Path) -> Result<()> {
    let file = root.join("updates/pending.json");
    let Ok(mut pending) = store::read::<Value>(&file) else {
        return Ok(());
    };
    if pending["version"] != VERSION {
        return Ok(());
    }
    if let Some(executable) = pending["executable"].as_str() {
        let current = env::current_exe()?.to_string_lossy().into_owned();
        if if cfg!(windows) {
            !executable.eq_ignore_ascii_case(&current)
        } else {
            executable != current
        } {
            return Ok(());
        }
    }
    pending["ready"] = json!(true);
    store::atomic(&file, &pending)?;
    if pending["nativeHelper"] == true {
        fs::write(
            root.join("updates/app-ready.txt"),
            pending["token"].as_str().unwrap_or_default(),
        )?;
    }
    Ok(())
}
fn resources(_app: &AppHandle) -> Result<PathBuf> {
    if let Some(value) = env::var_os("FLUID_TEST_RESOURCES") {
        return Ok(value.into());
    }
    #[cfg(windows)]
    // Tauri canonicalizes this path to the verbatim Win32 form. Node's entry
    // point resolver requires the ordinary DOS path for installed resources.
    let path = env::current_exe()?
        .parent()
        .context("Missing installation directory.")?
        .to_path_buf();
    #[cfg(not(windows))]
    let path = _app.path().resource_dir()?;
    if path.join("worker").is_dir() {
        return Ok(path);
    }
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.build");
    if cfg!(debug_assertions) && source.join("worker").is_dir() {
        return Ok(source);
    }
    Ok(path)
}

fn root_dir() -> PathBuf {
    env::var_os("SWITCH_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            BaseDirs::new()
                .expect("missing home directory")
                .home_dir()
                .join(".fluid")
        })
}

fn launch_guard(paths: &WorkerPaths) -> Result<std::process::Child> {
    use std::process::{Command, Stdio};
    let mut command = Command::new(env::current_exe()?);
    command
        .arg("--recover-on-exit")
        .arg(&paths.runtime)
        .arg(&paths.script)
        .arg(&paths.root)
        .arg(paths.port.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    Ok(command.spawn()?)
}
fn recovery_guard() -> Result<()> {
    use std::io::Read;
    let mut args = env::args_os().skip(2);
    let argument =
        |value: Option<std::ffi::OsString>| value.context("Invalid recovery process arguments.");
    let paths = WorkerPaths {
        runtime: argument(args.next())?.into(),
        script: argument(args.next())?.into(),
        root: argument(args.next())?.into(),
        port: argument(args.next())?.to_string_lossy().parse()?,
        resources: PathBuf::new(),
    };
    let mut confirmation = String::new();
    std::io::stdin().read_to_string(&mut confirmation)?;
    if confirmation != "stop" {
        let _instance = Instance::acquire(&paths.root)?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        runtime.block_on(paths.once("recover", Value::Null))?;
    }
    Ok(())
}

async fn start_desktop(app: AppHandle, listener: std::net::TcpListener) {
    let state = desktop(&app);
    let _transition = state.route_transition.lock().await;
    let gateway = state.gateway.clone();
    let service = gateway.clone();
    tauri::async_runtime::spawn(async move {
        let _ = service.listen(listener).await;
    });
    let result = async {
        let network = state
            .worker
            .call("network", Value::Null, Value::Null)
            .await?;
        gateway.set_network(&network)?;
        state
            .worker
            .call("activate", Value::Null, gateway.context())
            .await
    }
    .await;
    match result {
        Ok(snapshot) => {
            gateway.enabled.store(true, Ordering::Release);
            if let Err(error) = receipt(&state.root) {
                eprintln!("fluid update confirmation: {error:#}");
            }
            let hidden = env::args().any(|arg| arg == "--hidden");
            let first_run = snapshot["providers"].as_array().is_none_or(Vec::is_empty);
            if !hidden || first_run {
                let ui = app.clone();
                let _ = app.run_on_main_thread(move || preferences_window(&ui, None));
            }
        }
        Err(error) => {
            eprintln!("fluid startup: {error:#}");
            *lock(&state.startup) = error.to_string();
            let ui = app.clone();
            let _ = app.run_on_main_thread(move || preferences_window(&ui, None));
        }
    }
    if let Ok(watcher) = watch_providers(&app) {
        *lock(&state.watcher) = Some(watcher);
    }
    let ui = app.clone();
    let _ = app.run_on_main_thread(move || {
        let _ = refresh_menu(&ui);
    });
    tauri::async_runtime::spawn(background_sync(app.clone()));
}
async fn background_sync(app: AppHandle) {
    let state = desktop(&app);
    let cancel = state.gateway.stop.clone();
    loop {
        let config = store::read::<Value>(&state.root.join("sync.json")).unwrap_or_default();
        let enabled =
            config["enabled"] == true && config["url"].as_str().is_some_and(|s| !s.is_empty());
        if enabled && !state.exiting.load(Ordering::Acquire) && lock(&state.startup).is_empty() {
            let result = if state.visible.load(Ordering::Acquire) {
                state
                    .worker
                    .call("sync-background", Value::Null, Value::Null)
                    .await
            } else {
                state.paths.once("sync-background", Value::Null).await
            };
            let delay = if result.as_ref().is_ok_and(|value| value["phase"] != "error") {
                30
            } else {
                150
            };
            tokio::select! { _ = cancel.cancelled() => break, _ = tokio::time::sleep(Duration::from_secs(delay)) => {} }
        } else {
            tokio::select! { _ = cancel.cancelled() => break, _ = state.sync_changed.notified() => {} }
        }
    }
}

#[tauri::command]
async fn desktop_call(
    window: WebviewWindow,
    action: String,
    payload: Option<Value>,
) -> Result<Value, String> {
    if window.label() != SETTINGS || !window.url().ok().is_some_and(|url| trusted_url(&url)) {
        return Err("Untrusted application frame.".into());
    }
    call(window, &action, payload.unwrap_or_default())
        .await
        .map_err(|error| error.to_string())
}

async fn call(window: WebviewWindow, action: &str, mut payload: Value) -> Result<Value> {
    let app = window.app_handle();
    let state = desktop(app);
    if state.exiting.load(Ordering::Acquire) {
        bail!("fluid is closing.");
    }
    match action {
        "retain-window" => {
            state.retained.store(payload == true, Ordering::Release);
            release_when_idle(app);
            return Ok(Value::Null);
        }
        "foreground" => {
            set_foreground(app, payload == true);
            return Ok(Value::Null);
        }
        "quit" => {
            let app = app.clone();
            tauri::async_runtime::spawn(quit(app, true));
            return Ok(Value::Null);
        }
        "stop" => return stop_routes(&state).await,
        "start" | "routing" => {
            let _transition = state.route_transition.lock().await;
            if action == "routing" && payload["enabled"] == false {
                let result = state
                    .worker
                    .call(action, payload.clone(), state.gateway.context())
                    .await?;
                state.gateway.cancel_routes(payload["client"] == "claude");
                return Ok(result);
            }
            let network = state
                .worker
                .call("network", Value::Null, Value::Null)
                .await?;
            state.gateway.set_network(&network)?;
            let result = state
                .worker
                .call(action, payload, state.gateway.context())
                .await?;
            state.gateway.enabled.store(true, Ordering::Release);
            lock(&state.startup).clear();
            return Ok(result);
        }
        "autostart" => {
            let enabled = payload
                .as_bool()
                .context("Invalid start at login preference.")?;
            let previous = state.autostart.load(Ordering::Acquire);
            set_autostart(enabled)?;
            match state
                .worker
                .call(action, payload, state.gateway.context())
                .await
            {
                Ok(result) => {
                    state.autostart.store(enabled, Ordering::Release);
                    return Ok(result);
                }
                Err(error) => {
                    let _ = set_autostart(previous);
                    return Err(error);
                }
            }
        }
        "uninstall" => {
            return uninstall(app.clone()).await;
        }
        "skill-discover" if matches!(payload["kind"].as_str(), Some("folder" | "zip")) => {
            let dialog = rfd::AsyncFileDialog::new();
            let selected = if payload["kind"] == "folder" {
                dialog.pick_folder().await
            } else {
                dialog.add_filter("ZIP", &["zip"]).pick_file().await
            };
            let Some(file) = selected else {
                return Ok(Value::Null);
            };
            payload["source"] = json!(file.path());
        }
        "update-reveal" => {
            let file = state
                .worker
                .call(action, Value::Null, state.gateway.context())
                .await?;
            reveal(file.as_str().context("No verified installer.")?)?;
            return Ok(Value::Null);
        }
        "update-install" => {
            return install_update(app.clone()).await;
        }
        "usage-stats" | "state" | "client" | "switch" | "order" | "edit" | "remove" | "add-api"
        | "login" | "login-code" | "existing-login" | "import-login" | "models" | "reset-cards"
        | "consume-reset" | "preferences" | "open-login" | "updates" | "update-download"
        | "star" | "sync-client" | "sync-state" | "sync-guide" | "sync-tasks" | "sync-configure"
        | "sync-select" | "sync-remove-remote" | "sync-resolve" | "sync-now" | "mcp-settings"
        | "mcp-parse" | "mcp-details" | "mcp-change" | "skill-settings" | "skill-cancel"
        | "skill-discard" | "skill-discover" | "skill-import" | "skill-update-all"
        | "skill-change" => {}
        _ => bail!("Unsupported application action."),
    }
    let mut result = state
        .worker
        .call(action, payload, state.gateway.context())
        .await?;
    if action == "state" {
        result["error"] = json!(*lock(&state.startup));
        result["loginItem"] = json!(state.autostart.load(Ordering::Acquire));
        #[cfg(target_os = "macos")]
        {
            result["menuBarHidden"] = json!(tray_hidden(app));
        }
        let context = state.gateway.context();
        result["activeRequests"] = context["activeRequests"].clone();
        result["clients"]["codex"]["activeRequests"] = context["codexRequests"].clone();
        result["clients"]["claude"]["activeRequests"] = context["claudeRequests"].clone();
        if let Some((client, alias)) = lock(&state.pending_auth).take() {
            result["reauth"] = json!({"client":client,"alias":alias});
        }
    }
    if action == "preferences" {
        let _ = window.set_theme(native_theme(&state.root));
        #[cfg(target_os = "macos")]
        {
            let ui = app.clone();
            let _ = app.run_on_main_thread(move || {
                let _ = application_menu(&ui);
            });
        }
    }
    if action == "sync-configure" {
        state.sync_changed.notify_one();
    }
    if matches!(
        action,
        "preferences" | "client" | "switch" | "order" | "add-api" | "remove" | "edit"
    ) {
        let ui = app.clone();
        let _ = app.run_on_main_thread(move || {
            let _ = refresh_menu(&ui);
        });
    }
    Ok(result)
}

pub fn run() {
    if env::args().nth(1).as_deref() == Some("--recover-on-exit") {
        if recovery_guard().is_err() {
            std::process::exit(1);
        }
        return;
    }
    if let Some(exit) = maintenance::entry() {
        std::process::exit(exit);
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("Unable to initialize the desktop runtime.");
    tauri::async_runtime::set(runtime.handle().clone());
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            preferences_window(app, None)
        }))
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "quit" {
                tauri::async_runtime::spawn(quit(app.clone(), true));
            }
        })
        .invoke_handler(tauri::generate_handler![desktop_call])
        .setup(|app| {
            let root = root_dir();
            fs::create_dir_all(&root)?;
            let instance = Instance::acquire(&root)?;
            let port = env::var("SWITCH_PORT")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(18345);
            let listener = std::net::TcpListener::bind(("127.0.0.1", port))
                .context("The fluid routing port is already in use.")?;
            listener.set_nonblocking(true)?;
            let paths = WorkerPaths::new(
                &resources(app.handle())?,
                root.clone(),
                listener.local_addr()?.port(),
            );
            let worker = {
                let handle = tauri::async_runtime::handle();
                let _entered = handle.inner().enter();
                let ui = app.handle().clone();
                Worker::start(
                    paths.clone(),
                    Some(Box::new(move || {
                        let app = ui.clone();
                        let _ = ui.run_on_main_thread(move || {
                            if desktop(&app).visible.load(Ordering::Acquire) {
                                if let Some(window) = app.get_webview_window(SETTINGS) {
                                    bridge(&window, "change", None);
                                }
                            }
                        });
                    })),
                )
            };
            let ui = app.handle().clone();
            let reauth = Box::new(move |client: &str, alias: &str| {
                let state = desktop(&ui);
                let next = (client.to_owned(), alias.to_owned());
                let mut pending = lock(&state.pending_auth);
                if pending.as_ref() == Some(&next) {
                    return;
                }
                *pending = Some(next);
                drop(pending);
                let app = ui.clone();
                let _ = ui.run_on_main_thread(move || {
                    preferences_window(&app, Some("providers"));
                    if let Some(window) = app.get_webview_window(SETTINGS) {
                        bridge(&window, "change", None);
                    }
                });
            });
            let gateway = Arc::new(Gateway::new(
                root.clone(),
                worker.clone(),
                paths.clone(),
                Mode::Desktop,
                Some(reauth),
            )?);
            let autostart = maintenance::migrate_autostart(&root)?;
            let guard = launch_guard(&paths)?;
            app.manage(Desktop {
                root,
                paths,
                worker,
                gateway,
                startup: Mutex::default(),
                menu: Mutex::default(),
                release: Mutex::default(),
                watcher: Mutex::default(),
                sync_changed: tokio::sync::Notify::new(),
                guard: Mutex::new(Some(guard)),
                retained: AtomicBool::new(false),
                visible: AtomicBool::new(false),
                exiting: AtomicBool::new(false),
                ui_opening: AtomicBool::new(false),
                route_transition: tokio::sync::Mutex::new(()),
                autostart: AtomicBool::new(autostart),
                pending_auth: Mutex::default(),
                _instance: instance,
            });
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                app.set_dock_visibility(false);
                application_menu(app.handle())?;
            }
            let icon_bytes = if cfg!(target_os = "macos") {
                include_bytes!("../../../desktop/assets/trayTemplate.png").as_slice()
            } else {
                include_bytes!("../../../desktop/assets/tray.png").as_slice()
            };
            let tray = TrayIconBuilder::with_id(TRAY)
                .tooltip("fluid")
                .icon(Image::from_bytes(icon_bytes)?)
                .icon_as_template(cfg!(target_os = "macos"))
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } | TrayIconEvent::DoubleClick {
                            button: MouseButton::Left,
                            ..
                        }
                    ) {
                        preferences_window(tray.app_handle(), None);
                    }
                })
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => preferences_window(app, Some("providers")),
                    "settings" => preferences_window(app, Some("settings")),
                    "updates" => preferences_window(app, Some("updates")),
                    "quit" => {}
                    id => {
                        let state = desktop(app);
                        let result = if matches!(id, "codex" | "claude") {
                            let file = state.root.join("desktop.json");
                            let mut updated = prefs(&state.root);
                            updated["client"] = json!(id);
                            store::atomic(&file, &updated)
                        } else if let Some(alias) = id
                            .strip_prefix("provider:")
                            .and_then(|index| index.parse::<usize>().ok())
                            .and_then(|index| lock(&state.menu).get(index).cloned())
                        {
                            let claude = prefs(&state.root)["client"] == "claude";
                            let result = store::select(&client_root(&state.root, claude), &alias);
                            if result.is_ok() && claude {
                                let worker = state.worker.clone();
                                tauri::async_runtime::spawn(async move {
                                    let _ = worker
                                        .call("sync-client-settings", Value::Null, Value::Null)
                                        .await;
                                });
                            }
                            result
                        } else {
                            Ok(())
                        };
                        if let Err(error) = result {
                            notify_error(&error.to_string());
                        }
                        let _ = refresh_menu(app);
                        if let Some(window) = app.get_webview_window(SETTINGS) {
                            bridge(&window, "change", None);
                        }
                    }
                })
                .build(app)?;
            #[cfg(target_os = "macos")]
            {
                use objc2_foundation::NSString;
                use sha2::{Digest, Sha256};

                // Match the Electron tray GUID so AppKit restores the saved position.
                let hash = Sha256::digest(desktop(app.handle()).root.to_string_lossy().as_bytes());
                let mut bytes = [0; 16];
                bytes.copy_from_slice(&hash[..16]);
                let name = uuid::Builder::from_random_bytes(bytes)
                    .into_uuid()
                    .to_string();
                tray.with_inner_tray_icon(move |tray| {
                    if let Some(item) = tray.ns_status_item() {
                        item.setAutosaveName(Some(&NSString::from_str(&name)));
                    }
                })?;
            }
            #[cfg(not(target_os = "macos"))]
            drop(tray);
            refresh_menu(app.handle())?;
            tauri::async_runtime::spawn(start_desktop(app.handle().clone(), listener));
            Ok(())
        })
        .build(tauri::generate_context!());
    match result {
        Ok(app) => app.run(|app, event| match event {
            RunEvent::ExitRequested {
                code: None, api, ..
            } => {
                api.prevent_exit();
            }
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => preferences_window(app, None),
            _ => {}
        }),
        Err(error) => {
            eprintln!("fluid startup: {error:#}");
            notify_error(&error.to_string());
            std::process::exit(1);
        }
    }
}
