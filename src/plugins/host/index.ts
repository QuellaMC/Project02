/**
 * Public API of the plugin host: registration, lifecycle hooks, tool
 * routing, and confirmation. Cross-module imports of host behavior land
 * here (arch:check rule 5); the runtime consumes host TYPES only, via
 * this barrel or plugins/index.ts.
 */
export {
  createRuntimePluginHost,
  runRuntimePluginSessionEndHooks,
  runRuntimePluginShutdownHooks,
  runtimePluginId,
  type CreateRuntimePluginHostOptions,
  type RuntimePluginBeforeRoleModelCallCompletedResult,
  type RuntimePluginBeforeRoleModelCallHostResult,
  type RuntimePluginBeforeRoleModelCallRejectedResult,
  type RuntimePluginHealthHostResult,
  type RuntimePluginHookHostResult,
  type RuntimePluginHost,
  type RuntimePluginSessionEndOptions
} from './host.ts';
export {
  type RuntimePluginToolConfirmationHandler,
  type RuntimePluginToolConfirmationRequest
} from './tool-confirmation.ts';
export {
  runBestEffortPluginSessionEnd,
  runBestEffortPluginShutdown
} from './lifecycle.ts';
