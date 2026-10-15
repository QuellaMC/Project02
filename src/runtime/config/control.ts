import {createRuntimeConfigAuthoredSnapshot} from './mutate.ts';
import {layeredRuntimeConfigFingerprintForScope} from './fingerprint.ts';
import {readCharacterOverlayForScope} from './overlay.ts';
import {
  assertResolvedProject02HomeAdoptable,
  loadProject02RuntimeConfigForLocation,
  type ResolvedProject02RuntimeLocation,
} from './location.ts';
import {resolveLayeredProject02RuntimeConfigWithSnapshot} from './resolve-layered.ts';
import {canonicalJsonValuesEqual} from '../../shared/canonical-json.ts';
import {createRuntimeSectionConfigInspectShape} from './inspect.ts';
import {resolveRuntimeSectionConfigs} from './resolve.ts';
import {
  runtimeConfigFieldValueMismatchMessage,
  runtimeConfigValueMatchesField,
} from './schema.ts';
import {runtimeSectionScopeViolation} from './section-scope.ts';
import {redactRuntimeConfigValue} from './redact.ts';
import type {RuntimeConfigFieldDeclaration} from '../../plugins/api/index.ts';
import type {
  Project02RuntimeConfig,
  RuntimeConfigMutationOperation,
  RuntimeConfigSectionDeclaration,
  RuntimeConfigSectionNamespace,
  RuntimeConfigSections,
  RuntimeConfigValue,
  RuntimePluginActivationStatusShape,
  RuntimePluginConfigInspectShape,
} from './types.ts';

export type RuntimeConfigControlOperation = Extract<
  RuntimeConfigMutationOperation,
  {
    readonly kind: 'set' | 'unset';
  }
>;

export function assertRuntimeConfigControlOperation(
  operation: RuntimeConfigMutationOperation,
): asserts operation is RuntimeConfigControlOperation {
  switch (operation.kind) {
    case 'set':
    case 'unset':
      return;
    case 'section_enable':
    case 'section_disable':
      throw new TypeError(
        'Plugin activation must be changed through manifest-aware control.',
      );
    case 'section_field_set':
    case 'section_field_unset':
      throw new TypeError(
        'Plugin config fields must be changed through manifest-aware control.',
      );
  }
}

export type RuntimePluginConfigControlActor = 'operator' | 'agent';

export type RuntimePluginConfigFieldControlOperation =
  | {
      readonly kind: 'set';
      readonly fieldName: string;
      readonly value: RuntimeConfigValue;
    }
  | {
      readonly kind: 'unset';
      readonly fieldName: string;
    };

export function inspectRuntimePluginConfig(options: {
  readonly runtimeLocation: ResolvedProject02RuntimeLocation;
  /** The one document this inspection's control operation can mutate. */
  readonly targetScope: 'global' | 'character';
  readonly namespace: RuntimeConfigSectionNamespace;
  readonly declaration: RuntimeConfigSectionDeclaration;
  readonly sections: RuntimeConfigSections;
  readonly activation?: RuntimePluginActivationStatusShape;
  readonly defaultEnabled?: boolean;
}): RuntimePluginConfigInspectShape {
  assertResolvedProject02HomeAdoptable(options.runtimeLocation);
  const loadedConfig = loadProject02RuntimeConfigForLocation(
    options.runtimeLocation,
  );
  const characterScope = options.runtimeLocation.characterScope;
  // A rebound data directory must not feed an overlay into model-visible config.
  const overlayConfig = readCharacterOverlayForScope(characterScope).overlay;
  const sections = sectionsIncludingTarget(options);
  const {layeredConfig, resolvedConfig} =
    resolveLayeredProject02RuntimeConfigWithSnapshot({
      loadedConfig,
      runtimeLocation: options.runtimeLocation,
      overlayConfig,
      sections,
      validateInactiveSectionConfigs: true,
    });
  const mutationBase =
    createRuntimeConfigAuthoredSnapshot(loadedConfig).document;

  return createRuntimeSectionConfigInspectShape({
    layeredConfig,
    targetScope: options.targetScope,
    sectionResolution: resolvedConfig,
    namespace: options.namespace,
    declaration: options.declaration,
    ...(options.activation === undefined
      ? {}
      : {activation: options.activation}),
    ...(options.defaultEnabled === undefined
      ? {}
      : {defaultEnabled: options.defaultEnabled}),
    fingerprint: layeredRuntimeConfigFingerprintForScope({
      globalConfig: mutationBase,
      characterScope,
      overlay: overlayConfig,
      sections,
    }),
  });
}

export function runtimeSectionFieldControlMutation(options: {
  readonly namespace: RuntimeConfigSectionNamespace;
  readonly declaration: RuntimeConfigSectionDeclaration;
  readonly sections: RuntimeConfigSections;
  readonly actor: RuntimePluginConfigControlActor;
  readonly operation: RuntimePluginConfigFieldControlOperation;
  readonly authoredScope?: 'global' | 'character';
}): {
  readonly operation: RuntimeConfigMutationOperation;
  readonly validateCandidate: (config: Project02RuntimeConfig) => void;
} {
  const scopeViolation = runtimeSectionScopeViolation({
    namespace: options.namespace,
    declaration: options.declaration,
    authoredScope: options.authoredScope ?? 'global',
    operation: {
      kind: 'field',
      fieldName: fieldNameOf(options.operation),
    },
  });

  if (scopeViolation !== undefined) {
    throw new TypeError(scopeViolation.message);
  }

  const field = validateRuntimePluginConfigControlOperation(options);

  return {
    operation: runtimeSectionFieldMutationOperation(options.operation, {
      namespace: options.namespace,
      id: options.declaration.id,
      fieldName: field.name,
    }),
    validateCandidate: config => {
      assertRuntimeSectionConfigCandidateValid({
        config,
        namespace: options.namespace,
        declaration: options.declaration,
        sections: options.sections,
        operation: options.operation,
      });
    },
  };
}

function fieldNameOf(
  operation: RuntimePluginConfigFieldControlOperation,
): string {
  return operation.fieldName;
}

function runtimeSectionFieldMutationOperation(
  operation: RuntimePluginConfigFieldControlOperation,
  target: {
    readonly namespace: RuntimeConfigSectionNamespace;
    readonly id: string;
    readonly fieldName: string;
  },
): RuntimeConfigMutationOperation {
  switch (operation.kind) {
    case 'set':
      return {
        kind: 'section_field_set',
        ...target,
        value: operation.value,
      };
    case 'unset':
      return {
        kind: 'section_field_unset',
        ...target,
      };
  }
}

function assertRuntimeSectionConfigCandidateValid(options: {
  readonly config: Project02RuntimeConfig;
  readonly namespace: RuntimeConfigSectionNamespace;
  readonly declaration: RuntimeConfigSectionDeclaration;
  readonly sections: RuntimeConfigSections;
  readonly operation: RuntimePluginConfigFieldControlOperation;
}): void {
  const resolved = resolveRuntimeSectionConfigs({
    config: options.config,
    sections: sectionsIncludingTarget(options),
    skipSectionScopeValidation: true,
    validateInactiveSectionConfigs: true,
  });
  const blockingDiagnostic = resolved.diagnostics.find(
    diagnostic =>
      diagnostic.severity === 'error' &&
      diagnostic.scope === 'plugin' &&
      diagnostic.pluginId === options.declaration.id,
  );

  if (blockingDiagnostic !== undefined) {
    throw new TypeError(
      `Cannot update plugin config because the resulting config is invalid: ${blockingDiagnostic.message}`,
    );
  }
}

export function validateRuntimePluginConfigControlOperation(options: {
  readonly declaration: RuntimeConfigSectionDeclaration;
  readonly actor: RuntimePluginConfigControlActor;
  readonly operation: RuntimePluginConfigFieldControlOperation;
}): RuntimeConfigFieldDeclaration {
  const field = options.declaration.config.fields.find(
    candidate => candidate.name === options.operation.fieldName,
  );

  if (field === undefined) {
    const declaredFieldNames = options.declaration.config.fields
      .map(candidate => candidate.name)
      .join(', ');

    throw new TypeError(
      `Plugin "${options.declaration.id}" does not declare config field "${options.operation.fieldName}". ` +
        `Declared fields: ${declaredFieldNames.length === 0 ? 'none' : declaredFieldNames}.`,
    );
  }

  // A secret is the operator's alone: the model never reads one back, so
  // it never writes one either.
  if (field.secret && options.actor !== 'operator') {
    throw new TypeError(
      `Plugin config field "${field.name}" is secret; only an operator may change it.`,
    );
  }

  if (options.actor === 'agent' && field.agentMutable !== true) {
    throw new TypeError(
      `Plugin config field "${field.name}" does not allow agent mutation.`,
    );
  }

  if (options.operation.kind === 'unset' && field.required) {
    throw new TypeError(
      `Required plugin config field "${field.name}" cannot be unset.`,
    );
  }

  if (options.operation.kind === 'set') {
    if (!runtimeConfigValueMatchesField(options.operation.value, field)) {
      throw new TypeError(
        runtimeConfigFieldValueMismatchMessage(field, options.operation.value),
      );
    }

    // A secret field holds a credential by declaration; a plain field
    // must not be handed one by its name.
    if (
      !field.secret &&
      runtimeConfigControlValueRequiresRedaction(
        options.operation.value,
        field.name,
      )
    ) {
      throw new TypeError(
        `Plugin config field "${field.name}" value contains content that must stay redacted and cannot be written.`,
      );
    }
  }

  return field;
}

function runtimeConfigControlValueRequiresRedaction(
  value: RuntimeConfigValue,
  fieldName: string,
): boolean {
  return !canonicalJsonValuesEqual(
    redactRuntimeConfigValue(value, {key: fieldName}),
    value,
  );
}

function sectionsIncludingTarget(options: {
  readonly namespace: RuntimeConfigSectionNamespace;
  readonly declaration: RuntimeConfigSectionDeclaration;
  readonly sections: RuntimeConfigSections;
}): RuntimeConfigSections {
  const byId = new Map(
    options.sections[options.namespace].map(
      declaration => [declaration.id, declaration] as const,
    ),
  );

  byId.set(options.declaration.id, options.declaration);
  return Object.freeze({
    ...options.sections,
    [options.namespace]: Object.freeze([...byId.values()]),
  });
}
