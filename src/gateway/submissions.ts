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
   * joins the run in flight, a repeat of a finished one gets its outcome
   * back instead of a second turn, and an id the thread already holds from
   * a run before this one is refused as a duplicate. An id reused for a
   * different line is refused, so no line is ever silently swallowed by an
   * old one.
   */
  submit(
    message: GatewayMessage,
    turn: () => Promise<TurnOutcome>,
  ): Promise<TurnOutcome>;
};

export type SubmissionLedgerOptions = {
  /** Whether the thread already holds this line: a run before this one took it. */
  readonly committed: (message: GatewayMessage) => Promise<boolean>;
};

/** Finished submissions a conversation remembers; older ones are just turns. */
const recentSubmissionsPerConversation = 32;

/**
 * A connection can drop after the daemon accepted a turn and before the
 * caller heard the outcome, and the daemon itself can go down between the
 * two. The submission id is what lets the caller ask again without saying
 * it twice: this run remembers what it ran, and for an id it never saw,
 * the thread says whether a run before it took the line.
 */
export function createSubmissionLedger(
  options: SubmissionLedgerOptions,
): SubmissionLedger {
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
        outcome: options
          .committed(message)
          .then(taken =>
            taken ? alreadyTaken(message.clientMessageId) : turn(),
          )
          .then(outcome => {
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

function alreadyTaken(clientMessageId: string): TurnOutcome {
  return Object.freeze({
    status: 'refused' as const,
    reason: 'duplicate_submission' as const,
    message:
      `clientMessageId "${clientMessageId}" is already on this conversation, ` +
      'taken by an earlier run of the daemon; read the thread for its reply.',
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
