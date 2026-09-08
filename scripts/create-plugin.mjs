// The stamped descriptor must satisfy schemas/project02.plugin.schema.json
// and the runtime validator.
import {existsSync, mkdirSync, readdirSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {
  displayNameFromProject02Identifier,
  isProject02Identifier,
} from '../src/shared/identifier.ts';
import {canonicalPath} from '../src/shared/real-path.ts';
import {atomicReplaceFileSync} from '../src/runtime/storage/atomic-file.ts';
import {
  acquireLocalRuntimeMutationLockSync,
  LocalRuntimeMutationLockBusyError,
} from '../src/runtime/storage/mutation-lock.ts';

export function scaffoldRuntimePluginPackage({id, packagesRoot, bundledPath}) {
  if (!isProject02Identifier(id)) {
    throw new Error(
      `Plugin id "${id}" must start with a letter and use only letters, numbers, dots, underscores, or hyphens.`,
    );
  }

  const packageRoot = join(packagesRoot, id);

  // One scaffold at a time per registry: check, create, and register must
  // not interleave, or a colliding loser leaves files it can never register.
  return withBundledRegistryLock(bundledPath, () => {
    const source = readFileSync(bundledPath, 'utf8');
    const registered = source.includes(`'../packages/${id}/index.ts'`);
    const packageRootExists = existsSync(packageRoot);

    if (packageRootExists) {
      assertOwnScaffold({id, packageRoot});
      if (registered) {
        throw new Error(
          `Plugin package directory already exists: ${packageRoot}`,
        );
      }
    }
    if (!registered) {
      assertBundledRegistrationNamesAvailable({id, source});
    }
    if (!packageRootExists) {
      mkdirSync(packageRoot, {recursive: true});
    }

    const displayName = displayNameFromProject02Identifier(id);

    writeMissingScaffoldFile(
      join(packageRoot, 'project02.plugin.json'),
      `${JSON.stringify(descriptorTemplate({id, displayName}), null, 2)}\n`,
    );
    writeMissingScaffoldFile(
      join(packageRoot, 'package.json'),
      `${JSON.stringify({type: 'module'}, null, 2)}\n`,
    );
    writeMissingScaffoldFile(
      join(packageRoot, 'index.ts'),
      "export {createProject02Plugin} from './plugin.ts';\n",
    );
    writeMissingScaffoldFile(
      join(packageRoot, 'plugin.ts'),
      pluginModuleTemplate(id),
    );
    if (!registered) {
      registerBundledRuntimePluginFactory({id, bundledPath, source});
    }

    return {packageRoot};
  });
}

// Atomic writes make existence mean completeness: a rerun heals a crashed
// scaffold, a torn file cannot arise, and no existing file is overwritten.
function writeMissingScaffoldFile(path, content) {
  if (!existsSync(path)) {
    atomicReplaceFileSync({targetPath: path, content, mode: 0o644});
  }
}

// Only an empty directory or this id's own descriptor may be completed.
function assertOwnScaffold({id, packageRoot}) {
  if (readdirSync(packageRoot).length === 0) {
    return;
  }

  let descriptorId;

  try {
    const descriptor = JSON.parse(
      readFileSync(join(packageRoot, 'project02.plugin.json'), 'utf8'),
    );

    descriptorId = descriptor.manifest.id;
  } catch {
    descriptorId = undefined;
  }
  if (descriptorId !== id) {
    throw new Error(
      `Plugin package directory already exists and is not a scaffold of "${id}": ${packageRoot}`,
    );
  }
}

function withBundledRegistryLock(bundledPath, transaction) {
  let lease;

  try {
    lease = acquireLocalRuntimeMutationLockSync({
      locksRoot: join(tmpdir(), 'project02-scaffold-locks'),
      resourceKey: `bundled-registry:${canonicalPath(bundledPath)}`,
    });
  } catch (error) {
    if (error instanceof LocalRuntimeMutationLockBusyError) {
      throw new Error(
        'Another scaffold is updating the bundled registry; retry when it finishes.',
        {cause: error},
      );
    }
    throw error;
  }
  try {
    return transaction();
  } finally {
    lease.release();
  }
}

// Ids that differ only in separators derive one registration name; emitting
// the second would break bundled.ts for both packages.
function assertBundledRegistrationNamesAvailable({id, source}) {
  const constantPrefix = identifierConstantPrefix(id);

  for (const name of [
    `create${capitalize(constantPrefix)}Plugin`,
    `${constantPrefix}PluginId`,
  ]) {
    if (new RegExp(`\\b${name}\\b`, 'u').test(source)) {
      throw new Error(
        `Plugin id "${id}" derives the registration name "${name}", which bundled.ts already uses for another package. Pick an id that differs in letters or digits, not only in separators.`,
      );
    }
  }
}

/** A package the host cannot import statically never loads at runtime. */
function registerBundledRuntimePluginFactory({id, bundledPath, source}) {
  const constantPrefix = identifierConstantPrefix(id);
  const factoryAlias = `create${capitalize(constantPrefix)}Plugin`;
  const idConstant = `${constantPrefix}PluginId`;
  const lines = source.split('\n');
  const importLines = [
    `import {createProject02Plugin as ${factoryAlias}} from '../packages/${id}/index.ts';`,
    `import {${idConstant}} from '../packages/${id}/plugin.ts';`,
  ];
  const entryLines = [
    '  [',
    `    ${idConstant},`,
    '    Object.freeze({',
    "      entryRelativePath: 'index.ts',",
    `      factory: ${factoryAlias},`,
    '    }),',
    '  ],',
  ];

  lines.splice(bundledMapEntryIndex(lines, idConstant), 0, ...entryLines);
  lines.splice(bundledImportIndex(lines, id), 0, ...importLines);
  atomicReplaceFileSync({
    targetPath: bundledPath,
    content: lines.join('\n'),
    mode: 0o644,
  });
}

function bundledImportIndex(lines, id) {
  const packageImport = /from '\.\.\/packages\/(?<packageId>[^/]+)\//u;
  let lastImport = 0;

  for (const [index, line] of lines.entries()) {
    const packageId = packageImport.exec(line)?.groups?.packageId;

    if (packageId !== undefined && packageId > id) {
      return index;
    }

    if (line.startsWith('import ')) {
      lastImport = index + 1;
    }
  }

  return lastImport;
}

function bundledMapEntryIndex(lines, idConstant) {
  const mapEnd = lines.findIndex(line => line === ']);');

  for (let index = 0; index < mapEnd; index += 1) {
    const entryId =
      lines[index] === '  [' ? lines[index + 1]?.trim() : undefined;

    if (entryId !== undefined && entryId > `${idConstant},`) {
      return index;
    }
  }

  return mapEnd;
}

function capitalize(value) {
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}

function identifierConstantPrefix(id) {
  return id
    .split(/[._-]/u)
    .filter(part => part.length > 0)
    .map((part, index) => (index === 0 ? part : capitalize(part)))
    .join('');
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
      },
      declaredPlugins: ['before_role_model_call'],
      config: {
        scope: 'global_with_character_overrides',
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
      firstParty: true,
      runtimePolicy: {
        timeoutMs: 1000,
        redactionLabels: [],
        failureBehavior: {
          beforeRoleModelCall: 'degrade',
          handleToolCall: 'reject_tool_call',
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
  const constantPrefix = identifierConstantPrefix(id);

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

export function create${capitalize(constantPrefix)}PluginManifest(): RuntimePluginManifest {
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
      bundledPath: fileURLToPath(
        new URL('../src/plugins/package-loader/bundled.ts', import.meta.url),
      ),
    });

    console.log(`Created ${packageRoot}`);
    console.log('Registered it in src/plugins/package-loader/bundled.ts');
    console.log('Next steps:');
    console.log('  1. Edit the manifest and plugin behavior.');
    console.log('  2. pnpm check');
    console.log(
      `  3. Enable it: pnpm runtime-config ui  (Plugins -> ${id} -> Enable)`,
    );
    console.log(
      '  4. pnpm serve, export the PROJECT02_GATEWAY line, pnpm chat',
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
