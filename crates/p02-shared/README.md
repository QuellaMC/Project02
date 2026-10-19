# p02-shared

Generic, domain-free primitives for every other crate, and the leaf of the
crate graph: it depends on no crate of this workspace.

- **Files.** The fs seam is the one place the file system is reached;
  `clippy.toml` refuses `std::fs`, `tokio::fs` and the `Path` methods that
  touch the disk everywhere else. It reads text lossily, writes owner-only
  files whole (a replacement through a sibling temporary and a rename, or
  an exclusive create), says what is at a path, spells a path canonically
  even before it exists (without Windows' `\\?\` prefix), and says whether
  one path lies inside another.
- **JSON.** `serde_json` parses each decimal to the nearest double
  (`float_roundtrip`) and keeps object keys in document order
  (`preserve_order`); both features are set once, in the workspace
  manifest. Canonical JSON sorts keys by code point and writes values as
  `serde_json` writes them; a fingerprint is `sha256:` and the digest of
  that text. The JSON boundary holds a value from elsewhere to its limits,
  names the first place it overflows them, and can redact the values of
  credential-named keys.
- **The daemon record**, `<home>/daemon.json`, which the daemon writes and
  its clients read to find it: its shape, its token and port rules, and its
  reader; and the default home, `.project02`.
- **Identifiers**, **credential-shaped key names**, and the **server-sent
  event splitter** the gateway client and the model provider read streams
  with.
