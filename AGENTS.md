# AGENTS.md

Repository operating guide for the **Live Character Framework**. Follow this for every agent run in this repo.

Build gradually: pick one small behavior slice, specify it, test it, implement the smallest passing code, log it, review it, commit it, open a PR, then extend. Do not try to implement the whole framework at once.

Core rule:

```text
The model proposes. The runtime commits.
```

---

## 1. Source of Truth

Product north star:

```text
https://www.notion.so/35e8995c0c5e81a8b2bff80957fd22b9
```

Before planning a feature slice or changing architecture, read the current Notion source through MCP/Notion tools.

Use this repo for implementation specs, tests, runtime contracts, progress history, schema evolution, and concrete engineering decisions. Do not duplicate large Notion pages; link to the source and quote only the small parts needed for local decisions.

If Notion and local docs disagree: Notion controls product direction; local specs/tests control already-built behavior; record the mismatch in the active slice or development journal before changing code.

---

## 2. Project Direction

The framework combines:

- **Living Character:** persistent character reality, living state, virtual body, incidents, continuity, memory, and relationship development.
- **Productivity Agent:** tool use, retrieval, planning, reminders, document/task/calendar-style help, and useful actions while staying in character.

Current priority: **runtime foundation**, not fine-tuning, assets, or advanced productivity tools.

Runtime boundaries:

| Boundary | Owns |
|---|---|
| Runtime Kernel | Event intake, normalization, IDs, priority, interruption, scheduling policy, permission/policy routing, deciding whether model judgment is needed, and routing to the next boundary. |
| Character State Engine | Loading current character state, deterministic state advancement, living state, virtual body, active incident view, scheduled directive view, continuity, retrieval planning, and compact context building. |
| Role Model Loop | Rendering model input, calling the model through an interface, parsing structured `CharacterDecision`, enforcing the output contract, and rejecting malformed output. |
| Commit and Effects Engine | Validating proposed decisions, durable state commits, raw logs, visible conversation outputs, tool execution/results, follow-up `RuntimeEvent`s, Live2D semantic status, assets, future events, rejected-decision logs, and side effects. |

Boundary limits:

- Runtime Kernel does **not** own character emotion, relationship meaning, durable mutation decisions, tools, Live2D rendering, asset generation, or final commits.
- Character State Engine does **not** own event priority, model calls, durable commits, visible output delivery, or external side effects.
- Role Model Loop does **not** own storage writes, tool execution, final state commits, visible delivery, or permission bypass.
- Commit and Effects Engine is the **only** boundary that commits durable changes or emits real side effects.

Keep `RuntimeKernel` small. It may coordinate intake, normalization, trace/event IDs, raw-log append requests, and route selection for implemented event types. Move character state, model calls, commit validation, tools, Live2D, and side-effect boundaries into separate modules only when an active slice requires them.

---

## 3. Local Documentation

Maintain these roots:

```text
docs/wiki/
docs/plan/
docs/develop-journal/
```

Write durable project docs as organized HTML files. Use them for implementation specs, runtime contracts, schema evolution notes, test plans, engineering/architecture decisions, journals, future slice ideas, and review notes. Link related local files and relevant Notion pages. Keep docs precise and reviewable; avoid generic bloat.

Recommended structure, created only when needed by an active slice:

```text
docs/
  wiki/
    architecture.html
    runtime-contracts.html
    schema-evolution.html
  plan/
    active-slice.html
    future-slices.html
    completed/
  develop-journal/
    YYYY-MM-DD/
      journal.html
```

Date-scoped journal example:

```text
docs/develop-journal/2026-05-14/
```

---

## 4. Active Slice Rule

There must be exactly one active implementation slice at a time.

Default active slice path:

```text
docs/plan/active-slice.html
```

Before production code, identify the active slice spec. If it does not exist, create it first. Do not implement code until the active slice has a local spec.

The active slice spec must define: source context and links; goal; current scope; explicit non-goals; functional and non-functional requirements; minimal schema fields; acceptance criteria; test plan; implementation boundaries; review notes; open questions; and future ideas discovered during planning.

Only implement behavior inside the active slice. Do not widen scope because implementation feels convenient. If an idea is useful but outside scope, record it in the future ideas parking lot. If a slice is too large, split it and finish the smallest useful part.

---

## 5. Future Ideas Parking Lot

Use:

```text
docs/plan/future-slices.html
```

For each outside-scope idea, record: idea; why it may matter; source/trigger; dependency; possible future slice; risk/unknown; schema impact; and why not now. Keep entries short and actionable.

Example:

```text
Idea:
Add recurring scheduled directives.

Why:
Users may ask the character to check in every night.

Dependency:
One-shot ScheduledDirective must work first.

Possible future slice:
ScheduledDirective recurrence v0.1.

Do not implement now because:
The active slice only supports one-shot due events.
```

---

## 6. Slice Workflow

Before a new functional spec or production code, create a short-lived branch from current mainline using the branch policy below. Do not use a `codex/` prefix.

Preferred workflow:

1. Pick one small behavior from the Notion roadmap.
2. Create/update the active slice spec in `docs/plan/`.
3. Define only the minimum schema needed.
4. Review the spec before code.
5. Write minimal tests.
6. Implement the smallest passing code.
7. Run relevant checks/tests and record results.
8. Update the development journal.
9. Record future ideas separately.
10. Commit spec, code, tests, journal, and future-slice notes.
11. Open a PR.
12. After PR creation, update the Mermaid implementation graph in `docs/plan/index.html` so it reflects the new PR and current implemented architecture.

Plan future slices to build on existing code without rewriting or deleting working code.

Pre-code review checks: behavior already exists; reusable code; shared module justification; slice size; security and persistence boundaries; minimal but sufficient tests; only needed schema fields; future ideas parked; no speculative infrastructure.

Post-code review checks: unused code; duplicate logic; dead abstractions; flawed boundaries; security/efficiency issues; maintenance gotchas; accidental schema overreach; untested behavior; future-slice code. Any new boundary, schema field, persistence record, or runtime action must be justified by the active spec and tests.

A slice is complete only when: active spec exists; implementation matches it; tests pass; journal is updated; future ideas are recorded separately; no speculative modules or unrelated rewrites were added; schema changes and review notes are documented; and the next action is clear.

---

## 7. Schema Evolution

Do not freeze the full framework schema upfront. Schemas become more complete only when implemented behavior requires them.

For each slice: define only needed event/state/context/decision/log fields; include `schema_version` on persisted runtime records; keep `RawEventLog` append-only; add fields gradually; avoid silently changing field meaning; use adapters, migrations, or explicit compatibility handling for breaking changes; put useful experimental fields under `extensions`; promote them only after implemented behavior proves they are useful.

Stable from day one: `RuntimeEvent` boundary, `event_id`, `trace_id`, append-only raw logging, Runtime Kernel as routing boundary, Role Model Loop as only model-call boundary, Commit and Effects Engine as only durable commit/effect boundary, and tests for every implemented behavior slice.

Flexible and expected to evolve: exact `CharacterRuntimeState` fields, `DecisionContext` shape, `CharacterDecision` actions, incident types, body needs, retrieval schema, tool list, Live2D vocabulary, productivity features, compaction strategy, and replay depth.

Allowed without migration: adding optional fields, record kinds, event types behind tests, and action types behind tests.

Requires explicit compatibility handling: renaming persisted fields; changing field meaning, required fields, ID semantics, event ordering assumptions, commit behavior, or log record interpretation.

Preferred early experimental shape:

```ts
extensions?: Record<string, unknown>
```

Do not let `extensions` become a permanent junk drawer. Do not add a schema field because it might be useful someday; add it when the active slice needs it.

---

## 8. Runtime Events and Logging

All external or internal triggers should eventually become `RuntimeEvent`s. At first, implement only event types required by the active slice.

Long-term event family may include:

```text
USER_MESSAGE
TIMER
NEED_THRESHOLD
INCIDENT_COMPLETION
SCHEDULED_DIRECTIVE_DUE
TOOL_RESULT
ASSET_RESULT
MAINTENANCE
```

Do not implement all of them upfront.

Raw logging is part of the runtime foundation and is not optional. The raw event log must be append-only. Every meaningful runtime action should be traceable by `trace_id`, `event_id` when relevant, `schema_version`, record kind, creation timestamp, and source event IDs when relevant.

Log enough to answer: what event arrived; how it was normalized; what route was chosen; whether model judgment was needed; what context was built; what model input/output appeared; what decision was parsed; what was committed or rejected; what side effects were emitted; what future events were scheduled; and what errors/fallbacks happened.

Do not wait for a debug inspector to log runtime facts.

---

## 9. Implementation Standards

Write the minimum code that satisfies the active spec and tests. Maximize security and efficiency without speculative complexity.

Rules: reuse existing logic; create shared helpers only for a real shared boundary or a concrete future caller clear from the active spec; keep persistence, model calls, side effects, and logging behind explicit boundaries; do not rewrite/delete working code to make a slice easier; avoid placeholder APIs, empty modules, and speculative framework code; make persisted records debuggable; prefer explicit data shapes over implicit prompt behavior; keep `RawEventLog` and trace IDs stable while schemas evolve.

Write future-compatible code without implementing future behavior. If the current slice has a normalized record or explicit contract field, derive downstream values from that record instead of duplicating literal constants. Keep validation and dispatch tables limited to implemented behavior, but shape them so later reviewed slices can add tested event types, action types, or routes without changing existing contracts.

Routing values such as `model_needed` and `next_step` are event-specific policy, not universal defaults. Add one event type or one boundary at a time, and require each added type to define tested validation, logging, and routing policy.

Prefer deterministic runtime behavior where model judgment is not needed. Do not call the model for tiny deterministic body changes, trace creation, ID creation, simple routing, simple log appends, timer bookkeeping, delivery status, or cleanup jobs. Model calls happen only when the active slice requires judgment, language, interpretation, or character meaning.

---

## 10. Do Not Overbuild

Do not add future framework parts before the active slice needs them.

Do not add: retrieval modules before a retrieval slice; vector database setup before simple retrieval; model-provider adapters before the model-call slice; incident queues before one active incident; virtual body fields before a body slice; scheduled directive recurrence before one-shot directives; Live2D asset code before semantic status; productivity tools before tool-request/result flow; compaction machinery before context pressure; replay tools before raw logs and state snapshots; permission matrices before an effect/tool slice; abstract plugin systems before two concrete implementations; or background workers before real scheduled/async behavior.

Do not create placeholder interfaces only because Notion mentions a future module. Future ideas belong in `docs/plan/future-slices.html`. Speculative scaffolding with no active tests is not acceptable.

---

## 11. Source Layout

Keep `src/` as source root. Do not add empty code folders. Add module folders gradually, only when a reviewed spec and tests require production code. Keep the project modular enough for parallel development, but do not create modules before behavior needs them.

Recommended gradual source growth:

```text
src/
  runtime/
    kernel/
    logging/
  character/
    state/
  role-model/
  commit-effects/
```

Do not create the full layout at once. Do not let feature code directly access databases, external tools, model providers, renderers, or file systems unless the active spec explicitly defines that boundary.

---

## 12. Model, Persistence, Security, and Errors

Model provider rules: do not hard-code a model provider into core runtime logic; route model calls through an explicit interface; tests must not call live providers unless the active spec says so; raw model output must never directly mutate state.

Persistence rules: do not let runtime modules directly depend on a concrete database unless the active slice defines that storage adapter; use interfaces for persistence boundaries; early slices may use in-memory test stores if allowed by the active spec; persisted records should be traceable; prefer append-only records for logs; mutable state snapshots must be traceable through raw logs; compaction changes model-facing views, not source-of-truth records, and must not delete raw truth.

Security rules: character fiction must not bypass real permissions. The model may propose actions, but runtime policy decides whether actions are allowed. Any action affecting user data, external systems, money, private information, messages, documents, files, calendars, tasks, or accounts must go through explicit Commit and Effects Engine validation. Do not implement real external side effects without active slice spec, permission rule, test coverage, logging, failure behavior, and user confirmation policy when needed. Early slices should prefer read-only or fake tools.

Actions that usually require confirmation: sending email, creating calendar events, deleting files, modifying user documents, posting messages, sharing private information, purchasing/spending money, and changing account settings.

Error/fallback rules: every implemented boundary should define what happens if validation, logging, parsing, model output, side-effect validation, scheduled-event deduplication, or duplicate event processing fails. Early handling may be simple but must be explicit. Do not hide errors behind character language. Runtime errors should be logged. User-visible errors should be handled by Commit and Effects Engine or a defined output boundary.

---

## 13. Testing Standards

Use TDD for runtime implementation. Write the minimal necessary tests for actual functions.

Prefer unit tests for pure validation, parsing, routing, deterministic state behavior, schema normalization, ID assignment, model-output parsing, and commit validation.

Use integration tests for event intake to raw log append, Runtime Kernel to Character State Engine, Role Model Loop to Commit and Effects Engine, tool request to tool result event, and scheduled directive due event to committed output.

Each active slice should include a success path, at least one validation failure or malformed input case, boundary behavior, logging behavior, and deterministic behavior.

Use fakes, mocks, stubs, or test adapters for model providers, storage, schedulers, external tools, Live2D renderers, and asset services.

Do not call live model providers or external services from tests unless a later spec explicitly requires it. Do not depend on Notion availability, external services, local machine state, or future behavior. Avoid broad snapshot tests unless stable and useful. Prefer small, focused tests. Run relevant tests after implementation and record results in the journal. If behavior is hard to test, simplify it or split the slice.

---

## 14. Development Journal

Every non-trivial change should update the date-scoped journal. Record what changed, why, files touched, tests run, review notes, next action, future ideas discovered, whether active slice scope changed, and whether schema fields were added or changed.

A good entry answers:

```text
What did this slice change?
Why was it needed?
How was it tested?
What should happen next?
```

---

## 15. Current Build Direction and First Slice

Build the runtime foundation before fine-tuning, assets, or advanced productivity tools.

First runtime implementation slice: smallest part of MVP Phase 1 that accepts a `USER_MESSAGE`-like `RuntimeEvent`, assigns stable event and trace identifiers, appends a raw event log entry through an interface, returns deterministic routing, and avoids model calls.

The first slice must not include model provider calls, character state, incident system, virtual body, scheduled directives, retrieval, tools, Live2D, assets, compaction, or replay UI.

Acceptance criteria: accept a `USER_MESSAGE`-like event; assign missing `event_id` and `trace_id`; preserve or normalize existing valid IDs according to the active spec; include `schema_version`; request one raw event log append through an explicit interface; return deterministic routing; clearly state no model call is needed; call no live model provider or external service; pass relevant unit and integration tests; record files changed and tests run in the journal; and record future ideas separately instead of implementing them.

Possible route shape only; active spec controls the real shape:

```ts
type RuntimeRouteResult = {
  trace_id: string
  event_id: string
  event_type: "USER_MESSAGE"
  model_needed: false
  next_step: "logged_only"
}
```

---

## 16. Suggested Gradual Build Order

Use this as a guide, not a frozen contract.

0. **Runtime Skeleton:** `USER_MESSAGE` in; `RawEventLog` append; deterministic route out; `trace_id` everywhere. No model call, character state, or incidents.
1. **Real Model Call:** Runtime Kernel; Character State Engine builds tiny `DecisionContext`; Role Model Loop calls model through an interface; Commit and Effects Engine commits visible reply; `RawEventLog` stores input/output/decision. Use a fake model in tests.
2. **Minimal Living State:** add `current_activity`, `mood`, `toward_user`, `updated_at`, `source_event_ids`; model proposes small state patches; Commit and Effects Engine validates them.
3. **One Active Incident:** add `active_incident`, `start_incident`, `complete_incident`, `cancel_incident`; no incident queue yet.
4. **User Interruption:** add `interrupted_incident`, `resume_incident`, `go_idle`, `no_change`; this is one of the most important live-character behaviors.
5. **Lazy Virtual Body:** start with `hunger`, `fatigue`, `social_need`; do not add thirst, boredom, stress, comfort, or sleep pressure until a slice needs them.
6. **Scheduled Directives:** start with one-shot directives only; do not add recurrence until one-shot due events work.
7. **Simple Retrieval:** start with recent visible messages, keyword search, and exact source IDs; do not build full vector retrieval immediately.
8. **One Safe Tool:** start with one safe internal or read-only tool such as `ai_buddy.ask`, then add tool result events.
9. **Live2D Semantic Status:** start with semantic labels `idle`, `talking`, `thinking`, `sleepy`, `eating`; use a mock renderer or simple UI label first; do not block runtime work on asset generation.
10. **Debug Inspector and Replay:** add debug views after raw logs and state snapshots exist. Minimum view: `RuntimeEvent`, `DecisionContext`, model input, model raw output, parsed `CharacterDecision`, commit/reject result, state before/after, and `RawEventLog` entries.

---

## 17. Branch, PR, Merge, and CI Policy

The repository uses one protected main branch. `main` is the only permanent development branch and must always be stable. Development happens on short-lived branches; do not use a permanent `develop` branch.

Branch names:

```text
feature/<slice-id>-<short-name>
fix/<short-name>
docs/<short-name>
chore/<short-name>
```

Examples:

```text
feature/mvp-001-runtime-event-intake
feature/mvp-002-kernel-tests
docs/revise-agents-md
chore/setup-ci
```

Commit rules: keep commits coherent and reviewable; include active spec, implementation, tests, journal, and future-slice notes when changed; prefer separate commits for separable review units such as spec/docs, tests, implementation, and review fixes; do not split so finely that tests/docs no longer match code; do not mix unrelated slice work.

Sign every commit using the configured Git signing setup. Use signed flows such as `git commit -S` or `git rebase --gpg-sign`, and make sure the signing key is loaded before creating, amending, squashing, or rebasing commits.

All changes to `main` must go through a PR. Each PR should implement one active slice only, link the active slice spec, include tests, keep the diff small/reviewable, avoid speculative future modules, update the journal for non-trivial changes, update the Mermaid implementation graph in `docs/plan/index.html` after PR creation, and pass required CI checks.

The CI/CD workflow is the PR quality gate and should run lint/readability checks, source compilation, unit tests, integration tests, and full test discovery for currently implemented behavior. Treat lint/readability failures as blockers.

Required checks:

```text
ci / lint
ci / typecheck
ci / test
```

Merge rules: PR before merge; at least 1 approving review; stale approvals dismissed on new commits; approval of the most recent reviewable push; all review conversations resolved; required CI passing; branch up to date; linear history; no force pushes; no branch deletion. Use squash merge by default.

No normal developer should bypass branch rules. Emergency bypass may be reserved for repository admins, only for urgent recovery, and must be documented afterward.

---

## 18. Final Rule

Design the architecture globally. Implement behavior locally. Evolve schemas gradually. Keep logs and boundaries stable. Do not build the future before the current slice works.
