import type { RuntimePluginJsonObject } from './plugin-types.ts';

export type RuntimePluginToolConfirmationRequest = {
  readonly pluginId: string;
  readonly toolName: string;
  readonly summary: string;
  readonly preview: RuntimePluginJsonObject;
};

export type RuntimePluginToolConfirmationDecision =
  | { readonly status: 'approved' }
  | { readonly status: 'denied' }
  | { readonly status: 'cancelled' };

export type RuntimePluginToolConfirmationContext = {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
};

export type RuntimePluginToolConfirmationHandler = (
  request: RuntimePluginToolConfirmationRequest,
  context: RuntimePluginToolConfirmationContext
) =>
  | RuntimePluginToolConfirmationDecision
  | Promise<RuntimePluginToolConfirmationDecision>;

export const runtimePluginToolApprovalTimeoutMs = 5 * 60_000;

export async function requestRuntimePluginToolConfirmation(
  handler: RuntimePluginToolConfirmationHandler,
  request: RuntimePluginToolConfirmationRequest,
  timeoutMs = runtimePluginToolApprovalTimeoutMs
): Promise<RuntimePluginToolConfirmationDecision | { readonly status: 'timed_out' }> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const abortController = new AbortController();
  const deadlineAt = Date.now() + timeoutMs;

  try {
    return await Promise.race([
      Promise.resolve().then(() =>
        handler(request, {
          signal: abortController.signal,
          deadlineAt
        })
      ),
      new Promise<{ readonly status: 'timed_out' }>((resolve) => {
        timeoutId = setTimeout(() => {
          resolve(Object.freeze({ status: 'timed_out' as const }));
          abortController.abort();
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    abortController.abort();
  }
}
