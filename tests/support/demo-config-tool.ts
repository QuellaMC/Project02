import {runtimePluginConfigUpdateToolName} from '../../src/plugins/api/contract.ts';
import {
  createDemoConfigPluginManifest,
  demoConfigPluginId,
} from '../../src/plugins/packages/demo-config/plugin.ts';
import {inspectRuntimePluginConfig} from '../../src/runtime/config/index.ts';
import {runtimeLocationForTest} from './runtime-config.ts';

/**
 * The one confirmation-gated path in the runtime, as a model would take
 * it: a call to the config-update tool for the demo-config plugin's tone,
 * carrying the fingerprint the character's config has right now. The
 * character must be running on the home.
 */
export function demoConfigToneChangeOutput(
  homeRoot: string,
  characterId: string,
  tone = 'warm',
): string {
  const manifest = createDemoConfigPluginManifest();
  const inspected = inspectRuntimePluginConfig({
    targetScope: 'character',
    runtimeLocation: runtimeLocationForTest({
      storeRoot: homeRoot,
      character: characterId,
    }),
    namespace: 'plugins',
    declaration: manifest,
    sections: {plugins: [manifest], connectors: []},
  });

  return JSON.stringify({
    toolCalls: [
      {
        name: runtimePluginConfigUpdateToolName,
        input: {
          pluginId: demoConfigPluginId,
          fieldName: 'tone',
          operation: 'set',
          value: tone,
          expectedFingerprint: inspected.fingerprint,
        },
      },
    ],
  });
}
