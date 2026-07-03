import type {
  ResolvedProject02RuntimeConfig,
  RuntimeConfigInspectShape
} from './types.ts';

export function createRuntimeConfigInspectShape(
  resolvedConfig: ResolvedProject02RuntimeConfig
): RuntimeConfigInspectShape {
  return Object.freeze({
    source: resolvedConfig.source,
    ...(resolvedConfig.path === undefined ? {} : { path: resolvedConfig.path }),
    storeRoot: resolvedConfig.storeRoot,
    ...(resolvedConfig.defaultMemoryProvider === undefined
      ? {}
      : { defaultMemoryProvider: resolvedConfig.defaultMemoryProvider }),
    diagnostics: Object.freeze([...resolvedConfig.diagnostics]),
    fingerprint: resolvedConfig.effectiveConfigFingerprint
  } satisfies RuntimeConfigInspectShape);
}
