# tests/e2e

End-to-end here means: the test drives a CLI entrypoint in-process via
argv and captured stdio streams (`runServeCliFromArgs`,
`runChatCliFromArgs`, `runInspectCliFromArgs`,
`runRuntimeConfigCliFromArgs`) — the whole composition root executes, but
no packaged binary is spawned. The chat shim's suite stands up the daemon
in-process on an ephemeral port and talks to it over the real socket.

Two exceptions spawn `node` against the real entry files:
`plugin-barrel-startup.test.ts` pins module-init-order safety, a property
no import-graph rule can express, and `two-character-concurrency.test.ts`
runs real `serve` processes to prove one home's leases across processes.
