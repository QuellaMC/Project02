import {checkAnswer, type Answer} from './schema.ts';
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
 * outcome as the daemon sent it, held to the contract's definition of it.
 * A status other than 200 is a failure that names it: a domain outcome
 * always comes with a 200.
 */
export function wireOf(daemon: Address) {
  const call = (
    method: 'GET' | 'POST',
    path: string,
    answer: Answer,
    body?: unknown,
  ) =>
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

        checkAnswer(`${method} ${path}`, answer, response.status, text);

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
    health: () => call('GET', '/api/health', 'GatewayHealth'),
    start: (characterId: string) =>
      call(
        'POST',
        `/api/characters/${segment(characterId)}/start`,
        'StartOutcome',
      ),
    open: async (characterId: string) =>
      (await call('POST', '/api/conversations/open', 'OpenOutcome', {
        characterId,
      })) as OpenOutcome,
    turn: (message: {
      readonly conversationId: string;
      readonly senderId: string;
      readonly text: string;
      readonly source: string;
      readonly clientMessageId: string;
    }) => call('POST', '/api/turns', 'TurnOutcome', message),
    history: (
      conversationId: string,
      page: {readonly before?: string; readonly limit?: number} = {},
    ) =>
      call(
        'GET',
        `/api/conversations/${segment(conversationId)}/messages${query(page)}`,
        'HistoryOutcome',
      ),
    pending: () =>
      call('GET', '/api/confirmations', {listOf: 'PendingConfirmation'}),
    answer: (confirmationId: string, decision: Decision) =>
      call(
        'POST',
        `/api/confirmations/${segment(confirmationId)}`,
        'AnswerOutcome',
        {decision},
      ),
    configView: (
      target:
        | {readonly scope: 'global'}
        | {readonly scope: 'character'; readonly characterId: string},
    ) => call('GET', `/api/config${query(target)}`, 'ConfigView'),
    configChange: (change: object) =>
      call('POST', '/api/config', 'ConfigChangeOutcome', change),
    connectorConfig: (connectorId: string) =>
      call(
        'GET',
        `/api/connectors/${segment(connectorId)}/config`,
        'ConnectorConfigView',
      ),
    pairingRequest: (
      connectorId: string,
      subject: {readonly id: string; readonly label: string},
    ) =>
      call(
        'POST',
        `/api/connectors/${segment(connectorId)}/pairing`,
        'PairingRequestOutcome',
        {subject},
      ),
    pendingPairings: () =>
      call('GET', '/api/pairing', {listOf: 'PairingRequest'}),
    pairingAnswer: (code: string, decision: Decision) =>
      call('POST', `/api/pairing/${segment(code)}`, 'PairingSettleOutcome', {
        decision,
      }),
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
  await wire.start(characterId);

  const opened = await conversationOf(wire, characterId);

  return (text, clientMessageId) =>
    wire.turn({
      conversationId: opened.conversationId,
      senderId: opened.userParticipantId,
      text,
      source: 'web',
      clientMessageId,
    });
}

/** The direct conversation of a running character, as an open answers it. */
export async function conversationOf(
  wire: Wire,
  characterId: string,
): Promise<{
  readonly conversationId: string;
  readonly userParticipantId: string;
}> {
  const opened = await wire.open(characterId);

  if (opened.status !== 'opened') {
    throw failure(
      `${characterId} has no conversation: the open answered ${JSON.stringify(opened)}.`,
    );
  }

  return opened;
}

/**
 * One change sent as a settings page sends it: against the fingerprint the
 * target's view hands out now. Answers the outcome as the daemon sent it.
 */
export async function changeConfig(
  wire: Wire,
  target: Parameters<Wire['configView']>[0],
  operation: object,
): Promise<unknown> {
  const view = (await wire.configView(target)) as {
    readonly fingerprint?: string;
  };

  return wire.configChange({
    target,
    expectedFingerprint: view.fingerprint,
    operation,
  });
}

/** One change as a page sends it; a change not applied is a failure that names the outcome. */
export async function saveConfig(
  wire: Wire,
  target: Parameters<Wire['configView']>[0],
  operation: object,
): Promise<void> {
  const outcome = await changeConfig(wire, target, operation);

  if ((outcome as {readonly status?: string}).status !== 'applied') {
    throw failure(
      `The change ${JSON.stringify(operation)} answered ${JSON.stringify(outcome)}.`,
    );
  }
}
