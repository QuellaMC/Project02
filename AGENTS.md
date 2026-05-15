# AGENTS.md

This repository is the local implementation workspace for the Live Character
Framework. Follow these instructions for every future agent run in this repo.

The project should be built gradually. The Notion project hub is the product
north star, but this repository is where implementation specs, tests, runtime
contracts, progress history, and concrete engineering decisions live.

Do not try to implement the whole framework at once. Build one small behavior
slice, test it, log it, review it, then extend the system.

---

## Product Source

- The Notion project hub is the evolving product source:
  `https://www.notion.so/35e8995c0c5e81a8b2bff80957fd22b9`
- Use MCP/Notion tools to read the current source before planning a new feature
  slice or changing architecture.
- Local docs in this repo hold the actual implementation details, decisions,
  specs, tests, and progress history.
- Do not duplicate large Notion pages into the repo. Link to the relevant Notion
  source and quote only the small parts needed for the local implementation
  decision.
- If Notion and local implementation docs disagree:
  - treat Notion as the product direction source
  - treat local specs and tests as the implementation truth for already-built
    behavior
  - record the mismatch in the active slice or development journal before
    changing code

---

## Core Project Direction

The project is the local implementation of the Live Character Framework.

The long-term framework combines:

1. Living Character
   - persistent character reality
   - living state
   - virtual body
   - incidents
   - continuity
   - memory and relationship development

2. Productivity Agent
   - tool use
   - retrieval
   - planning
   - reminders
   - document/task/calendar-style help
   - useful actions while staying in character

The current implementation priority is the runtime foundation, not fine-tuning,
assets, or advanced productivity tools.

The core runtime ownership model is:

- Runtime Kernel:
  event intake, priority, interruption, scheduling, policy, and operation routing

- Character State Engine:
  living state, virtual body, incidents, directives, continuity, retrieval, and
  context building

- Role Model Loop:
  model input rendering, model calls, and structured `CharacterDecision` parsing

- Commit and Effects Engine:
  validation, durable commits, raw logging, tools, messages, Live2D, assets, and
  future events

The foundational rule is:

```text
The model proposes. The runtime commits.
````

---

## Progressive Schema Rule

Do not freeze the full framework schema upfront.

This project will evolve through small implementation slices. New ideas are
expected. Schemas should become more complete only when real implemented
behavior requires them.

For each implementation slice:

* define only the event, state, context, decision, and log fields needed by that
  slice
* include `schema_version` on persisted runtime records
* keep `RawEventLog` append-only
* add fields gradually when behavior requires them
* avoid silently changing the meaning of existing fields
* use adapters, migrations, or explicit compatibility handling for breaking
  changes
* put experimental fields under an explicit `extensions` object when useful
* promote experimental fields into the main schema only after they prove useful
  in implemented behavior

Stable from day one:

* `RuntimeEvent` boundary
* `event_id`
* `trace_id`
* append-only raw logging
* Runtime Kernel as the routing boundary
* Role Model Loop as the only model-call boundary
* Commit and Effects Engine as the only durable commit/effect boundary
* tests for every implemented behavior slice

Flexible and expected to evolve:

* exact `CharacterRuntimeState` fields
* exact `DecisionContext` shape
* exact `CharacterDecision` actions
* incident types
* body needs
* retrieval schema
* tool list
* Live2D vocabulary
* productivity features
* compaction strategy
* replay depth

Do not add a schema field because it might be useful someday. Add it when the
active slice needs it.

---

## Local Documentation Rules

Maintain these documentation roots:

* `docs/wiki/`
* `docs/plan/`
* `docs/develop-journal/`

Write durable local project docs as organized HTML files.

Use local docs for:

* implementation specs
* runtime contracts
* schema evolution notes
* test plans
* engineering decisions
* architecture decisions
* development journals
* future slice ideas
* review notes

Link related local files and relevant Notion source pages.

Use short quotes where helpful, but do not duplicate large Notion pages.

Keep docs precise and reviewable. Do not bloat them with generic explanation.

Development journal entries belong under date folders, for example:

```text
docs/develop-journal/2026-05-14/
```

Recommended local documentation structure:

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

Do not create these files just to satisfy the structure. Create them when they
are needed by an active slice.

---

## Active Slice Rule

There must be only one active implementation slice at a time.

Before writing production code, identify the active slice spec.

Default active slice path:

```text
docs/plan/active-slice.html
```

If there is no active slice spec, create one before implementing code.

The active slice spec must define:

* source context and links
* goal
* current scope
* explicit non-goals
* functional requirements
* non-functional requirements
* minimal schema fields needed
* acceptance criteria
* test plan
* implementation boundaries
* review notes
* open questions
* future ideas discovered during planning

Only implement behavior that belongs to the active slice.

If a useful idea appears during implementation but is outside the current slice,
record it in the future ideas parking lot instead of expanding the current
slice.

Do not widen the active slice because implementation feels convenient.

---

## Future Ideas Parking Lot

Use a future-slices document to preserve ideas without expanding the current
implementation scope.

Recommended path:

```text
docs/plan/future-slices.html
```

When a useful idea appears but is outside the current slice, record:

* idea
* why it may matter
* source or trigger
* dependency, if any
* possible future slice
* risk or unknown
* whether it affects schema evolution

Do not implement future-slice ideas during the current slice.

A good future idea record is short and actionable.

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

## Planning Workflow

Choose only one small part from the Notion roadmap at a time.

Before implementation, write a clean functional spec in `docs/plan/`.

The spec must define:

* source context and links
* goal
* functional requirements
* non-functional requirements
* acceptance criteria
* test plan
* implementation boundaries
* minimal schema fields
* review notes and open questions
* future ideas discovered during planning

Plan for future slices to build on existing code without rewriting or deleting
working code.

Do not implement code until the active slice has a local spec.

Before working on a new functional spec or production code, create a new
short-lived git branch from the current mainline using the branch naming policy
below. Do not create branches with a `codex/` prefix.

When planning, prefer this pattern:

```text
1. Pick one behavior.
2. Define the minimum schema needed for that behavior.
3. Write tests for that behavior.
4. Implement the smallest code that passes.
5. Log the change.
6. Review the result.
7. Commit the completed spec, code, tests, and journal changes.
8. Open a pull request for review.
9. Update the Mermaid implementation graph in `docs/plan/index.html` so it
   reflects the newly created pull request and the current implemented
   architecture.
10. Record future ideas separately.
```

---

## Branch, Commit, and Pull Request Workflow

Every new functional spec or coding pass should happen on its own branch.

Use this sequence:

1. Start from the current mainline and create a new branch that follows the
   branch naming policy before editing the spec or code.
2. Keep commits coherent and small enough to review; include the active spec,
   implementation, tests, journal, and future-slice notes when they changed.
   Prefer separate commits for separable review units, such as spec/docs,
   tests, implementation, and follow-up review fixes. Do not split so finely
   that tests or docs no longer match the code in each commit.
3. Sign every commit using the repository/user configured Git signing setup.
   Use signed commit and rebase flows, such as `git commit -S` or
   `git rebase --gpg-sign`, and make sure the configured signing key is loaded
   before creating, amending, squashing, or rebasing commits.
4. Do not mix unrelated slice work into the branch.
5. After the slice is complete and local checks pass, push the branch and create
   a pull request.
6. The pull request must pass the repository CI/CD workflow before it is ready
   to merge.
7. Treat lint/readability failures as blockers. Fix them on the branch instead
   of bypassing the workflow.

The CI/CD workflow is the pull request quality gate for this repository. It
should run lint/readability checks, source compilation, unit tests, integration
tests, and full test discovery for the currently implemented behavior.

---

## Review Workflow

Do a spec review before writing code.

During pre-code review, check:

* whether the behavior already exists
* whether existing code can be reused
* whether a shared module is justified
* whether the slice is small enough
* whether security and persistence boundaries are explicit
* whether the tests are minimal but sufficient
* whether the slice defines only the schema fields it actually needs
* whether any new idea should be moved to the future-slices document
* whether the implementation can be done without speculative infrastructure

After writing code, review it for:

* unused code
* duplicate logic
* dead abstractions
* flawed boundaries
* security issues
* efficiency issues
* future-maintenance gotchas
* accidental schema overreach
* untested behavior
* code that belongs to a future slice instead of the active slice

If the code introduces a new boundary, schema field, persistence record, or
runtime action, make sure the active slice spec and tests justify it.

---

## TDD Workflow

Use TDD for runtime implementation.

Write the minimal necessary tests for the actual functions needed.

Prefer unit tests for:

* pure validation
* parsing
* routing
* deterministic state behavior
* schema normalization
* ID assignment
* model-output parsing
* commit validation

Use integration tests for behavior across boundaries, such as:

* event intake to raw log append
* Runtime Kernel to Character State Engine
* Role Model Loop to Commit and Effects Engine
* tool request to tool result event
* scheduled directive due event to committed output

Do not call live model providers or external services from tests unless a later
spec explicitly requires it.

Use fakes, mocks, stubs, or test adapters for:

* model providers
* storage
* schedulers
* external tools
* Live2D renderers
* asset services

Run the relevant tests after implementation and record results in the journal.

If a behavior is hard to test, simplify the behavior or split the slice.

---

## Source Layout Rules

Keep `src/` as the source root.

Do not add empty code folders.

Add module folders gradually, only when a reviewed spec and tests require
production code in that area.

Keep the project modular enough for parallel development, but do not create
modules before behavior needs them.

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

Do not create this full layout at once. Create folders only when the active
slice needs production code there.

Keep persistence, model calls, side effects, and logging behind explicit
boundaries.

Do not let feature code directly access databases, external tools, model
providers, renderers, or file systems unless the active spec explicitly defines
that boundary.

---

## Implementation Standards

Write the minimum code that satisfies the active spec and tests.

Maximize security and efficiency without speculative complexity.

Reuse existing logic before adding new code.

Create shared helpers only when there is a real shared boundary or at least one
concrete future caller is clear from the active spec.

Keep persistence, model calls, side effects, and logging behind explicit
boundaries.

Do not rewrite or delete existing working code to make a new slice easier.

Avoid placeholder APIs, empty modules, and speculative framework code.

Every persisted runtime record should include enough information to debug where
it came from.

Prefer explicit data shapes over implicit prompt behavior.

Write code that is future-compatible without implementing future behavior. When
the current slice already has a normalized record or explicit contract field,
derive downstream values from that record instead of duplicating today's literal
constant. Keep validation and dispatch tables limited to implemented behavior,
but shape them so a later reviewed slice can add a new event type, action type,
or route by adding tested cases instead of changing existing contracts.

Routing values such as `model_needed` and `next_step` are event-specific policy,
not universal defaults. Add one event type or one boundary at a time, and require
each added type to define its own tested validation, logging, and routing policy.

Do not confuse future-compatible code with speculative scaffolding. Do not add
placeholder event types, schema fields, modules, interfaces, side effects, or
configuration just to look extensible.

Keep `RuntimeKernel` small. It may coordinate intake, normalization, trace and
event IDs, raw-log append requests, and route selection for implemented event
types. Move character state, model calls, commit validation, tools, Live2D, and
other side-effect boundaries into separate modules only when an active slice
requires them. Keep `RawEventLog` and trace IDs stable while schemas evolve
gradually.

Prefer deterministic runtime behavior where model judgment is not needed.

Do not call the model for:

* tiny deterministic body changes
* trace creation
* ID creation
* simple routing
* simple log appends
* timer bookkeeping
* delivery status
* cleanup jobs

Model calls should happen only when the active slice requires judgment,
language, interpretation, or character meaning.

---

## Do Not Overbuild

Do not add future framework parts before the active slice needs them.

Do not add:

* retrieval modules before a retrieval slice exists
* vector database setup before simple retrieval exists
* model-provider adapters before the model-call slice exists
* incident queues before one active incident works
* virtual body fields before a body slice needs them
* scheduled directive recurrence before one-shot directives work
* Live2D asset code before semantic status exists
* productivity tools before tool-request/result flow exists
* compaction machinery before context pressure exists
* replay tools before raw logs and state snapshots exist
* permission matrices before an actual effect/tool slice needs them
* abstract plugin systems before two concrete implementations exist
* background workers before a real scheduled or async behavior exists

Do not create placeholder interfaces only because the Notion doc mentions a
future module.

It is acceptable to leave a future idea in `docs/plan/future-slices.html`.

It is not acceptable to implement speculative scaffolding with no active tests.

---

## Runtime Boundary Rules

All external or internal triggers should eventually become `RuntimeEvent`s.

At the beginning, only implement the event types needed by the active slice.

The long-term event family may include:

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

Runtime Kernel owns:

* event intake
* event normalization
* event ID assignment
* trace ID assignment
* priority
* interruption handling
* scheduling policy
* permission/policy routing
* deciding whether model judgment is needed
* routing to the next boundary

Runtime Kernel does not own:

* character emotion
* relationship meaning
* durable mutation decisions
* tool implementation
* Live2D rendering
* asset generation
* final commit decisions

Character State Engine owns:

* loading current character state
* deterministic state advancement
* active incident view
* scheduled directive view
* retrieval planning
* compact context building

Character State Engine does not own:

* event priority
* model calls
* durable commits
* visible output delivery
* external side effects

Role Model Loop owns:

* rendering model input
* calling the model
* parsing structured model output
* enforcing the output contract

Role Model Loop does not own:

* storage writes
* tool execution
* final state commits
* final visible delivery
* permission bypass

Commit and Effects Engine owns:

* validating proposed decisions
* committing durable state
* appending raw logs
* writing conversation outputs
* executing tools
* storing tool results
* emitting follow-up RuntimeEvents
* updating Live2D semantic status
* scheduling future events

Commit and Effects Engine is the only boundary that commits durable changes or
emits real side effects.

---

## Logging Rules

Raw logging is part of the runtime foundation.

Do not treat logging as optional for implemented runtime behavior.

The raw event log should be append-only.

Every meaningful runtime action should be traceable by:

* `trace_id`
* `event_id`, when relevant
* `schema_version`
* record kind
* creation timestamp
* source event IDs, when relevant

Log enough to answer:

* what event arrived
* how it was normalized
* what route was chosen
* whether model judgment was needed
* what context was built
* what model input was rendered
* what model output was received
* what decision was parsed
* what was committed or rejected
* what side effects were emitted
* what future events were scheduled
* what errors or fallbacks happened

Do not wait until the debug inspector exists to log runtime facts.

---

## Schema Versioning Rules

Persisted runtime records should include `schema_version`.

Use additive schema changes when possible.

Allowed without migration:

* adding optional fields
* adding new record kinds
* adding new event types behind tests
* adding new action types behind tests

Requires explicit compatibility handling:

* renaming persisted fields
* changing field meaning
* changing required fields
* changing ID semantics
* changing event ordering assumptions
* changing commit behavior
* changing log record interpretation

For early experimental fields, prefer:

```ts
extensions?: Record<string, unknown>
```

Do not let `extensions` become a permanent junk drawer. Promote useful fields
into reviewed schema when real behavior depends on them.

---

## Current Build Direction

Build the runtime foundation before fine-tuning, assets, or advanced
productivity tools.

The first runtime implementation slice should be the smallest part of MVP
Phase 1:

* accept a `USER_MESSAGE`-like `RuntimeEvent`
* assign stable event and trace identifiers
* append a raw event log entry through an interface
* return a deterministic routing result
* avoid model calls

The first slice should not include:

* model provider calls
* character state
* incident system
* virtual body
* scheduled directives
* retrieval
* tools
* Live2D
* assets
* compaction
* replay UI

---

## First Runtime Slice Acceptance Criteria

The first runtime slice is complete only when:

* a `USER_MESSAGE`-like `RuntimeEvent` can be accepted
* missing `event_id` and `trace_id` are assigned
* existing valid `event_id` and `trace_id` are preserved or normalized according
  to the active spec
* the normalized event includes `schema_version`
* one raw event log append is requested through an explicit interface
* the routing result is deterministic
* the route clearly states that no model call is needed for this slice
* no live model provider is called
* no external service is called
* relevant unit tests pass
* relevant integration tests pass
* the development journal records files changed and tests run
* future ideas discovered during implementation are recorded separately instead
  of implemented

A possible first-slice routing result may look like:

```ts
type RuntimeRouteResult = {
  trace_id: string
  event_id: string
  event_type: "USER_MESSAGE"
  model_needed: false
  next_step: "logged_only"
}
```

This shape is only an example. The active slice spec controls the real shape.

---

## Suggested Gradual Build Order

Use this as a guide, not as a frozen contract.

### Step 0 — Runtime Skeleton

Goal:

```text
USER_MESSAGE in
RawEventLog append
deterministic route out
trace_id everywhere
```

No model call. No character state. No incidents.

### Step 1 — Real Model Call

Goal:

```text
Runtime Kernel
Character State Engine builds tiny DecisionContext
Role Model Loop calls model through an interface
Commit and Effects Engine commits visible reply
RawEventLog stores input/output/decision
```

Use a fake model in tests.

### Step 2 — Minimal Living State

Add:

```text
current_activity
mood
toward_user
updated_at
source_event_ids
```

Let the model propose small state patches. Commit and Effects Engine validates
them.

### Step 3 — One Active Incident

Add:

```text
active_incident
start_incident
complete_incident
cancel_incident
```

No incident queue yet.

### Step 4 — User Interruption

Add:

```text
interrupted_incident
resume_incident
go_idle
no_change
```

This is one of the most important live-character behaviors.

### Step 5 — Lazy Virtual Body

Start with only:

```text
hunger
fatigue
social_need
```

Do not add thirst, boredom, stress, comfort, and sleep pressure until a slice
needs them.

### Step 6 — Scheduled Directives

Start with one-shot directives only.

Do not add recurrence until one-shot due events work.

### Step 7 — Simple Retrieval

Start with:

```text
recent visible messages
keyword search
exact source IDs
```

Do not build full vector retrieval immediately.

### Step 8 — One Safe Tool

Start with one safe internal or read-only tool, such as:

```text
ai_buddy.ask
```

Then add tool result events.

### Step 9 — Live2D Semantic Status

Start with semantic labels only:

```text
idle
talking
thinking
sleepy
eating
```

Use a mock renderer or simple UI label first. Do not block runtime work on asset
generation.

### Step 10 — Debug Inspector and Replay

Add debug views after the raw logs and state snapshots exist.

Minimum debug view:

```text
RuntimeEvent
DecisionContext
model input
model raw output
parsed CharacterDecision
commit/reject result
state before/after
RawEventLog entries
```

---

## Journal Requirement

Every non-trivial change should update the date-scoped development journal.

Journal entries should record:

* what changed
* why it changed
* files touched
* tests run
* review notes
* next action
* future ideas discovered
* whether the active slice scope changed
* whether schema fields were added or changed

Development journal entries should be concise but useful.

A good journal entry answers:

```text
What did this slice change?
Why was it needed?
How was it tested?
What should happen next?
```

---

## Security and Permission Rules

Character fiction must not bypass real permissions.

The model may propose actions, but runtime policy decides whether actions are
allowed.

Any action that affects user data, external systems, money, private
information, messages, documents, files, calendars, tasks, or accounts must go
through explicit validation in Commit and Effects Engine.

Do not implement real external side effects without:

* active slice spec
* permission rule
* test coverage
* logging
* failure behavior
* user confirmation policy, when needed

Examples of actions that usually require confirmation:

* sending email
* creating calendar events
* deleting files
* modifying user documents
* posting messages
* sharing private information
* purchasing or spending money
* changing account settings

For early slices, prefer read-only or fake tools.

---

## Model Provider Rules

Do not hard-code a model provider into core runtime logic.

Model calls should go through an explicit interface.

Tests must not call live model providers unless the active spec explicitly says
so.

Role Model Loop should own:

* rendering input
* calling the model adapter
* parsing output
* rejecting malformed output

Commit and Effects Engine should own:

* validating parsed decisions
* committing accepted decisions
* logging rejected decisions
* applying side effects

Do not let raw model output directly mutate state.

---

## Persistence Rules

Do not let runtime modules directly depend on a concrete database unless the
active slice explicitly defines that storage adapter.

Use interfaces for persistence boundaries.

Early slices may use in-memory test stores if the active spec allows it.

Persisted records should be designed for traceability.

Prefer append-only records for logs.

State snapshots may be mutable, but changes should be traceable through raw log
records.

Do not delete raw truth as part of compaction. Compaction changes model-facing
views, not source-of-truth records.

---

## Error and Fallback Rules

Every implemented boundary should define failure behavior.

For each active slice, answer:

* what happens if validation fails?
* what happens if logging fails?
* what happens if parsing fails?
* what happens if model output is malformed?
* what happens if a side effect is rejected?
* what happens if a scheduled event is duplicated?
* what happens if the same event is processed twice?

Early slices may keep error handling simple, but the behavior should be
explicit.

Do not hide errors behind character language.

Runtime errors should be logged.

User-visible errors should be handled by Commit and Effects Engine or a defined
output boundary.

---

## Testing Standards

Each active slice should include tests for:

* success path
* at least one validation failure or malformed input case
* boundary behavior
* logging behavior
* deterministic behavior

Avoid broad snapshot tests unless they are stable and useful.

Prefer small, focused tests.

Do not test future behavior that has not been implemented.

Do not make tests depend on Notion availability, live model providers, external
services, or local machine state.

---

## Completion Criteria for Any Slice

A slice is complete only when:

* the active spec exists
* implementation matches the active spec
* tests pass
* journal is updated
* future ideas are recorded separately
* no speculative modules were added
* no unrelated code was rewritten
* schema changes are documented
* review notes are recorded
* the next action is clear

If a slice reveals that the plan was too large, split the slice and finish the
smallest useful part.

---

# Branch and Merge Policy

The repository uses one protected main branch.

## Branches

- `main` is the only permanent development branch.
- `main` must always be stable.
- Development work happens on short-lived branches.
- Do not use a permanent `develop` branch.

Branch naming:

- `feature/<slice-id>-<short-name>`
- `fix/<short-name>`
- `docs/<short-name>`
- `chore/<short-name>`

Examples:

- `feature/mvp-001-runtime-event-intake`
- `feature/mvp-002-kernel-tests`
- `docs/revise-agents-md`
- `chore/setup-ci`

## Pull Requests

All changes to `main` must go through a pull request.

Each PR should:

- implement one active slice only
- link the active slice spec
- include tests for implemented behavior
- keep the diff small and reviewable
- avoid speculative future modules
- update the development journal for non-trivial changes
- update the Mermaid implementation graph in `docs/plan/index.html` after the
  pull request is created so it reflects the latest implemented architecture
- pass all required CI checks

## Merge Rules

The `main` branch ruleset requires:

- pull request before merge
- at least 1 approving review
- stale approvals dismissed when new commits are pushed
- approval of the most recent reviewable push
- all review conversations resolved
- required CI checks passing
- branch up to date before merge
- linear history
- no force pushes
- no branch deletion

Use squash merge as the default merge method.

## CI/CD

Required checks:

- `ci / lint`
- `ci / typecheck`
- `ci / test`

No PR may merge into `main` unless required checks pass.

## Bypass

No normal developer should bypass branch rules.

Emergency bypass may be reserved for repository admins, but it should be used
only for urgent recovery and documented afterward.

---

## Final Rule

Design the architecture globally.

Implement behavior locally.

Evolve schemas gradually.

Keep logs and boundaries stable.

Do not build the future before the current slice works.
