# AGENTS.md

Operating guide for this repository — a **Live Character Framework**: a
character-driven agent runtime with persona continuity, plugins, tools, and
durable local state, its daemon in Rust under `crates/` and its clients in
TypeScript under `src/`.

Core rule:

```text
The model proposes. The runtime, tests, and policy commit.
```

---

## 0. Simplicity and the Greenfield Principle

**Simplicity is the ultimate sophistication.** Simple can be harder than
complex: you have to work hard to get your thinking clean to make it simple.
Complexity that remains is thinking that stopped early.

**Every line of code and documentation should read as if it had been written
correctly the first time.** The two principles share top rank. They govern
every other section here and apply to source, tests, docs, and this file.

1. **No patching.** Trace a break to its cause and fix it there. Do not stack
   special cases, copy logic and tweak it, or add a flag to route around the
   problem. Tearing something down and rewriting it is in scope.
2. **Code explains itself.** Names carry the *what*. A comment carries a *why*
   or a rule that cannot be inferred from the code, and it is clear, simple,
   and rare. Explanatory comments that narrate the code misguide more than
   they help: delete them, or rewrite the code that needed them. No
   commented-out code.
3. **No residue.** No backup copies, orphaned files, or dead code. When a
   mechanism goes, its tests, fixtures, and docs go with it.
4. **Deployment parity.** Deployed and local source stay byte-identical.

Before changing code, ask *"if I were writing this for the first time, how
would I write it?"* — not *"how do I graft this onto what is here?"* Two
corollaries: a business rule is defined in exactly one place, and all state
changes pass through the same entry point, so a competing second source never
appears.

Document only what is high-value, stable, and not discoverable by reading the
code. When tempted by "good enough for now", prefer the rewrite over leaving a
landmine.

---

## 1. Orientation

Top-level modules under `src/` carry a `README.md` stating what that module
owns; read it before changing the module, and write one when adding a module
that lacks it. Those READMEs, the code, and the tests are the source of truth
for what exists. This file is process, not architecture.

Precedence when sources disagree: the current user request controls the task,
tests and code control already-built behavior, and this file controls how you
work. Call out a mismatch rather than silently resolving it.

---

## 2. Design for the User

The people who run this are not engineers. They install it, pick a character,
and talk to it. Judge every change by what it costs them, not by how complete
it looks from inside the code.

**Simplify the complex.** Difficulty belongs in the runtime, where we can
solve it once, not in the user's lap as one more thing to understand. A
setting is a decision handed to someone with less context than we have — so
every new flag, field, or environment variable needs a real user who would
change it and a reason the runtime cannot decide for them. Otherwise pick a
good default and keep it out of the surface.

Before building for a case, ask whether a regular user reaches it. A case that
takes deliberate effort to produce is not a requirement, and code written for
it is code that will be maintained forever on the strength of a hypothetical.
Ask the same about functions: what does someone actually do with this?

This is not licence to drop real robustness. Crashes mid-write, interrupted
processes, a full disk, two windows open at once — a regular user hits all of
these without trying, and their data is at stake. Those are ordinary
conditions, not edge cases. The distinction is whether a person could
plausibly land there, not whether the code path looks unusual.

---

## 3. Operating Order

1. Identify the request or issue that authorizes the work.
2. Find the level where the cause actually lives, and fix it there.
3. Add or update tests for the behavior that changed.
4. Run `pnpm check`.
5. Say what changed, how it was tested, and what is still open.

Scope discipline applies to *adding* things — do not grow features because a
larger one feels convenient, and park good out-of-scope ideas in the PR
description. It does not mean patching shallowly to keep a diff small.

---

## 4. One Seam Per Job

One job, one implementation. Two code paths doing the same job will drift,
and then a bug fixed in one stays alive in the other.

When you touch an area, look for seams that have split apart: two validators
for one shape, two ways to write a file, two places that decide the same
thing. Unifying them is in scope and does not need separate authorization.
Say what you merged in the PR description. Refactoring that would sprawl past
the current task belongs in its own PR, right after this one — not abandoned,
and not smuggled into a feature commit.

**A small patch is usually a report about the architecture.** When you find
yourself adding a special case, a flag, or a guard so that one caller behaves,
stop and look at the seam. The question is not "how do I handle this case" but
"why can this case exist at all." A shape that makes the bad state
unrepresentable retires the edge case and every future one like it; a guard
retires today's bug report.

Some patches are genuinely just patches — a wrong constant, a typo in a
message, an off-by-one. Fix those directly. The rule is about repeated
special-casing, which is the signal worth acting on.

Grow structure from working behavior: start with the smallest path that
actually runs, add when real usage or tests create pressure, and skip
speculative frameworks, empty modules, placeholder APIs, and schema fields
added for a someday caller.

Compatibility is owed to real callers. This project has not shipped, so
nothing outside the repository depends on a name here; keep a shape when an
operator's data or scripts would break, not because it was written first. A
test that only exists to exercise an old shape is removed with the shape.

---

## 5. Reuse Before Building

Do not rebuild what already works. Before writing a function, constant,
interface, codec, validator, or helper, look for it in this order:

1. **This repository.** Search for the behavior. If it exists, call it, or
   widen it and merge both callers onto the one seam.
2. **The Node standard library and existing dev dependencies.** Node 24 covers
   far more than it used to; check before hand-rolling.
3. **A maintained package**, when the problem is real, general, and solved
   better elsewhere than we would solve it. Prefer a well-maintained
   community package over hand-rolling the same wheel; `package.json` is the
   inventory. Name every new runtime dependency and the alternative you
   rejected in the PR description; never add one quietly.
4. **Write it yourself**, on a shared seam with a concrete second caller.

Say what you looked for and what you found. "I searched and there was nothing"
is a useful sentence; silently writing a second copy is not.

---

## 6. Implementation Standards

- Follow existing project patterns and reuse existing logic.
- Create shared helpers only for a real shared boundary with a concrete caller.
- Keep persistence, model calls, side effects, logging, rendering, and external
  tools behind explicit boundaries.
- Prefer explicit data shapes over implicit prompt behavior, and deterministic
  code wherever model judgment is not actually needed.
- Keep identifiers and persisted record meanings stable once they exist.

Architecture gates enforced by `pnpm arch:check`:

- A client — `src/frontends`, `src/gateway/client` — imports only the wire's
  contract (`src/gateway/api`), the reference client, and `src/shared`.
- `src/shared` is a leaf, and additions need a reviewed `consumers.json` entry
  naming the modules that really import the file — at least two, unless the
  file is internal plumbing other `src/shared` files import.
- Cross-module imports land on barrels (`src/<module>/index.ts`), not deep paths.
- Pre-existing violations live in `.dependency-cruiser-known-violations.json`,
  which may only shrink. Regenerate with `pnpm arch:baseline` in the same PR
  that removes violations; a baseline diff that adds entries is a rejection.

The same ratchet applies to the `max-lines` overrides in `eslint.config.mjs`.

---

## 7. Testing

Test behavior — what a user or a calling module would notice if it broke. Use
TDD for runtime or behavior changes when practical.

**One behavior, one test.** Do not re-assert through a unit test what an
integration test already proves end to end, and do not add a case per branch
when the branches are one behavior. Duplicated tests are not extra safety:
they cost the same maintenance as real ones, fail in groups for a single
cause, and make the suite expensive to change — which is what stops people
from refactoring.

**The conformance suite is the daemon's acceptance gate.** A behavior the
daemon must keep is a row of `tests/conformance/inventory.csv` with a test
under `tests/conformance` titled by it, proved from outside the process; an
internal test may not pin what that suite proves. A rule of the daemon no
test from outside can bring about — a host rule no bundled plugin shows, a
race no client can hold open, a write no switch of the binary fails — is a
`rust-unit` row, proved by a Rust test under `crates` titled by it, and the
row says why.

Reach for a unit test when the logic is worth pinning on its own: validation,
parsing, routing, deterministic state, schema normalization, ID assignment,
model-output parsing, commit validation. Reach for an integration test at real
boundaries: input to output, provider to core, model loop to commit, tool
request to tool result. When a behavior is fully covered by the integration
test, that is the test.

When you remove or replace behavior, remove its tests with it.

Coverage is a floor that catches untested code, not a target to farm. Never
write a test whose purpose is to move the number. If deleting a duplicate
drops coverage below the thresholds in `vitest.config.ts`, lower the threshold
in the same PR and say why in the description — that is a real change of
intent, and it should be reviewed as one.

Never call live model providers or external services from tests — use fakes,
stubs, or test adapters. Keep test temp roots canonical (`realpath`); macOS
symlinks a temp dir that CI does not, and the difference silently splits local
and CI results.

---

## 8. Model, Persistence, Security, and Errors

Model output may propose actions; runtime policy decides what is allowed. Raw
model output must never directly mutate durable state.

Any action affecting user data, external systems, money, private information,
messages, documents, files, accounts, or settings goes through explicit
validation and, when needed, user confirmation.

Every boundary defines what happens when validation, parsing, logging, model
output, or duplicate processing fails. Do not hide runtime errors behind
friendly language — a non-technical user needs to know what broke and what to
do next, which is not the same as being spared the fact that it broke.

---

## 9. TypeScript and Checks

Node 24.12+, pnpm, TypeScript, ESLint, Vitest. Code follows Google TypeScript
style, enforced by Prettier plus the gts core rules in `eslint.config.mjs`.

- Prefer simple, readable TypeScript over type-level cleverness.
- No `any`, `as any`, `@ts-ignore`, `@ts-expect-error`, broad casts, or non-null
  assertions without explicit justification.
- No branded types, complex conditional types, or framework-wide abstractions
  unless the task requires them. That rule is TypeScript's, against
  type-level cleverness; the Rust crates under `crates/` follow the Rust API
  Guidelines, which ask for newtypes with validating constructors.
- Do not change public APIs unless the task requires it.

`pnpm check` is the clients' gate — format, lint, typecheck, arch, the web
page's build, coverage, and the browser suite (Chromium via Playwright)
against the binary. `pnpm check:rust` is the daemon's gate — rustfmt,
clippy, the tests, the generated contract, and cargo-deny — which CI runs on
Linux, macOS, and Windows, and `pnpm test:conformance` runs the conformance
suite against the binary, which CI runs on Linux after `pnpm check`. For
TypeScript-heavy changes also run:

```text
pnpm exec tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters
```

Do not commit dependency folders, caches, coverage, build output, or temp
files. Before commits touching package or tooling files, check `git status
--short` and `git ls-files -ci --exclude-standard`.

---

## 10. Branch, Commit, and PR Policy

One branch, one PR, merged before the next starts. All changes to `main` go
through a PR unless the user directs otherwise.

Branch names: `feature/`, `fix/`, `docs/`, `chore/` plus a short name.

- Sign commits (`git commit -S`).
- Keep commits coherent; do not mix unrelated work.
- PR descriptions are real multi-line Markdown with `## Summary` and `## Tests`.
- No agent or platform branding in commits, PR titles, PR bodies, code, or
  generated artifacts.

---

## 11. Documentation

`docs/wiki/` holds durable HTML reference pages; add one when a subsystem needs
explanation that does not belong in a module README. `docs/plan/` and
`docs/develop-journal/` are gitignored local scratch space — nothing there is
a shared source of truth. PR descriptions carry the record for normal changes.

`.gitignore` does not apply to files already tracked, so an ignored path can
still sit in the index and produce committable diffs. If you find one, untrack
it (`git rm --cached`) rather than editing it in place.

---

## 12. Final Rule

Design the architecture globally. Implement behavior locally. Fix causes at the
seam, not symptoms at the call site. Let schemas, modules, settings, and docs
grow only when a real user's working behavior needs them.
