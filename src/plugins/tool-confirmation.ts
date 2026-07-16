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
