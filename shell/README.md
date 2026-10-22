# project02-shell

The app a person installs: the daemon and the Telegram connector run in its
own process, a window shows the daemon's page at the address the daemon
says, and a tray keeps both running while the window is closed, until Quit.
It is a Tauri 2 app over `project02::serve` and `p02_telegram::run`, each on
a thread and a runtime of its own; the page renders in the processes the
system's webview starts for it.

It builds only where a webview's development files are: on Linux,
`webkit2gtk-4.1`'s, with `pkg-config`, GTK 3, `librsvg` and an
appindicator library; on Windows, with the MSVC build tools; on macOS, with
Xcode's command line tools. The workspace's gate installs none of them, so
the crate is a workspace of its own, outside `crates/`, whose every folder
is a member of the root's, and its `Cargo.lock` was begun from the root's so
the daemon's crates resolve to the versions the gate tests.

- **The home** is `%LOCALAPPDATA%\Project02`, `~/Library/Application
  Support/Project02`, or `$XDG_DATA_HOME/project02` (else
  `~/.local/share/project02`): the person's, outside the app, the same for
  every version, and never the app's own data folder, which the webview
  writes into. `--store <dir>` on the shell's command line takes its place;
  nothing else is accepted there.
- **The start** makes the store there as `serve --init` does, the person
  having consented by installing, and starts the connector beside the
  daemon. The window opens on the address line the daemon says; a daemon
  that ends before it says one is a dialog with the last lines of its log,
  then the app quits. When another daemon already holds the home, its
  address is the one the window opens on.
- **The window**, when closed, hides: the characters keep answering in
  Telegram. The tray's Open, the Dock, and a second launch bring it back; a
  second launch starts nothing.
- **The logs** are `daemon.log` and `telegram.log` in the app's log folder,
  begun anew at each start; the tray opens the folder, and the data folder.
- **Quit**, from the tray, the application menu, or the system, runs one
  stop order: the connector, given 5 s, then the daemon, given 20 s, then
  the app leaves. One that outstays its grace ends with the process, which
  the runtime recovers from as from a crash.
- **The notice** `THIRD-PARTY-NOTICES.txt` beside `tauri.conf.json` ships in
  every bundle and must exist before the crate builds. From the repository
  root: `cargo about generate -m shell/Cargo.toml --fail about.hbs -o
  shell/THIRD-PARTY-NOTICES.txt`, which needs `MPL-2.0` accepted for
  `cssparser`, `cssparser-macros`, `dtoa-short`, `selectors` and
  `option-ext`, which Tauri brings in.
- **The bundles** are made with `cargo tauri build` in this folder
  (`tauri-cli` 2): NSIS, per user, on Windows; the app and a DMG on macOS;
  an `AppImage` and a deb on Linux.
