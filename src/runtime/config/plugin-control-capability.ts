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

/** Lets plugins use runtime config without value-importing it (arch rule). */
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
