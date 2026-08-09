/** The runtime consumes host TYPES only, via this barrel or plugins/index.ts. */
export {
  createRuntimePluginHost,
  runRuntimePluginSessionEndHooksForTargets,
  runRuntimePluginShutdownHooksForTargets,
  runtimePluginId,
  type CreateRuntimePluginHostOptions,
  type RuntimePluginHealthHostResult,
  type RuntimePluginHookHostResult,
  type RuntimePluginHost,
  type RuntimePluginSessionEndOptions,
} from './host.ts';
export {type RuntimePluginBeforeRoleModelCallCompletedResult} from './before-role-model-call.ts';
export {
  runtimePluginLifecycleTarget,
  type RuntimePluginLifecycleTarget,
} from './instance-lifecycle.ts';
export {
  type RuntimePluginToolConfirmationHandler,
  type RuntimePluginToolConfirmationRequest,
} from './tool-confirmation.ts';
export {
  type RuntimePluginConfigReloadHostResult,
  type RuntimePluginReloader,
  type RuntimePluginReloadResult,
} from './reload.ts';
export {
  runBestEffortPluginSessionEnd,
  runBestEffortPluginShutdown,
} from './lifecycle.ts';
