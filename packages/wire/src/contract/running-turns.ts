import type {
  GatewayEvent,
  RunningDraft,
  RunningTurn,
} from './generated/contract.ts';

/** Conversation id → the turn running there; a conversation runs one turn at a time. */
export type RunningTurns = ReadonlyMap<string, RunningTurn>;

/**
 * The one definition of a running turn, folded from the stream: it begins
 * at the `user_message` frame that names its submission, each
 * `reply_delta` extends a draft, a draft ends at its commit or withdrawal,
 * and the turn ends at the `turn_completed` that names the same
 * submission — never at another's, since the gateway completes a
 * submission it refused on the spot while the turn ahead of it still
 * runs. The daemon folds every event for the `ready` snapshot; a surface
 * folds the frames it receives, and installs the snapshot. A change
 * returns a new map; no change returns the one given.
 */
export function foldRunningTurns(
  turns: RunningTurns,
  event: GatewayEvent,
): RunningTurns {
  if (event.kind !== 'turn_progress' && event.kind !== 'turn_completed') {
    return turns;
  }

  const turn = turns.get(event.conversationId);
  const next =
    event.kind === 'turn_progress'
      ? progressed(turn, event)
      : completed(turn, event);

  if (next === turn) {
    return turns;
  }

  const folded = new Map(turns);

  if (next === undefined) {
    folded.delete(event.conversationId);
  } else {
    folded.set(event.conversationId, next);
  }

  return folded;
}

function progressed(
  turn: RunningTurn | undefined,
  event: Extract<GatewayEvent, {kind: 'turn_progress'}>,
): RunningTurn | undefined {
  const {progress} = event;

  switch (progress.kind) {
    case 'user_message':
      return {
        characterId: event.characterId,
        conversationId: event.conversationId,
        source: progress.source,
        clientMessageId: progress.clientMessageId,
        drafts: [],
      };
    case 'reply_delta':
      return turn === undefined
        ? turn
        : {...turn, drafts: extended(turn.drafts, progress)};
    case 'visible_reply':
    case 'reply_withdrawn':
      return turn === undefined ||
        !turn.drafts.some(draft => draft.draftId === progress.draftId)
        ? turn
        : {
            ...turn,
            drafts: turn.drafts.filter(
              draft => draft.draftId !== progress.draftId,
            ),
          };
    case 'tool_calls_requested':
    case 'tool_call_completed':
      return turn;
  }
}

function extended(
  drafts: readonly RunningDraft[],
  delta: {readonly draftId: string; readonly text: string},
): readonly RunningDraft[] {
  return drafts.some(draft => draft.draftId === delta.draftId)
    ? drafts.map(draft =>
        draft.draftId === delta.draftId
          ? {draftId: draft.draftId, text: draft.text + delta.text}
          : draft,
      )
    : [...drafts, {draftId: delta.draftId, text: delta.text}];
}

function completed(
  turn: RunningTurn | undefined,
  event: Extract<GatewayEvent, {kind: 'turn_completed'}>,
): RunningTurn | undefined {
  return turn !== undefined &&
    turn.clientMessageId === event.clientMessageId &&
    turn.source === event.source
    ? undefined
    : turn;
}
