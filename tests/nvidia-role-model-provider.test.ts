import { describe, expect, it } from 'vitest';

import {
  createDecisionContext,
  createNvidiaRoleModelProviderConfigFromEnv,
  createRoleModelInputEnvelope,
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent,
  nvidiaModelEnvName,
  renderNvidiaMessages,
  roleModelDecisionOutputContractText,
  visibleReplyModelToolName
} from '../src/index.ts';

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

    expect(roleModelDecisionOutputContractText).toContain(
      'visible_reply is the only non-executed output tool'
    );
    expect(rendered).toContain('outputContract');
    expect(rendered).toContain(visibleReplyModelToolName);
    expect(rendered).not.toContain('"action"');
  });
});
