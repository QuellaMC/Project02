import type {Address} from './daemon.ts';
import {failure, within} from './wait.ts';

type Decision = 'approved' | 'denied';

type OpenOutcome =
  | {
      readonly status: 'opened';
      readonly conversationId: string;
      readonly characterId: string;
      readonly userParticipantId: string;
    }
  | {readonly status: 'refused' | 'failed'; readonly message: string};

export type Wire = ReturnType<typeof wireOf>;

/**
 * The verbs of docs/wiki/gateway-api.html, one method each, answering the
 * outcome as the daemon sent it. A status other than 200 is a failure that
 * names it: a domain outcome always comes with a 200.
 */
export function wireOf(daemon: Address) {
  const call = (method: 'GET' | 'POST', path: string, body?: unknown) =>
    within(
      `${method} ${path}`,
      (async (): Promise<unknown> => {
        const response = await fetch(new URL(path, daemon.origin), {
          method,
          headers: {
            authorization: `Bearer ${daemon.token}`,
            ...(body === undefined ? {} : {'content-type': 'application/json'}),
          },
          ...(body === undefined ? {} : {body: JSON.stringify(body)}),
        });
        const text = await response.text();

        if (response.status !== 200) {
          throw failure(
            `${method} ${path} answered ${String(response.status)}: ${text}`,
          );
        }

        return JSON.parse(text) as unknown;
      })(),
    );
  const segment = encodeURIComponent;

  return {
    health: () => call('GET', '/api/health'),
    start: (characterId: string) =>
      call('POST', `/api/characters/${segment(characterId)}/start`),
    open: async (characterId: string) =>
      (await call('POST', '/api/conversations/open', {
        characterId,
      })) as OpenOutcome,
    turn: (message: {
      readonly conversationId: string;
      readonly senderId: string;
      readonly text: string;
      readonly source: string;
      readonly clientMessageId: string;
    }) => call('POST', '/api/turns', message),
    history: (
      conversationId: string,
      page: {readonly before?: string; readonly limit?: number} = {},
    ) =>
      call(
        'GET',
        `/api/conversations/${segment(conversationId)}/messages${query(page)}`,
      ),
    pending: () => call('GET', '/api/confirmations'),
    answer: (confirmationId: string, decision: Decision) =>
      call('POST', `/api/confirmations/${segment(confirmationId)}`, {decision}),
    configView: (
      target:
        | {readonly scope: 'global'}
        | {readonly scope: 'character'; readonly characterId: string},
    ) => call('GET', `/api/config${query(target)}`),
    configChange: (change: object) => call('POST', '/api/config', change),
    connectorConfig: (connectorId: string) =>
      call('GET', `/api/connectors/${segment(connectorId)}/config`),
    pairingRequest: (
      connectorId: string,
      subject: {readonly id: string; readonly label: string},
    ) =>
      call('POST', `/api/connectors/${segment(connectorId)}/pairing`, {
        subject,
      }),
    pendingPairings: () => call('GET', '/api/pairing'),
    pairingAnswer: (code: string, decision: Decision) =>
      call('POST', `/api/pairing/${segment(code)}`, {decision}),
  };
}

function query(fields: Readonly<Record<string, string | number>>): string {
  const search = new URLSearchParams(
    Object.fromEntries(
      Object.entries(fields).map(([name, value]) => [name, String(value)]),
    ),
  ).toString();

  return search === '' ? '' : `?${search}`;
}

/**
 * A conversation with the character, once it is ready: the turn verb with
 * all but the line and its client message id filled in. The start joins
 * the boot the daemon began itself and answers when it settles.
 */
export async function converse(
  wire: Wire,
  characterId: string,
): Promise<(text: string, clientMessageId: string) => Promise<unknown>> {
  const started = await wire.start(characterId);
  const opened = await wire.open(characterId);

  if (opened.status !== 'opened') {
    throw failure(
      `${characterId} has no conversation: the start answered ${JSON.stringify(
        started,
      )}, the open ${JSON.stringify(opened)}.`,
    );
  }

  return (text, clientMessageId) =>
    wire.turn({
      conversationId: opened.conversationId,
      senderId: opened.userParticipantId,
      text,
      source: 'web',
      clientMessageId,
    });
}
