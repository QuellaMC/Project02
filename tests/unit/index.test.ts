import {testCharacterProfile} from '../support/character-fixtures.ts';
import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import * as project02 from '../../src/index.ts';

import {
  createSession,
  createDeterministicLocalRoleModelAdapter,
  createRuntimePluginHost,
  createRuntimeEventIdentity,
  createRuntimeLogStore,
  createUserMessageRuntimeEvent,
  parseRoleModelDecision,
  roleModelDecisionContractVersion,
  runLocalUserMessageEvent,
  visibleReplyModelToolName,
} from '../../src/index.ts';

describe('root public surface', () => {
  it('does not expose partial conversation mutation helpers', () => {
    expect(project02).not.toHaveProperty('appendCharacterVisibleMessage');
  });

  it('exposes prepared plugin activation-plan APIs', () => {
    expect(project02.prepareConfiguredProject02PluginActivation).toBeTypeOf(
      'function',
    );
    expect(project02.createConfiguredProject02PluginHostFromPlan).toBeTypeOf(
      'function',
    );
  });

  it('keeps the broad production barrels cold for Character State', () => {
    const pluginBarrel = readFileSync(
      new URL('../../src/plugins/index.ts', import.meta.url),
      'utf8',
    );
    const rootBarrel = readFileSync(
      new URL('../../src/index.ts', import.meta.url),
      'utf8',
    );
    const entrypoints = ['chat', 'serve'].map(name =>
      readFileSync(
        new URL(`../../src/cli/${name}/main.ts`, import.meta.url),
        'utf8',
      ),
    );

    expect(pluginBarrel).not.toContain('packages/character-state/plugin');
    expect(pluginBarrel).not.toContain("export * from './default-host.ts'");
    expect(rootBarrel).not.toContain('packages/character-state/plugin');

    for (const entrypoint of entrypoints) {
      expect(entrypoint).not.toContain('runRuntimePluginSessionEndHooks');
    }
  });

  it('declares the root public surface without wildcard exports', () => {
    const rootBarrel = readFileSync(
      new URL('../../src/index.ts', import.meta.url),
      'utf8',
    );

    expect(rootBarrel).not.toMatch(/\bexport\s+\*/u);
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
                text: 'hello',
              },
            },
          ],
        }),
      ),
    ).toEqual({
      status: 'accepted',
      decision: {
        version: roleModelDecisionContractVersion,
        toolCalls: [
          {
            name: visibleReplyModelToolName,
            input: {
              text: 'hello',
            },
          },
        ],
      },
    });
  });

  it('keeps root runtime compatibility exports usable together', async () => {
    const session = createSession({
      character: testCharacterProfile,
      id: 'root-compat-session',
    });
    const logStore = createRuntimeLogStore();

    const result = await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent(
        'hello',
        createRuntimeEventIdentity({
          eventId: 'evt_root_compat',
          traceId: 'trace_root_compat',
          createdAt: '2026-06-16T00:00:00.000Z',
        }),
      ),
      session,
      logStore,
      pluginHost: createRuntimePluginHost(),
      roleModelAdapter: createDeterministicLocalRoleModelAdapter(),
    });

    expect(result.status).toBe('completed');
    expect(
      logStore.conversationMessages().map(message => message.text),
    ).toEqual(['hello', "I'm here. Tell me what you need."]);
  });
});
