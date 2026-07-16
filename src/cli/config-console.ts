import { createInterface } from 'node:readline/promises';

import type {
  RuntimePluginConfigField,
  RuntimePluginManifest
} from '../plugins/plugin-types.ts';
import {
  applyRuntimeConfigControlOperation,
  applyRuntimePluginConfigControlOperation,
  createProject02RuntimeConfigFingerprint,
  createRuntimeConfigMutationBase,
  getRedactedRuntimeConfigValueAtPath,
  inspectRuntimePluginConfig,
  loadProject02RuntimeConfig,
  project02RuntimeConfigFieldDefinitions,
  redactRuntimeConfigText,
  redactRuntimeConfigValue,
  runtimeConfigValueMatchesField,
  type Project02ConfigFieldDefinition,
  type RuntimeConfigDiagnostic,
  type RuntimeConfigMutationOperation,
  type RuntimeConfigValue,
  type RuntimePluginConfigActivationInspectShape,
  type RuntimePluginConfigFieldInspectShape
} from '../runtime/config/index.ts';
import { prepareConfiguredProject02PluginActivation, type RuntimePluginFactoryDefinition } from '../app/index.ts';
import { ownJsonRecordValue } from '../shared/json-boundary.ts';

export type RuntimeConfigConsolePromptAdapter = {
  question(prompt: string): Promise<string | undefined>;
};

export type RuntimeConfigConsoleOptions = {
  readonly stdout: NodeJS.WritableStream;
  readonly stdin?: NodeJS.ReadableStream;
  readonly env?: NodeJS.ProcessEnv;
  readonly runtimeEnv?: NodeJS.ProcessEnv;
  readonly configPath?: string;
  readonly storeRoot?: string;
  readonly factories?: Readonly<Record<string, RuntimePluginFactoryDefinition>>;
  readonly prompt?: RuntimeConfigConsolePromptAdapter;
};

type RuntimeConfigConsoleContext = RuntimeConfigConsoleOptions & {
  readonly prompt: RuntimeConfigConsolePromptAdapter;
};

type RuntimeConfigConsoleSnapshot = {
  readonly loadedConfig: ReturnType<typeof loadProject02RuntimeConfig>;
  readonly config: ReturnType<typeof createRuntimeConfigMutationBase>;
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
  readonly fingerprint: string;
};

type StagedRuntimeConfigChange = {
  readonly target: string;
  readonly oldValue: RuntimeConfigValue | undefined;
  readonly newValue: RuntimeConfigValue | undefined;
  readonly reloadRequired: boolean;
  commit(): void;
};

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

const cancelled = Symbol('runtime-config-console-cancelled');

export async function runRuntimeConfigConsole(
  options: RuntimeConfigConsoleOptions
): Promise<number> {
  const ownedPrompt = options.prompt === undefined
    ? createDefaultPrompt(options.stdin ?? process.stdin, options.stdout)
    : undefined;
  const prompt = options.prompt ?? ownedPrompt?.prompt;

  if (prompt === undefined) {
    throw new TypeError('Runtime config console prompt could not be created.');
  }

  const context: RuntimeConfigConsoleContext = {
    ...options,
    prompt
  };

  try {
    const snapshot = loadConsoleSnapshot(context);

    writeLine(context.stdout, 'Project02 Runtime Config');
    writeDiagnostics(context.stdout, snapshot.diagnostics);
    writeLine(context.stdout, '1) Project02');
    writeLine(context.stdout, '2) Plugins');
    writeLine(context.stdout, 'q) Quit');

    const section = await askForNumber(context, 'Select a section: ', 2);

    if (section === undefined) {
      return 0;
    }

    if (section === 1) {
      await runProject02ConfigSection(context, snapshot);
    } else {
      await runPluginConfigSection(context, snapshot);
    }

    return 0;
  } finally {
    ownedPrompt?.close();
  }
}

async function runProject02ConfigSection(
  context: RuntimeConfigConsoleContext,
  snapshot: RuntimeConfigConsoleSnapshot
): Promise<void> {
  const fields = project02RuntimeConfigFieldDefinitions();

  writeLine(context.stdout, '');
  writeLine(context.stdout, 'Project02');
  fields.forEach((field, index) => {
    const currentValue = getRedactedRuntimeConfigValueAtPath(
      snapshot.config,
      field.path
    );

    writeLine(
      context.stdout,
      `${String(index + 1)}) ${field.label}: ${formatCurrentValue(currentValue, field.defaultValueSummary)}`
    );
  });

  const selected = await askForNumber(
    context,
    'Select a Project02 field: ',
    fields.length
  );
  const field = selected === undefined ? undefined : fields[selected - 1];

  if (field === undefined) {
    return;
  }

  const change = await stageProject02FieldChange(context, snapshot, field);

  if (change !== undefined) {
    await previewAndCommitChange(context, change);
  }
}

async function stageProject02FieldChange(
  context: RuntimeConfigConsoleContext,
  snapshot: RuntimeConfigConsoleSnapshot,
  field: Project02ConfigFieldDefinition
): Promise<StagedRuntimeConfigChange | undefined> {
  writeLine(context.stdout, '1) Set');
  writeLine(context.stdout, '2) Unset');
  writeLine(context.stdout, '3) Cancel');

  const action = await askForNumber(context, 'Choose an action: ', 3);

  if (action === undefined || action === 3) {
    writeLine(context.stdout, 'Change cancelled.');
    return undefined;
  }

  const oldValue = getRedactedRuntimeConfigValueAtPath(snapshot.config, field.path);
  let operation: RuntimeConfigMutationOperation;
  let newValue: RuntimeConfigValue | undefined;

  if (action === 2) {
    operation = { kind: 'unset', path: field.path };
  } else {
    const value = await askForFieldValue(context, field);

    if (value === cancelled) {
      writeLine(context.stdout, 'Change cancelled.');
      return undefined;
    }

    newValue = redactRuntimeConfigValue(value, { key: field.name });
    operation = { kind: 'set', path: field.path, value };
  }

  return {
    target: field.path,
    oldValue,
    newValue,
    reloadRequired: field.reloadRequired,
    commit() {
      applyRuntimeConfigControlOperation({
        ...runtimeConfigLocation(context),
        ...(context.env === undefined ? {} : { env: context.env }),
        expectedFingerprint: snapshot.fingerprint,
        operation
      });
    }
  };
}

async function runPluginConfigSection(
  context: RuntimeConfigConsoleContext,
  snapshot: RuntimeConfigConsoleSnapshot
): Promise<void> {
  const catalog = pluginCatalog(context, snapshot);
  const entries = catalog.entries;
  const manifests = Object.freeze(entries.map((entry) => entry.manifest));

  writeLine(context.stdout, '');

  if (entries.length === 0) {
    writeLine(context.stdout, 'No plugins are available.');
    return;
  }

  writePluginEntries(context.stdout, entries);

  const selected = await askForNumber(context, 'Select a plugin: ', entries.length);
  const manifest = selected === undefined
    ? undefined
    : entries[selected - 1]?.manifest;

  if (manifest === undefined) {
    return;
  }

  const activation = ownJsonRecordValue(
    catalog.activationByPluginId,
    manifest.id
  );

  const inspected = inspectRuntimePluginConfig({
    ...runtimeConfigLocation(context),
    ...(context.runtimeEnv === undefined && context.env === undefined
      ? {}
      : { env: context.runtimeEnv ?? context.env }),
    manifest,
    pluginManifests: manifests,
    ...(activation === undefined ? {} : { activation }),
    defaultEnabled: catalog.defaultEnabledPluginIds.includes(manifest.id)
  });

  writeLine(context.stdout, '');
  writeLine(context.stdout, `${inspected.displayName} (${inspected.pluginId})`);
  writeLine(context.stdout, `1) Enabled: ${String(inspected.enabled)}`);
  inspected.fields.forEach((field, index) => {
    writeLine(
      context.stdout,
      `${String(index + 2)}) ${field.name}: ${formatInspectedFieldValue(field)}`
    );
  });
  writeDiagnostics(context.stdout, inspected.diagnostics);

  const item = await askForNumber(
    context,
    'Select a plugin setting: ',
    inspected.fields.length + 1
  );

  if (item === undefined) {
    return;
  }

  if (item === 1) {
    const change = await stagePluginActivationChange(
      context,
      manifest,
      inspected.enabled,
      inspected.fingerprint
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
    inspected.fingerprint
  );

  if (change !== undefined) {
    await previewAndCommitChange(context, change);
  }
}

async function stagePluginActivationChange(
  context: RuntimeConfigConsoleContext,
  manifest: RuntimePluginManifest,
  enabled: boolean,
  fingerprint: string
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
      `Plugin ${manifest.id} is already ${enabled ? 'enabled' : 'disabled'}.`
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
        ...(context.env === undefined ? {} : { env: context.env }),
        expectedFingerprint: fingerprint,
        operation: {
          kind: nextEnabled ? 'plugin_enable' : 'plugin_disable',
          pluginId: manifest.id
        }
      });
    }
  };
}

async function stagePluginFieldChange(
  context: RuntimeConfigConsoleContext,
  manifest: RuntimePluginManifest,
  field: RuntimePluginConfigField,
  inspectedField: RuntimePluginConfigFieldInspectShape,
  fingerprint: string
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
    field.required ? 2 : 3
  );
  const cancelAction = field.required ? 2 : 3;

  if (action === undefined || action === cancelAction) {
    writeLine(context.stdout, 'Change cancelled.');
    return undefined;
  }

  const oldValue = inspectedField.authored.configured
    ? inspectedField.authored.value
    : undefined;
  let operation: { readonly kind: 'set'; readonly fieldName: string; readonly value: RuntimeConfigValue } |
    { readonly kind: 'unset'; readonly fieldName: string };
  let newValue: RuntimeConfigValue | undefined;

  if (!field.required && action === 2) {
    if (!inspectedField.authored.configured) {
      writeLine(context.stdout, `Field ${field.name} is already unset.`);
      return undefined;
    }

    operation = { kind: 'unset', fieldName: field.name };
  } else {
    const value = await askForFieldValue(context, field);

    if (value === cancelled) {
      writeLine(context.stdout, 'Change cancelled.');
      return undefined;
    }

    operation = { kind: 'set', fieldName: field.name, value };
    newValue = redactRuntimeConfigValue(value, { key: field.name });
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
          : { env: context.runtimeEnv ?? context.env }),
        manifest,
        actor: 'operator',
        expectedFingerprint: fingerprint,
        operation
      });
    }
  };
}

async function previewAndCommitChange(
  context: RuntimeConfigConsoleContext,
  change: StagedRuntimeConfigChange
): Promise<void> {
  writeLine(context.stdout, '');
  writeLine(context.stdout, `Target: ${change.target}`);
  writeLine(context.stdout, `Old: ${formatPreviewValue(change.oldValue)}`);
  writeLine(context.stdout, `New: ${formatPreviewValue(change.newValue)}`);
  writeLine(context.stdout, '1) Save');
  writeLine(context.stdout, '2) Cancel');

  const decision = await askForNumber(context, 'Commit this change: ', 2);

  if (decision !== 1) {
    writeLine(context.stdout, 'Change cancelled.');
    return;
  }

  change.commit();
  writeLine(context.stdout, `Saved ${change.target}.`);

  if (change.reloadRequired) {
    writeLine(context.stdout, 'This change takes effect after the runtime reloads.');
  }
}

async function askForFieldValue(
  context: RuntimeConfigConsoleContext,
  field: RuntimePluginConfigField
): Promise<RuntimeConfigValue | typeof cancelled> {
  for (;;) {
    const answer = await context.prompt.question(`New ${field.name}: `);

    if (answer === undefined) {
      return cancelled;
    }

    const parsed = parseRuntimeConfigFieldValue(answer, field);

    if (parsed.ok) {
      return parsed.value;
    }

    writeLine(context.stdout, parsed.message);
  }
}

function parseRuntimeConfigFieldValue(
  answer: string,
  field: RuntimePluginConfigField
):
  | { readonly ok: true; readonly value: RuntimeConfigValue }
  | { readonly ok: false; readonly message: string } {
  const trimmed = answer.trim();
  const parsed = parseValueForType(trimmed, field.valueType);

  if (parsed === undefined || !runtimeConfigValueMatchesField(parsed, field)) {
    return {
      ok: false,
      message: fieldValueErrorMessage(field)
    };
  }

  return { ok: true, value: parsed };
}

function parseValueForType(
  value: string,
  valueType: RuntimePluginConfigField['valueType']
): RuntimeConfigValue | undefined {
  if (valueType === 'string' || valueType === 'path' || valueType === 'enum') {
    return value;
  }

  if (valueType === 'boolean') {
    if (value === 'true') {
      return true;
    }
    if (value === 'false') {
      return false;
    }
    return undefined;
  }

  if (valueType === 'secret') {
    return undefined;
  }

  try {
    return JSON.parse(value) as RuntimeConfigValue;
  } catch {
    return valueType === undefined ? value : undefined;
  }
}

function fieldValueErrorMessage(field: RuntimePluginConfigField): string {
  if (field.allowedValues !== undefined) {
    return `Expected one of: ${field.allowedValues.join(', ')}.`;
  }

  switch (field.valueType) {
    case 'number':
      return 'Expected a JSON number.';
    case 'boolean':
      return 'Expected true or false.';
    case 'object':
      return 'Expected a JSON object.';
    case 'array':
      return 'Expected a JSON array.';
    case 'secret':
      return 'Secret values must be managed through secret set.';
    case 'string':
    case 'path':
    case 'enum':
    case undefined:
      return 'Value does not match the field metadata.';
  }

  return 'Value does not match the field metadata.';
}

async function askForNumber(
  context: RuntimeConfigConsoleContext,
  question: string,
  maximum: number
): Promise<number | undefined> {
  for (;;) {
    const answer = (await context.prompt.question(question))?.trim();

    if (answer === undefined || answer.toLowerCase() === 'q') {
      return undefined;
    }

    const value = Number(answer);

    if (Number.isInteger(value) && value >= 1 && value <= maximum) {
      return value;
    }

    writeLine(
      context.stdout,
      `Choose a number from 1 to ${String(maximum)}, or q to quit.`
    );
  }
}

function loadConsoleSnapshot(
  context: RuntimeConfigConsoleContext
): RuntimeConfigConsoleSnapshot {
  const loaded = loadProject02RuntimeConfig({
    ...runtimeConfigLocation(context),
    ...(context.env === undefined ? {} : { env: context.env })
  });
  let blockingDiagnostic: (typeof loaded.diagnostics)[number] | undefined;
  const diagnostics: (typeof loaded.diagnostics)[number][] = [];

  for (const diagnostic of loaded.diagnostics) {
    if (diagnostic.code !== 'runtime_config_missing') {
      diagnostics.push(diagnostic);
    }

    if (
      blockingDiagnostic === undefined &&
      diagnostic.severity === 'error' &&
      diagnostic.code !== 'runtime_config_missing'
    ) {
      blockingDiagnostic = diagnostic;
    }
  }

  if (blockingDiagnostic !== undefined) {
    throw new TypeError(
      `Cannot open config console because the runtime config is invalid: ${blockingDiagnostic.message}`
    );
  }

  const config = createRuntimeConfigMutationBase({
    loadedConfig: loaded,
    ...runtimeConfigLocation(context)
  });

  return Object.freeze({
    loadedConfig: loaded,
    config,
    diagnostics: Object.freeze(diagnostics),
    fingerprint: createProject02RuntimeConfigFingerprint(config)
  });
}

function pluginCatalog(
  context: RuntimeConfigConsoleContext,
  snapshot: RuntimeConfigConsoleSnapshot
): RuntimeConfigConsolePluginCatalog {
  const activationPlan = prepareConfiguredProject02PluginActivation({
    loadedConfig: snapshot.loadedConfig,
    ...(context.storeRoot === undefined
      ? {}
      : { storeRoot: context.storeRoot }),
    ...(context.runtimeEnv === undefined && context.env === undefined
      ? {}
      : { env: context.runtimeEnv ?? context.env }),
    ...(context.factories === undefined
      ? {}
      : { factories: context.factories })
  });
  const entriesById = new Map<string, RuntimeConfigConsolePluginEntry>();

  for (const definition of Object.values(activationPlan.catalogEntries)) {
    entriesById.set(definition.manifest.id, Object.freeze({
      manifest: definition.manifest,
      section:
        definition.catalogKind === 'host_service'
          ? 'system_service'
          : 'plugin'
    }));
  }

  const entries = [...entriesById.values()];

  return Object.freeze({
    entries: Object.freeze([
      ...entries
        .filter((entry) => entry.section === 'plugin')
        .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id)),
      ...entries
        .filter((entry) => entry.section === 'system_service')
        .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id))
    ]),
    activationByPluginId:
      activationPlan.pluginConfigControl.activationByPluginId ??
      Object.freeze({}),
    defaultEnabledPluginIds:
      activationPlan.pluginConfigControl.defaultEnabledPluginIds ??
      Object.freeze([])
  });
}

function writePluginEntries(
  stdout: NodeJS.WritableStream,
  entries: readonly RuntimeConfigConsolePluginEntry[]
): void {
  const sections = [
    { heading: 'Plugins', section: 'plugin' },
    { heading: 'System services', section: 'system_service' }
  ] as const;
  let index = 0;

  for (const { heading, section } of sections) {
    const sectionEntries = entries.filter((entry) => entry.section === section);

    if (sectionEntries.length === 0) {
      continue;
    }

    writeLine(stdout, heading);
    for (const entry of sectionEntries) {
      index += 1;
      writeLine(
        stdout,
        `${String(index)}) ${entry.manifest.displayName} (${entry.manifest.id})`
      );
    }
  }
}

function formatInspectedFieldValue(
  field: RuntimePluginConfigFieldInspectShape
): string {
  const value = field.authored.configured
    ? field.authored.value
    : field.effective.value;
  const suffix = field.authored.configured
    ? 'authored'
    : field.effective.source;

  return `${formatCurrentValue(value, field.defaultValueSummary)} [${suffix}]`;
}

function formatCurrentValue(
  value: RuntimeConfigValue | undefined,
  defaultValueSummary?: string
): string {
  if (value !== undefined) {
    return formatPreviewValue(value);
  }

  return defaultValueSummary === undefined
    ? '(unset)'
    : `(unset; default: ${redactRuntimeConfigText(defaultValueSummary)})`;
}

function formatPreviewValue(value: RuntimeConfigValue | undefined): string {
  return value === undefined ? '(unset)' : JSON.stringify(value);
}

function writeSecretConfigInstructions(
  context: RuntimeConfigConsoleContext,
  manifest: RuntimePluginManifest,
  field: RuntimePluginConfigField
): void {
  const locationArgs = [
    ...(context.storeRoot === undefined
      ? []
      : ['--store', shellQuote(context.storeRoot)]),
    ...(context.configPath === undefined
      ? []
      : ['--config', shellQuote(context.configPath)])
  ];
  const envVar = field.envVar ?? suggestedSecretEnvVar(manifest.id, field.name);
  const commandArgs = [
    'secret',
    'set',
    shellQuote(manifest.id),
    shellQuote(field.name),
    shellQuote(envVar)
  ];

  writeLine(
    context.stdout,
    'Secret values are not displayed or entered in this console.'
  );
  writeLine(
    context.stdout,
    `Set ${envVar} in the environment, then run:`
  );
  writeLine(
    context.stdout,
    `pnpm runtime-config${locationArgs.length === 0 ? '' : ` ${locationArgs.join(' ')}`} -- ${commandArgs.join(' ')}`
  );
}

function writeDiagnostics(
  stdout: NodeJS.WritableStream,
  diagnostics: readonly RuntimeConfigDiagnostic[]
): void {
  if (diagnostics.length === 0) {
    return;
  }

  writeLine(stdout, 'Diagnostics:');
  for (const diagnostic of diagnostics) {
    writeLine(
      stdout,
      `- ${diagnostic.severity}: ${redactRuntimeConfigText(diagnostic.message)}`
    );
  }
}

function runtimeConfigLocation(options: {
  readonly configPath?: string;
  readonly storeRoot?: string;
}): { readonly configPath?: string; readonly storeRoot?: string } {
  return {
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot })
  };
}

function suggestedSecretEnvVar(pluginId: string, fieldName: string): string {
  return `${pluginId}_${fieldName}`.replaceAll(/[^A-Za-z0-9]+/g, '_').toUpperCase();
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function writeLine(stdout: NodeJS.WritableStream, value: string): void {
  stdout.write(`${value}\n`);
}

function createDefaultPrompt(
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream
): {
  readonly prompt: RuntimeConfigConsolePromptAdapter;
  close(): void;
} {
  let closed = false;
  let inputError: Error | undefined;
  let rejectActiveQuestion: ((error: Error) => void) | undefined;

  const handleInputError = (error: unknown): void => {
    const detail =
      error instanceof Error && error.message.trim().length > 0
        ? `: ${error.message}`
        : '';
    const normalizedError = new TypeError(
      `Could not read runtime config console input${detail}.`,
      { cause: error }
    );

    inputError = normalizedError;
    rejectActiveQuestion?.(normalizedError);
  };
  stdin.on('error', handleInputError);
  const readline = createInterface({ input: stdin, output: stdout });

  readline.once('close', () => {
    closed = true;
  });
  readline.on('error', handleInputError);

  return {
    prompt: Object.freeze({
      question(prompt: string): Promise<string | undefined> {
        if (closed) {
          return Promise.resolve(undefined);
        }

        if (inputError !== undefined) {
          return Promise.reject(inputError);
        }

        return new Promise<string | undefined>((resolve, reject) => {
          let settled = false;
          const settle = (answer: string | undefined): void => {
            if (settled) {
              return;
            }

            settled = true;
            rejectActiveQuestion = undefined;
            readline.off('close', handleClose);
            resolve(answer);
          };
          const rejectQuestion = (error: Error): void => {
            if (settled) {
              return;
            }

            settled = true;
            rejectActiveQuestion = undefined;
            readline.off('close', handleClose);
            reject(error);
          };
          const handleClose = (): void => {
            settle(undefined);
          };

          rejectActiveQuestion = rejectQuestion;
          readline.once('close', handleClose);
          void (async () => {
            try {
              settle(await readline.question(prompt));
            } catch (error: unknown) {
              rejectQuestion(
                error instanceof Error
                  ? error
                  : new TypeError('Could not read runtime config console input.', {
                      cause: error
                    })
              );
            }
          })();
        });
      }
    }),
    close() {
      stdin.off('error', handleInputError);
      readline.off('error', handleInputError);
      readline.close();
    }
  };
}
