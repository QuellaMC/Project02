import {join} from 'node:path';

import {expect} from 'vitest';

import {createGateway, type Gateway} from '../../src/gateway/index.ts';
import {runtimePluginConfigUpdateToolName} from '../../src/plugins/api/contract.ts';
import {
  createDemoConfigPluginManifest,
  demoConfigPluginId,
} from '../../src/plugins/packages/demo-config/plugin.ts';
import type {RoleModelAdapter} from '../../src/role-model/index.ts';
import {
  ensureInitializedProject02Store,
  inspectRuntimePluginConfig,
} from '../../src/runtime/config/index.ts';
import {runtimeLocationForTest, writeRuntimeConfig} from './runtime-config.ts';
import {createTestTempRoot} from './temp-root.ts';

/** A consented, empty home with the bundled mira package. */
export async function createGatewayTestHome(
  prefix = 'project02-gateway-',
): Promise<string> {
  const homeRoot = join(createTestTempRoot(prefix), 'home');

  await ensureInitializedProject02Store({homeRoot});

  return homeRoot;
}

/**
 * A gateway whose character runs the bundled demo-config plugin, and an
 * adapter that asks to change its tone: the one confirmation-gated path in
 * the runtime, driven through real activation and the runtime's own broker.
 */
export async function createConfirmationHome(reply = 'done'): Promise<{
  readonly gateway: Gateway;
  readonly inspectTone: () => ReturnType<typeof inspectRuntimePluginConfig>;
}> {
  const homeRoot = await createGatewayTestHome();
  const manifest = createDemoConfigPluginManifest();

  writeRuntimeConfig(join(homeRoot, 'config.json'), {
    plugins: {[demoConfigPluginId]: {enabled: true}},
  });

  let expectedFingerprint = '';
  let invocations = 0;
  const adapter: RoleModelAdapter = {
    invoke() {
      invocations += 1;

      return {
        rawOutputText: JSON.stringify({
          toolCalls:
            invocations === 1
              ? [
                  {
                    name: runtimePluginConfigUpdateToolName,
                    input: {
                      pluginId: demoConfigPluginId,
                      fieldName: 'tone',
                      operation: 'set',
                      value: 'warm',
                      expectedFingerprint,
                    },
                  },
                ]
              : [{name: 'visible_reply', input: {text: reply}}],
        }),
      };
    },
  };
  const gateway = createGateway({
    location: {storeRoot: homeRoot},
    env: {},
    roleModelAdapter: adapter,
  });
  const inspectTone = () =>
    inspectRuntimePluginConfig({
      targetScope: 'character',
      runtimeLocation: runtimeLocationForTest({
        storeRoot: homeRoot,
        character: 'mira',
      }),
      manifest,
      pluginManifests: [manifest],
    });

  await gateway.startCharacter('mira');
  expectedFingerprint = inspectTone().fingerprint;

  return {gateway, inspectTone};
}

export function authoredTone(
  inspected: ReturnType<typeof inspectRuntimePluginConfig>,
): unknown {
  return inspected.fields.find(field => field.name === 'tone')?.authored.value;
}

/** Opens the DM or fails the test with the outcome's own message. */
export async function openDirect(gateway: Gateway, characterId: string) {
  const outcome = await gateway.openDirectConversation(characterId);

  if (outcome.status !== 'opened') {
    expect.fail(outcome.message);
  }

  return outcome;
}
