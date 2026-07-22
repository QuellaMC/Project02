import {
  applyRuntimePluginConfigControlOperation,
  inspectRuntimePluginConfig,
  prepareRuntimePluginConfigControlOperation,
  resolveRuntimeConfigControlTargetPath,
  validateRuntimePluginConfigControlOperation,
} from './control.ts';
import {
  canonicalRuntimeConfigMutationPath,
  RuntimeConfigConflictError,
} from './mutate.ts';
import {characterOverlayConfigPath} from './overlay.ts';
import {redactRuntimeConfigValue} from './redact.ts';
import {
  applyScopedRuntimePluginConfigControlOperation,
  prepareScopedRuntimePluginConfigControlOperation,
} from './scope.ts';
import type {RuntimeConfigCharacterScope} from './types.ts';

type ScopeRoutedTargetPathOptions = Parameters<
  typeof resolveRuntimeConfigControlTargetPath
>[0] & {
  readonly characterScope?: RuntimeConfigCharacterScope;
};

/**
 * Host capability handed to the builtin plugin-management tools so they can
 * validate, prepare, apply, inspect, and redact runtime config without
 * value-importing this module (arch rule: plugins never value-import
 * runtime/config). The composition root attaches it to the config-control
 * host state.
 */
export type RuntimePluginConfigControlCapability = Readonly<{
  validateOperation: typeof validateRuntimePluginConfigControlOperation;
  resolveTargetPath: (options: ScopeRoutedTargetPathOptions) => string;
  prepareOperation: typeof prepareRuntimePluginConfigControlOperation;
  applyOperation: typeof applyRuntimePluginConfigControlOperation;
  inspectConfig: typeof inspectRuntimePluginConfig;
  redactValue: typeof redactRuntimeConfigValue;
  createConflictError: (message: string) => Error;
}>;

export function createRuntimePluginConfigControlCapability(): RuntimePluginConfigControlCapability {
  return Object.freeze({
    validateOperation: validateRuntimePluginConfigControlOperation,
    resolveTargetPath: options =>
      options.characterScope === undefined
        ? resolveRuntimeConfigControlTargetPath(options)
        : canonicalRuntimeConfigMutationPath(
            characterOverlayConfigPath(options.characterScope.dataRoot),
          ),
    // A character-scoped host writes the active character's overlay,
    // never the shared home config: an agent-approved update for one
    // character must not leak into every other character's runtime.
    prepareOperation: options =>
      options.characterScope === undefined
        ? prepareRuntimePluginConfigControlOperation(options)
        : prepareScopedRuntimePluginConfigControlOperation({
            ...options,
            scope: 'character',
          }),
    applyOperation: options =>
      options.characterScope === undefined
        ? applyRuntimePluginConfigControlOperation(options)
        : applyScopedRuntimePluginConfigControlOperation({
            ...options,
            scope: 'character',
          }),
    inspectConfig: inspectRuntimePluginConfig,
    redactValue: redactRuntimeConfigValue,
    createConflictError: message => new RuntimeConfigConflictError(message),
  });
}
