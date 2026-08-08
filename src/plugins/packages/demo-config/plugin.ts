import {createRuntimePlugin} from '../../api/constructors.ts';
import {createRuntimePluginContextItem} from '../../api/manifest-validation.ts';
import {readRuntimePluginPackageDescriptor} from '../../api/package-descriptor.ts';
import {createPluginContextEvidence} from '../../api/evidence-helpers.ts';
import type {RuntimePluginFactoryInput} from '../../api/factory.ts';
import type {
  RuntimePlugin,
  RuntimePluginBeforeRoleModelCallResult,
  RuntimePluginManifest,
} from '../../api/types.ts';

export const demoConfigPluginId = 'demo-config';
export const demoConfigDefaultTone = 'neutral';

const demoConfigPluginEntry = './index.ts';
const demoConfigPluginDescriptorUrl = new URL(
  './project02.plugin.json',
  import.meta.url,
);

export function createDemoConfigPluginManifest(): RuntimePluginManifest {
  return readRuntimePluginPackageDescriptor({
    descriptorUrl: demoConfigPluginDescriptorUrl,
    expectedEntry: demoConfigPluginEntry,
  }).manifest;
}

// Runs at host construction and again after a live config reload.
export function createProject02Plugin(
  input: RuntimePluginFactoryInput,
): RuntimePlugin {
  const tone = configuredStringValue(input, 'tone') ?? demoConfigDefaultTone;
  const signoff = configuredStringValue(input, 'signoff');
  const directives =
    'Demo Config style directives (agent-adjustable via the ' +
    `runtime.plugin.config tools): reply in a ${tone} tone.` +
    (signoff === undefined
      ? ''
      : ` End every reply with the exact signoff "${signoff}".`);

  return createRuntimePlugin({
    manifest: input.manifest,
    lifecycleHooks: {
      beforeRoleModelCall(context) {
        return Object.freeze({
          contextItems: [
            createRuntimePluginContextItem({
              pluginId: input.pluginId,
              id: 'style',
              kind: 'runtime_note',
              text: directives,
              budget: {
                estimatedTokens: 48,
                priority: 60,
              },
              sourceReferences: [],
              confidence: 1,
              redactionLabels: context.privacy.redactionLabels,
            }),
          ],
          evidence: [
            createPluginContextEvidence({
              context,
              pluginId: input.pluginId,
              status: 'accepted',
              summary: 'Provided demo config style directives.',
            }),
          ],
        } satisfies RuntimePluginBeforeRoleModelCallResult);
      },
    },
  });
}

function configuredStringValue(
  input: RuntimePluginFactoryInput,
  fieldName: string,
): string | undefined {
  const field = input.resolvedConfig[fieldName];

  if (
    field === undefined ||
    !field.resolved ||
    typeof field.value !== 'string'
  ) {
    return undefined;
  }

  const value = field.value.trim();

  return value.length === 0 ? undefined : value;
}
