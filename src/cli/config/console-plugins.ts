import type {
  RuntimePluginConfigField,
  RuntimePluginManifest,
} from '../../plugins/api/index.ts';
import {
  applyRuntimeConfigControlOperation,
  inspectRuntimePluginConfig,
  pluginSecretEnvVarName,
  redactRuntimeConfigValue,
  resolveRuntimeConfigScopeTarget,
  runtimePluginScopeViolation,
  type RuntimeConfigFieldScope,
  type RuntimeConfigValue,
  type RuntimePluginActivationStatusShape,
  type RuntimePluginConfigFieldInspectShape,
  type RuntimePluginConfigInspectShape,
  type RuntimePluginScopeOperation,
} from '../../runtime/config/index.ts';
import {prepareConfiguredProject02PluginActivation} from '../../app/index.ts';
import {ownJsonRecordValue} from '../../shared/json-boundary.ts';
import {shellQuoteCommandArgument} from '../../shared/shell-command.ts';
import {
  consoleCatalogManifests,
  askForFieldValue,
  askForNumber,
  cancelled,
  ensureConsoleCommitTarget,
  formatInspectedFieldValue,
  previewAndCommitChange,
  writeDiagnostics,
  writeLine,
  type RuntimeConfigConsoleContext,
  type RuntimeConfigConsoleSnapshot,
  type StagedRuntimeConfigChange,
} from './console-shared.ts';

type RuntimeConfigConsolePluginEntry = {
  readonly manifest: RuntimePluginManifest;
  readonly section: 'plugin' | 'system_service';
};

type RuntimeConfigConsolePluginCatalog = {
  readonly entries: readonly RuntimeConfigConsolePluginEntry[];
  readonly activationByPluginId: Readonly<
    Record<string, RuntimePluginActivationStatusShape>
  >;
  readonly defaultEnabledPluginIds: readonly string[];
};

export async function runPluginConfigSection(
  context: RuntimeConfigConsoleContext,
  snapshot: RuntimeConfigConsoleSnapshot,
): Promise<void> {
  const catalog = pluginCatalog(context, snapshot);
  const entries = catalog.entries;
  const manifests = Object.freeze(entries.map(entry => entry.manifest));

  writeLine(context.stdout, '');

  if (entries.length === 0) {
    writeLine(context.stdout, 'No plugins are available.');
    return;
  }

  writePluginEntries(context.stdout, entries);

  const selected = await askForNumber(
    context,
    'Select a plugin: ',
    entries.length,
  );
  const manifest =
    selected === undefined ? undefined : entries[selected - 1]?.manifest;

  if (manifest === undefined) {
    return;
  }

  const activation = ownJsonRecordValue(
    catalog.activationByPluginId,
    manifest.id,
  );

  const inspected = inspectRuntimePluginConfig({
    runtimeLocation: snapshot.runtimeLocation,
    ...(context.runtimeEnv === undefined && context.env === undefined
      ? {}
      : {env: context.runtimeEnv ?? context.env}),
    targetScope: snapshot.scope,
    manifest,
    pluginManifests: manifests,
    ...(activation === undefined ? {} : {activation}),
    defaultEnabled: catalog.defaultEnabledPluginIds.includes(manifest.id),
  });

  writeLine(context.stdout, '');
  writeLine(context.stdout, `${inspected.displayName} (${inspected.pluginId})`);
  writeLine(
    context.stdout,
    `1) Enabled: ${String(inspected.enabled)}` +
      readOnlyMarker(inspected.activation.editableInScope),
  );
  inspected.fields.forEach((field, index) => {
    writeLine(
      context.stdout,
      `${String(index + 2)}) ${field.name}: ${formatInspectedFieldValue(field)}` +
        readOnlyMarker(field.editableInScope),
    );
  });
  writeDiagnostics(context.stdout, inspected.diagnostics);

  const item = await askForNumber(
    context,
    'Select a plugin setting: ',
    inspected.fields.length + 1,
  );

  if (item === undefined) {
    return;
  }

  if (item === 1) {
    const change = await stageActivationChoice(
      context,
      manifest,
      inspected,
      snapshot,
    );

    if (change !== undefined) {
      await previewAndCommitChange(context, change);
    }
    return;
  }

  const field = manifest.config.fields[item - 2];
  const inspectedField = inspected.fields[item - 2];

  if (field === undefined || inspectedField === undefined) {
    return;
  }

  // Scope first: a secret command printed for the wrong scope would be
  // rejected the moment the operator ran it.
  if (!inspectedField.editableInScope) {
    writeScopeRestriction(context, manifest, snapshot.scope, {
      kind: 'field',
      fieldName: field.name,
    });

    // A value this scope's document already holds can still be removed
    // here; that unset is the one repair scope rules permit.
    if (inspectedField.authored.configured) {
      const repair = await stageFieldScopeRepair(
        context,
        manifest,
        field.name,
        inspectedField.authored.value,
        inspected.fingerprint,
        snapshot,
      );

      if (repair !== undefined) {
        await previewAndCommitChange(context, repair);
      }
    }

    return;
  }

  if (field.secret) {
    writeSecretConfigInstructions(context, manifest, field, snapshot);
    return;
  }

  const change = await stagePluginFieldChange(
    context,
    manifest,
    field,
    inspectedField,
    inspected.fingerprint,
    snapshot,
  );

  if (change !== undefined) {
    await previewAndCommitChange(context, change);
  }
}

/**
 * A scope that may not decide this activation can still remove a value its
 * document already holds; deciding it stays refused.
 */
async function stageActivationChoice(
  context: RuntimeConfigConsoleContext,
  manifest: RuntimePluginManifest,
  inspected: RuntimePluginConfigInspectShape,
  snapshot: RuntimeConfigConsoleSnapshot,
): Promise<StagedRuntimeConfigChange | undefined> {
  if (inspected.activation.editableInScope) {
    return await stagePluginActivationChange(
      context,
      manifest,
      inspected.enabled,
      inspected.fingerprint,
      snapshot,
    );
  }

  writeScopeRestriction(context, manifest, snapshot.scope, {
    kind: 'activation',
  });

  // With nothing authored here there is nothing to remove: offering the
  // repair would rewrite an unchanged document and report a save.
  const scopeDocument =
    snapshot.scope === 'global' ? snapshot.config : snapshot.scopedConfig;

  if (scopeDocument?.plugins?.[manifest.id]?.enabled === undefined) {
    return undefined;
  }

  return await stageActivationScopeRepair(
    context,
    manifest,
    inspected.enabled,
    inspected.fingerprint,
    snapshot,
  );
}

async function stageFieldScopeRepair(
  context: RuntimeConfigConsoleContext,
  manifest: RuntimePluginManifest,
  fieldName: string,
  authoredValue: RuntimeConfigValue | undefined,
  fingerprint: string,
  snapshot: RuntimeConfigConsoleSnapshot,
): Promise<StagedRuntimeConfigChange | undefined> {
  writeLine(context.stdout, "1) Remove this scope's value");
  writeLine(context.stdout, '2) Cancel');

  const action = await askForNumber(context, 'Choose an action: ', 2);

  if (action !== 1) {
    writeLine(context.stdout, 'Change cancelled.');
    return undefined;
  }

  return {
    target: `plugins.${manifest.id}.config.${fieldName}`,
    oldValue: authoredValue,
    newValue: undefined,
    reloadRequired: true,
    async commit() {
      await ensureConsoleCommitTarget({
        runtimeLocation: snapshot.runtimeLocation,
        scope: snapshot.scope,
      });
      applyRuntimeConfigControlOperation({
        target: resolveRuntimeConfigScopeTarget({
          runtimeLocation: snapshot.runtimeLocation,
          ...(context.env === undefined ? {} : {env: context.env}),
          scope: snapshot.scope,
        }),
        pluginManifests: consoleCatalogManifests(context),
        expectedFingerprint: fingerprint,
        request: {
          kind: 'plugin_config',
          manifest,
          actor: 'operator',
          fieldOperation: {kind: 'unset', fieldName},
        },
      });
    },
  };
}

async function stageActivationScopeRepair(
  context: RuntimeConfigConsoleContext,
  manifest: RuntimePluginManifest,
  inspectedEnabled: boolean,
  fingerprint: string,
  snapshot: RuntimeConfigConsoleSnapshot,
): Promise<StagedRuntimeConfigChange | undefined> {
  writeLine(context.stdout, "1) Remove this scope's enabled value");
  writeLine(context.stdout, '2) Cancel');

  const action = await askForNumber(context, 'Choose an action: ', 2);

  if (action !== 1) {
    writeLine(context.stdout, 'Change cancelled.');
    return undefined;
  }

  return {
    target: `plugins.${manifest.id}.enabled`,
    oldValue: inspectedEnabled,
    newValue: undefined,
    reloadRequired: true,
    async commit() {
      await ensureConsoleCommitTarget({
        runtimeLocation: snapshot.runtimeLocation,
        scope: snapshot.scope,
      });
      applyRuntimeConfigControlOperation({
        target: resolveRuntimeConfigScopeTarget({
          runtimeLocation: snapshot.runtimeLocation,
          ...(context.env === undefined ? {} : {env: context.env}),
          scope: snapshot.scope,
        }),
        pluginManifests: consoleCatalogManifests(context),
        expectedFingerprint: fingerprint,
        request: {kind: 'plugin_activation', manifest},
      });
    },
  };
}

async function stagePluginActivationChange(
  context: RuntimeConfigConsoleContext,
  manifest: RuntimePluginManifest,
  enabled: boolean,
  fingerprint: string,
  snapshot: RuntimeConfigConsoleSnapshot,
): Promise<StagedRuntimeConfigChange | undefined> {
  writeLine(context.stdout, '1) Enable');
  writeLine(context.stdout, '2) Disable');
  writeLine(context.stdout, '3) Cancel');

  const action = await askForNumber(context, 'Choose an action: ', 3);

  if (action === undefined || action === 3) {
    writeLine(context.stdout, 'Change cancelled.');
    return undefined;
  }

  const nextEnabled = action === 1;

  if (nextEnabled === enabled) {
    writeLine(
      context.stdout,
      `Plugin ${manifest.id} is already ${enabled ? 'enabled' : 'disabled'}.`,
    );
    return undefined;
  }

  return {
    target: `plugins.${manifest.id}.enabled`,
    oldValue: enabled,
    newValue: nextEnabled,
    reloadRequired: true,
    async commit() {
      await ensureConsoleCommitTarget({
        runtimeLocation: snapshot.runtimeLocation,
        scope: snapshot.scope,
      });
      const target = resolveRuntimeConfigScopeTarget({
        runtimeLocation: snapshot.runtimeLocation,
        ...(context.env === undefined ? {} : {env: context.env}),
        scope: snapshot.scope,
      });

      applyRuntimeConfigControlOperation({
        target,
        pluginManifests: consoleCatalogManifests(context),
        expectedFingerprint: fingerprint,
        request: {
          kind: 'plugin_activation',
          manifest,
          enabled: nextEnabled,
        },
      });
    },
  };
}

async function stagePluginFieldChange(
  context: RuntimeConfigConsoleContext,
  manifest: RuntimePluginManifest,
  field: RuntimePluginConfigField,
  inspectedField: RuntimePluginConfigFieldInspectShape,
  fingerprint: string,
  snapshot: RuntimeConfigConsoleSnapshot,
): Promise<StagedRuntimeConfigChange | undefined> {
  writeLine(context.stdout, '1) Set');
  if (!field.required) {
    writeLine(context.stdout, '2) Unset');
    writeLine(context.stdout, '3) Cancel');
  } else {
    writeLine(context.stdout, '2) Cancel');
  }

  const action = await askForNumber(
    context,
    'Choose an action: ',
    field.required ? 2 : 3,
  );
  const cancelAction = field.required ? 2 : 3;

  if (action === undefined || action === cancelAction) {
    writeLine(context.stdout, 'Change cancelled.');
    return undefined;
  }

  const oldValue = inspectedField.authored.configured
    ? inspectedField.authored.value
    : undefined;
  let operation:
    | {
        readonly kind: 'set';
        readonly fieldName: string;
        readonly value: RuntimeConfigValue;
      }
    | {readonly kind: 'unset'; readonly fieldName: string};
  let newValue: RuntimeConfigValue | undefined;

  if (!field.required && action === 2) {
    if (!inspectedField.authored.configured) {
      writeLine(context.stdout, `Field ${field.name} is already unset.`);
      return undefined;
    }

    operation = {kind: 'unset', fieldName: field.name};
  } else {
    const value = await askForFieldValue(context, field);

    if (value === cancelled) {
      writeLine(context.stdout, 'Change cancelled.');
      return undefined;
    }

    operation = {kind: 'set', fieldName: field.name, value};
    newValue = redactRuntimeConfigValue(value, {key: field.name});
  }

  return {
    target: `plugins.${manifest.id}.config.${field.name}`,
    oldValue,
    newValue,
    reloadRequired: field.reloadRequired !== false,
    async commit() {
      await ensureConsoleCommitTarget({
        runtimeLocation: snapshot.runtimeLocation,
        scope: snapshot.scope,
      });
      const runtimeEnv = context.runtimeEnv ?? context.env;
      const target = resolveRuntimeConfigScopeTarget({
        runtimeLocation: snapshot.runtimeLocation,
        ...(runtimeEnv === undefined ? {} : {env: runtimeEnv}),
        scope: snapshot.scope,
      });

      applyRuntimeConfigControlOperation({
        target,
        pluginManifests: consoleCatalogManifests(context),
        expectedFingerprint: fingerprint,
        request: {
          kind: 'plugin_config',
          manifest,
          actor: 'operator',
          fieldOperation: operation,
        },
      });
    },
  };
}

function pluginCatalog(
  context: RuntimeConfigConsoleContext,
  snapshot: RuntimeConfigConsoleSnapshot,
): RuntimeConfigConsolePluginCatalog {
  const activationPlan = prepareConfiguredProject02PluginActivation({
    loadedConfig: snapshot.loadedConfig,
    runtimeLocation: snapshot.runtimeLocation,
    // The scope may be a flag override the loaded config does not name.
    ...(snapshot.scope === 'global'
      ? {}
      : {
          overlayConfig: snapshot.overlay,
        }),
    ...(context.runtimeEnv === undefined && context.env === undefined
      ? {}
      : {env: context.runtimeEnv ?? context.env}),
    catalogSnapshot: context.catalogSnapshot,
  });
  const entriesById = new Map<string, RuntimeConfigConsolePluginEntry>();

  for (const definition of Object.values(activationPlan.catalogEntries)) {
    entriesById.set(
      definition.manifest.id,
      Object.freeze({
        manifest: definition.manifest,
        section:
          definition.catalogKind === 'host_service'
            ? 'system_service'
            : 'plugin',
      }),
    );
  }

  const entries = [...entriesById.values()];

  return Object.freeze({
    entries: Object.freeze([
      ...entries
        .filter(entry => entry.section === 'plugin')
        .sort((left, right) =>
          left.manifest.id.localeCompare(right.manifest.id),
        ),
      ...entries
        .filter(entry => entry.section === 'system_service')
        .sort((left, right) =>
          left.manifest.id.localeCompare(right.manifest.id),
        ),
    ]),
    activationByPluginId:
      activationPlan.pluginConfigControl.activationByPluginId ??
      Object.freeze({}),
    defaultEnabledPluginIds:
      activationPlan.pluginConfigControl.defaultEnabledPluginIds ??
      Object.freeze([]),
  });
}

function writePluginEntries(
  stdout: NodeJS.WritableStream,
  entries: readonly RuntimeConfigConsolePluginEntry[],
): void {
  const sections = [
    {heading: 'Plugins', section: 'plugin'},
    {heading: 'System services', section: 'system_service'},
  ] as const;
  let index = 0;

  for (const {heading, section} of sections) {
    const sectionEntries = entries.filter(entry => entry.section === section);

    if (sectionEntries.length === 0) {
      continue;
    }

    writeLine(stdout, heading);
    for (const entry of sectionEntries) {
      index += 1;
      writeLine(
        stdout,
        `${String(index)}) ${entry.manifest.displayName} (${entry.manifest.id})`,
      );
    }
  }
}

/** Read-only here means another scope owns the setting, not that it is fixed. */
function readOnlyMarker(editableInScope: boolean): string {
  return editableInScope ? '' : ' (read-only in this scope)';
}

function writeScopeRestriction(
  context: RuntimeConfigConsoleContext,
  manifest: RuntimePluginManifest,
  scope: RuntimeConfigFieldScope,
  operation: RuntimePluginScopeOperation,
): void {
  const violation = runtimePluginScopeViolation({
    manifest,
    authoredScope: scope,
    operation,
  });

  writeLine(context.stdout, '');
  writeLine(
    context.stdout,
    violation?.message ?? 'This setting cannot be changed in this scope.',
  );
}

function writeSecretConfigInstructions(
  context: RuntimeConfigConsoleContext,
  manifest: RuntimePluginManifest,
  field: RuntimePluginConfigField,
  snapshot: RuntimeConfigConsoleSnapshot,
): void {
  const envVar = pluginSecretEnvVarName(manifest.id, field);
  const commandArgs = [
    // At character scope the value lands in this character's own secrets
    // file, so two characters can hold different accounts for one plugin.
    ...(snapshot.scope === 'character'
      ? [
          '--character',
          shellQuoteCommandArgument(
            snapshot.runtimeLocation.characterScope.characterId,
          ),
        ]
      : []),
    'secret',
    'set',
    shellQuoteCommandArgument(manifest.id),
    shellQuoteCommandArgument(field.name),
    shellQuoteCommandArgument(envVar),
  ];

  writeLine(
    context.stdout,
    'Secret values are not displayed or entered in this console.',
  );
  writeLine(context.stdout, `Set ${envVar} in the environment, then run:`);
  writeLine(
    context.stdout,
    `${context.secretSetCommandPrefix} -- ${commandArgs.join(' ')}`,
  );
}
