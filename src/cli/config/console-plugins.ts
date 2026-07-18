/**
 * Plugin section of the runtime config console: builds the plugin
 * catalog from the activation plan, inspects per-plugin config, and
 * stages enable/disable and field changes (secrets are directed to the
 * secret set command instead).
 */
import type {
  RuntimePluginConfigField,
  RuntimePluginManifest,
} from '../../plugins/api/index.ts';
import {
  applyRuntimeConfigControlOperation,
  applyRuntimePluginConfigControlOperation,
  inspectRuntimePluginConfig,
  redactRuntimeConfigValue,
  type RuntimeConfigValue,
  type RuntimePluginConfigActivationInspectShape,
  type RuntimePluginConfigFieldInspectShape,
} from '../../runtime/config/index.ts';
import {prepareConfiguredProject02PluginActivation} from '../../app/index.ts';
import {ownJsonRecordValue} from '../../shared/json-boundary.ts';
import {
  askForFieldValue,
  askForNumber,
  cancelled,
  formatInspectedFieldValue,
  previewAndCommitChange,
  runtimeConfigLocation,
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
    Record<string, RuntimePluginConfigActivationInspectShape>
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
    ...runtimeConfigLocation(context),
    ...(context.runtimeEnv === undefined && context.env === undefined
      ? {}
      : {env: context.runtimeEnv ?? context.env}),
    manifest,
    pluginManifests: manifests,
    ...(activation === undefined ? {} : {activation}),
    defaultEnabled: catalog.defaultEnabledPluginIds.includes(manifest.id),
  });

  writeLine(context.stdout, '');
  writeLine(context.stdout, `${inspected.displayName} (${inspected.pluginId})`);
  writeLine(context.stdout, `1) Enabled: ${String(inspected.enabled)}`);
  inspected.fields.forEach((field, index) => {
    writeLine(
      context.stdout,
      `${String(index + 2)}) ${field.name}: ${formatInspectedFieldValue(field)}`,
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
    const change = await stagePluginActivationChange(
      context,
      manifest,
      inspected.enabled,
      inspected.fingerprint,
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

  if (field.secret) {
    writeSecretConfigInstructions(context, manifest, field);
    return;
  }

  const change = await stagePluginFieldChange(
    context,
    manifest,
    field,
    inspectedField,
    inspected.fingerprint,
  );

  if (change !== undefined) {
    await previewAndCommitChange(context, change);
  }
}

async function stagePluginActivationChange(
  context: RuntimeConfigConsoleContext,
  manifest: RuntimePluginManifest,
  enabled: boolean,
  fingerprint: string,
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
    commit() {
      applyRuntimeConfigControlOperation({
        ...runtimeConfigLocation(context),
        ...(context.env === undefined ? {} : {env: context.env}),
        expectedFingerprint: fingerprint,
        operation: {
          kind: nextEnabled ? 'plugin_enable' : 'plugin_disable',
          pluginId: manifest.id,
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
    reloadRequired: field.reloadRequired === true,
    commit() {
      applyRuntimePluginConfigControlOperation({
        ...runtimeConfigLocation(context),
        ...(context.runtimeEnv === undefined && context.env === undefined
          ? {}
          : {env: context.runtimeEnv ?? context.env}),
        manifest,
        actor: 'operator',
        expectedFingerprint: fingerprint,
        operation,
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
    ...(context.storeRoot === undefined ? {} : {storeRoot: context.storeRoot}),
    ...(context.runtimeEnv === undefined && context.env === undefined
      ? {}
      : {env: context.runtimeEnv ?? context.env}),
    ...(context.factories === undefined ? {} : {factories: context.factories}),
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

function writeSecretConfigInstructions(
  context: RuntimeConfigConsoleContext,
  manifest: RuntimePluginManifest,
  field: RuntimePluginConfigField,
): void {
  const locationArgs = [
    ...(context.storeRoot === undefined
      ? []
      : ['--store', shellQuote(context.storeRoot)]),
    ...(context.configPath === undefined
      ? []
      : ['--config', shellQuote(context.configPath)]),
  ];
  const envVar = field.envVar ?? suggestedSecretEnvVar(manifest.id, field.name);
  const commandArgs = [
    'secret',
    'set',
    shellQuote(manifest.id),
    shellQuote(field.name),
    shellQuote(envVar),
  ];

  writeLine(
    context.stdout,
    'Secret values are not displayed or entered in this console.',
  );
  writeLine(context.stdout, `Set ${envVar} in the environment, then run:`);
  writeLine(
    context.stdout,
    `pnpm runtime-config${locationArgs.length === 0 ? '' : ` ${locationArgs.join(' ')}`} -- ${commandArgs.join(' ')}`,
  );
}

function suggestedSecretEnvVar(pluginId: string, fieldName: string): string {
  return `${pluginId}_${fieldName}`
    .replaceAll(/[^A-Za-z0-9]+/g, '_')
    .toUpperCase();
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
