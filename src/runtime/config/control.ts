import {
  applyRuntimeConfigMutation,
  type RuntimeConfigMutationResult
} from './mutate.ts';
import type {
  RuntimeConfigMutationOperation
} from './types.ts';

export type RuntimeConfigControlOperation = RuntimeConfigMutationOperation;

export function applyRuntimeConfigControlOperation(options: {
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly storeRoot?: string;
  readonly operation: RuntimeConfigControlOperation;
}): RuntimeConfigMutationResult {
  return applyRuntimeConfigMutation(options);
}
