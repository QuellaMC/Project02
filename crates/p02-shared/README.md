# p02-shared

Generic, domain-free primitives for every other crate, and the leaf of the
crate graph: it depends on no crate of this workspace.

- **Files.** The fs seam is the one place the file system is reached;
  `clippy.toml` refuses `std::fs`, `tokio::fs` and the `Path` methods that
  touch the disk everywhere else. It reads a file whole, as text lossily,
  or up to a limit; writes owner-only files whole, by an exclusive create
  or by a replacement through a sibling temporary and a rename, made under
  the lock that guards the file, so a temporary found beside it is a dead
  writer's and goes first; appends a line, first cutting what a crash left
  after the last one; flushes a file to disk, its name in its directory
  with it; stamps a file, so a reader can tell it changed while it read;
  makes and removes files and directories, a directory it makes flushed
  into the one above it; takes a file's exclusive advisory lock, which the
  operating system releases when its holder dies; says what is at a path
  and what each entry of a directory is; spells a path canonically even
  before it exists (without Windows' `\\?\` prefix); and says whether one
  path lies inside another.
- **JSON.** `serde_json` parses each decimal to the nearest double
  (`float_roundtrip`) and keeps object keys in document order
  (`preserve_order`); both features are set once, in the workspace
  manifest. Canonical JSON sorts keys by code point and writes values as
  `serde_json` writes them; a fingerprint is `sha256:` and the digest of
  that text, and reads back only in that spelling. The JSON boundary holds
  a value from elsewhere to its limits, names the first place it
  overflows them, and can redact the values of credential-named keys.
- **The daemon record**, `<home>/daemon.json`, which the daemon writes and
  its clients read to find it: its shape, its token, minted from 32 random
  bytes spelled base64url, and its port rules, and its reader; and the
  default home, `.project02`.
- **HTTP**, behind the `http` feature for the crates that call services:
  a service's base URL, held to one rule a refusal can state without
  echoing the value, its endpoints below it, a credential as a header no
  `Debug` prints, and the client builder every caller starts from, with
  TLS through the ring provider and no redirect or environment proxy
  followed.
- **Sentences.** Every error displays itself as a lowercase fragment with
  its cause beneath it; what a person is told of one is the fragments
  joined into one sentence, what broke and then why.
- **Identifiers**, **credential-shaped key names**, and the **server-sent
  event splitter** the gateway client and the model provider read streams
  with.
