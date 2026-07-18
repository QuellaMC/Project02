/**
 * Scaffold for `pnpm plugin:new <id>`: stamps a runnable runtime plugin
 * package under src/plugins/packages/<id>/ — descriptor (schema-linked),
 * package.json, single-export entry, and a minimal before_role_model_call
 * plugin that reads its own config. The stamped descriptor must always
 * satisfy schemas/project02.plugin.schema.json and the runtime validator;
 * tests/unit/plugin-package-schema.test.ts pins that.
 */
import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const pluginIdPattern = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;

export function scaffoldRuntimePluginPackage({id, packagesRoot}) {
  if (!pluginIdPattern.test(id)) {
    throw new Error(
      `Plugin id "${id}" must start with a letter and use only letters, numbers, dots, underscores, or hyphens.`,
    );
  }

  const packageRoot = join(packagesRoot, id);

  if (existsSync(packageRoot)) {
    throw new Error(`Plugin package directory already exists: ${packageRoot}`);
  }

  const displayName = id
    .split(/[._-]/u)
    .filter(part => part.length > 0)
    .map(part => part[0].toUpperCase() + part.slice(1))
    .join(' ');

  mkdirSync(packageRoot, {recursive: true});
  writeFileSync(
    join(packageRoot, 'project02.plugin.json'),
    `${JSON.stringify(descriptorTemplate({id, displayName}), null, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    join(packageRoot, 'package.json'),
    `${JSON.stringify({type: 'module'}, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    join(packageRoot, 'index.ts'),
    "export {createProject02Plugin} from './plugin.ts';\n",
    'utf8',
  );
  writeFileSync(join(packageRoot, 'plugin.ts'), pluginModuleTemplate(id), 'utf8');

  return {packageRoot};
}

function descriptorTemplate({id, displayName}) {
  return {
    $schema: '../../../../schemas/project02.plugin.schema.json',
    format: 'project02.plugin.v1',
    entry: './index.ts',
    manifest: {
      id,
      displayName,
      version: '1.0.0',
      kind: 'context_provider',
      description: `${displayName} runtime plugin.`,
      contractVersion: 'mvp-008.runtime_plugin.v2',
      compatibility: {
        hostContractVersions: ['mvp-008.runtime_plugin.v2'],
        sourceSystem: 'project02',
      },
      declaredPlugins: ['before_role_model_call'],
      config: {
        fields: [
          {
            name: 'greeting',
            description:
              'Example agent-adjustable text this plugin adds to model context.',
            required: false,
            secret: false,
            valueType: 'string',
            agentMutable: true,
            redactionLabels: [],
          },
        ],
      },
      localTrustLevel: 'first_party',
      runtimePolicy: {
        requiredForTurn: false,
        sideEffectLevel: 'none',
        confirmation: 'not_required',
        timeoutMs: 1000,
        sourceReferencesRequired: false,
        redactionLabels: [],
        failureBehavior: {
          beforeRoleModelCall: 'degrade',
          handleToolCall: 'reject_tool_call',
          afterTurnCommitted: 'log_failure',
          health: 'degrade',
        },
      },
      activation: {
        defaultEnabled: false,
        reasons: [`bundled_${id.replaceAll(/[.-]/gu, '_')}`],
      },
      requestedAccess: {model_input: 'write'},
    },
  };
}

function pluginModuleTemplate(id) {
  const constantPrefix = id
    .split(/[._-]/u)
    .filter(part => part.length > 0)
    .map((part, index) =>
      index === 0 ? part : part[0].toUpperCase() + part.slice(1),
    )
    .join('');

  return `import {createRuntimePlugin} from '../../api/constructors.ts';
import {createRuntimePluginContextItem} from '../../api/manifest-validation.ts';
import {readRuntimePluginPackageDescriptor} from '../../api/package-descriptor.ts';
import {createPluginContextEvidence} from '../../api/evidence-helpers.ts';
import type {RuntimePluginFactoryInput} from '../../api/factory.ts';
import type {
  RuntimePlugin,
  RuntimePluginBeforeRoleModelCallResult,
  RuntimePluginManifest,
} from '../../api/types.ts';

export const ${constantPrefix}PluginId = '${id}';

const ${constantPrefix}PluginDescriptorUrl = new URL(
  './project02.plugin.json',
  import.meta.url,
);

export function create${constantPrefix[0].toUpperCase()}${constantPrefix.slice(1)}PluginManifest(): RuntimePluginManifest {
  return readRuntimePluginPackageDescriptor({
    descriptorUrl: ${constantPrefix}PluginDescriptorUrl,
    expectedEntry: './index.ts',
  }).manifest;
}

// Package entry: runs with the discovered manifest and resolved config.
export function createProject02Plugin(
  input: RuntimePluginFactoryInput,
): RuntimePlugin {
  const greetingField = input.resolvedConfig['greeting'];
  const greeting =
    greetingField?.resolved === true && typeof greetingField.value === 'string'
      ? greetingField.value
      : undefined;

  return createRuntimePlugin({
    manifest: input.manifest,
    lifecycleHooks: {
      beforeRoleModelCall(context) {
        return Object.freeze({
          contextItems:
            greeting === undefined
              ? []
              : [
                  createRuntimePluginContextItem({
                    pluginId: input.pluginId,
                    id: 'greeting',
                    kind: 'runtime_note',
                    text: greeting,
                    budget: {estimatedTokens: 16, priority: 50},
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
              summary: 'Provided ${id} context.',
            }),
          ],
        } satisfies RuntimePluginBeforeRoleModelCallResult);
      },
    },
  });
}
`;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const id = process.argv[2];

  if (id === undefined || id.length === 0) {
    console.error('Usage: pnpm plugin:new <plugin-id>');
    process.exit(1);
  }

  try {
    const {packageRoot} = scaffoldRuntimePluginPackage({
      id,
      packagesRoot: fileURLToPath(
        new URL('../src/plugins/packages/', import.meta.url),
      ),
    });

    console.log(`Created ${packageRoot}`);
    console.log('Next steps:');
    console.log('  1. Edit the manifest and plugin behavior.');
    console.log('  2. pnpm check');
    console.log(
      `  3. Enable it: pnpm runtime-config ui  (Plugins -> ${id} -> Enable)`,
    );
    console.log('  4. pnpm chat');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
