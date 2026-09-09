import type {RoleModelReplyDelta} from '../api/adapter.ts';

export type RoleModelReplyDeltaEvent = {
  readonly draftId: string;
  readonly text: string;
};

export type RoleModelReplyWithdrawnEvent = {
  readonly draftId: string;
};

export type ReplyDrafts = {
  /** Forwards a piece of a draft, opening the draft on its first piece. Silent once closed. */
  readonly speak: (delta: RoleModelReplyDelta) => void;
  /** The id this round's reply at that index carries, spoken or not. */
  readonly draftId: (reply: number) => string;
  /** Marks a draft as replaced by its commit. */
  readonly settle: (reply: number) => void;
  /** Withdraws every draft opened and not settled, in the order opened; idempotent. */
  readonly close: () => void;
};

/**
 * The drafts one model round speaks, and their endings. A draft opens with
 * its first delta and ends exactly once: the commit that names its id
 * settles it, and close() withdraws whatever the round opened and did not
 * commit — a note the model wrote beside a tool call, a refused round's
 * text, a reply whose commit failed.
 */
export function createReplyDrafts(options: {
  readonly round: number;
  readonly onReplyDelta?: (event: RoleModelReplyDeltaEvent) => void;
  readonly onReplyWithdrawn?: (event: RoleModelReplyWithdrawnEvent) => void;
}): ReplyDrafts {
  const opened: number[] = [];
  const settled = new Set<number>();
  let closed = false;
  const draftId = (reply: number): string =>
    `${String(options.round)}.${String(reply)}`;

  return Object.freeze({
    speak(delta) {
      if (
        closed ||
        !Number.isSafeInteger(delta.reply) ||
        delta.reply < 0 ||
        delta.text.length === 0
      ) {
        return;
      }

      if (!opened.includes(delta.reply)) {
        opened.push(delta.reply);
      }

      options.onReplyDelta?.({draftId: draftId(delta.reply), text: delta.text});
    },
    draftId,
    settle(reply) {
      settled.add(reply);
    },
    close() {
      if (closed) {
        return;
      }

      closed = true;

      for (const reply of opened) {
        if (!settled.has(reply)) {
          options.onReplyWithdrawn?.({draftId: draftId(reply)});
        }
      }
    },
  });
}
