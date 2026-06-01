import type { DecisionContextSectionProvider } from '../character/state/context.ts';
import type { ModelActionSpec } from '../role-model/loop.ts';
import type { UserTurnWriteActionModule } from './user-turn-actions.ts';
import {
  createRuntimeOperationRegistry,
  freezeRuntimeOperationDefinition,
  type RuntimeOperationDefinition,
  type RuntimeOperationRegistry
} from './operation-registry.ts';

export type RuntimeComponent = {
  id: string;
  version: string;
  enabled: boolean;
  operations?: readonly RuntimeOperationDefinition[];
  userTurnActions?: readonly UserTurnWriteActionModule[];
  modelActionSpecs?: readonly ModelActionSpec[];
  contextSectionProviders?: readonly DecisionContextSectionProvider[];
};

export type RuntimeComponentRegistry = {
  components: readonly RuntimeComponent[];
  operationRegistry: RuntimeOperationRegistry;
  userTurnActions: readonly UserTurnWriteActionModule[];
  modelActionSpecs: readonly ModelActionSpec[];
  contextSectionProviders: readonly DecisionContextSectionProvider[];
};

export class RuntimeComponentRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeComponentRegistryError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function createRuntimeComponentRegistry(
  components: readonly RuntimeComponent[]
): RuntimeComponentRegistry {
  const enabledComponents = components
    .filter((component) => component.enabled)
    .map((component) => freezeRuntimeComponent(validateComponent(component)));

  assertUnique(
    enabledComponents.map((component) => component.id),
    'component id'
  );
  for (const component of enabledComponents) {
    assertComponentOwnsOperations(component);
  }

  const operations = enabledComponents.flatMap((component) => component.operations ?? []);
  const userTurnActions = enabledComponents.flatMap(
    (component) => component.userTurnActions ?? []
  );
  const modelActionSpecs = enabledComponents.flatMap(
    (component) => component.modelActionSpecs ?? []
  );
  const contextSectionProviders = enabledComponents.flatMap(
    (component) => component.contextSectionProviders ?? []
  );
  const contextSectionProviderIds = enabledComponents.flatMap((component) =>
    (component.contextSectionProviders ?? []).map((provider, index) =>
      contextSectionProviderId(provider, component.id, index)
    )
  );

  assertUnique(
    operations.map((operation) => operation.op),
    'operation'
  );
  assertUnique(
    userTurnActions.map((action) => action.id),
    'user-turn action id'
  );
  assertUnique(
    modelActionSpecs.map((spec) => spec.id),
    'model action spec id'
  );
  assertUnique(
    contextSectionProviderIds,
    'context section provider id'
  );

  return Object.freeze({
    components: Object.freeze([...enabledComponents]),
    operationRegistry: createRuntimeOperationRegistry(operations),
    userTurnActions: Object.freeze([...userTurnActions]),
    modelActionSpecs: Object.freeze([...modelActionSpecs]),
    contextSectionProviders: Object.freeze([...contextSectionProviders])
  });
}

function validateComponent(component: RuntimeComponent): RuntimeComponent {
  requireNonEmpty(component.id, 'RuntimeComponent.id');
  requireNonEmpty(component.version, 'RuntimeComponent.version');
  return component;
}

function freezeRuntimeComponent(component: RuntimeComponent): RuntimeComponent {
  const frozenComponent: RuntimeComponent = {
    id: component.id,
    version: component.version,
    enabled: component.enabled
  };
  if (component.operations !== undefined) {
    frozenComponent.operations = Object.freeze(
      component.operations.map((operation) => freezeRuntimeOperationDefinition(operation))
    );
  }
  if (component.userTurnActions !== undefined) {
    frozenComponent.userTurnActions = Object.freeze(
      component.userTurnActions.map((action) => freezeUserTurnAction(action))
    );
  }
  if (component.modelActionSpecs !== undefined) {
    frozenComponent.modelActionSpecs = Object.freeze(
      component.modelActionSpecs.map((spec) => freezeModelActionSpec(spec))
    );
  }
  if (component.contextSectionProviders !== undefined) {
    frozenComponent.contextSectionProviders = Object.freeze(
      component.contextSectionProviders.map((provider) => freezeContextSectionProvider(provider))
    );
  }
  return Object.freeze(frozenComponent);
}

function freezeUserTurnAction(action: UserTurnWriteActionModule): UserTurnWriteActionModule {
  const frozenAction: UserTurnWriteActionModule = { ...action };
  if (action.modelActionSpec !== undefined) {
    frozenAction.modelActionSpec = freezeModelActionSpec(action.modelActionSpec);
  }
  return Object.freeze(frozenAction);
}

function freezeModelActionSpec(spec: ModelActionSpec): ModelActionSpec {
  const frozenSpec: ModelActionSpec = {
    ...spec,
    allowed_actions: Object.freeze([...spec.allowed_actions]) as ModelActionSpec['allowed_actions'],
    decision_contract: Object.freeze({ ...spec.decision_contract })
  };
  return Object.freeze(frozenSpec);
}

function freezeContextSectionProvider(
  provider: DecisionContextSectionProvider
): DecisionContextSectionProvider {
  return Object.freeze({ ...provider });
}

function assertComponentOwnsOperations(component: RuntimeComponent): void {
  for (const operation of component.operations ?? []) {
    if (operation.owner_component_id !== component.id) {
      throw new RuntimeComponentRegistryError(
        `operation ${operation.op} owner ${operation.owner_component_id} ` +
          `does not match component ${component.id}.`
      );
    }
  }
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new RuntimeComponentRegistryError(`duplicate ${label}: ${value}`);
    }
    seen.add(value);
  }
}

function contextSectionProviderId(
  provider: DecisionContextSectionProvider,
  componentId: string,
  index: number
): string {
  const providerId = provider.id;
  if (typeof providerId === 'string' && providerId.trim().length > 0) {
    return providerId;
  }
  return `${componentId}.context_section_provider.${String(index)}`;
}

function requireNonEmpty(value: string, fieldName: string): void {
  if (value.trim().length === 0) {
    throw new RuntimeComponentRegistryError(`${fieldName} must be a non-empty string.`);
  }
}
