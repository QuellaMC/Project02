import {
  inspectRuntimePluginConfig,
  validateRuntimePluginConfigControlOperation,
} from './control.ts';
import {RuntimeConfigConflictError} from './mutate.ts';
import {redactRuntimeConfigValue} from './redact.ts';
import {
  applyRuntimeConfigControlOperation,
  prepareRuntimeConfigControlOperation,
} from './scope.ts';

/**
 * Host capability handed to the builtin plugin-management tools so they can
 * validate, prepare, apply, inspect, and redact runtime config without
 * value-importing this module (arch rule: plugins never value-import
 * runtime/config). The composition root attaches it to the config-control
 * host state.
 */
export type RuntimePluginConfigControlCapability = Readonly<{
  validateOperation: typeof validateRuntimePluginConfigControlOperation;
  prepareOperation: typeof prepareRuntimeConfigControlOperation;
  applyOperation: typeof applyRuntimeConfigControlOperation;
  inspectConfig: typeof inspectRuntimePluginConfig;
  redactValue: typeof redactRuntimeConfigValue;
  createConflictError: (message: string) => Error;
}>;

export function createRuntimePluginConfigControlCapability(): RuntimePluginConfigControlCapability {
  return Object.freeze({
    validateOperation: validateRuntimePluginConfigControlOperation,
    prepareOperation: prepareRuntimeConfigControlOperation,
    applyOperation: applyRuntimeConfigControlOperation,
    inspectConfig: inspectRuntimePluginConfig,
    redactValue: redactRuntimeConfigValue,
    createConflictError: message => new RuntimeConfigConflictError(message),
  });
}
