import { describe, expect, it } from 'vitest';

import {
  createDecisionContext,
  createRoleModelInputEnvelope,
  roleModelDecisionOutputContractText
} from '../src/role-model/contracts.ts';
import {
  createNvidiaRoleModelProviderConfigFromEnv,
  nvidiaModelEnvName,
  renderNvidiaMessages
} from '../src/role-model/providers/nvidia.ts';
import {
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent
} from '../src/runtime/event.ts';
import {
  visibleReplyModelToolName
} from '../src/role-model/model-tools.ts';

describe('NVIDIA role-model provider', () => {
  it('reads the model name from environment configuration', () => {
    expect(
      createNvidiaRoleModelProviderConfigFromEnv({
        NVIDIA_API_KEY: 'secret',
        [nvidiaModelEnvName]: 'nvidia/test-model'
      }).model
    ).toBe('nvidia/test-model');
  });

  it('renders plugin-era tool instructions without legacy actions', () => {
    const messages = renderNvidiaMessages(
      createRoleModelInputEnvelope({
        event: createUserMessageRuntimeEvent(
          'hello',
          createRuntimeEventIdentity({
            eventId: 'evt_nvidia',
            traceId: 'trace_nvidia',
            createdAt: '2026-06-15T00:00:00.000Z'
          })
        ),
        decisionContext: createDecisionContext({
          sessionId: 'session-nvidia',
          characterSnapshot: {
            id: 'mira',
            displayName: 'Mira'
          }
        }),
        allowedTools: [visibleReplyModelToolName]
      })
    );
    const rendered = messages.map((message) => message.content).join('\n');
    const userPayload = JSON.parse(messages[1]?.content ?? '{}') as {
      readonly responseContract?: {
        readonly allowedTopLevelFields?: readonly string[];
        readonly forbiddenTopLevelFields?: readonly string[];
      };
      readonly runtimeInput?: {
        readonly event?: {
          readonly payload?: {
            readonly currentUserMessage?: string;
          };
        };
      };
    };

    expect(roleModelDecisionOutputContractText).toContain(
      'visible_reply is the only non-executed output tool'
    );
    expect(rendered).toContain(
      'Do not include a top-level "version" field'
    );
    expect(rendered).toContain(
      'the runtime stamps its internal decision version'
    );
    expect(rendered).toContain('Do not copy input envelope fields');
    expect(Object.keys(userPayload)).toEqual([
      'responseContract',
      'runtimeInput'
    ]);
    expect(userPayload.responseContract?.allowedTopLevelFields).toEqual([
      'toolCalls',
      'text'
    ]);
    expect(userPayload.responseContract?.forbiddenTopLevelFields).toEqual(
      expect.arrayContaining([
        'event',
        'recentVisibleMessages',
        'toolObservations',
        'pluginContextItems',
        'characterSnapshot'
      ])
    );
    expect(userPayload.runtimeInput?.event?.payload?.currentUserMessage).toBe(
      'hello'
    );
    expect(rendered).not.toContain('mvp-006.tool_calls.v1');
    expect(rendered).toContain(visibleReplyModelToolName);
    expect(rendered).not.toContain('"action"');
  });
});
