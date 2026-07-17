# tests/e2e

End-to-end here means: the test drives a CLI entrypoint in-process via
argv and captured stdio streams (`runChatCliFromArgs`,
`runInspectCliFromArgs`, `runRelayCli`, `runRuntimeConfigCliFromArgs`) —
the whole composition root executes, but no packaged binary is spawned.
The one exception is `plugin-barrel-startup.test.ts`, which spawns `node`
against the real entry files to pin module-init-order safety — a property
no import-graph rule can express, so it stays a test.
