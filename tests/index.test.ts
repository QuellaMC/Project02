import { describe, expect, it } from 'vitest';

import {
  createConversationSession,
  createDeterministicLocalRoleModelAdapter,
  createRuntimeEventIdentity,
  createRuntimeLogStore,
  createUserMessageRuntimeEvent,
  parseRoleModelDecision,
  projectHealth,
  roleModelDecisionContractVersion,
  runLocalUserMessageEvent,
  visibleReplyModelToolName
} from '../src/index.ts';

describe('projectHealth', () => {
  it('reports the TypeScript baseline is callable', () => {
    expect(projectHealth()).toEqual({
      status: 'ok',
      runtime: 'typescript'
    });
  });
});

describe('role-model module smoke', () => {
  it('exposes the local adapter and parser through the root barrel', () => {
    expect(createDeterministicLocalRoleModelAdapter()).toHaveProperty('invoke');
    expect(
      parseRoleModelDecision(
        JSON.stringify({
          toolCalls: [
            {
              name: visibleReplyModelToolName,
              input: {
                text: 'hello'
              }
            }
          ]
        })
      )
    ).toEqual({
      status: 'accepted',
      decision: {
        version: roleModelDecisionContractVersion,
        toolCalls: [
          {
            name: visibleReplyModelToolName,
            input: {
              text: 'hello'
            }
          }
        ]
      }
    });
  });

  it('keeps root runtime compatibility exports usable together', async () => {
    const session = createConversationSession({
      id: 'root-compat-session'
    });
    const logStore = createRuntimeLogStore();

    const result = await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent(
        'hello',
        createRuntimeEventIdentity({
          eventId: 'evt_root_compat',
          traceId: 'trace_root_compat',
          createdAt: '2026-06-16T00:00:00.000Z'
        })
      ),
      session,
      logStore,
      roleModelAdapter: createDeterministicLocalRoleModelAdapter(),
      committedAt: '2026-06-16T00:00:01.000Z'
    });

    expect(result.status).toBe('completed');
    expect(logStore.conversationMessages().map((message) => message.text)).toEqual([
      'hello',
      "I'm here. Tell me what you need."
    ]);
  });
});
