# AGENTS.md

Operating guide for this repository — a TypeScript **Live Character Framework**:
a character-driven agent runtime with persona continuity, plugins, tools, and
durable local state.

Core rule:

```text
The model proposes. The runtime, tests, and policy commit.
```

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

## 2. Operating Order

1. Identify the request or issue that authorizes the work.
2. Make the smallest useful change that satisfies it.
3. Add or update tests for behavior changes.
4. Run `pnpm check`.
5. Say what changed, how it was tested, and what is still open.

Do not widen scope because a larger refactor feels convenient. Park good
out-of-scope ideas in the PR description instead of building them.

---

## 3. Build Style

Grow from working behavior, not from anticipated structure:

- Start with the smallest end-to-end path that actually runs.
- Add features when real usage or tests expose pressure.
- Refactor when the current structure blocks real work, not before.
- Avoid speculative frameworks, empty modules, placeholder APIs, and schema
  fields added for a someday caller.

One job, one implementation. A second command or module that re-does an
existing path is not a simpler alternative — it is a fork that drifts. Where
something needs a smaller composition, expose a seam in the existing path and
test through it.

Compatibility is owed to real callers. This project has not shipped, so
nothing outside the repository depends on a name here; keep a shape when an
operator's data or scripts would break, not because it was written first. A
test that only exists to exercise an old shape is removed with the shape.

---

## 4. Implementation Standards

- Follow existing project patterns and reuse existing logic.
- Before adding a function, constant, hard-coded value, interface, contract,
  codec, validator, or helper, search for the behavior first. If it exists,
  reuse it or merge into the shared seam instead of building a parallel one.
- Create shared helpers only for a real shared boundary with a concrete caller.
- Keep persistence, model calls, side effects, logging, rendering, and external
  tools behind explicit boundaries.
- Prefer explicit data shapes over implicit prompt behavior, and deterministic
  code wherever model judgment is not actually needed.
- Keep identifiers and persisted record meanings stable once they exist.

Architecture gates enforced by `pnpm arch:check`:

- `src/core` is pure domain — it may import `core` and `shared` only.
- `src/shared` is a leaf, and additions need a reviewed `consumers.json` entry
  naming at least two consumer modules.
- Cross-module imports land on barrels (`src/<module>/index.ts`), not deep paths.
- Pre-existing violations live in `.dependency-cruiser-known-violations.json`,
  which may only shrink. Regenerate with `pnpm arch:baseline` in the same PR
  that removes violations; a baseline diff that adds entries is a rejection.

The same ratchet applies to the `max-lines` overrides in `eslint.config.mjs`.

---

## 5. Testing

Use TDD for runtime or behavior changes when practical.

Unit-test pure logic: validation, parsing, routing, deterministic state, schema
normalization, ID assignment, model-output parsing, commit validation.
Integration-test real boundaries: input to output, provider to core, model loop
to commit, tool request to tool result.

Never call live model providers or external services from tests — use fakes,
stubs, or test adapters. Keep test temp roots canonical (`realpath`); macOS
symlinks a temp dir that CI does not, and the difference silently splits local
and CI results.

---

## 6. Model, Persistence, Security, and Errors

Model output may propose actions; runtime policy decides what is allowed. Raw
model output must never directly mutate durable state.

Any action affecting user data, external systems, money, private information,
messages, documents, files, accounts, or settings goes through explicit
validation and, when needed, user confirmation.

Every boundary defines what happens when validation, parsing, logging,
model output, or duplicate processing fails. Do not hide runtime errors behind
friendly language.

---

## 7. TypeScript and Checks

Node 24.12+, pnpm, TypeScript, ESLint, Vitest. Code follows Google TypeScript
style, enforced by Prettier plus the gts core rules in `eslint.config.mjs`.

- Prefer simple, readable TypeScript over type-level cleverness.
- No `any`, `as any`, `@ts-ignore`, `@ts-expect-error`, broad casts, or non-null
  assertions without explicit justification.
- No branded types, complex conditional types, or framework-wide abstractions
  unless the task requires them.
- Do not change public APIs unless the task requires it.

`pnpm check` is the gate — format, lint, typecheck, arch, and coverage. CI runs
the same command. For TypeScript-heavy changes also run:

```text
pnpm exec tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters
```

Do not commit dependency folders, caches, coverage, build output, or temp
files. Before commits touching package or tooling files, check `git status
--short` and `git ls-files -ci --exclude-standard`.

---

## 8. Branch, Commit, and PR Policy

One branch, one PR, merged before the next starts. All changes to `main` go
through a PR unless the user directs otherwise.

Branch names: `feature/`, `fix/`, `docs/`, `chore/` plus a short name.

- Sign commits (`git commit -S`).
- Keep commits coherent; do not mix unrelated work.
- PR descriptions are real multi-line Markdown with `## Summary` and `## Tests`.
- No agent or platform branding in commits, PR titles, PR bodies, code, or
  generated artifacts.

---

## 9. Documentation

`docs/wiki/` holds durable HTML reference pages; add one when a subsystem needs
explanation that does not belong in a module README. `docs/plan/` and
`docs/develop-journal/` are gitignored local scratch space — nothing there is
a shared source of truth. PR descriptions carry the record for normal changes.

---

## 10. Final Rule

Design the architecture globally. Implement behavior locally. Let schemas,
modules, and docs grow only when working behavior needs them.
