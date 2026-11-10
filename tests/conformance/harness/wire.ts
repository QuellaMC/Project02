import {checkAnswer, type Answer} from './schema.ts';
import type {Address} from './daemon.ts';
import {frameOf, openEvents, type Events, type Frame} from './events.ts';
import {failure, within} from './wait.ts';

type Decision = 'approved' | 'denied';

type OpenOutcome =
  | {
      readonly status: 'opened';
      readonly conversationId: string;
      readonly characterId: string;
    }
  | {readonly status: 'refused' | 'failed'; readonly message: string};

export type Wire = ReturnType<typeof wireOf>;

/** A line as a client sends it. */
export type Line = {
  readonly conversationId: string;
  readonly text: string;
  readonly source: string;
  readonly clientMessageId: string;
};

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
    /** The daemon these verbs reach. */
    address: daemon,
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
    turn: (line: Line) => call('POST', '/api/turns', 'SubmitOutcome', line),
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
      request: {
        readonly subject: {readonly id: string; readonly label: string};
        readonly source: string;
      },
    ) =>
      call(
        'POST',
        `/api/connectors/${segment(connectorId)}/pairing`,
        'PairingRequestOutcome',
        request,
      ),
    connectorBots: (
      connectorId: string,
      table: {readonly bots: readonly object[]},
    ) =>
      call(
        'POST',
        `/api/connectors/${segment(connectorId)}/bots`,
        'ConnectorBotsOutcome',
        table,
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
 * A conversation with the character, once it is ready: a line sent as the
 * page sends it, with all but its text and its client message id filled
 * in, answered as `sender` answers it. The start joins the boot the daemon
 * began itself and answers when it settles.
 */
export async function converse(
  wire: Wire,
  characterId: string,
): Promise<(text: string, clientMessageId: string) => Promise<unknown>> {
  await wire.start(characterId);

  const opened = await conversationOf(wire, characterId);
  const send = await sender(wire);

  return (text, clientMessageId) =>
    send({
      conversationId: opened.conversationId,
      text,
      source: 'web',
      clientMessageId,
    });
}

/**
 * Lines sent as a client sends them, each answered as the stream says its
 * turn ended: its completion, with the messages it committed, the
 * person's line first; a line the daemon refuses at once is answered with
 * its refusal. The stream is opened first, so no turn's end is missed.
 */
export async function sender(
  wire: Wire,
): Promise<(line: Line) => Promise<unknown>> {
  const events = await openEvents(wire.address);

  return async line => {
    const ends = (frames: readonly Frame[]) =>
      frames.filter(
        frameOf('turn_completed', {
          conversationId: line.conversationId,
          clientMessageId: line.clientMessageId,
        }),
      );
    // A line sent again after its turn left it out of the log ends anew.
    const before = ends(events.frames).length;
    const answer = (await wire.turn(line)) as {readonly status: string};

    if (answer.status !== 'queued' && answer.status !== 'already_queued') {
      return answer;
    }

    const ended = await events.holding(
      `the turn of line "${line.clientMessageId}" to end`,
      frames => ends(frames)[before],
    );

    return turnOf(events, ended, line);
  };
}

/** The turn `ended` ended, as the stream told it: its completion, and the messages it committed. */
function turnOf(events: Events, ended: Frame, line: Line): unknown {
  const end = events.frames.indexOf(ended);
  const begun = events.frames.slice(0, end).findLastIndex(
    frameOf('turn_progress', {
      conversationId: line.conversationId,
      progress: {kind: 'user_message', clientMessageId: line.clientMessageId},
    }),
  );
  const messages =
    begun === -1
      ? []
      : events.frames
          .slice(begun, end)
          .filter(
            frameOf('turn_progress', {conversationId: line.conversationId}),
          )
          .map(frame => dataOf(frame)['progress'] as Record<string, unknown>)
          .filter(
            progress =>
              progress['kind'] === 'user_message' ||
              progress['kind'] === 'visible_reply',
          )
          .map(({messageId, speakerId, speakerName, text}) => ({
            messageId,
            speakerId,
            speakerName,
            text,
          }));

  return {...dataOf(ended), messages};
}

function dataOf(frame: Frame): Record<string, unknown> {
  return JSON.parse(frame.data ?? '') as Record<string, unknown>;
}

/** The direct conversation of a running character, as an open answers it. */
export async function conversationOf(
  wire: Wire,
  characterId: string,
): Promise<{readonly conversationId: string}> {
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
