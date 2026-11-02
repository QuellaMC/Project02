#![doc = include_str!("../README.md")]
#![forbid(unsafe_code)]
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use std::error::Error;
use std::ffi::OsString;
use std::fmt::Display;
use std::io::{self, Write as _};
use std::path::{self, Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::{Mutex, PoisonError};
use std::thread;

use p02_shared::{read_text_lossy, sentence};
use project02::ADDRESS_PREFIX;
use project02_shell::home;
use project02_shell::run::{self, DAEMON_LOG, Running};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{
    App, AppHandle, Manager as _, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt as _, MessageDialogKind};

/// The label of the one window.
const WINDOW: &str = "main";

/// What the shell holds while it runs: the two folders the tray opens, the
/// tray, and the two services Quit stops, taken once.
struct Shell {
    home: PathBuf,
    logs: PathBuf,
    tray: TrayIcon,
    running: Mutex<Option<Running>>,
    /// Set once the daemon ended without an address or the window could
    /// not open, so whichever quit follows ends the app with 1.
    start_failed: AtomicBool,
}

fn main() -> ExitCode {
    let args: Vec<OsString> = env::args_os().skip(1).collect();
    let named = match home::named(&args) {
        Ok(named) => named,
        Err(usage) => return failed(&usage),
    };
    let builder = tauri::Builder::default()
        // First, so a second launch reaches this one before anything starts.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .plugin(tauri_plugin_dialog::init())
        // The tray's menu and a Mac's application menu, which share Quit.
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show(app),
            "data" => reveal(&app.state::<Shell>().home),
            "logs" => reveal(&app.state::<Shell>().logs),
            "quit" => quit(app),
            _ => {}
        })
        .setup(move |app| start(app, named));
    // Elsewhere an app's menu is a bar in its window.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(mac_menu);

    match builder
        .build(tauri::generate_context!())
        .map(|app| app.run_return(on_event))
    {
        Ok(0) => ExitCode::SUCCESS,
        Ok(_) => ExitCode::FAILURE,
        Err(error) => failed(&error),
    }
}

/// Says on stderr, in one line, why the shell ends before it runs.
fn failed(why: &dyn Display) -> ExitCode {
    let _ = writeln!(io::stderr(), "Error: {why}");
    ExitCode::FAILURE
}

/// Builds the tray, starts the daemon and the connector on the home, and
/// leaves the window to open on the address the daemon says.
fn start(app: &mut App, named: Option<PathBuf>) -> Result<(), Box<dyn Error>> {
    let home = match named {
        Some(dir) => path::absolute(dir)?,
        None => home::per_user(&app.path().local_data_dir()?),
    };
    let logs = app.path().app_log_dir()?;

    // Before the two start, so a desktop that refuses a tray starts nothing.
    let tray = tray(app)?;
    let (running, address) = run::start(home.clone(), &logs)?;

    app.manage(Shell {
        home,
        logs,
        tray,
        running: Mutex::new(Some(running)),
        start_failed: AtomicBool::new(false),
    });

    let app = app.handle().clone();

    thread::Builder::new().name("signals".to_owned()).spawn({
        let app = app.clone();

        move || quit_when_signalled(&app)
    })?;
    thread::Builder::new()
        .name("address".to_owned())
        .spawn(move || open_when_served(&app, &address))?;
    Ok(())
}

/// Runs the stop order at the first signal a person or the system sends
/// the process, the one `project02 serve` stops at: a `kill`, Ctrl-C in the
/// terminal that started the app, a hangup. A second signal ends the
/// process at once, the way out when stopping hangs, so the listener stays
/// until the process ends. One that cannot begin leaves the signals to end
/// the process, as a crash does.
fn quit_when_signalled(app: &AppHandle) -> io::Result<()> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .build()?;

    runtime.block_on(async {
        let stop = project02::listen_for_stop()?;

        stop.cancelled().await;
        quit(app);
        std::future::pending().await
    })
}

/// Opens the window on the address the daemon says; when the daemon ends
/// without one, or the window cannot open, says so with the end of the
/// daemon's log, then quits.
fn open_when_served(app: &AppHandle, address: &Receiver<String>) {
    let opened = match address.recv() {
        Ok(address) => open(app, &address)
            .map_err(|error| sentence(&format!("the window could not open: {error}"))),
        Err(_) => Err("The character service did not start.".to_owned()),
    };

    if let Err(what) = opened {
        let shell = app.state::<Shell>();
        let log = shell.logs.join(DAEMON_LOG);

        shell.start_failed.store(true, Ordering::SeqCst);
        app.dialog()
            .message(format!(
                "{what}\n\n{}\n\nThe whole log is {}.",
                last_lines(&log),
                log.display()
            ))
            .title("Project02")
            .kind(MessageDialogKind::Error)
            .blocking_show();
        quit(app);
    }
}

/// The one window, on the daemon's page at `address`. No capability names
/// it, so the page gets nothing of Tauri.
fn open(app: &AppHandle, address: &str) -> tauri::Result<()> {
    let url: Url = address.parse().map_err(tauri::Error::InvalidUrl)?;

    WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::External(url))
        .title("Project02")
        .inner_size(1080.0, 760.0)
        .build()?;
    Ok(())
}

/// The last five lines of the log at `path`, where the daemon says why it
/// ended. The address line is never why, and carries the token.
fn last_lines(path: &Path) -> String {
    let log = read_text_lossy(path).unwrap_or_default();
    let lines: Vec<&str> = log
        .lines()
        .filter(|line| !line.starts_with(ADDRESS_PREFIX))
        .collect();

    lines[lines.len().saturating_sub(5)..].join("\n")
}

fn tray(app: &App) -> tauri::Result<TrayIcon> {
    let item = |id: &str, text: &str| MenuItem::with_id(app, id, text, true, None::<&str>);
    let menu = Menu::with_items(
        app,
        &[
            &item("open", "Open Project02")?,
            &item("data", "Open data folder")?,
            &item("logs", "Open logs")?,
            &item("quit", "Quit")?,
        ],
    )?;
    let mut tray = TrayIconBuilder::new().menu(&menu).tooltip("Project02");

    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }

    tray.build(app)
}

/// A Mac's menu bar: the app's menu, whose Quit and Cmd-Q run the stop
/// order where the system's own Quit would end the process at once, and the
/// Edit menu, whose items carry the page's copy and paste keys.
#[cfg(target_os = "macos")]
fn mac_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    use tauri::menu::{PredefinedMenuItem, Submenu};

    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                "Project02",
                true,
                &[
                    &PredefinedMenuItem::about(app, None, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::show_all(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "quit", "Quit Project02", true, Some("CmdOrCtrl+Q"))?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Edit",
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
            )?,
        ],
    )
}

/// Brings the window back, once it is open.
fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Opens `folder` in the system's file manager; one not made yet opens
/// nothing.
fn reveal(folder: &Path) {
    let _ = tauri_plugin_opener::open_path(folder, None::<&str>);
}

/// Runs the stop order once, for whichever quit comes first: the window
/// hidden and the tray saying why the app has not gone yet, then, off the
/// event loop, which the graces must not hold, the two stopped and the app
/// let go.
fn quit(app: &AppHandle) {
    let shell = app.state::<Shell>();
    let Some(running) = shell
        .running
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take()
    else {
        return;
    };

    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.hide();
    }

    let _ = shell.tray.set_tooltip(Some("Finishing a reply…"));
    let app = app.clone();

    thread::spawn(move || {
        running.stop();

        let start_failed = app.state::<Shell>().start_failed.load(Ordering::SeqCst);

        app.exit(i32::from(start_failed));
    });
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
        // An exit the stop order did not ask for waits for it; the one it
        // asks for carries a code and passes.
        RunEvent::ExitRequested {
            code: None, api, ..
        } => {
            api.prevent_exit();
            quit(app);
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show(app),
        // The system ending the app itself, the Dock's Quit, a logout or a
        // shutdown, comes here without asking: the stop order runs as the
        // loop ends, for the seconds the system waits.
        RunEvent::Exit => {
            let running = app
                .state::<Shell>()
                .running
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .take();

            if let Some(running) = running {
                running.stop();
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use p02_shared::append_line;

    use super::*;

    #[test]
    fn the_dialog_shows_the_logs_last_five_lines_and_never_the_address() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(DAEMON_LOG);
        let address = format!("{ADDRESS_PREFIX}http://127.0.0.1:4310/#token=abc");

        for line in ["one", "two", &address, "three", "four", "five", "six"] {
            append_line(&path, line.as_bytes()).unwrap();
        }

        assert_eq!(last_lines(&path), "two\nthree\nfour\nfive\nsix");
    }
}
