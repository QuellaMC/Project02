# AGENTS.md

Reusable agent operating guide. This file is intentionally project-agnostic.

Repository-specific instructions live in [`AGENTS.repo.md`](./AGENTS.repo.md).
Read this file first, then read the repository addendum before changing this
repo.

Core rule:

```text
The agent proposes. The runtime, tests, policy, and repository process commit.
```

---

## 1. Operating Order

For every meaningful change:

1. Read this file and the repository addendum.
2. Identify the current task, slice, issue, or user request that authorizes the work.
3. Make the smallest useful change that satisfies it.
4. Run the relevant checks.
5. Record what changed, how it was tested, and what should happen next.

Do not widen scope because a larger refactor feels convenient.

---

## 2. Build Style

Build from working vertical slices.

Prefer this order:

1. Start with the smallest end-to-end behavior that can actually run.
2. Add features when real usage or tests expose pressure.
3. Improve logs, errors, configuration, and ergonomics when they become needed.
4. Refactor only when the current structure is blocking real work.
5. Preserve compatibility when migrating names, config, storage, or user-facing contracts.

Avoid speculative frameworks, empty modules, placeholder APIs, and broad rewrites.

---

## 3. Source of Truth

Follow the project-specific addendum for product direction, source links,
repository structure, and local paths.

General precedence:

- Current user request controls the immediate task.
- External product or design sources control product direction when the addendum identifies them.
- Local specs and tests control already-built behavior.
- Source code controls what actually exists.

If sources disagree, call out the mismatch before changing behavior.

Do not duplicate large external documents in the repository. Link to them and
quote only the small parts needed for local decisions.

---

## 4. Scope Discipline

For non-trivial feature work, define the active slice before production code.
The definition can be lightweight, but it should make these points clear:

- Goal.
- Current scope.
- Explicit non-goals.
- Acceptance criteria.
- Test plan.
- Implementation boundaries.
- Future ideas discovered during planning.

Only implement behavior inside the current slice. Park useful outside-scope
ideas in the repository's backlog, future-ideas document, issue, or PR notes.

---

## 5. Parallel and Delegated Work

When work is split across threads or agents, keep one coordinator-facing active
slice. The main thread owns the user conversation, intended outcome, active
slice, task decomposition, final integration review, and user-facing progress
report.

Child threads should receive task packets derived from the active slice. A task
packet should define goal, scope, non-goals, acceptance criteria, likely files,
dependencies, required checks, and handoff expectations. Child threads may keep
local notes or child task documents when the repository addendum allows it, but
they must not create competing active slices or override the parent slice.

Agents inside a child thread may implement, test, review, audit docs, or
research. The child thread remains responsible for merging that work into one
coherent handoff.

Before handoff or PR review, a child thread should run the required checks,
assign review agents when useful, fix all actionable findings, and clearly mark
anything unresolved. The main thread reviews child work against the user intent,
active slice, repository policy, tests, and sibling-thread conflicts.

Resolve mechanical conflicts locally when the safe answer is clear. Escalate
semantic conflicts to the parent thread. Escalate to the user only when the
decision requires a product, priority, scope, or architecture call that is not
already authorized.

---

## 6. Implementation Standards

Write the minimum code that satisfies the current slice and tests.

Rules:

- Follow existing project patterns.
- Reuse existing logic.
- Create shared helpers only for a real shared boundary or a concrete next caller.
- Keep persistence, model calls, side effects, logging, rendering, and external tools behind explicit boundaries.
- Prefer explicit data shapes over implicit prompt behavior.
- Keep identifiers and persisted record meanings stable once they exist.
- Do not add schema fields because they might be useful someday.

Prefer deterministic behavior where model judgment is not needed. Model calls
should happen only when the slice requires judgment, language, interpretation,
or meaning.

---

## 7. Testing

Use TDD for runtime or behavior changes when practical.

Prefer focused unit tests for pure validation, parsing, routing, deterministic
state behavior, schema normalization, ID assignment, model-output parsing, and
commit validation.

Use integration tests for actual boundaries: input to output, provider to core,
model loop to commit, tool request to tool result, or scheduled event to
committed output.

Do not call live model providers or external services from tests unless the
current slice explicitly requires it. Use fakes, mocks, stubs, or test adapters.

---

## 8. Model, Persistence, Security, and Errors

Model output may propose actions, but runtime policy decides what is allowed.
Raw model output must never directly mutate durable state.

Any action affecting user data, external systems, money, private information,
messages, documents, files, calendars, tasks, accounts, or settings must go
through explicit validation and, when needed, user confirmation.

Every implemented boundary should define what happens when validation, logging,
parsing, model output, side-effect validation, deduplication, or duplicate
processing fails. Do not hide runtime errors behind friendly language only.

---

## 9. TypeScript Policy

Default behavior:

- Prefer simple, readable TypeScript over clever type-level programming.
- Do not add `any`, `as any`, `@ts-ignore`, `@ts-expect-error`, broad casts, or non-null assertions unless explicitly justified.
- Do not introduce branded types, complex conditional types, or framework-wide abstractions unless required by the task.
- Do not change public APIs unless the task requires it.

Required checks before done:

- Run the repo's typecheck command.
- Run lint.
- Run relevant tests.
- For behavior changes, add or update tests.

---

## 10. Git Hygiene

Follow the repository-specific branch, PR, merge, and CI policy.

General rules:

- Keep commits coherent and reviewable.
- Do not mix unrelated work.
- Sign commits when the repository requires it.
- Use PR descriptions with real multi-line Markdown.
- Run required checks before considering work done.

---

## 11. Final Rule

Design the architecture globally. Implement behavior locally. Let schemas,
modules, docs, and process grow only when working behavior needs them.
