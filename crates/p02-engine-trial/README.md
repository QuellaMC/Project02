# p02-engine-trial

A trial, never merged: the same tiny app (`app/tiny.js`) run through two
embedded script engines, `QuickJS` through `rquickjs` and Boa through
`boa_engine`, each reaching only the `Phone` the host gives it. The test
under `tests/engines` runs one body against both: actions called by name
with JSON in and out, a synchronous and an asynchronous host function,
state kept in the phone's storage, a runaway stopped by `TIME_LIMIT`, a
throw reported as text, and exactly what a bare engine exposes.
