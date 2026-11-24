/**
 * When the desktop app shows a notification: for a message of hers
 * committed in Messages while the main window does not have the focus,
 * once. What she sends in Telegram is Telegram's to announce, on the
 * person's phone; with the window in front, the message is already there
 * to read. Nothing here touches the DOM: whether the window has the focus
 * comes in, so the rule is tested in Node.
 */
import type {GatewayEvent} from '@project02/wire/contract';
import {messagesApp} from './thread-layout.ts';
import type {DesktopNotification} from './window-calls.ts';

/**
 * The notification a frame of the stream asks for, with the messages
 * notified once it is asked for: a message of hers committed in Messages
 * while the window does not have the focus, which `notified` does not hold
 * yet, titled with her name as the message carries it, its body her words,
 * whole. Anything else asks for none: the person's own line, her writing, a
 * message of hers in another app, one while the window has the focus, and
 * one notified already.
 */
export function notificationFor(
  notified: ReadonlySet<string>,
  event: GatewayEvent,
  focused: boolean,
):
  | {
      readonly notification: DesktopNotification;
      readonly notified: ReadonlySet<string>;
    }
  | undefined {
  if (
    focused ||
    event.kind !== 'turn_progress' ||
    event.progress.kind !== 'visible_reply'
  ) {
    return undefined;
  }

  const {messageId, app, speakerName, text} = event.progress;

  return app === messagesApp && !notified.has(messageId)
    ? {
        notification: {title: speakerName, body: text},
        notified: new Set(notified).add(messageId),
      }
    : undefined;
}
