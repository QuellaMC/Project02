# project02-shell

The app a person installs: the daemon and the Telegram connector in its own
process, a window on the daemon's page, and a tray that keeps them running
while the window is closed. It depends on p02-shared, p02-telegram and
project02, and on Tauri 2 for the window and the tray.

It builds only where a webview's development files are: on Linux, the
packages the gate's Linux job installs (`pkg-config`,
`libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev` and
`libxdo-dev`); on Windows, the MSVC build tools and WebView2; on macOS,
Xcode's command line tools.
