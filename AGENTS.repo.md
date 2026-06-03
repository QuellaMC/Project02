# AGENTS.repo.md

Repository-specific addendum for the **Live Character Framework**.

Read [`AGENTS.md`](./AGENTS.md) first, then this file. This addendum is a
durable operating contract for rebuilding this repository.

Core repo rule:

```text
The model proposes. The runtime commits.
```

---

## 1. Repository Baseline and Legacy Reference

The repository is being rebuilt from a small TypeScript baseline. Keep the main
line small and runnable.

The old TypeScript implementation is preserved on:

```text
legacy/typescript
```

Use `legacy/typescript` as a reference branch only. It can help answer questions
about previous experiments, tests, contracts, naming, and failure cases. Do not
merge it into the new line, copy large subsystems wholesale, or treat its MVP
docs as the current build plan. Bring old code forward only when a new slice
explicitly needs the behavior and the code still fits the new direction.

Do not store current branch state, current slice status, PR numbers, CI run IDs,
or other frequently updated project status in this file. Put current work in the
active slice document, PR description, issue, or development journal.

---

## 2. Product Direction

Product north star:

```text
https://www.notion.so/35e8995c0c5e81a8b2bff80957fd22b9
```

Before planning a product slice or changing product architecture, read the
current Notion source when the tools are available. If Notion is unavailable,
state that clearly and proceed from the latest local instructions plus the user
request.

The product direction remains a Live Character Framework:

- Living character continuity, state, incidents, memory, relationship, and presence.
- Useful agent behavior: tool use, retrieval, planning, reminders, documents, tasks, calendars, and practical actions while staying in character.

Rebuild priority: grow the core workflow from a tiny working product path, not
by recreating the old framework structure upfront.

---

## 3. OpenClaw-Style Build Strategy

Build this project the way OpenClaw grew:

- Start extremely small.
- Build one working vertical slice first.
- Add features from real pressure.
- Test gradually.
- Refactor only when needed.
- Preserve compatibility when migrating config, storage, names, or user-facing behavior.

For this repository, the first real product direction should look like a small
relay-style vertical slice:

```text
message comes in -> agent or CLI handles it -> reply goes out
```

The first implementation should be boring and runnable. A simple CLI relay is
the preferred starting point. Add webhook/provider support, such as Twilio, only
when the current slice explicitly chooses it. Do not begin with a full runtime
kernel, component registry, memory system, Live2D layer, plugin architecture, or
background scheduler.

Features should arrive from pressure in roughly this order:

1. Basic relay CLI: accept input, run through a minimal agent seam, print/send output.
2. Provider edge when needed: one webhook or transport, such as Twilio, with clear inbound/outbound tests.
3. Operational pressure: better logs, verbose mode, setup errors, timeout handling, and clear failure messages.
4. User-flow pressure: confirmation flags, dry-run mode, safe defaults, and explicit permission checks.
5. Provider pressure: WhatsApp, web, or other transports only after the first provider path works.
6. Migration pressure: config and storage migrations only when real old data or names must keep working.

---

## 4. Slice Scope

The first product slice should be a tiny relay path unless the user chooses a
different vertical slice:

```text
one input -> minimal agent seam -> one reply output
```

Keep each slice minimal:

- One command, endpoint, or entry point.
- One input path.
- One output path.
- One fake or local agent seam by default.
- Focused tests around input parsing, reply production, errors, and boundary behavior.

Do not put current slice status in this file. Current slice details belong in
the active slice document, PR description, issue, or journal.

---

## 5. Documentation

Use the same durable documentation style as the previous repo line: organized
HTML files.

Maintain these roots when durable docs are needed:

```text
docs/wiki/
docs/plan/
docs/develop-journal/
```

Recommended structure, created only when the active slice needs it:

```text
docs/
  wiki/
    architecture.html
    runtime-contracts.html
    schema-evolution.html
  plan/
    active-slice.html
    child-tasks/
    future-slices.html
    completed/
  develop-journal/
    YYYY-MM-DD/
      journal.html
```

Guidelines:

- Keep repo operating instructions in `AGENTS.md` and `AGENTS.repo.md`.
- For parallel Codex thread and agent coordination, follow
  [`docs/wiki/parallel-agent-development-protocol.md`](./docs/wiki/parallel-agent-development-protocol.md).
- Keep one active product slice at `docs/plan/active-slice.html`; subthreads
  may create child task documents under `docs/plan/child-tasks/` only when a
  durable task packet or sub-slice note is needed.
- Use PR descriptions for small review summaries.
- Use `docs/plan/active-slice.html` when a slice needs a durable active spec.
- Use `docs/plan/future-slices.html` when future ideas start accumulating.
- Use date-scoped HTML journal pages for non-trivial implementation history.
- Markdown is allowed for agent-operating protocols and child task packets;
  durable product, plan, wiki, and journal pages should otherwise keep the
  repo's HTML style.
- Do not recreate a broad planning site before the slice needs it.

Every non-trivial change should still answer:

```text
What changed?
Why was it needed?
How was it tested?
What should happen next?
```

Future ideas should be recorded separately from active work. A PR note is enough
for tiny slices; create a durable backlog when ideas start accumulating.

---

## 6. Architecture Rules

Keep architecture pressure-driven.

Allowed early:

- A minimal CLI entry point.
- A small pure core function that turns input into output.
- A fake or local agent adapter for tests.
- One provider adapter only when the slice includes a real provider.
- Simple structured logs once debugging needs them.

Not allowed early:

- Recreating the old `RuntimeComponentRegistry`.
- Building full Runtime Kernel, Character State Engine, Role Model Loop, or Commit and Effects Engine modules before a vertical slice needs them.
- Adding memory, retrieval, tools, scheduler, Live2D, assets, permissions matrix, replay UI, or plugin system upfront.
- Adding empty folders to reserve future architecture.

Long-term boundaries may still use the old vocabulary when useful, but old
vocabulary does not authorize old structure. Let boundaries appear when there is
running behavior and tests that need them.

---

## 7. Compatibility and Migration

Refactor only when the current product path needs it.

When changing config, storage, command names, provider names, or user-facing
contracts:

- Keep old inputs working when users or tests already depend on them.
- Add migration or compatibility adapters before removing old shapes.
- Test both old and new shapes during the migration.
- Remove compatibility only in a later explicit cleanup slice.

Use the OpenClaw-style config migration lesson as the model: old config paths or
names can keep working while new paths are introduced.

---

## 8. TypeScript and CI

This repo uses Node 24, pnpm, TypeScript, ESLint, and Vitest.

Required local checks before done:

```text
pnpm lint
pnpm typecheck
pnpm test
```

`pnpm check` runs all three. For TypeScript-heavy changes, also run:

```text
pnpm exec tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters
```

Do not commit dependency folders, caches, coverage, build output, or temp files.
Before commits that touch package/tooling files, check:

```text
git status --short
git ls-files -ci --exclude-standard
```

---

## 9. Branch, Commit, and PR Policy

Use short-lived branches. Do not use a `codex/` prefix.

Branch names:

```text
feature/<short-name>
fix/<short-name>
docs/<short-name>
chore/<short-name>
```

Commit rules:

- Keep commits coherent and reviewable.
- Sign commits with `git commit -S`.
- Do not mix unrelated slice work.
- Include tests with behavior changes.
- Keep PR descriptions as real multi-line Markdown with `## Summary` and `## Tests`.

All changes to `main` should go through a PR unless the user explicitly directs
a different repository operation.

---

## 10. Final Rule

Build the product from the smallest working message path. Let real usage create
the next requirement. Treat `legacy/typescript` as reference material, not as
the blueprint for the new main line.
