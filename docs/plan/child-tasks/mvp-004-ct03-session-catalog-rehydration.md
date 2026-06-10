# MVP-004 CT-03 - Session Catalog And Rehydration

Parent active slice: [MVP-004 - Durable Local Runtime Continuity](../completed/mvp-004-durable-local-runtime-continuity.html)

Assigned subthread: `mvp-004-session-catalog-rehydration`

## Goal

Implement local session catalog and rehydration behavior so a chat session can be created, listed,
selected, reopened after process restart, and restored with recent visible conversation context.

## Current Scope

- Implement local session creation using CT-01's session identity and metadata contract.
- Implement session list/read/update metadata behavior.
- Implement loading visible conversation records from the durable log store.
- Rehydrate an existing conversation session with persisted visible messages in order.
- Add the smallest public conversation-core rehydration seam needed to seed a session from persisted visible messages.
- Preserve the conversation core's validation, frozen snapshots, speaker metadata, and recent-visible-context behavior.
- Preserve next visible message ID behavior so resumed turns append after restored messages instead of duplicating old IDs.
- Keep separate sessions isolated so their visible transcripts do not mix.

## Explicit Non-Goals

- Do not add semantic memory, summaries, retrieval, embeddings, relationship state, or long-term personality adaptation.
- Do not add provider accounts, auth, users, multi-character support, cloud sync, or cross-device identity.
- Do not implement chat CLI UX except through APIs CT-04 can consume.
- Do not mutate old logs during rehydration.
- Do not restore the old Character State Engine from `legacy/typescript`.

## Expected Files Or Areas

- `src/session-store.ts`
- `tests/session-store.test.ts`
- `src/index.ts`
- `src/conversation.ts` only for the minimal public rehydration seam.
- `tests/conversation.test.ts` only for focused rehydration-seam regressions.

## Dependencies

- Depends on CT-01's storage contract.
- Depends on CT-02's durable conversation log read API for final integration.
- Can begin with CT-01 contract fixtures if CT-02 is not merged, but the handoff must flag those assumptions and must not create alternate production log readers.

## Coordination Notes

- This task is the bridge between durable truth and the existing conversation core.
- Rehydration must not fabricate messages that were never committed as visible conversation records.
- Session metadata updates should be narrow: enough for create/list/resume, not a general database layer.
- Conversation-core changes should be limited to a seed/rehydrate API and validation needed to protect transcript ownership.

## Acceptance Criteria

- Tests prove a session can be created, listed, reopened, and selected by ID.
- Tests prove persisted visible messages rehydrate into a conversation session in order.
- Tests prove a resumed second turn can see prior visible context from before process restart.
- Tests prove resumed turns allocate the next visible message IDs after restored records and do not duplicate old message IDs.
- Tests prove separate sessions do not share visible transcript context.
- Tests prove malformed persisted visible messages fail loudly and do not create a partially rehydrated fake session.

## Required Checks

- Focused session catalog and rehydration tests.
- Relevant durable log-store and conversation tests.
- `pnpm check`
- `pnpm exec tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters`
- `git diff --check`

## Handoff Expectations

Return a handoff with:

- summary of session catalog and rehydration behavior;
- exact files changed;
- checks run and results;
- exported functions, types, and error names;
- accepted assumptions;
- unresolved questions or conflicts;
- API details CT-04 and CT-05 must follow.
