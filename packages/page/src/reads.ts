/**
 * When the person has read a message of hers: once the chat of its
 * conversation shows it in the main window while that window has the
 * focus and the chat's end, where her newest message stands, is in view —
 * as it arrives there, when the person opens that chat, when the window
 * comes to the front with it open, or when they scroll back down to it.
 * The daemon is told of the newest message of hers the chat shows, once
 * it has taken it: as hers come it moves on, never back, so none older
 * than a message told is told. Her phone's window never counts, since it
 * is her phone: its session asks nothing of this rule. Nothing here
 * touches the DOM: whether the window has the focus and whether the
 * chat's end is in view come in, so the rule is tested in Node.
 */
import type {WebState} from './store.ts';

/** A message of hers the person read: its conversation, and its id. */
export type Read = {
  readonly conversationId: string;
  readonly messageId: string;
};

/** What the window says of itself: whether it has the focus, and whether the chat's end is in view. */
export type Seen = {
  readonly focused: boolean;
  readonly endInView: boolean;
};

/**
 * The message of hers the person has read that the daemon is to be told
 * of, with what is told once it is, `told` naming the message told last in
 * each conversation: the newest message of hers the chat on screen shows,
 * while the window has the focus, the chat's end is in view and the stream
 * is live, unless it was told already. None while the settings or the
 * welcome stand in front of the chat.
 */
export function readOf(
  told: ReadonlyMap<string, string>,
  state: WebState,
  {focused, endInView}: Seen,
):
  | {readonly read: Read; readonly told: ReadonlyMap<string, string>}
  | undefined {
  const {thread} = state;

  if (
    !focused ||
    !endInView ||
    state.settings !== undefined ||
    state.connection.status !== 'live' ||
    thread === undefined
  ) {
    return undefined;
  }

  const {conversationId} = thread;
  const hers = [...(thread.stale ?? []), ...thread.messages].findLast(
    message => message.role === 'character',
  );

  if (hers === undefined || told.get(conversationId) === hers.messageId) {
    return undefined;
  }

  return {
    read: {conversationId, messageId: hers.messageId},
    told: new Map(told).set(conversationId, hers.messageId),
  };
}
