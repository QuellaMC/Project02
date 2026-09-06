import type {GatewayMessage, TurnOutcome} from './api/contract.ts';

type Submission = {
  /** What the id was first used for; the same id must mean the same line. */
  readonly fingerprint: string;
  readonly outcome: Promise<TurnOutcome>;
  settled: TurnOutcome | undefined;
};

export type SubmissionLedger = {
  /**
   * Runs `turn` once per submission id within a conversation: a repeat
   * joins the run in flight, and a repeat of a finished one gets its
   * outcome back instead of a second turn. An id reused for a different
   * line is refused, so no line is ever silently swallowed by an old one.
   */
  submit(
    message: GatewayMessage,
    turn: () => Promise<TurnOutcome>,
  ): Promise<TurnOutcome>;
};

/** Finished submissions a conversation remembers; older ones are just turns. */
const recentSubmissionsPerConversation = 32;

/**
 * A connection can drop after the daemon accepted a turn and before the
 * caller heard the outcome. The submission id is what lets the caller ask
 * again without saying it twice. This is the memory of one run; a line a
 * run before it took is the turn's own question, asked of the thread.
 */
export function createSubmissionLedger(): SubmissionLedger {
  const conversations = new Map<string, Map<string, Submission>>();

  return Object.freeze({
    submit(message, turn) {
      let submissions = conversations.get(message.conversationId);

      if (submissions === undefined) {
        submissions = new Map();
        conversations.set(message.conversationId, submissions);
      }

      const fingerprint = fingerprintOf(message);
      const known = submissions.get(message.clientMessageId);

      if (known !== undefined) {
        return known.fingerprint === fingerprint
          ? known.outcome
          : Promise.resolve(reusedId(message.clientMessageId));
      }

      const submission: Submission = {
        fingerprint,
        outcome: turn().then(outcome => {
          submission.settled = outcome;
          forget(submissions, recentSubmissionsPerConversation);

          return outcome;
        }),
        settled: undefined,
      };

      submissions.set(message.clientMessageId, submission);

      return submission.outcome;
    },
  });
}

function fingerprintOf(message: GatewayMessage): string {
  return JSON.stringify([message.senderId, message.source, message.text]);
}

function reusedId(clientMessageId: string): TurnOutcome {
  return Object.freeze({
    status: 'refused' as const,
    reason: 'invalid_message' as const,
    message:
      `clientMessageId "${clientMessageId}" was already used for a ` +
      'different message on this conversation; give each message its own.',
  });
}

/** Drops the oldest settled submissions past the bound; in-flight ones stay. */
function forget(submissions: Map<string, Submission>, keep: number): void {
  let settledCount = 0;

  for (const submission of submissions.values()) {
    if (submission.settled !== undefined) {
      settledCount += 1;
    }
  }

  // Insertion order is age: the first keys are the oldest.
  for (const [id, submission] of submissions) {
    if (settledCount <= keep) {
      break;
    }

    if (submission.settled !== undefined) {
      submissions.delete(id);
      settledCount -= 1;
    }
  }
}
