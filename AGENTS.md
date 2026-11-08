# AGENTS.md

Operating guide for this repository — a **Live Character Framework**: a
character-driven agent runtime with persona continuity, plugins, tools, and
durable local state, its daemon in Rust under `crates/` and its clients in
TypeScript under `packages/`.

Core rule:

```text
The model proposes. The runtime decides and commits.
```

---

## 1. What We Are Building

A personal app in early development. The people who use it are not
engineers: they install it, pick a character, and talk to her. It is not a
platform that must never fail. Build it the way a small team builds a good
app: simple code, a few guarantees kept without exception, and problems
fixed when someone hits them.

**Simplicity is the ultimate sophistication.** Complexity that remains is
thinking that stopped early. Every line of code and documentation should
read as if it had been written correctly the first time.

The character is a person, not a bot under policy. The framework gives her
mechanics — a heartbeat, tools, memory — and never rules on her behavior.
What she does comes from her persona and from what the person tells her.

## 2. How Strict to Be

Be strict in three places, and only these:

1. **The person's data survives.** Conversations, her memories and the
   settings are never lost or corrupted by a crash, an interrupted write or
   a second window. Use the plain tools: append-only logs, whole-file
   atomic writes, one writer per file.
2. **Secrets stay secret.** Keys are never logged, recorded or shown back.
3. **Only the person decides.** Only paired people reach her, and nothing
   acts on the person's machine, accounts, messages or money without their
   say.

Everywhere else, do the simplest thing that works:

- Read stored data forgivingly. Skip or repair what cannot be used, and say
  so, rather than refusing the whole home. Add a field with a default
  rather than a version bump that locks older data out.
- Validate where outside data comes in: the wire, files, model output.
  Inside, trust our own types. Do not add checks that guard our code
  against itself; test the code instead.
- Build for what a person can actually do. A case that takes deliberate
  effort to produce is not a requirement: it gets no handling, tests or
  docs.
- When something a person would notice fails, tell them plainly what broke
  and what to do next.

## 3. Writing Code

1. **No patching.** Trace a break to its cause and fix it there. Do not
   stack special cases or add a flag to route around a problem. Rewriting
   is in scope.
2. **One job, one place.** A rule lives in one place, and every change of a
   kind goes through one path. When you touch an area and find two paths
   doing one job, merge them; a merge that would sprawl is its own PR, right
   after this one.
3. **Code explains itself.** Names carry the _what_; a rare comment carries
   a _why_ the code cannot show. No commented-out code.
4. **No residue.** When something goes, its tests, fixtures and docs go
   with it.
5. **Reuse before building.** Look in this repository, then the standard
   library and existing dependencies, then a maintained package. Name every
   new runtime dependency, and the alternative you rejected, in the PR.
6. **Grow from working behavior.** No speculative frameworks, placeholder
   APIs or fields for a someday caller.
7. **Settings are a last resort.** Each one is a decision handed to someone
   with less context than we have. Add one only for a real user who would
   change it; otherwise pick a good default.

Keep persistence, model calls, side effects, rendering and external tools
behind clear boundaries, and prefer deterministic code wherever model
judgment is not needed. This project has not shipped: keep a shape only
when a person's data or scripts depend on it, not because it was written
first.

## 4. Orientation

Each crate under `crates/` and each package under `packages/` has a
`README.md` saying what it owns. Read it before changing that code, and keep
it short and current. The code and tests are the source of truth for what
exists. When the request, the code and this file disagree, say so rather
than resolving it silently.

## 5. Working Order

1. Know which request the work is for.
2. Fix the cause where it lives.
3. Test what changed.
4. Run the checks.
5. Say what changed, how it was tested, and what is still open.

Do not grow a feature because a larger one feels convenient; park good
ideas in the PR description.

**Plans are short:** what changes for the person, the decisions, the steps.

**Reviews are suggestions,** whether they come from GPT Pro, Codex or
anyone else. Adopt what fixes a problem a person could hit, and decline the
rest in a sentence. Stop a PR's review loop after two rounds unless a real
bug is still open.

## 6. Testing

Test what a person or a calling module would notice if it broke. One
behavior, one test: do not prove again in a unit test what an end-to-end
test already proves, and do not write a case per branch when the branches
are one behavior.

- **Conformance tests** (`tests/conformance`) run the real binary from
  outside, as a client would, for what a person or a client sees.
- **Rust tests** under `crates/` cover logic worth pinning on its own, and
  what no client can bring about from outside.
- **Browser tests** (`tests/browser`) cover the page.

Never call live model providers or external services from tests: use fakes
or the harness's stand-in servers. Keep test temp roots canonical
(`realpath`), since macOS symlinks a temp dir that CI does not.

Coverage thresholds are a floor, not a target. When removing a test drops a
package below its threshold, lower the threshold in the same PR and say
why.

## 7. Model, Data and Security

Model output may propose actions; the runtime decides what is allowed. Raw
model output never directly changes stored state. An action that touches
the person's files, accounts, messages, money or settings goes through the
runtime's checks and, when needed, the person's confirmation.

## 8. Languages and Checks

Node 24.12+, pnpm, TypeScript, ESLint and Vitest for the clients; Rust as
`rust-toolchain.toml` pins it for the daemon.

- TypeScript follows Google style: Prettier plus the gts rules in
  `eslint.config.mjs`. Prefer simple, readable code. No `any`, `as any`,
  `@ts-ignore`, `@ts-expect-error`, broad casts or non-null assertions
  without a stated reason, and no type-level cleverness.
- Rust follows the Rust API Guidelines, validating at the edges as §2 says.
- A client (`packages/page`, `packages/wire/src/client`) imports only the
  wire's contract and the reference client, and cross-package imports name
  the package (`@project02/wire/contract`). `pnpm arch:check` enforces both.
- The `max-lines` overrides in `eslint.config.mjs` may only shrink.

The gates are `pnpm check` for the clients, `pnpm check:rust` for the daemon,
and `pnpm test:conformance` against the binary. CI runs all three.

Do not commit dependency folders, caches, coverage, build output or temp
files. Before a commit that touches package or tooling files, check `git
status --short` and `git ls-files -ci --exclude-standard`.

## 9. Branches, Commits and PRs

One part, one branch, one PR, merged before the next starts unless the
owner stacks them. All changes to `main` go through a PR unless the owner
says otherwise. Branch names: `feature/`, `fix/`, `docs/` or `chore/` plus a
short name.

- Sign commits (`git commit -S`), and keep each commit coherent.
- PR descriptions are Markdown with `## Summary` and `## Tests`.
- No agent or platform branding in commits, PRs, code or generated files.

## 10. Documentation

Document only what is useful, stable and not discoverable from the code.
`docs/wiki/` holds HTML reference pages for subsystems that need more than a
README. `docs/plan/` and `docs/develop-journal/` are gitignored scratch
space. PR descriptions carry the record of normal changes.

A path in `.gitignore` can still be tracked. If you find one, untrack it
(`git rm --cached`) rather than editing it.
