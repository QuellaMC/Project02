import {describe, expect, it} from 'vitest';
import {
  createNvidiaRoleModelProviderAdapter,
  type NvidiaFetchClient,
} from '../../src/role-model/providers/nvidia.ts';
import {
  createDecisionContext,
  createRoleModelInputEnvelope,
  renderRoleModelTurnContext,
  type ConversationTurn,
} from '../../src/role-model/index.ts';
import {createUserMessageRuntimeEvent} from '../../src/core/index.ts';
import {testCharacterProfile} from '../support/character-fixtures.ts';
import {streamed} from '../support/nvidia-fixtures.ts';

describe('provider exchange evidence size', () => {
  it('records the exchange for a prompt as large as the window admits', async () => {
    // A few dozen ordinary exchanges: far inside a 32k-token window, and far
    // past the aggregate limit meant for a single plugin's output.
    const conversationHistory: ConversationTurn[] = Array.from(
      {length: 24},
      (_, index) => ({
        eventId: `evt_history_${String(index)}`,
        traceId: `trace_history_${String(index)}`,
        createdAt: '2026-06-15T00:00:00.000Z',
        userMessage: {
          id: `session-size:message-${String(2 * index + 1)}`,
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'You',
          text: 'a'.repeat(1_500),
        },
        toolRounds: [],
        finalReplies: [
          {
            id: `session-size:message-${String(2 * index + 2)}`,
            role: 'character',
            speakerId: testCharacterProfile.id,
            speakerName: testCharacterProfile.displayName,
            text: 'b'.repeat(1_500),
          },
        ],
      }),
    );
    const inputEnvelope = createRoleModelInputEnvelope({
      event: createUserMessageRuntimeEvent('hello'),
      decisionContext: createDecisionContext({
        sessionId: 'session-size',
        characterSnapshot: testCharacterProfile,
        historyWindow: {
          turnEventIds: conversationHistory.map(turn => turn.eventId),
        },
      }),
      pluginToolDefinitions: [],
    });
    const turnContext = renderRoleModelTurnContext(inputEnvelope, {
      conversationHistory,
    });
    const fetchClient: NvidiaFetchClient = () =>
      Promise.resolve(
        streamed({
          choices: [
            {
              finish_reason: 'stop',
              message: {role: 'assistant', content: 'noted'},
            },
          ],
        }),
      );
    const adapter = createNvidiaRoleModelProviderAdapter({
      apiKey: 'provider-secret',
      fetchClient,
    });

    expect(JSON.stringify(turnContext.messages).length).toBeGreaterThan(
      64 * 1_024,
    );

    const output = await adapter.invoke(inputEnvelope, {
      turnContext,
      conversationHistory,
    });

    expect(output.rejection).toBeUndefined();
    expect(output.providerExchange?.renderedMessages).toHaveLength(
      turnContext.messages.length,
    );
  });
});
