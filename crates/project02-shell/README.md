# project02-shell

The app a person installs: the daemon and the Telegram connector in its own
process, a window on the daemon's page and one for her phone, and a tray
that keeps them running while the main window is closed. It depends on
p02-shared, p02-telegram and project02, and on Tauri 2 for the windows and
the tray.

It builds only where a webview's development files are: on Linux, the
packages the gate's Linux job installs (`pkg-config`,
`libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev` and
`libxdo-dev`); on Windows, the MSVC build tools and WebView2; on macOS,
Xcode's command line tools.

- **The home** is `%APPDATA%\Project02`, `~/Library/Application
  Support/Project02`, or `$XDG_DATA_HOME/project02` (else
  `~/.local/share/project02`): the person's, outside the app, the same for
  every version, and neither the app's own data folder, which the webview
  writes into, nor on Windows the local one, where the installer puts the
  app itself. `--store <dir>` on the shell's command line takes its place;
  nothing else is accepted there.
- **The start** makes the store there as `serve --init` does, the person
  having consented by installing, and starts the connector beside the
  daemon. The main window opens on the address the daemon says; a daemon
  that ends before it says one, or a window that cannot open, is a dialog
  with the last lines of the daemon's log, then the app quits. When another
  daemon already holds the home, its address is the one the window opens
  on.
- **The main window**, when closed, hides: the characters keep answering
  in Telegram. The tray's Open, the Dock, and a second launch bring it
  back; a second launch starts nothing.
- **A link that leads outside** the page, over https, as the one to
  OpenAI's sign-in page does, opens in the person's browser. The main
  window gives the page no window of its own for any request.
- **Her phone's window** is the app's own. Her Phone in the chat calls
  `window.open` on her phone's address; the main window answers that with
  no window, as it answers every request, and the app opens her phone's
  window itself at that address: 372 by 792, not resizable, without a
  frame and transparent around the phone. There is one: another
  character's phone takes it to her address. The capability `phone-window`
  in `tauri.conf.json` gives that window, labelled `phone`, four of
  Tauri's window calls, on 127.0.0.1, where the daemon serves, and nowhere
  else: whether it stays on top, keeping it on top, starting a drag and
  closing it, with which its page moves it by its bar, pins it and closes
  it. The main window's page reaches nothing of Tauri. However it is
  closed, it closes and does not hide; Quit hides it with the main window
  before the stop order.
- **What the app remembers** of her phone's window is in
  `phone-window.json`, in the app's config folder
  (`io.github.quellamc.project02` under the system's), written whole when
  the window closes and when the app ends: where it was left, whether it
  was pinned, and whose phone it showed when the app ended with it open.
  At the next start, once the main window is on the daemon's address, that
  phone opens again, pinned as it was and where it was, unless no screen
  holds that place any more: then beside the main window, as the first
  time. A file that cannot be read is no memory.
- **The logs** are `daemon.log` and `telegram.log` in the app's log folder,
  `~/Library/Logs/io.github.quellamc.project02` on macOS and
  `io.github.quellamc.project02/logs` under the local data folder
  elsewhere, begun anew at each start; the tray opens the folder, and the
  data folder.
- **Quit**, from the tray, from a Mac's application menu or Cmd-Q, or by
  the first signal a `kill`, Ctrl-C or a closed terminal sends, which the
  app listens for as `project02 serve` does, runs one stop order: the
  connector, given 5 s, then the daemon, given 20 s, then the app leaves.
  One that outstays its grace ends with the process, and a second signal
  ends it at once. The Dock's Quit, a logout and a shutdown run the same
  order as the app ends, for the seconds the system waits; past them the
  process ends as a crash does, which the runtime recovers from.
- **The notice** is `THIRD-PARTY-NOTICES.txt` at the repository root, and
  every bundle carries it: the crates the app is built from, with the texts
  of their licenses, and the mem0 prompt the daemon includes. From the
  repository root, cargo-about 0.9.2 makes it from `about.toml`, which
  accepts what `deny.toml` allows, with
  `cargo about generate --workspace --locked --fail about.hbs -o THIRD-PARTY-NOTICES.txt`;
  `pnpm check:rust` runs that and fails while the committed file differs.
  `--fail` writes nothing while a crate's license cannot be read or is not
  accepted; the mem0 prompt, being no crate, is a fixed section of
  `about.hbs`. The command needs the network, for the texts some crates
  keep only in their repository; offline it warns and puts the canonical
  texts in their place, which the check then reports as a difference.
- **The bundles** are made by Tauri's bundler from `tauri.conf.json`, each
  on the system it is for: on Windows an NSIS installer that installs for
  the person alone, with no administrator; on macOS the app, signed ad hoc,
  and a disk image; on Linux an AppImage, which carries the appindicator
  library the tray loads, and a deb, which depends on it. The ad-hoc
  signature needs no account: a Mac refuses a download with no signature at
  all as damaged, and one signed ad hoc the way *Open Anyway* passes; an
  identity in `APPLE_SIGNING_IDENTITY` replaces it. Tauri's CLI is a
  development dependency, which the lockfile pins at 2.12.4: at the
  repository root run `pnpm install`, then `pnpm build:web` so the daemon's
  page is embedded, then `pnpm exec tauri build`, which finds this crate by
  its `tauri.conf.json`; they land in `target/release/bundle`.
  `.github/workflows/package.yml` makes every bundle, by hand or from a
  version tag `v*`, on a runner of the system it is for, smokes each there,
  and keeps them with the run; a tag, which must be `v` and the version
  `tauri.conf.json` names, also publishes them to a draft release once every
  one has passed. On the AppImage and the app the smoke is
  `scripts/smoke-shell.sh`: on a temporary home the app must serve and
  connect, end with exit code 0 at SIGTERM with its record left without a
  run, and carry the notice. Windows gives a script no graceful quit, so
  there the installed app, started as a person starts it, is ended as a
  crash ends it, and its next start must take its home over.
