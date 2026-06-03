# Parallel Agent Development Protocol

This protocol defines how multiple Codex threads and agents work on this
repository at the same time without creating competing sources of truth.

The workflow simulates a large development team:

- the user is the product and priority authority;
- the main thread is the team lead and user-facing coordinator;
- subthreads are small teams that own child tasks;
- agents inside subthreads may implement, test, review, audit, or research;
- the main thread coordinates conflicts, reviews subthread PRs, and presents
  integrated progress to the user.

This protocol does not replace `AGENTS.md`, `AGENTS.repo.md`, tests, runtime
policy, or the active slice. It explains how to coordinate parallel work under
those rules.

## One Active Slice

There should be one active product slice.

For this repository, that slice lives at:

```text
docs/plan/active-slice.html
```

The main thread owns that active slice. It updates the active slice after the
user and main thread agree on the intended outcome, scope, non-goals,
acceptance criteria, integration expectations, and test plan.

Subthreads should not create competing active slices. If a subthread needs to
document its own work, it should create a child task document or sub-slice note
that points back to the active slice.

Use child task documents only when a task needs durable coordination beyond the
thread or PR description. Put them under:

```text
docs/plan/child-tasks/
```

A child task document should describe execution scope, not redefine the product
goal. It should include:

- parent active slice link;
- task ID or short name;
- assigned subthread;
- goal;
- current scope;
- explicit non-goals;
- expected files or areas likely to change;
- dependencies;
- acceptance criteria;
- required checks;
- handoff expectations.

## Workflow

1. User and main thread discuss the next intended outcome.
2. Main thread turns the decision into one active product slice.
3. Main thread decomposes the active slice into child task packets.
4. Main thread assigns child task packets to subthreads.
5. Subthreads choose whether to delegate implementation, review, testing, docs
   audit, or research to agents inside the subthread.
6. Subthreads implement their task, run required checks, and assign review
   agents when useful.
7. Subthreads fix all actionable review findings until no further actionable
   problems are raised.
8. Subthreads create or prepare a PR for their completed task.
9. Main thread reviews each PR against the user intent, active slice,
   acceptance criteria, repository policy, tests, and sibling-thread conflicts.
10. Main thread asks the owning subthread to fix PR issues until the PR aligns
    with the intended outcome.
11. Main thread coordinates conflicts across subthreads.
12. After subthreads finish, main thread presents integrated progress to the
    user, including important details, risks, and possible improvements.
13. User decides final improvements and merges PRs when satisfied.

## Task Packets

The main thread should assign work through task packets, not loose prompts.

Each task packet should define:

- task ID or short name;
- parent active slice;
- goal;
- current scope;
- explicit non-goals;
- expected files or areas likely to change;
- files or areas that require extra coordination;
- known dependencies;
- acceptance criteria;
- required checks;
- expected handoff format.

Task packets should be sized so a subthread can complete or reject the task
without needing continuous clarification.

## Choosing Tasks For Subthreads

Prefer tasks with high internal cohesion and low cross-thread coupling.

Good parallel task candidates:

- a single CLI command, endpoint, provider adapter, validation rule, or docs
  page;
- a focused test expansion for an existing behavior;
- a read-only review of one boundary;
- a docs update that has a clear source and audience;
- a bug fix with a reproducible failure and narrow ownership.

Poor parallel task candidates:

- broad architecture rewrites;
- shared schema redesigns;
- package, build, or lint configuration changes used by every thread;
- changes that require multiple subthreads to edit the same contract before the
  contract is agreed;
- tasks whose acceptance criteria are still product questions.

When a shared contract is needed, the main thread should usually assign the
contract task first. Downstream implementation tasks should start after the
contract is stable enough to reference.

## Ownership Boundaries

Each subthread owns the outcome of its task packet, not permanent ownership of a
file.

Subthreads should declare the files or areas they expect to touch before
editing. The purpose is coordination, not file locking. Shared files may be
edited by multiple subthreads when the task requires it.

Examples of shared files that often need coordination:

- active slice documents;
- child task documents;
- repo operating instructions;
- package and tooling configuration;
- shared contracts and exported types;
- central indexes or navigation pages;
- development journals.

Editing a shared file is allowed. The subthread must make the reason clear in
its handoff and identify any possible conflict with sibling work.

## Conflict Handling

Conflicts are normal in parallel development.

If a conflict is mechanical and safely solvable, the subthread that finds it
should solve it. Examples include import ordering, nearby documentation wording,
formatting, or a non-semantic merge conflict where both edits can coexist.

If a conflict is semantic but the correct resolution follows directly from the
task packet, active slice, local docs, tests, or existing repo rules, the
subthread may resolve it and explain the decision in its handoff.

If a conflict changes product behavior, architecture direction, public
contracts, task scope, or the meaning of another subthread's work, the subthread
must escalate it to the main thread.

The main thread should resolve the conflict when the answer follows from the
user request, accepted active slice, local docs, tests, or repository policy.

The main thread should escalate to the user only when the decision requires a
new product call, priority tradeoff, scope change, or architectural direction
that is not already authorized.

## Delegation Inside A Subthread

A subthread may delegate internally when the task benefits from independent
checks.

Useful internal roles:

- implementer: makes the scoped change;
- reviewer: looks for correctness, scope creep, and missing tests;
- tester: runs focused checks and investigates failures;
- doc auditor: verifies that docs match behavior and source-of-truth;
- integration reviewer: checks whether the task collides with sibling work.

The subthread should merge internal feedback into one coherent result before
handoff. The main thread should not have to reconcile contradictory internal
agent messages.

## Review Gate

Before a subthread creates or prepares a PR, it should complete a local review
gate:

- run the task packet's required checks;
- assign review agents when useful;
- fix all actionable implementation, test, docs, and scope findings;
- rerun checks affected by the fixes;
- record any skipped checks and why;
- escalate unresolved semantic issues to the main thread.

"No further problem raised" means no unresolved actionable finding remains
inside the subthread's authority. It does not mean product decisions were made
without the main thread or user.

## PR And Main Thread Review

Each subthread-owned PR should explain:

- intended outcome;
- parent active slice;
- child task packet or child task document;
- files changed;
- checks run and results;
- review agents used and actionable findings fixed;
- conflicts encountered and how they were resolved;
- unresolved risks or questions.

The main thread reviews the PR against:

- the user-approved intended outcome;
- `docs/plan/active-slice.html`;
- the task packet;
- repository policy;
- relevant tests and docs;
- sibling-thread work and merge order.

If the PR does not align, the main thread asks the owning subthread to fix it.
This repeats until the PR is aligned, explicitly blocked, or escalated to the
user for a decision.

## Final User Review

After all assigned subthreads finish, the main thread presents the integrated
product progress to the user.

The progress report should include:

- what changed;
- what now works;
- important implementation or docs details;
- tests and checks run;
- conflicts resolved;
- unresolved risks;
- recommended improvements or follow-up slices.

The user decides whether more improvements are needed. The user remains the
final merge authority.

## Handoff Contract

Every subthread should return a handoff packet with:

- summary of what changed;
- files changed;
- checks run and results;
- accepted assumptions;
- unresolved questions;
- conflicts encountered and how they were resolved;
- follow-up ideas that are outside the current task.

If the task is read-only, the handoff should clearly say that no files changed.

If checks were skipped, the handoff should say why and what remains unverified.

## Integration Rules

The main thread integrates subthread work in dependency order.

Before accepting a subthread handoff, the main thread should verify:

- the work matches the task packet;
- scope did not silently widen;
- shared-file edits are intentional;
- tests or docs evidence match the risk of the change;
- unresolved decisions are either handled or escalated.

The main thread should avoid merging several subthread results at once when
they touch the same behavior. Integrate one coherent result, rerun the relevant
checks, then continue.

## Repository Fit

For this repository:

- keep product work slice-sized;
- keep one active product slice at `docs/plan/active-slice.html`;
- put durable child task documents under `docs/plan/child-tasks/` only when
  needed;
- prefer short-lived branches;
- keep docs-only protocol changes separate from runtime behavior changes;
- avoid putting fast-changing thread state in `AGENTS.repo.md`;
- keep conflict decisions visible in handoffs, PR notes, or journals.

The main rule remains:

```text
The model proposes. The runtime, tests, policy, and repository process commit.
```
