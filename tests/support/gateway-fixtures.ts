import {join} from 'node:path';

import {expect} from 'vitest';

import type {GatewayClient} from '../../src/gateway/client/index.ts';
import {createGateway, type Gateway} from '../../src/gateway/index.ts';
import {
  createDemoConfigPluginManifest,
  demoConfigPluginId,
} from '../../src/plugins/packages/demo-config/plugin.ts';
import type {RoleModelAdapter} from '../../src/role-model/index.ts';
import {
  ensureInitializedProject02Store,
  inspectRuntimePluginConfig,
} from '../../src/runtime/config/index.ts';
import {writeTestCharacterPackage} from './character-fixtures.ts';
import {demoConfigToneChangeOutput} from './demo-config-tool.ts';
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
 * A character other than the bundled mira is installed beside her.
 */
export async function createConfirmationHome(
  reply = 'done',
  characterId = 'mira',
): Promise<{
  readonly homeRoot: string;
  readonly gateway: Gateway;
  readonly inspectTone: () => ReturnType<typeof inspectRuntimePluginConfig>;
}> {
  const homeRoot = await createGatewayTestHome();
  const manifest = createDemoConfigPluginManifest();

  if (characterId !== 'mira') {
    writeTestCharacterPackage(homeRoot, {
      id: characterId,
      displayName: (characterId[0] ?? '').toUpperCase() + characterId.slice(1),
    });
  }

  writeRuntimeConfig(join(homeRoot, 'config.json'), {
    plugins: {[demoConfigPluginId]: {enabled: true}},
  });

  let invocations = 0;
  const adapter: RoleModelAdapter = {
    invoke() {
      invocations += 1;

      return {
        rawOutputText:
          invocations === 1
            ? demoConfigToneChangeOutput(homeRoot, characterId)
            : JSON.stringify({
                toolCalls: [{name: 'visible_reply', input: {text: reply}}],
              }),
      };
    },
  };
  const gateway = createGateway({
    location: {storeRoot: homeRoot},
    roleModelAdapter: adapter,
  });
  const inspectTone = () =>
    inspectRuntimePluginConfig({
      targetScope: 'character',
      runtimeLocation: runtimeLocationForTest({
        storeRoot: homeRoot,
        character: characterId,
      }),
      namespace: 'plugins',
      declaration: manifest,
      sections: {plugins: [manifest]},
    });

  await gateway.startCharacter(characterId);

  return {homeRoot, gateway, inspectTone};
}

export function authoredTone(
  inspected: ReturnType<typeof inspectRuntimePluginConfig>,
): unknown {
  return inspected.fields.find(field => field.name === 'tone')?.authored.value;
}

/**
 * Resolves once the character is ready, from the stream: the address a
 * daemon prints no longer implies its roster is up.
 */
export function awaitCharacterReady(
  client: GatewayClient,
  characterId: string,
): Promise<void> {
  const abort = new AbortController();
  const isReady = (
    summary: {readonly id: string; readonly state: string} | undefined,
  ): boolean => summary?.id === characterId && summary.state === 'ready';

  return new Promise<void>((resolve, reject) => {
    client
      .events(
        event => {
          if (
            event.kind === 'state_changed' &&
            event.characterId === characterId &&
            event.state === 'ready'
          ) {
            resolve();
            abort.abort();
          }
        },
        {
          signal: abort.signal,
          onReady: ({snapshot}) => {
            if (snapshot.health.characters.some(isReady)) {
              resolve();
              abort.abort();
            }
          },
        },
      )
      .catch(reject);
  });
}

/** Opens the DM or fails the test with the outcome's own message. */
export async function openDirect(gateway: Gateway, characterId: string) {
  const outcome = await gateway.openDirectConversation(characterId);

  if (outcome.status !== 'opened') {
    expect.fail(outcome.message);
  }

  return outcome;
}
