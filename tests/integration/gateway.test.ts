import {randomUUID} from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
import {
  acquireLocalRuntimeSessionWriterLease,
  characterDataDirPath,
  createLocalRuntimeStorageLayout,
  ensureCharacterDataDir,
  listConversationSegments,
} from '../../src/runtime/storage/index.ts';
import {createLocalRuntimeSessionPaths} from '../../src/runtime/storage/layout-contract.ts';
import {
  writeTestCharacterPackage,
  testCharacterProfile,
} from '../support/character-fixtures.ts';
import {
  authoredTone,
  createConfirmationHome,
} from '../support/gateway-fixtures.ts';
import {writeRuntimeConfig} from '../support/runtime-config.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

function replyAdapter(
  options: {readonly beforeReply?: () => Promise<void> | void} = {},
): RoleModelAdapter & {
  readonly maxInFlight: () => number;
  readonly invocations: () => number;
} {
  let inFlight = 0;
  let maxInFlight = 0;
  let invocations = 0;

  return {
    async invoke() {
      inFlight += 1;
      invocations += 1;
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
    invocations: () => invocations,
  };
}

async function open(gateway: Gateway, characterId: string) {
  const outcome = await gateway.openDirectConversation(characterId);

  if (outcome.status !== 'opened') {
    throw new Error(outcome.message);
  }

  return outcome;
}

async function createRotatedChat(texts: readonly string[]) {
  const homeRoot = await createGatewayHome();

  writeRuntimeConfig(join(homeRoot, 'config.json'), {
    project02: {contextWindowTokens: 100},
  });

  const gateway = createGateway({
    location: {storeRoot: homeRoot},
    env: {},
    roleModelAdapter: replyAdapter(),
    createPluginHost: () => createRuntimePluginHost({plugins: []}),
  });

  await gateway.startCharacter('mira');

  const ref = await open(gateway, 'mira');

  for (const text of texts) {
    await expect(
      gateway.deliver({
        conversationId: ref.conversationId,
        senderId: ref.userParticipantId,
        text,
        source: 'web',
        clientMessageId: `msg-${text}`,
      }),
    ).resolves.toMatchObject({status: 'completed'});
  }

  const {segments} = listConversationSegments({
    storeRoot: characterDataDirPath(homeRoot, 'mira'),
    characterId: 'mira',
    conversationId: ref.conversationId,
  });

  expect(segments.length).toBeGreaterThan(1);

  return {homeRoot, gateway, ref, segments};
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
        source: 'test',
        clientMessageId: randomUUID(),
        text: 'hello mira',
      }),
      gateway.deliver({
        conversationId: zeta.conversationId,
        senderId: zeta.userParticipantId,
        source: 'test',
        clientMessageId: randomUUID(),
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

  it('answers unknown_character for a package removed after its character ran', async () => {
    const homeRoot = await createGatewayHome();

    writeTestCharacterPackage(homeRoot, {id: 'zeta', displayName: 'Zeta'});

    const gateway = createGateway({
      location: {storeRoot: homeRoot},
      env: {},
      roleModelAdapter: replyAdapter(),
      createPluginHost: () => createRuntimePluginHost({plugins: []}),
    });

    await gateway.startCharacter('zeta');
    await expect(gateway.openDirectConversation('zeta')).resolves.toMatchObject(
      {
        status: 'opened',
      },
    );

    // The package goes while the daemon runs; reconcile stops the runtime.
    rmSync(join(homeRoot, 'characters', 'zeta'), {recursive: true});
    await expect(gateway.reconcile()).resolves.toMatchObject({
      stopping: ['zeta'],
    });

    // A retained, stopped runtime is not a character anyone can reach.
    await expect(gateway.openDirectConversation('zeta')).resolves.toMatchObject(
      {
        status: 'refused',
        reason: 'unknown_character',
      },
    );
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
        source: 'test',
        clientMessageId: randomUUID(),
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

  it('lands a delivery after a fatal turn on the recovered character without a reopen', async () => {
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
        source: 'test',
        clientMessageId: randomUUID(),
        text: 'hello there',
      });
    } finally {
      chmodSync(sessionsRoot, 0o755);
    }

    // The thread cannot be held again while its store is unreadable: the
    // turn ends as the open did, and every surface hears that it ended.
    const events: GatewayEvent[] = [];
    const conversationsRoot = join(homeRoot, 'conversations');
    const unheld = randomUUID();

    gateway.events(event => events.push(event));
    chmodSync(conversationsRoot, 0o000);

    try {
      await expect(
        gateway.deliver({
          conversationId: ref.conversationId,
          senderId: ref.userParticipantId,
          source: 'test',
          clientMessageId: unheld,
          text: 'anyone?',
        }),
      ).resolves.toMatchObject({status: 'failed'});
    } finally {
      chmodSync(conversationsRoot, 0o755);
    }

    expect(events.at(-1)).toMatchObject({
      kind: 'turn_completed',
      conversationId: ref.conversationId,
      clientMessageId: unheld,
      status: 'failed',
    });

    // The recovery let the thread go; the next delivery holds it again on
    // its own, joining the recovery first, and runs.
    await expect(
      gateway.deliver({
        conversationId: ref.conversationId,
        senderId: ref.userParticipantId,
        source: 'test',
        clientMessageId: randomUUID(),
        text: 'still here?',
      }),
    ).resolves.toMatchObject({status: 'completed'});
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
        source: 'test',
        clientMessageId: randomUUID(),
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
        source: 'test',
        clientMessageId: randomUUID(),
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
      gateway.deliver({
        conversationId: 'no-such',
        senderId: 'u',
        source: 'test',
        clientMessageId: randomUUID(),
        text: 'hi',
      }),
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
      source: 'test',
      clientMessageId: randomUUID(),
      text: 'hello there',
    };
    const sessionsRoot = join(
      characterDataDirPath(homeRoot, 'mira'),
      'sessions',
    );

    chmodSync(sessionsRoot, 0o000);

    // Each send is its own submission; the same id would join the first.
    const send = () =>
      gateway.deliver({...message, clientMessageId: randomUUID()});
    let outcomes;

    try {
      outcomes = await Promise.all([send(), send()]);
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
    await expect(send()).resolves.toMatchObject({status: 'completed'});
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
        source: 'test',
        clientMessageId: randomUUID(),
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
  it("puts the person's message on the stream, stamped, once it is durable", async () => {
    const homeRoot = await createGatewayHome();
    const gateway = createGateway({
      location: {storeRoot: homeRoot},
      env: {},
      roleModelAdapter: replyAdapter(),
      createPluginHost: () => createRuntimePluginHost({plugins: []}),
    });
    const progress: unknown[] = [];

    gateway.events(event => {
      if (event.kind === 'turn_progress') {
        progress.push(event.progress);
      }
    });
    await gateway.startCharacter('mira');

    const ref = await open(gateway, 'mira');
    const outcome = await gateway.deliver({
      conversationId: ref.conversationId,
      senderId: ref.userParticipantId,
      text: 'hello there',
      source: 'web',
      clientMessageId: 'msg-1',
    });

    expect(outcome.status).toBe('completed');
    expect(progress).toEqual([
      expect.objectContaining({
        kind: 'user_message',
        speakerName: 'You',
        text: 'hello there',
        source: 'web',
        clientMessageId: 'msg-1',
      }),
      expect.objectContaining({kind: 'visible_reply', text: 'noted'}),
    ]);
    await gateway.stop();
  });

  it('refuses a malformed stamp before the runtime sees the message', async () => {
    const homeRoot = await createGatewayHome();
    const gateway = createGateway({
      location: {storeRoot: homeRoot},
      env: {},
      roleModelAdapter: replyAdapter(),
      createPluginHost: () => createRuntimePluginHost({plugins: []}),
    });
    const events: GatewayEvent[] = [];

    await gateway.startCharacter('mira');

    const ref = await open(gateway, 'mira');

    gateway.events(event => events.push(event));
    await expect(
      gateway.deliver({
        conversationId: ref.conversationId,
        senderId: ref.userParticipantId,
        text: 'hello there',
        source: 'web ui',
        clientMessageId: 'msg-1',
      }),
    ).resolves.toMatchObject({status: 'refused', reason: 'invalid_message'});
    expect(events).toEqual([]);
    await gateway.stop();
  });

  it('runs one turn per submission id, however often it is sent', async () => {
    const homeRoot = await createGatewayHome();
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

    const ref = await open(gateway, 'mira');
    const message = {
      conversationId: ref.conversationId,
      senderId: ref.userParticipantId,
      text: 'hello there',
      source: 'web',
      clientMessageId: 'msg-1',
    };
    // Sent twice while the first is in flight: one turn, one outcome.
    const [first, second] = await Promise.all([
      gateway.deliver(message),
      gateway.deliver(message),
    ]);

    expect(first.status).toBe('completed');
    expect(second).toEqual(first);
    expect(adapter.invocations()).toBe(1);

    // Sent again after it finished: the remembered outcome, no new turn.
    await expect(gateway.deliver(message)).resolves.toEqual(first);
    expect(adapter.invocations()).toBe(1);

    // A new submission id is a new turn.
    await expect(
      gateway.deliver({...message, clientMessageId: 'msg-2'}),
    ).resolves.toMatchObject({status: 'completed'});
    expect(adapter.invocations()).toBe(2);

    // The same id for a different line is refused, never swallowed by the
    // old outcome.
    await expect(
      gateway.deliver({...message, text: 'something else entirely'}),
    ).resolves.toMatchObject({status: 'refused', reason: 'invalid_message'});
    expect(adapter.invocations()).toBe(2);
    // The daemon comes back as a new run with an empty memory: the thread
    // itself says the line was taken, and it is not run again.
    await gateway.stop();

    const restarted = createGateway({
      location: {storeRoot: homeRoot},
      env: {},
      roleModelAdapter: adapter,
      createPluginHost: () => createRuntimePluginHost({plugins: []}),
    });

    await restarted.startCharacter('mira');
    await expect(
      restarted.openDirectConversation('mira'),
    ).resolves.toMatchObject({
      status: 'opened',
      conversationId: ref.conversationId,
    });
    await expect(restarted.deliver(message)).resolves.toMatchObject({
      status: 'refused',
      reason: 'duplicate_submission',
    });

    const history = await restarted.history(ref.conversationId);

    expect(
      history.status === 'ok' &&
        history.messages.filter(
          committed => committed.clientMessageId === 'msg-1',
        ),
    ).toHaveLength(1);
    await restarted.stop();
  });

  it('parks a tool confirmation for any client to answer and tells every client it settled', async () => {
    const {gateway, inspectTone} = await createConfirmationHome();
    const first: GatewayEvent[] = [];
    const second: GatewayEvent[] = [];

    gateway.events(event => first.push(event));
    gateway.events(event => second.push(event));

    const ref = await open(gateway, 'mira');
    const turn = gateway.deliver({
      conversationId: ref.conversationId,
      senderId: ref.userParticipantId,
      text: 'please be warmer',
      source: 'test',
      clientMessageId: randomUUID(),
    });

    await vi.waitFor(() => {
      expect(gateway.pendingConfirmations()).toHaveLength(1);
    });

    const pending = gateway.pendingConfirmations()[0];

    expect(pending).toMatchObject({characterId: 'mira'});
    expect(pending?.deadlineAt).toBeGreaterThan(Date.now());
    expect(first).toContainEqual(
      expect.objectContaining({
        kind: 'confirmation_requested',
        id: pending?.id,
      }),
    );

    expect(gateway.answerConfirmation(pending?.id ?? '', 'approved')).toEqual({
      status: 'answered',
    });
    await expect(turn).resolves.toMatchObject({status: 'completed'});

    for (const events of [first, second]) {
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: 'confirmation_settled',
          id: pending?.id,
          decision: 'approved',
        }),
      );
      expect(events.at(-1)).toMatchObject({
        kind: 'turn_completed',
        conversationId: ref.conversationId,
        status: 'completed',
      });
    }
    expect(gateway.pendingConfirmations()).toEqual([]);
    expect(authoredTone(inspectTone())).toBe('warm');
    await gateway.stop();
  });

  it('refuses an answer that arrives after the deadline, whatever the client believes', async () => {
    const {gateway, inspectTone} = await createConfirmationHome();
    const events: GatewayEvent[] = [];

    gateway.events(event => events.push(event));

    const ref = await open(gateway, 'mira');
    const turn = gateway.deliver({
      conversationId: ref.conversationId,
      senderId: ref.userParticipantId,
      text: 'please be warmer',
      source: 'test',
      clientMessageId: randomUUID(),
    });

    await vi.waitFor(() => {
      expect(gateway.pendingConfirmations()).toHaveLength(1);
    });

    const pending = gateway.pendingConfirmations()[0];

    // Only the clock moves: the host's own timer has not fired yet.
    vi.useFakeTimers({toFake: ['Date']});

    try {
      vi.setSystemTime(pending?.deadlineAt ?? 0);
      expect(gateway.answerConfirmation(pending?.id ?? '', 'approved')).toEqual(
        {status: 'expired'},
      );
    } finally {
      vi.useRealTimers();
    }

    await expect(turn).resolves.toMatchObject({status: 'completed'});
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'confirmation_settled',
        id: pending?.id,
        decision: 'cancelled',
      }),
    );
    expect(authoredTone(inspectTone())).toBeUndefined();
    await gateway.stop();
  });

  it('tells every surface how a turn ended, with the reason when it did not complete', async () => {
    const homeRoot = await createGatewayHome();
    const gateway = createGateway({
      location: {storeRoot: homeRoot},
      env: {},
      roleModelAdapter: {invoke: () => ({rawOutputText: 'not json at all'})},
      createPluginHost: () => createRuntimePluginHost({plugins: []}),
    });
    const events: GatewayEvent[] = [];

    gateway.events(event => events.push(event));
    await gateway.startCharacter('mira');

    const ref = await open(gateway, 'mira');

    const clientMessageId = randomUUID();

    await expect(
      gateway.deliver({
        conversationId: ref.conversationId,
        senderId: ref.userParticipantId,
        text: 'hello there',
        source: 'test',
        clientMessageId,
      }),
    ).resolves.toMatchObject({status: 'rejected'});
    // Stamped with the submission's own marks, so every surface knows
    // whose turn ended, even one that committed nothing.
    expect(events.at(-1)).toMatchObject({
      kind: 'turn_completed',
      characterId: 'mira',
      conversationId: ref.conversationId,
      source: 'test',
      clientMessageId,
      status: 'rejected',
      reason: 'malformed_output',
    });
    await gateway.stop();
  });

  it('reports a failed segment rotation as maintenance while the turn stays completed', async () => {
    const homeRoot = await createGatewayHome();

    // A window this small rotates after a few turns.
    writeRuntimeConfig(join(homeRoot, 'config.json'), {
      project02: {contextWindowTokens: 100},
    });

    const gateway = createGateway({
      location: {storeRoot: homeRoot},
      env: {},
      roleModelAdapter: replyAdapter(),
      createPluginHost: () => createRuntimePluginHost({plugins: []}),
    });
    const events: GatewayEvent[] = [];

    gateway.events(event => events.push(event));
    await gateway.startCharacter('mira');

    const ref = await open(gateway, 'mira');
    // Hold the next segment's writer lease from outside, so the rotation
    // fails after planning and the current segment stays in place.
    const blocker = await acquireLocalRuntimeSessionWriterLease({
      storeRoot: characterDataDirPath(homeRoot, 'mira'),
      sessionId: `${ref.conversationId}.2`,
    });

    try {
      for (const text of ['one', 'two', 'three', 'four']) {
        await expect(
          gateway.deliver({
            conversationId: ref.conversationId,
            senderId: ref.userParticipantId,
            text,
            source: 'test',
            clientMessageId: randomUUID(),
          }),
        ).resolves.toMatchObject({status: 'completed'});
      }
    } finally {
      await blocker.release();
    }

    const maintenance = gateway.health().characters[0]?.maintenance;

    expect(maintenance?.message).toContain('busy');
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'maintenance_failed',
        characterId: 'mira',
        at: maintenance?.at,
        message: maintenance?.message,
      }),
    );
    expect(gateway.health().characters[0]?.state).toBe('ready');
    // The failure belongs to that boot: off and on again, health is clean.
    writeRuntimeConfig(join(homeRoot, 'config.json'), {
      project02: {contextWindowTokens: 100, enabled: false},
    });
    await expect(gateway.reconcile()).resolves.toMatchObject({
      stopping: ['mira'],
    });
    writeRuntimeConfig(join(homeRoot, 'config.json'), {
      project02: {contextWindowTokens: 100, enabled: true},
    });
    await expect(gateway.reconcile()).resolves.toMatchObject({
      starting: ['mira'],
    });
    expect(gateway.health().characters[0]?.maintenance).toBeUndefined();
    await gateway.stop();
  });
  it('reads a conversation as one scrollback, newest page first, back across segments', async () => {
    const texts = ['one', 'two', 'three', 'four', 'five', 'six'];
    const {gateway, ref} = await createRotatedChat(texts);
    const newest = await gateway.history(ref.conversationId, {limit: '3'});

    expect(newest).toMatchObject({status: 'ok', characterId: 'mira'});

    if (newest.status !== 'ok') {
      throw new Error(newest.message);
    }

    expect(newest.messages.map(message => message.text)).toEqual([
      'noted',
      'six',
      'noted',
    ]);
    expect(newest.earlier).toBeDefined();

    const pages = [newest.messages];
    let earlier = newest.earlier;

    while (earlier !== undefined) {
      const page = await gateway.history(ref.conversationId, {
        before: earlier,
        limit: 3,
      });

      if (page.status !== 'ok') {
        throw new Error(page.message);
      }

      pages.unshift(page.messages);
      earlier = page.earlier;
    }

    const whole = pages.flat();

    expect(whole.map(message => message.text)).toEqual(
      texts.flatMap(text => [text, 'noted']),
    );
    expect(whole.map(message => message.role)).toEqual(
      texts.flatMap(() => ['user', 'character']),
    );
    expect(whole[0]).toMatchObject({
      speakerName: 'You',
      source: 'web',
      clientMessageId: 'msg-one',
    });
    expect(whole[1]?.source).toBeUndefined();

    // The whole thread in one page, and a cursor the client kept is still
    // exactly where it pointed.
    const all = await gateway.history(ref.conversationId);

    expect(all.status === 'ok' && all.messages).toHaveLength(whole.length);
    expect(all.status === 'ok' && all.earlier).toBeUndefined();
    await gateway.stop();
  });

  it('refuses an unknown conversation and a page it did not describe', async () => {
    const {gateway, ref} = await createRotatedChat([
      'one',
      'two',
      'three',
      'four',
    ]);

    await expect(gateway.history('conv_missing')).resolves.toMatchObject({
      status: 'refused',
      reason: 'unknown_conversation',
    });
    await expect(gateway.history('not valid!')).resolves.toMatchObject({
      status: 'refused',
      reason: 'unknown_conversation',
    });

    for (const limit of [0, -1, 1.5, '1e2', 501, 'abc', '']) {
      await expect(
        gateway.history(ref.conversationId, {limit}),
      ).resolves.toMatchObject({status: 'refused', reason: 'invalid_page'});
    }

    for (const before of ['nonsense', 'v1:9:0', 'v1:1:999', 'v2:1:0']) {
      await expect(
        gateway.history(ref.conversationId, {before}),
      ).resolves.toMatchObject({status: 'refused', reason: 'invalid_page'});
    }
    await gateway.stop();
  });

  it('reads a stopped character, and an empty thread whose character has no data yet', async () => {
    const {homeRoot, gateway, ref} = await createRotatedChat([
      'one',
      'two',
      'three',
      'four',
    ]);

    await gateway.stop();
    await expect(gateway.history(ref.conversationId)).resolves.toMatchObject({
      status: 'ok',
      messages: expect.arrayContaining([
        expect.objectContaining({text: 'two'}),
      ]) as unknown[],
    });

    rmSync(characterDataDirPath(homeRoot, 'mira'), {recursive: true});
    await expect(gateway.history(ref.conversationId)).resolves.toEqual({
      status: 'ok',
      conversationId: ref.conversationId,
      characterId: 'mira',
      messages: [],
    });
  });

  it('keeps a thread readable beside a damaged catalog row and refuses a damaged or missing segment', async () => {
    const {homeRoot, gateway, ref, segments} = await createRotatedChat([
      'one',
      'two',
      'three',
      'four',
    ]);
    const storeRoot = characterDataDirPath(homeRoot, 'mira');

    await gateway.stop();
    appendFileSync(
      createLocalRuntimeStorageLayout({storeRoot}).sessionCatalogPath,
      '{"not": "a session"}\nnot json\n',
    );
    await expect(gateway.history(ref.conversationId)).resolves.toMatchObject({
      status: 'ok',
    });

    const latest = segments.at(-1);

    if (latest === undefined) {
      throw new Error('Expected a rotated chat.');
    }

    const paths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: latest.sessionId,
    });

    appendFileSync(paths.rawEventsPath, '{"eventId": "evt_torn"}\n');
    await expect(gateway.history(ref.conversationId)).resolves.toMatchObject({
      status: 'failed',
      code: 'malformed_record',
    });

    // A segment the catalog names but the disk lacks is damage, not an
    // empty stretch of the thread.
    rmSync(paths.sessionRoot, {recursive: true});
    await expect(gateway.history(ref.conversationId)).resolves.toMatchObject({
      status: 'failed',
      code: 'missing_file',
    });
  });
  it('reconcile boots every enabled character and leaves a disabled one offline', async () => {
    const homeRoot = await createGatewayHome();

    writeTestCharacterPackage(homeRoot, {id: 'zeta', displayName: 'Zeta'});
    await ensureCharacterDataDir({homeRoot, characterId: 'zeta'});
    writeRuntimeConfig(
      join(characterDataDirPath(homeRoot, 'zeta'), 'config.json'),
      {project02: {enabled: false}},
    );

    const gateway = createGateway({
      location: {storeRoot: homeRoot},
      env: {},
      roleModelAdapter: replyAdapter(),
      createPluginHost: () => createRuntimePluginHost({plugins: []}),
    });

    await expect(gateway.reconcile()).resolves.toEqual({
      starting: ['mira'],
      stopping: [],
    });
    expect(
      gateway.health().characters.map(({id, enabled, state}) => ({
        id,
        enabled,
        state,
      })),
    ).toEqual([
      {id: 'mira', enabled: true, state: 'ready'},
      {id: 'zeta', enabled: false, state: 'not_started'},
    ]);
    await gateway.stop();
  });

  it('reconcile stops a character disabled since it started and starts it again once enabled', async () => {
    const homeRoot = await createGatewayHome();
    const gateway = createGateway({
      location: {storeRoot: homeRoot},
      env: {},
      roleModelAdapter: replyAdapter(),
      createPluginHost: () => createRuntimePluginHost({plugins: []}),
    });

    await gateway.reconcile();

    const overlay = join(characterDataDirPath(homeRoot, 'mira'), 'config.json');

    writeRuntimeConfig(overlay, {project02: {enabled: false}});
    await expect(gateway.reconcile()).resolves.toEqual({
      starting: [],
      stopping: ['mira'],
    });
    expect(gateway.health().characters[0]).toMatchObject({
      enabled: false,
      state: 'stopped',
    });

    writeRuntimeConfig(overlay, {});
    await expect(gateway.reconcile()).resolves.toEqual({
      starting: ['mira'],
      stopping: [],
    });
    expect(gateway.health().characters[0]).toMatchObject({
      enabled: true,
      state: 'ready',
    });
    await gateway.stop();
  });

  it('reconcile retries a failed boot once the config is fixed', async () => {
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

    await gateway.reconcile();
    expect(gateway.health().characters[0]?.state).toBe('failed');

    writeRuntimeConfig(join(homeRoot, 'config.json'), {});
    await expect(gateway.reconcile()).resolves.toEqual({
      starting: ['mira'],
      stopping: [],
    });
    expect(gateway.health().characters[0]?.state).toBe('ready');
    await gateway.stop();
  });

  it('reconcile stops a disabled character that failed, freeing what it still held', async () => {
    const homeRoot = await createGatewayHome();
    const options = {
      location: {storeRoot: homeRoot},
      env: {},
      roleModelAdapter: replyAdapter(),
      createPluginHost: () => createRuntimePluginHost({plugins: []}),
    };
    const gateway = createGateway(options);

    await gateway.reconcile();

    const ref = await open(gateway, 'mira');
    const dataRoot = characterDataDirPath(homeRoot, 'mira');
    const sessionsRoot = join(dataRoot, 'sessions');
    const locksRoot = join(dataRoot, '.locks');

    // The turn dies, and the automatic recovery cannot release the thread:
    // the character stays failed, still holding its conversation.
    chmodSync(sessionsRoot, 0o000);
    chmodSync(locksRoot, 0o500);

    try {
      await gateway.deliver({
        conversationId: ref.conversationId,
        senderId: ref.userParticipantId,
        text: 'hello there',
        source: 'test',
        clientMessageId: randomUUID(),
      });
      await vi.waitFor(() => {
        expect(gateway.health().characters[0]?.diagnostic).toContain(
          'could not release',
        );
      });
    } finally {
      chmodSync(sessionsRoot, 0o755);
      chmodSync(locksRoot, 0o755);
    }

    writeRuntimeConfig(join(dataRoot, 'config.json'), {
      project02: {enabled: false},
    });
    await expect(gateway.reconcile()).resolves.toEqual({
      starting: [],
      stopping: ['mira'],
    });
    expect(gateway.health().characters[0]).toMatchObject({
      enabled: false,
      state: 'stopped',
    });

    // Released for real: another gateway can open the same thread.
    writeRuntimeConfig(join(dataRoot, 'config.json'), {});

    const fresh = createGateway(options);

    await fresh.reconcile();
    await expect(fresh.openDirectConversation('mira')).resolves.toMatchObject({
      status: 'opened',
      conversationId: ref.conversationId,
    });
    await fresh.stop();
    await gateway.stop();
  });

  it('a reconcile requested during a pass ends on the newest configuration', async () => {
    const homeRoot = await createGatewayHome();
    const gateway = createGateway({
      location: {storeRoot: homeRoot},
      env: {},
      roleModelAdapter: replyAdapter(),
      createPluginHost: () => createRuntimePluginHost({plugins: []}),
    });
    const first = gateway.reconcile();

    expect(gateway.health().characters[0]?.state).toBe('starting');
    // The person turns the character off while its boot is in flight.
    writeRuntimeConfig(join(homeRoot, 'config.json'), {
      project02: {enabled: false},
    });

    const second = gateway.reconcile();

    expect(second).toBe(first);
    await expect(first).resolves.toMatchObject({stopping: ['mira']});
    expect(gateway.health().characters[0]).toMatchObject({
      enabled: false,
      state: 'stopped',
    });
    await gateway.stop();
  });
});
