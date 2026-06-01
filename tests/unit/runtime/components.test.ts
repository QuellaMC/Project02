import { describe, expect, it } from 'vitest';

import {
  RuntimeComponentRegistryError,
  createRuntimeComponentRegistry,
  type RuntimeComponent
} from '../../../src/runtime/components.ts';
import { VISIBLE_REPLY_MODEL_ACTION_SPEC } from '../../../src/role-model/loop.ts';
import type { RuntimeOperationDefinition } from '../../../src/runtime/operation-registry.ts';
import type { UserTurnWriteActionModule } from '../../../src/runtime/user-turn-actions.ts';

function component(overrides: Partial<RuntimeComponent> = {}): RuntimeComponent {
  return {
    id: 'component.test',
    version: '0.1',
    enabled: true,
    ...overrides
  };
}

function action(id = 'action.test'): UserTurnWriteActionModule {
  return {
    id,
    operation: `operation.${id}`,
    phase: 'after_role_model',
    stop: 'test_stop',
    commit: () => ({
      schema_version: '0.1',
      trace_id: 'trace-1',
      event_id: 'event-1',
      event_type: 'USER_MESSAGE',
      status: 'life_incident_complete_skipped'
    }),
    isRejected: () => false,
    failure: () => ({
      stage: 'test',
      code: 'test_failure',
      message: 'test failure'
    }),
    resultFields: () => ({})
  };
}

function operation(
  overrides: Partial<RuntimeOperationDefinition> = {}
): RuntimeOperationDefinition {
  return {
    op: 'component.enabled.operation',
    owner_component_id: 'component.enabled',
    input_contract_id: 'component.enabled.operation.input.v0.1',
    output_contract_id: 'component.enabled.operation.output.v0.1',
    validate_input: (request) => request.input,
    validate_output: (output) => output,
    policy: {
      category: 'read',
      permission_policy_id: 'internal_runtime_only',
      allowed_callers: ['runtime.user_turn'],
      allowed_call_types: ['user_turn'],
      allowed_event_types: ['USER_MESSAGE']
    },
    privacy: {
      input: 'omitted',
      output: 'omitted'
    },
    logging: {
      mode: 'required'
    },
    transaction: {
      mode: 'read_only'
    },
    execution: {
      mode: 'sync_in_process'
    },
    handler: () => [],
    ...overrides
  };
}

describe('runtime component registry', () => {
  it('builds immutable derived views from enabled components only', () => {
    const provider = {
      buildDecisionContextSections: () => []
    };
    const enabledAction = action();
    const enabledComponent = component({
      id: 'component.enabled',
      userTurnActions: [enabledAction],
      modelActionSpecs: [VISIBLE_REPLY_MODEL_ACTION_SPEC],
      contextSectionProviders: [provider]
    });
    const disabledComponent = component({
      id: 'component.disabled',
      enabled: false,
      userTurnActions: [action('action.disabled')]
    });

    const registry = createRuntimeComponentRegistry([
      enabledComponent,
      disabledComponent
    ]);

    expect(registry.components.map((entry) => entry.id)).toEqual(['component.enabled']);
    expect(registry.userTurnActions).toEqual([enabledAction]);
    expect(registry.modelActionSpecs).toEqual([VISIBLE_REPLY_MODEL_ACTION_SPEC]);
    expect(registry.contextSectionProviders).toEqual([provider]);
    expect(Object.isFrozen(registry.components)).toBe(true);
    expect(Object.isFrozen(registry.userTurnActions)).toBe(true);
    expect(Object.isFrozen(registry.modelActionSpecs)).toBe(true);
    expect(Object.isFrozen(registry.contextSectionProviders)).toBe(true);
  });

  it('freezes registry-owned component and operation copies', () => {
    const sourceOperation = operation();
    const sourceComponent = component({
      id: 'component.enabled',
      operations: [sourceOperation],
      userTurnActions: [action()],
      modelActionSpecs: [VISIBLE_REPLY_MODEL_ACTION_SPEC],
      contextSectionProviders: [
        {
          id: 'provider.test',
          buildDecisionContextSections: () => []
        }
      ]
    });

    const registry = createRuntimeComponentRegistry([sourceComponent]);
    const registeredComponent = registry.components[0];
    const registeredOperation = registry.operationRegistry.get('component.enabled.operation');
    if (registeredComponent === undefined || registeredOperation === undefined) {
      throw new Error('expected registered component and operation');
    }

    expect(Object.isFrozen(registeredComponent)).toBe(true);
    expect(Object.isFrozen(registeredComponent.operations)).toBe(true);
    expect(Object.isFrozen(registeredComponent.userTurnActions)).toBe(true);
    expect(Object.isFrozen(registeredComponent.modelActionSpecs)).toBe(true);
    expect(Object.isFrozen(registeredComponent.contextSectionProviders)).toBe(true);
    expect(Object.isFrozen(registeredOperation)).toBe(true);
    expect(Object.isFrozen(registeredOperation.policy)).toBe(true);
    expect(Object.isFrozen(registeredOperation.policy.allowed_callers)).toBe(true);

    sourceOperation.policy.allowed_callers = ['component.mutated'];
    sourceOperation.policy.category = 'model_call';

    expect(registeredOperation.policy.allowed_callers).toEqual(['runtime.user_turn']);
    expect(registeredOperation.policy.category).toBe('read');
  });

  it('rejects duplicate enabled component and extension identifiers', () => {
    expect(() =>
      createRuntimeComponentRegistry([
        component({ id: 'component.dup' }),
        component({ id: 'component.dup' })
      ])
    ).toThrow(RuntimeComponentRegistryError);

    expect(() =>
      createRuntimeComponentRegistry([
        component({ id: 'component.a', userTurnActions: [action('action.dup')] }),
        component({ id: 'component.b', userTurnActions: [action('action.dup')] })
      ])
    ).toThrow(/duplicate user-turn action id/);

    expect(() =>
      createRuntimeComponentRegistry([
        component({ id: 'component.a', modelActionSpecs: [VISIBLE_REPLY_MODEL_ACTION_SPEC] }),
        component({ id: 'component.b', modelActionSpecs: [VISIBLE_REPLY_MODEL_ACTION_SPEC] })
      ])
    ).toThrow(/duplicate model action spec id/);

    const provider = {
      id: 'context.provider.dup',
      buildDecisionContextSections: () => []
    };
    expect(() =>
      createRuntimeComponentRegistry([
        component({ id: 'component.a', contextSectionProviders: [provider] }),
        component({ id: 'component.b', contextSectionProviders: [provider] })
      ])
    ).toThrow(/duplicate context section provider id/);
  });

  it('rejects operations whose owner does not match the registering component', () => {
    expect(() =>
      createRuntimeComponentRegistry([
        component({
          id: 'component.enabled',
          operations: [
            operation({
              owner_component_id: 'component.other'
            })
          ]
        })
      ])
    ).toThrow(/does not match component component.enabled/);
  });
});
