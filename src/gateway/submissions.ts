import type {TurnOutcome} from './api/contract.ts';

type ConversationSubmissions = {
  readonly inFlight: Map<string, Promise<TurnOutcome>>;
  readonly recent: Map<string, TurnOutcome>;
};

export type SubmissionLedger = {
  /**
   * Runs `turn` once per submission id within a conversation: a repeat
   * joins the run in flight, and a repeat of a finished one gets its
   * outcome back instead of a second turn.
   */
  submit(
    conversationId: string,
    clientMessageId: string,
    turn: () => Promise<TurnOutcome>,
  ): Promise<TurnOutcome>;
};

/** Finished submissions a conversation remembers; older ones are just turns. */
const recentSubmissionsPerConversation = 32;

/**
 * A connection can drop after the daemon accepted a turn and before the
 * caller heard the outcome. The submission id is what lets the caller ask
 * again without saying it twice.
 */
export function createSubmissionLedger(): SubmissionLedger {
  const conversations = new Map<string, ConversationSubmissions>();

  return Object.freeze({
    submit(conversationId, clientMessageId, turn) {
      let submissions = conversations.get(conversationId);

      if (submissions === undefined) {
        submissions = {inFlight: new Map(), recent: new Map()};
        conversations.set(conversationId, submissions);
      }

      const recent = submissions.recent.get(clientMessageId);

      if (recent !== undefined) {
        return Promise.resolve(recent);
      }

      const inFlight = submissions.inFlight.get(clientMessageId);

      if (inFlight !== undefined) {
        return inFlight;
      }

      const settled = submissions;
      const run = turn()
        .then(outcome => {
          remember(settled.recent, clientMessageId, outcome);

          return outcome;
        })
        .finally(() => {
          settled.inFlight.delete(clientMessageId);
        });

      submissions.inFlight.set(clientMessageId, run);

      return run;
    },
  });
}

function remember(
  recent: Map<string, TurnOutcome>,
  clientMessageId: string,
  outcome: TurnOutcome,
): void {
  recent.set(clientMessageId, outcome);

  // Insertion order is age: the first key is the oldest.
  for (const oldest of recent.keys()) {
    if (recent.size <= recentSubmissionsPerConversation) {
      break;
    }

    recent.delete(oldest);
  }
}
