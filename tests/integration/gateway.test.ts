import {chmodSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it, vi} from 'vitest';

import {createGateway, type GatewayEvent} from '../../src/gateway/index.ts';
import {createRuntimePluginHost} from '../../src/plugins/index.ts';
import type {RoleModelAdapter} from '../../src/role-model/index.ts';
import {ensureInitializedProject02Store} from '../../src/runtime/config/index.ts';
import {characterDataDirPath} from '../../src/runtime/storage/index.ts';
import {
  writeTestCharacterPackage,
  testCharacterProfile,
} from '../support/character-fixtures.ts';
import {writeRuntimeConfig} from '../support/runtime-config.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

function replyAdapter(
  options: {readonly beforeReply?: () => Promise<void> | void} = {},
): RoleModelAdapter & {readonly maxInFlight: () => number} {
  let inFlight = 0;
  let maxInFlight = 0;

  return {
    async invoke() {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await options.beforeReply?.();
      inFlight -= 1;

      return {
        rawOutputText: JSON.stringify({
          toolCalls: [{name: 'visible_reply', input: {text: 'noted'}}],
        }),
      };
    },
    maxInFlight: () => maxInFlight,
  };
}

async function createGatewayHome(): Promise<string> {
  const homeRoot = join(
    createTestTempRoot('project02-gateway-facade-'),
    'home',
  );

  await ensureInitializedProject02Store({homeRoot});

  return homeRoot;
}

describe('gateway façade', () => {
  it('routes each conversation to its character and interleaves their turns', async () => {
    const homeRoot = await createGatewayHome();

    writeTestCharacterPackage(homeRoot, {id: 'zeta', displayName: 'Zeta'});

    const adapter = replyAdapter({
      beforeReply: () => new Promise(resolve => setTimeout(resolve, 30)),
    });
    const gateway = createGateway({
      location: {storeRoot: homeRoot},
      env: {},
      roleModelAdapter: adapter,
      createPluginHost: () => createRuntimePluginHost({plugins: []}),
    });

    await gateway.startCharacter('mira');
    await gateway.startCharacter('zeta');

    const mira = await gateway.openDirectConversation('mira');
    const zeta = await gateway.openDirectConversation('zeta');

    expect(mira.conversationId).not.toBe(zeta.conversationId);

    const [fromMira, fromZeta] = await Promise.all([
      gateway.deliver({
        conversationId: mira.conversationId,
        senderId: mira.userParticipantId,
        text: 'hello mira',
      }),
      gateway.deliver({
        conversationId: zeta.conversationId,
        senderId: zeta.userParticipantId,
        text: 'hello zeta',
      }),
    ]);

    expect(
      fromMira.status === 'completed' && fromMira.messages.at(-1)?.speakerName,
    ).toBe(testCharacterProfile.displayName);
    expect(
      fromZeta.status === 'completed' && fromZeta.messages.at(-1)?.speakerName,
    ).toBe('Zeta');
    // The awaits overlap across characters; only within one character is a
    // turn exclusive.
    expect(adapter.maxInFlight()).toBe(2);

    await gateway.stop();
    expect(gateway.characters().map(character => character.state)).toEqual([
      'stopped',
      'stopped',
    ]);
  });

  it('reports installed characters with enabled and lifecycle state', async () => {
    const homeRoot = await createGatewayHome();
    const gateway = createGateway({
      location: {storeRoot: homeRoot},
      env: {},
      roleModelAdapter: replyAdapter(),
      createPluginHost: () => createRuntimePluginHost({plugins: []}),
    });

    expect(gateway.characters()).toEqual([
      {id: 'mira', enabled: true, state: 'not_started'},
    ]);

    await gateway.startCharacter('mira');

    expect(gateway.characters()).toEqual([
      {id: 'mira', enabled: true, state: 'ready'},
    ]);
    await gateway.stop();
  });

  it('refuses a disabled character at the one assembly seam', async () => {
    const homeRoot = await createGatewayHome();

    writeRuntimeConfig(join(homeRoot, 'config.json'), {
      project02: {enabled: false},
    });

    const gateway = createGateway({location: {storeRoot: homeRoot}, env: {}});

    await gateway.startCharacter('mira');

    const summary = gateway.characters()[0];

    expect(summary).toMatchObject({enabled: false, state: 'failed'});
    expect(summary?.diagnostic).toContain('disabled');
  });

  it('refuses an unknown character before creating a runtime', async () => {
    const homeRoot = await createGatewayHome();
    const gateway = createGateway({location: {storeRoot: homeRoot}, env: {}});

    await expect(gateway.startCharacter('ghost')).rejects.toThrow(
      'not installed',
    );
  });

  it('declines automatic recovery for a character disabled while running', async () => {
    const homeRoot = await createGatewayHome();
    const gateway = createGateway({
      location: {storeRoot: homeRoot},
      env: {},
      roleModelAdapter: replyAdapter(),
      createPluginHost: () => createRuntimePluginHost({plugins: []}),
    });

    await gateway.startCharacter('mira');

    const ref = await gateway.openDirectConversation('mira');

    writeRuntimeConfig(
      join(characterDataDirPath(homeRoot, 'mira'), 'config.json'),
      {project02: {enabled: false}},
    );

    const sessionsRoot = join(
      characterDataDirPath(homeRoot, 'mira'),
      'sessions',
    );

    chmodSync(sessionsRoot, 0o000);

    try {
      await gateway.deliver({
        conversationId: ref.conversationId,
        senderId: ref.userParticipantId,
        text: 'hello there',
      });
    } finally {
      chmodSync(sessionsRoot, 0o755);
    }

    await vi.waitFor(() => {
      const summary = gateway.characters()[0];

      expect(summary?.state).toBe('failed');
      expect(summary?.diagnostic).toContain('disabled');
    });
    await gateway.stop();
  });

  it('refuses a conversation it never attached', async () => {
    const homeRoot = await createGatewayHome();
    const gateway = createGateway({location: {storeRoot: homeRoot}, env: {}});

    await expect(
      gateway.deliver({conversationId: 'no-such', senderId: 'u', text: 'hi'}),
    ).resolves.toMatchObject({
      status: 'refused',
      reason: 'unknown_conversation',
    });
  });

  it('restarts a character once after a fatal turn; queued work is refused, then chat resumes', async () => {
    const homeRoot = await createGatewayHome();
    const gateway = createGateway({
      location: {storeRoot: homeRoot},
      env: {},
      roleModelAdapter: replyAdapter(),
      createPluginHost: () => createRuntimePluginHost({plugins: []}),
    });

    await gateway.startCharacter('mira');

    const ref = await gateway.openDirectConversation('mira');
    const message = {
      conversationId: ref.conversationId,
      senderId: ref.userParticipantId,
      text: 'hello there',
    };
    const sessionsRoot = join(
      characterDataDirPath(homeRoot, 'mira'),
      'sessions',
    );

    chmodSync(sessionsRoot, 0o000);

    let outcomes;

    try {
      outcomes = await Promise.all([
        gateway.deliver(message),
        gateway.deliver(message),
      ]);
    } finally {
      chmodSync(sessionsRoot, 0o755);
    }

    expect(outcomes.map(outcome => outcome.status)).toEqual([
      'failed',
      'refused',
    ]);

    await vi.waitFor(() => {
      expect(gateway.characters()[0]?.state).toBe('ready');
    });

    await gateway.openDirectConversation('mira');
    await expect(gateway.deliver(message)).resolves.toMatchObject({
      status: 'completed',
    });
    await gateway.stop();
  });

  it('lets a stop that races a starting character win, terminally', async () => {
    const homeRoot = await createGatewayHome();
    const gateway = createGateway({
      location: {storeRoot: homeRoot},
      env: {},
      roleModelAdapter: replyAdapter(),
      createPluginHost: () => createRuntimePluginHost({plugins: []}),
    });

    // The start creates the runtime mid-race; stop joins it and wins.
    await Promise.all([gateway.startCharacter('mira'), gateway.stop()]);

    expect(gateway.characters()[0]?.state).toBe('stopped');
    await expect(gateway.startCharacter('mira')).rejects.toThrow(
      'gateway is stopped',
    );
  });

  it('never leaks a conversation lease when an attach races a stop', async () => {
    const homeRoot = await createGatewayHome();
    const gatewayOptions = {
      location: {storeRoot: homeRoot},
      env: {},
      roleModelAdapter: replyAdapter(),
      createPluginHost: () => createRuntimePluginHost({plugins: []}),
    };
    const racing = createGateway(gatewayOptions);

    await racing.startCharacter('mira');
    await Promise.all([
      racing.openDirectConversation('mira').catch(() => undefined),
      racing.stop(),
    ]);

    // The invariant is the lease: whatever the race decided, a fresh
    // gateway must be able to open the same thread.
    const fresh = createGateway(gatewayOptions);

    await fresh.startCharacter('mira');
    await expect(fresh.openDirectConversation('mira')).resolves.toMatchObject({
      characterId: 'mira',
    });
    await fresh.stop();
  });

  it('lets a stop win over the automatic recovery of a fatal turn', async () => {
    const homeRoot = await createGatewayHome();
    const gateway = createGateway({
      location: {storeRoot: homeRoot},
      env: {},
      roleModelAdapter: replyAdapter(),
      createPluginHost: () => createRuntimePluginHost({plugins: []}),
    });

    await gateway.startCharacter('mira');

    const ref = await gateway.openDirectConversation('mira');
    const sessionsRoot = join(
      characterDataDirPath(homeRoot, 'mira'),
      'sessions',
    );

    chmodSync(sessionsRoot, 0o000);

    try {
      await gateway.deliver({
        conversationId: ref.conversationId,
        senderId: ref.userParticipantId,
        text: 'hello there',
      });
    } finally {
      chmodSync(sessionsRoot, 0o755);
    }

    await gateway.stop();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(gateway.characters()[0]?.state).toBe('stopped');
  });

  it('joins a start already in flight instead of resolving early', async () => {
    const homeRoot = await createGatewayHome();
    const gateway = createGateway({
      location: {storeRoot: homeRoot},
      env: {},
      roleModelAdapter: replyAdapter(),
      createPluginHost: () => createRuntimePluginHost({plugins: []}),
    });

    await Promise.all([
      gateway.startCharacter('mira'),
      gateway
        .startCharacter('mira')
        .then(() => gateway.openDirectConversation('mira')),
    ]);

    expect(gateway.characters()[0]?.state).toBe('ready');
    await gateway.stop();
  });

  it('leaves a boot failure failed instead of crash-looping', async () => {
    const homeRoot = await createGatewayHome();

    // An invalid global config fails activation while mira stays listed.
    writeRuntimeConfig(join(homeRoot, 'config.json'), {
      project02: {contextWindowTokens: -5},
    });

    const events: GatewayEvent[] = [];
    const gateway = createGateway({location: {storeRoot: homeRoot}, env: {}});

    gateway.events(event => events.push(event));
    await gateway.startCharacter('mira');

    const summary = gateway.characters()[0];

    expect(summary).toMatchObject({state: 'failed'});
    expect(summary?.diagnostic).toContain('contextWindowTokens');

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(
      events.filter(
        event => event.kind === 'state_changed' && event.state === 'starting',
      ),
    ).toHaveLength(1);
  });
});
