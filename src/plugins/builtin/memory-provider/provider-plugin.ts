import {createHash} from 'node:crypto';

import {createRuntimePlugin} from '../../api/constructors.ts';
import {project02IdentifierMaxLength} from '../../../shared/identifier.ts';
import {
  runtimePluginAccessNameValues,
  runtimePluginContractVersion,
  type RuntimePluginAccessMap,
  type RuntimePluginDeclaration,
} from '../../api/contract.ts';
import {runtimePluginAccessFor} from '../../policy/access-control.ts';
import type {
  RuntimePlugin,
  RuntimePluginManifest,
  RuntimePluginProvidedTool,
} from '../../api/types.ts';
import {createMemoryProviderLifecycleHooks} from './provider-lifecycle.ts';
import {memoryAddTool, memorySearchTool} from './tools.ts';
import type {Project02MemoryProvider} from './types.ts';

export type CreateMemoryProviderRuntimePluginOptions = {
  readonly pluginId?: string;
  readonly version?: string;
  readonly toolNamespace?: string;
  /**
   * Descriptor manifest for bundled packages, which import this helper
   * directly. Package loading requires the returned manifest to equal the
   * descriptor, so the factory adopts it wholesale after consistency
   * checks; hooks and tools still derive from the provider. An installed
   * operator package cannot reach this module -- its captured artifact
   * resolves only its own files -- and builds its RuntimePlugin itself
   * until a host-injected seam exists.
   */
  readonly manifest?: RuntimePluginManifest;
};

/** Long enough that trimmed namespaces do not collide in practice. */
const memoryToolNamespaceDigestLength = 8;

export function createMemoryProviderRuntimePlugin(
  provider: Project02MemoryProvider,
  options: CreateMemoryProviderRuntimePluginOptions = {},
): RuntimePlugin {
  const suppliedManifest = consistentSuppliedManifest(provider, options);
  const pluginId = suppliedManifest?.id ?? options.pluginId ?? provider.id;
  const toolNamespace = options.toolNamespace ?? provider.id;
  const searchToolName = boundedMemoryToolName(toolNamespace, 'search');
  const addToolName = boundedMemoryToolName(toolNamespace, 'add');
  return createRuntimePlugin({
    manifest: suppliedManifest ?? {
      id: pluginId,
      displayName: provider.displayName,
      version: options.version ?? '1.0.0',
      kind: 'memory_provider',
      description: 'Runtime memory provider adapter.',
      contractVersion: runtimePluginContractVersion,
      compatibility: {
        hostContractVersions: [runtimePluginContractVersion],
      },
      declaredPlugins: memoryProviderDeclarations(provider),
      config: {
        scope: 'global_with_character_overrides',
        fields: [],
      },
      firstParty: false,
      runtimePolicy: {
        timeoutMs: 1500,
        redactionLabels: ['memory'],
        failureBehavior: {
          beforeRoleModelCall: 'degrade',
          handleToolCall: 'degrade',
          health: 'degrade',
        },
      },
      activation: {
        defaultEnabled: false,
        reasons: ['memory_provider_factory'],
      },
      requestedAccess: memoryProviderRequestedAccess(provider),
    },
    providedTools: memoryProviderTools({
      provider,
      searchToolName,
      addToolName,
    }),
    lifecycleHooks: createMemoryProviderLifecycleHooks({
      provider,
      pluginId,
      searchToolName,
      addToolName,
    }),
  });
}

/**
 * A supplied manifest is the descriptor's; anything the provider needs but
 * the descriptor omits would surface as scrubbed context or rejected tools
 * at runtime, so divergence fails at construction instead.
 */
function consistentSuppliedManifest(
  provider: Project02MemoryProvider,
  options: CreateMemoryProviderRuntimePluginOptions,
): RuntimePluginManifest | undefined {
  const manifest = options.manifest;

  if (manifest === undefined) {
    return undefined;
  }

  if (options.pluginId !== undefined || options.version !== undefined) {
    throw new TypeError(
      'Memory provider manifest option cannot combine with pluginId or version overrides.',
    );
  }

  if (manifest.kind !== 'memory_provider') {
    throw new TypeError(
      `Memory provider manifest "${manifest.id}" must have kind "memory_provider", not "${manifest.kind}".`,
    );
  }

  const derivedDeclarations = memoryProviderDeclarations(provider);
  const surplus = manifest.declaredPlugins.filter(
    declaration => !derivedDeclarations.includes(declaration),
  );

  // A descriptor that advertises a hook the provider does not implement
  // loads a package promising behavior nothing can deliver.
  if (surplus.length > 0) {
    throw new TypeError(
      `Memory provider manifest "${manifest.id}" declares ${surplus.join(', ')} for provider methods it does not implement.`,
    );
  }

  const derivedAccess = memoryProviderRequestedAccess(provider);

  for (const accessName of runtimePluginAccessNameValues) {
    const requiredLevel = derivedAccess[accessName];
    const requestedLevel = runtimePluginAccessFor(
      manifest.requestedAccess,
      accessName,
    );

    // Exact, not "at least": a wider grant than the verbs use is a
    // capability the host must satisfy and the provider never exercises,
    // and a level nothing needs fails an unrelated startup where the host
    // has no such provider to hand out.
    if (requestedLevel !== (requiredLevel ?? 'none')) {
      throw new TypeError(
        requiredLevel === undefined
          ? `Memory provider manifest "${manifest.id}" requests ${accessName} access that no provider method needs.`
          : `Memory provider manifest "${manifest.id}" must request ${accessName} "${requiredLevel}" for the implemented provider methods, not "${requestedLevel}".`,
      );
    }
  }

  // Host-generated failure evidence carries the manifest's labels, so a
  // descriptor without the memory label would persist provider failures
  // without the redaction metadata every other memory record carries.
  if (!manifest.runtimePolicy.redactionLabels.includes('memory')) {
    throw new TypeError(
      `Memory provider manifest "${manifest.id}" must declare the "memory" redaction label in runtimePolicy.`,
    );
  }

  // The seam contract: an outage costs the turn its memory, never the
  // turn itself. A packaged manifest declaring reject_turn would fail the
  // user's message on an ordinary recall exception or a degraded backend.
  for (const hook of ['beforeRoleModelCall', 'health'] as const) {
    const implemented =
      hook === 'beforeRoleModelCall'
        ? provider.recall !== undefined
        : provider.health !== undefined;

    if (
      implemented &&
      manifest.runtimePolicy.failureBehavior[hook] === 'reject_turn'
    ) {
      throw new TypeError(
        `Memory provider manifest "${manifest.id}" must not declare ${hook}: "reject_turn"; memory failures degrade the turn's memory, not the turn.`,
      );
    }
  }

  return manifest;
}

/**
 * A provider id may use the whole identifier budget, and the derived tool
 * name still has to be a valid identifier: trim the namespace rather than
 * failing construction for an id the manifest itself accepts. Two ids
 * sharing a long prefix would then collide into one tool name and block
 * both providers, so a trimmed namespace carries a digest of the whole.
 */
export function boundedMemoryToolName(namespace: string, verb: string): string {
  const suffix = `.${verb}`;
  const budget = project02IdentifierMaxLength - suffix.length;

  if (namespace.length <= budget) {
    return `${namespace}${suffix}`;
  }

  const digest = createHash('sha256')
    .update(namespace)
    .digest('hex')
    .slice(0, memoryToolNamespaceDigestLength);

  return `${namespace.slice(0, budget - digest.length - 1)}-${digest}${suffix}`;
}

function memoryProviderDeclarations(
  provider: Project02MemoryProvider,
): readonly RuntimePluginDeclaration[] {
  const declarations: RuntimePluginDeclaration[] = ['plugin_discovery'];

  if (provider.recall !== undefined)
    declarations.push('before_role_model_call');
  if (provider.captureTurn !== undefined)
    declarations.push('after_turn_committed');
  if (provider.search !== undefined || provider.add !== undefined) {
    declarations.push('tool_provider', 'handle_tool_call');
  }
  if (provider.health !== undefined) declarations.push('health');
  if (provider.endSession !== undefined) declarations.push('on_session_end');
  if (provider.close !== undefined) declarations.push('on_shutdown');

  return Object.freeze(declarations);
}

function memoryProviderTools(options: {
  readonly provider: Project02MemoryProvider;
  readonly searchToolName: string;
  readonly addToolName: string;
}): readonly RuntimePluginProvidedTool[] {
  const tools: RuntimePluginProvidedTool[] = [];

  if (options.provider.search !== undefined) {
    tools.push(memorySearchTool(options.searchToolName));
  }
  if (options.provider.add !== undefined) {
    tools.push(memoryAddTool(options.addToolName));
  }

  return Object.freeze(tools);
}

function memoryProviderRequestedAccess(
  provider: Project02MemoryProvider,
): RuntimePluginAccessMap {
  return Object.freeze({
    ...(provider.recall === undefined && provider.captureTurn === undefined
      ? {}
      : {turn_context: 'read'}),
    ...(provider.recall === undefined &&
    provider.search === undefined &&
    provider.add === undefined
      ? {}
      : {model_input: 'write'}),
  } satisfies RuntimePluginAccessMap);
}
