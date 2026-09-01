import {chmodSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {loadProject02Home, type Project02Home} from '../../src/app/index.ts';
import {
  createLocalCharacterRuntime,
  type GatewayEvent,
  type LocalCharacterRuntimeOptions,
} from '../../src/gateway/index.ts';
import {createRuntimePluginHost} from '../../src/plugins/index.ts';
import type {RoleModelAdapter} from '../../src/role-model/index.ts';
import {ensureInitializedProject02Store} from '../../src/runtime/config/index.ts';
import {characterDataDirPath} from '../../src/runtime/storage/index.ts';
import {createSessionEndFileStoreProbePlugin} from '../support/plugin-host-fixtures.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

function replyAdapter(
  options: {
    readonly beforeReply?: () => Promise<void> | void;
    readonly rawOutputText?: string;
  } = {},
): RoleModelAdapter {
  return {
    async invoke() {
      await options.beforeReply?.();

      return {
        rawOutputText:
          options.rawOutputText ??
          JSON.stringify({
            toolCalls: [{name: 'visible_reply', input: {text: 'noted'}}],
          }),
      };
    },
  };
}

async function createConsentedHome(): Promise<{
  readonly homeRoot: string;
  readonly home: Project02Home;
}> {
  const homeRoot = join(createTestTempRoot('project02-gateway-'), 'home');

  await ensureInitializedProject02Store({homeRoot});

  return {
    homeRoot,
    home: loadProject02Home({location: {storeRoot: homeRoot}, env: {}}),
  };
}

async function createStartedRuntime(
  overrides: Partial<LocalCharacterRuntimeOptions> = {},
) {
  const {homeRoot, home} = await createConsentedHome();
  const events: GatewayEvent[] = [];
  const runtime = createLocalCharacterRuntime({
    loadHome: () => home,
    characterId: 'mira',
    pluginHost: createRuntimePluginHost({plugins: []}),
    roleModelAdapter: replyAdapter(),
    ...overrides,
  });

  runtime.events(event => events.push(event));
  await runtime.start();

  return {homeRoot, runtime, events};
}

describe('local character runtime', () => {
  it('boots from real activation, opens the DM once, and turns a delivery into committed messages', async () => {
    const {home} = await createConsentedHome();
    // No injected host: the runtime constructs its configured plugin host
    // from the activation plan, with the broker on the confirmation seam.
    const events: GatewayEvent[] = [];
    const runtime = createLocalCharacterRuntime({
      loadHome: () => home,
      characterId: 'mira',
      roleModelAdapter: replyAdapter(),
    });

    runtime.events(event => events.push(event));
    await runtime.start();
    expect(runtime.health()).toMatchObject({
      characterId: 'mira',
      state: 'ready',
    });

    const ref = await runtime.openDirectConversation();
    const again = await runtime.openDirectConversation();

    expect(again).toEqual(ref);
    expect(ref.characterId).toBe('mira');

    const outcome = await runtime.deliver({
      conversationId: ref.conversationId,
      senderId: ref.userParticipantId,
      text: 'hello there',
    });

    expect(outcome.status).toBe('completed');
    expect(
      outcome.status === 'completed' &&
        outcome.messages.map(message => message.text),
    ).toEqual(['hello there', 'noted']);
    expect(
      outcome.status === 'completed' && outcome.messages.at(-1),
    ).toMatchObject({speakerName: 'Mira'});

    const progress = events.filter(event => event.kind === 'turn_progress');

    expect(progress.at(-1)).toMatchObject({
      characterId: 'mira',
      conversationId: ref.conversationId,
      progress: {kind: 'visible_reply', text: 'noted'},
    });

    await runtime.stop();
    await runtime.stop();
    expect(runtime.health()).toMatchObject({
      state: 'stopped',
      openConversationIds: [],
    });
  });

  it('runs one turn at a time per character, in arrival order', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const adapter = replyAdapter({
      async beforeReply() {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(resolve => setTimeout(resolve, 20));
        inFlight -= 1;
      },
    });
    const {runtime} = await createStartedRuntime({roleModelAdapter: adapter});
    const ref = await runtime.openDirectConversation();
    const message = (text: string) => ({
      conversationId: ref.conversationId,
      senderId: ref.userParticipantId,
      text,
    });

    const outcomes = await Promise.all([
      runtime.deliver(message('first')),
      runtime.deliver(message('second')),
    ]);

    expect(outcomes.map(outcome => outcome.status)).toEqual([
      'completed',
      'completed',
    ]);
    expect(maxInFlight).toBe(1);
    await runtime.stop();
  });

  it('refuses deliveries it never ran, with a structured reason', async () => {
    const {home} = await createConsentedHome();
    const unstarted = createLocalCharacterRuntime({
      loadHome: () => home,
      characterId: 'mira',
      pluginHost: createRuntimePluginHost({plugins: []}),
      roleModelAdapter: replyAdapter(),
    });

    await expect(
      unstarted.deliver({conversationId: 'c', senderId: 'u', text: 'hi'}),
    ).resolves.toMatchObject({
      status: 'refused',
      reason: 'character_unavailable',
    });

    const {runtime} = await createStartedRuntime();
    const ref = await runtime.openDirectConversation();

    await expect(
      runtime.deliver({conversationId: 'no-such', senderId: 'u', text: 'hi'}),
    ).resolves.toMatchObject({
      status: 'refused',
      reason: 'unknown_conversation',
    });
    await expect(
      runtime.deliver({
        conversationId: ref.conversationId,
        senderId: 'mira',
        text: 'hi',
      }),
    ).resolves.toMatchObject({
      status: 'refused',
      reason: 'sender_not_supported',
    });
    await runtime.stop();
  });

  it('stays ready after a rejected turn and completes the next one', async () => {
    const {runtime} = await createStartedRuntime({
      roleModelAdapter: replyAdapter({rawOutputText: 'not json at all'}),
    });
    const ref = await runtime.openDirectConversation();
    const rejected = await runtime.deliver({
      conversationId: ref.conversationId,
      senderId: ref.userParticipantId,
      text: 'hello there',
    });

    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: 'malformed_output',
    });
    expect(runtime.health().state).toBe('ready');
    await runtime.stop();
  });

  it('fails the character on a fatal turn and comes back through reactivate', async () => {
    const {homeRoot, runtime, events} = await createStartedRuntime();
    const ref = await runtime.openDirectConversation();
    const sessionsRoot = join(
      characterDataDirPath(homeRoot, 'mira'),
      'sessions',
    );
    const message = {
      conversationId: ref.conversationId,
      senderId: ref.userParticipantId,
      text: 'hello there',
    };

    chmodSync(sessionsRoot, 0o000);

    try {
      await expect(runtime.deliver(message)).resolves.toMatchObject({
        status: 'failed',
      });
    } finally {
      chmodSync(sessionsRoot, 0o755);
    }

    expect(runtime.health().state).toBe('failed');
    expect(runtime.health().failure).toBeDefined();
    expect(
      events.some(
        event => event.kind === 'state_changed' && event.state === 'failed',
      ),
    ).toBe(true);
    await expect(runtime.deliver(message)).resolves.toMatchObject({
      status: 'refused',
      reason: 'character_unavailable',
    });
    await expect(runtime.openDirectConversation()).rejects.toThrow('failed');

    await runtime.reactivate();
    expect(runtime.health().state).toBe('ready');

    const reopened = await runtime.openDirectConversation();

    expect(reopened.conversationId).toBe(ref.conversationId);
    await expect(runtime.deliver(message)).resolves.toMatchObject({
      status: 'completed',
    });
    await runtime.stop();
  });

  it('turns an invalid provider env into a failed boot before any character state exists', async () => {
    const {homeRoot} = await createConsentedHome();
    const home = loadProject02Home({
      location: {storeRoot: homeRoot},
      env: {PROJECT02_ROLE_MODEL_PROVIDER: 'bogus'},
    });
    const runtime = createLocalCharacterRuntime({
      loadHome: () => home,
      characterId: 'mira',
    });

    await runtime.start();

    expect(runtime.health().state).toBe('failed');
    expect(runtime.health().failure).toContain('"local" or "nvidia"');
    expect(existsSync(characterDataDirPath(homeRoot, 'mira'))).toBe(false);
  });

  it('keeps a stop that overtakes a failing start as the last word', async () => {
    const {homeRoot, home} = await createConsentedHome();
    const runtime = createLocalCharacterRuntime({
      loadHome: () => home,
      characterId: 'mira',
    });
    let stopping: Promise<void> | undefined;

    runtime.events(event => {
      if (event.kind === 'state_changed' && event.state === 'starting') {
        stopping = runtime.stop();
      }
    });

    // A read-only data root fails activation when it materializes the
    // character's data dir — real async fs, landing after the stop settled.
    const dataRoot = dirname(characterDataDirPath(homeRoot, 'mira'));

    chmodSync(dataRoot, 0o555);

    try {
      await runtime.start();
      expect(stopping).toBeDefined();
      await stopping;
    } finally {
      chmodSync(dataRoot, 0o755);
    }

    expect(runtime.health().state).toBe('stopped');
    expect(runtime.health().failure).toBeUndefined();
  });

  it('stop joins the in-flight start before reporting shutdown complete', async () => {
    const {home} = await createConsentedHome();
    const runtime = createLocalCharacterRuntime({
      loadHome: () => home,
      characterId: 'mira',
      roleModelAdapter: replyAdapter(),
    });
    let stopping: Promise<void> | undefined;
    let startSettled = false;

    runtime.events(event => {
      if (event.kind === 'state_changed' && event.state === 'starting') {
        stopping = runtime.stop();
      }
    });

    const start = runtime.start().finally(() => {
      startSettled = true;
    });

    expect(stopping).toBeDefined();
    await stopping;

    expect(startSettled).toBe(true);
    expect(runtime.health().state).toBe('stopped');
    await start;
  });

  it('stop joins an attachment in flight before reporting shutdown complete', async () => {
    const {runtime} = await createStartedRuntime();
    let attachSettled = false;
    const attach = runtime
      .openDirectConversation()
      .catch(() => undefined)
      .finally(() => {
        attachSettled = true;
      });

    await runtime.stop();

    expect(attachSettled).toBe(true);
    expect(runtime.health()).toMatchObject({
      state: 'stopped',
      openConversationIds: [],
    });
    await attach;
  });

  it('stays failed when stop cannot release a conversation, and stops on retry', async () => {
    const {homeRoot, runtime} = await createStartedRuntime();
    const ref = await runtime.openDirectConversation();
    const locksRoot = join(characterDataDirPath(homeRoot, 'mira'), '.locks');

    chmodSync(locksRoot, 0o500);

    try {
      await runtime.stop();
    } finally {
      chmodSync(locksRoot, 0o755);
    }

    expect(runtime.health()).toMatchObject({
      state: 'failed',
      openConversationIds: [ref.conversationId],
    });
    expect(runtime.health().failure).toContain('could not release');

    await runtime.stop();

    expect(runtime.health()).toMatchObject({
      state: 'stopped',
      openConversationIds: [],
    });
  });

  it('holds what recovery could not release and frees it on the retry', async () => {
    const {homeRoot, runtime} = await createStartedRuntime();
    const ref = await runtime.openDirectConversation();
    const dataRoot = characterDataDirPath(homeRoot, 'mira');
    const sessionsRoot = join(dataRoot, 'sessions');
    const locksRoot = join(dataRoot, '.locks');

    chmodSync(sessionsRoot, 0o000);

    try {
      await runtime.deliver({
        conversationId: ref.conversationId,
        senderId: ref.userParticipantId,
        text: 'hello there',
      });
    } finally {
      chmodSync(sessionsRoot, 0o755);
    }

    chmodSync(locksRoot, 0o500);

    try {
      await runtime.reactivate();
    } finally {
      chmodSync(locksRoot, 0o755);
    }

    expect(runtime.health().state).toBe('failed');
    expect(runtime.health().failure).toContain('could not release');
    expect(runtime.health().openConversationIds).toEqual([ref.conversationId]);

    await runtime.reactivate();

    expect(runtime.health().state).toBe('ready');

    const reopened = await runtime.openDirectConversation();

    expect(reopened.conversationId).toBe(ref.conversationId);
    await runtime.stop();
  });

  it('stop waits for the in-flight turn and runs session-end hooks', async () => {
    const endedSessions: string[] = [];
    const probe = createSessionEndFileStoreProbePlugin({
      pluginId: 'session.end.probe',
      requestedAccess: {},
      onSessionEnd(context) {
        endedSessions.push(context.sessionId);
      },
    });
    const {runtime} = await createStartedRuntime({
      pluginHost: createRuntimePluginHost({
        plugins: [probe],
        enabledPluginIds: ['session.end.probe'],
      }),
      roleModelAdapter: replyAdapter({
        beforeReply: () => new Promise(resolve => setTimeout(resolve, 30)),
      }),
    });
    const ref = await runtime.openDirectConversation();
    const inFlight = runtime.deliver({
      conversationId: ref.conversationId,
      senderId: ref.userParticipantId,
      text: 'hello there',
    });

    await runtime.stop();

    await expect(inFlight).resolves.toMatchObject({status: 'completed'});
    expect(endedSessions).toEqual([`${ref.conversationId}.1`]);
    expect(runtime.health().state).toBe('stopped');
  });
});
