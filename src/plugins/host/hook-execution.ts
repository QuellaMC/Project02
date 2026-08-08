import {createJsonBoundarySnapshot} from '../../shared/json-boundary.ts';
import type {RuntimePluginManifest} from '../api/types.ts';

export class PluginHookTimeoutError extends Error {
  constructor(
    options: {
      readonly pluginId: string;
      readonly hookName: string;
      readonly timeoutMs: number;
    },
    errorOptions?: ErrorOptions,
  ) {
    super(
      `Plugin "${options.pluginId}" ${options.hookName} timed out after ${String(
        options.timeoutMs,
      )}ms.`,
      errorOptions,
    );
    this.name = 'PluginHookTimeoutError';
  }
}

export type PluginHookExecutionScope = {
  readonly abortController: AbortController;
  readonly deadlineAt: number;
};

/** A rejected candidate may supply hooks, but never its own timeout policy. */
export function createPluginHookExecutionScope(
  policyManifest: RuntimePluginManifest,
): PluginHookExecutionScope {
  return Object.freeze({
    abortController: new AbortController(),
    deadlineAt: Date.now() + policyManifest.runtimePolicy.timeoutMs,
  });
}

export async function withPluginHookTimeout<T>(options: {
  readonly pluginId: string;
  readonly policyManifest: RuntimePluginManifest;
  readonly hookName: string;
  readonly executionScope: PluginHookExecutionScope;
  readonly revokeFileStoreWrites: () => void;
  readonly operation: (deadlineAt: number) => T | Promise<T>;
}): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const deadlineAt = options.executionScope.deadlineAt;
  const remainingMs = Math.max(0, deadlineAt - Date.now());

  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => options.operation(deadlineAt))
        .then(value => {
          if (Date.now() >= deadlineAt) {
            const error = pluginHookTimeoutError(options);

            options.executionScope.abortController.abort(error);
            throw error;
          }

          return value;
        }),
      new Promise<T>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          const error = pluginHookTimeoutError(options);

          options.executionScope.abortController.abort(error);
          options.revokeFileStoreWrites();
          reject(error);
        }, remainingMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    options.revokeFileStoreWrites();
  }
}

export function snapshotPluginHookResult(options: {
  readonly pluginId: string;
  readonly policyManifest: RuntimePluginManifest;
  readonly hookName:
    | 'afterTurnCommitted'
    | 'beforeRoleModelCall'
    | 'handleToolCall'
    | 'health'
    | 'onSessionEnd'
    | 'onShutdown';
  readonly value: unknown;
  readonly deadlineAt: number;
}): unknown {
  try {
    return createJsonBoundarySnapshot(options.value, {
      field: `Plugin ${options.hookName} result`,
      redact: true,
      deadlineAt: options.deadlineAt,
    });
  } catch (error: unknown) {
    if (
      error instanceof TypeError &&
      error.message.endsWith('JSON normalization timed out.')
    ) {
      throw new PluginHookTimeoutError(
        {
          pluginId: options.pluginId,
          hookName: options.hookName,
          timeoutMs: options.policyManifest.runtimePolicy.timeoutMs,
        },
        {cause: error},
      );
    }

    throw error;
  }
}

function pluginHookTimeoutError(options: {
  readonly pluginId: string;
  readonly policyManifest: RuntimePluginManifest;
  readonly hookName: string;
}): PluginHookTimeoutError {
  return new PluginHookTimeoutError({
    pluginId: options.pluginId,
    hookName: options.hookName,
    timeoutMs: options.policyManifest.runtimePolicy.timeoutMs,
  });
}
