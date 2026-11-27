#![cfg_attr(
    all(feature = "desktop", not(debug_assertions)),
    windows_subsystem = "windows"
)]

mod catalog;
#[cfg(feature = "desktop")]
mod desktop;
mod gateway;
mod images;
#[cfg(unix)]
mod service;
mod store;
mod stream;
mod usage;
mod worker;

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!("fluid {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    #[cfg(unix)]
    if let Some(mode @ ("--service" | "--renderer-test")) = std::env::args().nth(1).as_deref() {
        if mode == "--renderer-test" && !cfg!(debug_assertions) {
            std::process::exit(2);
        }
        if let Err(error) = service::run(mode == "--renderer-test") {
            eprintln!("fluid: {error}");
            std::process::exit(1);
        }
        return;
    }
    #[cfg(feature = "desktop")]
    desktop::run();
    #[cfg(not(feature = "desktop"))]
    {
        eprintln!("Usage: fluid --service");
        std::process::exit(2);
    }
}
