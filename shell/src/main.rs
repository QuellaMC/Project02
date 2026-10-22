#![doc = include_str!("../README.md")]
#![forbid(unsafe_code)]
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod home;
mod lines;
mod run;

use std::env;
use std::error::Error;
use std::ffi::OsString;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::mpsc::Receiver;
use std::sync::{Mutex, PoisonError};
use std::thread;

use p02_shared::{create_directories, read_text_lossy};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{
    App, AppHandle, Manager as _, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt as _, MessageDialogKind};

use crate::run::Running;

/// The label of the one window.
const WINDOW: &str = "main";

/// What the shell holds while it runs: the folders it shows, and the two
/// it stops at Quit, taken once.
#[derive(Debug)]
struct Shell {
    home: PathBuf,
    logs: PathBuf,
    running: Mutex<Option<Running>>,
}

fn main() -> ExitCode {
    let args: Vec<OsString> = env::args_os().skip(1).collect();
    let named = match home::named(&args) {
        Ok(named) => named,
        Err(usage) => {
            let _ = writeln!(io::stderr(), "Error: {usage}");
            return ExitCode::FAILURE;
        }
    };
    let built = tauri::Builder::default()
        // First, so a second launch reaches this one before anything starts.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| start(app, named))
        .build(tauri::generate_context!());

    match built {
        Ok(app) => {
            app.run(on_event);
            ExitCode::SUCCESS
        }
        Err(error) => {
            let _ = writeln!(io::stderr(), "Error: {error}");
            ExitCode::FAILURE
        }
    }
}

/// Starts the two on the home, shows the tray, and opens the window once
/// the daemon says its address.
fn start(app: &mut App, named: Option<PathBuf>) -> Result<(), Box<dyn Error>> {
    let home = match named {
        Some(dir) => std::path::absolute(dir)?,
        None => home::per_user(&app.path().local_data_dir()?),
    };
    let logs = app.path().app_log_dir()?;

    create_directories(&logs)?;
    // Before the two start, so a tray the desktop refuses starts nothing.
    tray(app)?;

    let (running, address) = run::start(home.clone(), &logs)?;

    app.manage(Shell {
        home,
        logs,
        running: Mutex::new(Some(running)),
    });

    let app = app.handle().clone();

    thread::Builder::new()
        .name("address".to_owned())
        .spawn(move || open_when_served(&app, &address))?;
    Ok(())
}

/// Opens the window on the address the daemon says, or, when it ends
/// without one, says it did not start and why, then quits.
fn open_when_served(app: &AppHandle, address: &Receiver<String>) {
    let opened = match address.recv() {
        Ok(url) => open(app, &url).map_err(|error| format!("The window could not open: {error}.")),
        Err(_) => Err("The character service did not start.".to_owned()),
    };

    if let Err(what) = opened {
        let log = app.state::<Shell>().logs.join(run::DAEMON_LOG);

        app.dialog()
            .message(format!(
                "{what}\n\n{}\n\nThe whole log is {}.",
                last_lines(&log),
                log.display()
            ))
            .title("Project02")
            .kind(MessageDialogKind::Error)
            .blocking_show();
        quit(app, 1);
    }
}

fn open(app: &AppHandle, address: &str) -> Result<(), Box<dyn Error>> {
    WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::External(address.parse()?))
        .title("Project02")
        .inner_size(1080.0, 760.0)
        .build()?;
    Ok(())
}

/// The last lines of the log at `path`, where the daemon said what broke.
fn last_lines(path: &Path) -> String {
    let text = read_text_lossy(path).unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();

    lines[lines.len().saturating_sub(5)..].join("\n")
}

fn tray(app: &App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Project02", true, None::<&str>)?;
    let data = MenuItem::with_id(app, "data", "Open data folder", true, None::<&str>)?;
    let logs = MenuItem::with_id(app, "logs", "Open logs", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &data, &logs, &quit_item])?;
    let mut tray = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("Project02")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show(app),
            "data" => reveal(app, |shell| &shell.home),
            "logs" => reveal(app, |shell| &shell.logs),
            "quit" => quit(app, 0),
            _ => {}
        });

    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }

    tray.build(app)?;
    Ok(())
}

fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Opens the folder `folder` names in the system's file manager; one not
/// made yet opens nothing.
fn reveal(app: &AppHandle, folder: impl Fn(&Shell) -> &Path) {
    let shell = app.state::<Shell>();
    let _ = tauri_plugin_opener::open_path(folder(&shell), None::<&str>);
}

/// Runs the stop order once, off the event loop, which its graces must not
/// hold, then lets the app go with `code`.
fn quit(app: &AppHandle, code: i32) {
    let running = app
        .state::<Shell>()
        .running
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take();

    if let Some(running) = running {
        if let Some(window) = app.get_webview_window(WINDOW) {
            let _ = window.hide();
        }

        let app = app.clone();

        thread::spawn(move || {
            running.stop();
            app.exit(code);
        });
    }
}

fn on_event(app: &AppHandle, event: RunEvent) {
    match event {
        // Closing the window hides it: the characters keep answering in
        // Telegram until Quit.
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } => {
            api.prevent_close();

            if let Some(window) = app.get_webview_window(&label) {
                let _ = window.hide();
            }
        }
        // A quit the person or the system asks for runs the stop order
        // first; the exit it ends with passes.
        RunEvent::ExitRequested {
            code: None, api, ..
        } => {
            api.prevent_exit();
            quit(app, 0);
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show(app),
        _ => {}
    }
}
