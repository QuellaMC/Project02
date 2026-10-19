# tests/e2e

End-to-end here means: the test drives a CLI entrypoint in-process via
argv and captured stdio streams (`runServeCliFromArgs`,
`runInspectCliFromArgs`) — the whole composition root executes, but no
packaged binary is spawned.

Four exceptions spawn `node` against the real entry files:
`plugin-barrel-startup.test.ts` pins module-init-order safety, a property
no import-graph rule can express; `two-character-concurrency.test.ts`
runs a real `serve` process to prove one home's leases across characters;
`serve-instances.test.ts` proves one daemon per home across processes — a
second `serve` handing back the first's address, a crash succeeded on the
same address, and SIGHUP as a stop; and `serve-test-durations.test.ts`
starts `serve` with `PROJECT02_TEST_DURATIONS` set, to prove the stream
pings at the heartbeat it sets and a key `serve` does not read refuses
the start. The last three run one file at a time, under the `processes`
project.
