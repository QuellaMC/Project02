import {describe, expect, it} from 'vitest';

import {testCharacterProfile} from '../support/character-fixtures.ts';
import {createDefaultProject02PluginHost} from '../support/default-plugin-host.ts';
import {
  createConversationSession,
  createUserMessageRuntimeEvent,
} from '../../src/core/index.ts';
import {createRuntimeLogStore} from '../../src/runtime/evidence/index.ts';
import {runLocalUserMessageEvent} from '../../src/runtime/index.ts';
import type {
  RoleModelAdapter,
  RoleModelChatMessage,
} from '../../src/role-model/index.ts';

const personaSections = [
  'You are Mira, the persona-proof fixture.',
  'Stay terse.',
] as const;
const characterRef = {
  id: 'mira',
  version: '1.1.0',
  personaFingerprint: 'fp-persona-proof',
} as const;

function capturingVisibleReplyAdapter(
  captured: RoleModelChatMessage[][],
): RoleModelAdapter {
  return {
    invoke(_inputEnvelope, invocation) {
      captured.push([...invocation.turnContext.messages]);

      return {
        rawOutputText: JSON.stringify({
          toolCalls: [{name: 'visible_reply', input: {text: 'noted.'}}],
        }),
      };
    },
  };
}

describe('character persona through the role-model loop', () => {
  it('renders persona into the loop-prepared request and stamps characterRef into durable evidence', async () => {
    const session = createConversationSession({
      character: testCharacterProfile,
      id: 'persona-proof',
    });
    const logStore = createRuntimeLogStore({
      sessionId: session.id,
      boundCharacter: testCharacterProfile,
    });
    const capturedMessages: RoleModelChatMessage[][] = [];

    const result = await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent('hello'),
      session,
      logStore,
      pluginHost: createDefaultProject02PluginHost(),
      roleModelAdapter: capturingVisibleReplyAdapter(capturedMessages),
      characterPersonaSections: personaSections,
      characterRef,
    });

    expect(result.status).toBe('completed');

    // The loop pre-renders the request; the adapter must receive the
    // persona-driven system frame (the loop path wins over any
    // adapter-side fallback render).
    const systemMessage = capturedMessages[0]?.[0];

    expect(systemMessage?.role).toBe('system');
    expect(systemMessage?.content).toContain(
      'You are Mira, the persona-proof fixture.\n\nStay terse.',
    );

    // The committed raw event round-trips characterRef through the codec.
    const committed = logStore
      .rawEvents()
      .find(rawEvent => rawEvent.kind === 'visible_reply_committed');

    expect(committed?.roleModelIOSnapshot?.characterRef).toEqual(characterRef);
  });

  it('rejects committing a turn for a foreign character on a bound store even with role-model anchoring', async () => {
    const novaProfile = {id: 'nova', displayName: 'Nova'} as const;
    const session = createConversationSession({
      character: novaProfile,
      id: 'foreign-anchored',
    });
    const logStore = createRuntimeLogStore({
      sessionId: session.id,
      boundCharacter: testCharacterProfile,
    });

    await expect(
      runLocalUserMessageEvent({
        event: createUserMessageRuntimeEvent('hello'),
        session,
        logStore,
        pluginHost: createDefaultProject02PluginHost(),
        roleModelAdapter: capturingVisibleReplyAdapter([]),
      }),
    ).rejects.toThrow(
      'Durable character evidence must match the store-bound character.',
    );
  });

  it('rejects a characterRef whose id differs from the decision-context character', async () => {
    const session = createConversationSession({
      character: testCharacterProfile,
      id: 'persona-ref-mismatch',
    });
    const logStore = createRuntimeLogStore({
      sessionId: session.id,
      boundCharacter: testCharacterProfile,
    });

    await expect(
      runLocalUserMessageEvent({
        event: createUserMessageRuntimeEvent('hello'),
        session,
        logStore,
        pluginHost: createDefaultProject02PluginHost(),
        roleModelAdapter: capturingVisibleReplyAdapter([]),
        characterRef: {
          id: 'nova',
          version: '1.0.0',
          personaFingerprint: 'fp-foreign',
        },
      }),
    ).rejects.toThrow(
      'Role-model characterRef id must match the decision-context character.',
    );
  });

  it('keeps records without characterRef decoding as before', async () => {
    const session = createConversationSession({
      character: testCharacterProfile,
      id: 'persona-absent',
    });
    const logStore = createRuntimeLogStore({
      sessionId: session.id,
      boundCharacter: testCharacterProfile,
    });

    const result = await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent('hello'),
      session,
      logStore,
      pluginHost: createDefaultProject02PluginHost(),
      roleModelAdapter: capturingVisibleReplyAdapter([]),
    });

    expect(result.status).toBe('completed');
    const committed = logStore
      .rawEvents()
      .find(rawEvent => rawEvent.kind === 'visible_reply_committed');

    expect(committed?.roleModelIOSnapshot).toBeDefined();
    expect(committed?.roleModelIOSnapshot?.characterRef).toBeUndefined();
  });
});
