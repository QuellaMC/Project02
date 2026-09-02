import {chmodSync, existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';

import {describe, expect, it, vi} from 'vitest';

import {
  createGateway,
  type Gateway,
  type GatewayEvent,
} from '../../src/gateway/index.ts';
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

async function open(gateway: Gateway, characterId: string) {
  const outcome = await gateway.openDirectConversation(characterId);

  if (outcome.status !== 'opened') {
    throw new Error(outcome.message);
  }

  return outcome;
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

    const mira = await open(gateway, 'mira');
    const zeta = await open(gateway, 'zeta');

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
    expect(
      gateway.health().characters.map(character => character.state),
    ).toEqual(['stopped', 'stopped']);
  });

  it('reports installed characters with enabled and lifecycle state', async () => {
    const homeRoot = await createGatewayHome();
    const gateway = createGateway({
      location: {storeRoot: homeRoot},
      env: {},
      roleModelAdapter: replyAdapter(),
      createPluginHost: () => createRuntimePluginHost({plugins: []}),
    });

    expect(gateway.health().characters).toEqual([
      {id: 'mira', displayName: 'Mira', enabled: true, state: 'not_started'},
    ]);

    await gateway.startCharacter('mira');

    expect(gateway.health().characters).toEqual([
      {id: 'mira', displayName: 'Mira', enabled: true, state: 'ready'},
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

    const summary = gateway.health().characters[0];

    expect(summary).toMatchObject({enabled: false, state: 'failed'});
    expect(summary?.diagnostic).toContain('disabled');
    expect(existsSync(characterDataDirPath(homeRoot, 'mira'))).toBe(false);
  });

  it('refuses an unknown character before creating a runtime', async () => {
    const homeRoot = await createGatewayHome();
    const gateway = createGateway({location: {storeRoot: homeRoot}, env: {}});

    const outcome = await gateway.startCharacter('ghost');

    expect(outcome).toMatchObject({
      status: 'refused',
      reason: 'unknown_character',
    });
    expect(outcome.status === 'refused' && outcome.message).toContain(
      'was not found',
    );
  });

  it('keeps the bound home when the document redirects its store', async () => {
    const homeA = await createGatewayHome();
    const homeB = join(
      createTestTempRoot('project02-gateway-redirect-'),
      'other',
    );

    await ensureInitializedProject02Store({homeRoot: homeB});
    writeTestCharacterPackage(homeB, {id: 'zeta', displayName: 'Zeta'});

    const configPath = join(homeA, 'config.json');

    writeRuntimeConfig(configPath, {project02: {storeRoot: homeA}});

    const gateway = createGateway({location: {configPath}, env: {}});

    expect(gateway.health().characters.map(character => character.id)).toEqual([
      'mira',
    ]);

    // Another window redirects the document's store; the running gateway
    // keeps the home it bound.
    writeRuntimeConfig(configPath, {project02: {storeRoot: homeB}});

    expect(gateway.health().characters.map(character => character.id)).toEqual([
      'mira',
    ]);
    await gateway.stop();
  });

  it('reloads the global config for an explicit retry', async () => {
    const homeRoot = await createGatewayHome();

    writeRuntimeConfig(join(homeRoot, 'config.json'), {
      project02: {contextWindowTokens: -5},
    });

    const gateway = createGateway({
      location: {storeRoot: homeRoot},
      env: {},
      roleModelAdapter: replyAdapter(),
      createPluginHost: () => createRuntimePluginHost({plugins: []}),
    });

    await gateway.startCharacter('mira');

    expect(gateway.health().characters[0]).toMatchObject({state: 'failed'});
    expect(gateway.health().characters[0]?.diagnostic).toContain(
      'contextWindowTokens',
    );

    writeRuntimeConfig(join(homeRoot, 'config.json'), {});
    await gateway.startCharacter('mira');

    expect(gateway.health().characters[0]?.state).toBe('ready');
    await gateway.stop();
  });

  it('retries a failed character on an explicit start after the fix', async () => {
    const homeRoot = await createGatewayHome();
    const dataRoot = dirname(characterDataDirPath(homeRoot, 'mira'));
    const gateway = createGateway({
      location: {storeRoot: homeRoot},
      env: {},
      roleModelAdapter: replyAdapter(),
      createPluginHost: () => createRuntimePluginHost({plugins: []}),
    });

    // A read-only data root fails the boot; the operator then fixes it.
    chmodSync(dataRoot, 0o555);

    try {
      await gateway.startCharacter('mira');
    } finally {
      chmodSync(dataRoot, 0o755);
    }

    expect(gateway.health().characters[0]?.state).toBe('failed');

    await gateway.startCharacter('mira');

    expect(gateway.health().characters[0]?.state).toBe('ready');
    await gateway.stop();
  });

  it('reports a broken package by its diagnostic, not as missing', async () => {
    const homeRoot = await createGatewayHome();
    const packageRoot = join(homeRoot, 'characters', 'broken');

    mkdirSync(packageRoot, {recursive: true});
    writeFileSync(
      join(packageRoot, 'project02.character.json'),
      '{not json',
      'utf8',
    );

    const gateway = createGateway({location: {storeRoot: homeRoot}, env: {}});

    const outcome = await gateway.startCharacter('broken');

    expect(outcome).toMatchObject({
      status: 'refused',
      reason: 'unknown_character',
    });
    expect(outcome.status === 'refused' && outcome.message).toContain(
      'invalid_descriptor',
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

    const ref = await open(gateway, 'mira');

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
      const summary = gateway.health().characters[0];

      expect(summary?.state).toBe('failed');
      expect(summary?.diagnostic).toContain('disabled');
    });
    await gateway.stop();
  });

  it('joins the automatic recovery so a retry lands on the restarted character', async () => {
    const homeRoot = await createGatewayHome();
    const gateway = createGateway({
      location: {storeRoot: homeRoot},
      env: {},
      roleModelAdapter: replyAdapter(),
      createPluginHost: () => createRuntimePluginHost({plugins: []}),
    });

    await gateway.startCharacter('mira');

    const ref = await open(gateway, 'mira');
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

    await gateway.startCharacter('mira');

    const reopened = await open(gateway, 'mira');

    expect(reopened.conversationId).toBe(ref.conversationId);
    await gateway.stop();
  });

  it('overtakes the automatic recovery on stop instead of finishing it', async () => {
    const homeRoot = await createGatewayHome();
    const gateway = createGateway({
      location: {storeRoot: homeRoot},
      env: {},
      roleModelAdapter: replyAdapter(),
      createPluginHost: () => createRuntimePluginHost({plugins: []}),
    });

    await gateway.startCharacter('mira');

    const ref = await open(gateway, 'mira');
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

    // Recovery is mid-flight; the stop wins without the character coming
    // back to accept deliveries first.
    const readyAfterStopBegan: GatewayEvent[] = [];

    gateway.events(event => {
      if (event.kind === 'state_changed' && event.state === 'ready') {
        readyAfterStopBegan.push(event);
      }
    });
    await gateway.stop();

    expect(readyAfterStopBegan).toEqual([]);
    expect(gateway.health().characters[0]?.state).toBe('stopped');
  });

  it('joins the automatic recovery when a client reattaches straight away', async () => {
    const homeRoot = await createGatewayHome();
    const gateway = createGateway({
      location: {storeRoot: homeRoot},
      env: {},
      roleModelAdapter: replyAdapter(),
      createPluginHost: () => createRuntimePluginHost({plugins: []}),
    });

    await gateway.startCharacter('mira');

    const ref = await open(gateway, 'mira');
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

    const reopened = await open(gateway, 'mira');

    expect(reopened.conversationId).toBe(ref.conversationId);
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

    const ref = await open(gateway, 'mira');
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
      expect(gateway.health().characters[0]?.state).toBe('ready');
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

    expect(gateway.health().characters[0]?.state).toBe('stopped');
    await expect(gateway.startCharacter('mira')).resolves.toMatchObject({
      status: 'refused',
      reason: 'gateway_stopped',
    });
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
      status: 'opened',
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

    const ref = await open(gateway, 'mira');
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
    expect(gateway.health().characters[0]?.state).toBe('stopped');
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

    expect(gateway.health().characters[0]?.state).toBe('ready');
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

    const summary = gateway.health().characters[0];

    expect(summary).toMatchObject({state: 'failed'});
    expect(summary?.diagnostic).toContain('contextWindowTokens');

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(
      events.filter(
        event => event.kind === 'state_changed' && event.state === 'starting',
      ),
    ).toHaveLength(1);
  });
  it('reports config and package problems the roster cannot carry', async () => {
    const homeRoot = await createGatewayHome();
    const packageRoot = join(homeRoot, 'characters', 'broken');

    mkdirSync(packageRoot, {recursive: true});
    writeFileSync(
      join(packageRoot, 'project02.character.json'),
      '{not json',
      'utf8',
    );
    writeRuntimeConfig(join(homeRoot, 'config.json'), {
      project02: {character: 'mira'},
    });

    const health = createGateway({
      location: {storeRoot: homeRoot},
      env: {},
    }).health();

    expect(health.protocolVersion).toBe(1);
    expect(health.homeRoot).toBe(homeRoot);
    expect(health.config.diagnostics).toEqual([
      expect.objectContaining({severity: 'error', path: 'project02.character'}),
    ]);
    expect(health.packages.diagnostics).toEqual([
      expect.objectContaining({code: 'invalid_descriptor'}),
    ]);
    expect(health.packages.diagnostics[0]?.path).toContain('broken');
    expect(health.characters.map(character => character.id)).toEqual(['mira']);
  });

  it('tells an installed but unstarted character apart from an unknown one', async () => {
    const homeRoot = await createGatewayHome();
    const gateway = createGateway({location: {storeRoot: homeRoot}, env: {}});

    await expect(gateway.openDirectConversation('mira')).resolves.toMatchObject(
      {status: 'refused', reason: 'character_unavailable'},
    );
    const unknown = await gateway.openDirectConversation('ghost');

    expect(unknown).toMatchObject({
      status: 'refused',
      reason: 'unknown_character',
    });
    expect(unknown.status === 'refused' && unknown.message).toContain('mira');
    expect(gateway.answerConfirmation('nope', 'approved')).toEqual({
      status: 'unknown',
    });
  });

  it('refuses a thread another gateway holds, then opens it once that one lets go', async () => {
    const homeRoot = await createGatewayHome();
    const options = {
      location: {storeRoot: homeRoot},
      env: {},
      roleModelAdapter: replyAdapter(),
      createPluginHost: () => createRuntimePluginHost({plugins: []}),
    };
    const first = createGateway(options);
    const second = createGateway(options);

    await first.startCharacter('mira');
    await second.startCharacter('mira');

    const held = await open(first, 'mira');

    await expect(second.openDirectConversation('mira')).resolves.toMatchObject({
      status: 'refused',
      reason: 'conversation_busy',
    });
    // The holder keeps its thread, and the refusal left nothing cached.
    await expect(first.openDirectConversation('mira')).resolves.toMatchObject({
      status: 'opened',
      conversationId: held.conversationId,
    });
    await first.stop();
    await expect(second.openDirectConversation('mira')).resolves.toMatchObject({
      status: 'opened',
      conversationId: held.conversationId,
    });
    await second.stop();
  });

  it('reports an unreadable conversation store as a failure, not a bug', async () => {
    const homeRoot = await createGatewayHome();
    const gateway = createGateway({
      location: {storeRoot: homeRoot},
      env: {},
      roleModelAdapter: replyAdapter(),
      createPluginHost: () => createRuntimePluginHost({plugins: []}),
    });
    const conversationsRoot = join(homeRoot, 'conversations');

    await gateway.startCharacter('mira');
    mkdirSync(conversationsRoot, {recursive: true});
    chmodSync(conversationsRoot, 0o000);

    try {
      await expect(
        gateway.openDirectConversation('mira'),
      ).resolves.toMatchObject({status: 'failed', code: 'read_failed'});
    } finally {
      chmodSync(conversationsRoot, 0o755);
    }

    await expect(gateway.openDirectConversation('mira')).resolves.toMatchObject(
      {status: 'opened'},
    );
    await gateway.stop();
  });
});
