/**
 * Shared plumbing of the runtime config console: option/context/
 * snapshot types, the staged-change preview/commit protocol, and the
 * prompt, parse, format, and output helpers both sections use.
 */
import type {RuntimePluginConfigField} from '../../plugins/api/index.ts';
import {
  redactRuntimeConfigText,
  runtimeConfigDiagnosticAttribution,
  runtimeConfigValueMatchesField,
  type createRuntimeConfigMutationBase,
  type loadProject02RuntimeConfig,
  type Project02RuntimeConfig,
  type RuntimeConfigCharacterScope,
  type RuntimeConfigDiagnostic,
  type RuntimeConfigValue,
  type RuntimePluginConfigFieldInspectShape,
} from '../../runtime/config/index.ts';
import type {RuntimePluginFactoryDefinition} from '../../app/index.ts';

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
  /** Present when the console operates on one character's overlay. */
  readonly character?: string;
  readonly factories?: Readonly<Record<string, RuntimePluginFactoryDefinition>>;
  readonly prompt?: RuntimeConfigConsolePromptAdapter;
};

export type RuntimeConfigConsoleContext = RuntimeConfigConsoleOptions & {
  readonly prompt: RuntimeConfigConsolePromptAdapter;
};

export type RuntimeConfigConsoleSnapshot = {
  readonly loadedConfig: ReturnType<typeof loadProject02RuntimeConfig>;
  readonly config: ReturnType<typeof createRuntimeConfigMutationBase>;
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
  readonly fingerprint: string;
  /** Set when the console operates on one character's overlay. */
  readonly characterScope?: RuntimeConfigCharacterScope;
  /** The overlay document the scoped sections display and edit. */
  readonly scopedConfig?: Project02RuntimeConfig;
};

export type StagedRuntimeConfigChange = {
  readonly target: string;
  readonly oldValue: RuntimeConfigValue | undefined;
  readonly newValue: RuntimeConfigValue | undefined;
  readonly reloadRequired: boolean;
  commit(): void;
};

export const cancelled = Symbol('runtime-config-console-cancelled');

export async function previewAndCommitChange(
  context: RuntimeConfigConsoleContext,
  change: StagedRuntimeConfigChange,
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
    writeLine(
      context.stdout,
      'This change takes effect after the runtime reloads.',
    );
  }
}

export async function askForFieldValue(
  context: RuntimeConfigConsoleContext,
  field: RuntimePluginConfigField,
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
  field: RuntimePluginConfigField,
):
  | {readonly ok: true; readonly value: RuntimeConfigValue}
  | {readonly ok: false; readonly message: string} {
  const trimmed = answer.trim();
  const parsed = parseValueForType(trimmed, field.valueType);

  if (parsed === undefined || !runtimeConfigValueMatchesField(parsed, field)) {
    return {
      ok: false,
      message: fieldValueErrorMessage(field),
    };
  }

  return {ok: true, value: parsed};
}

function parseValueForType(
  value: string,
  valueType: RuntimePluginConfigField['valueType'],
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

export async function askForNumber(
  context: RuntimeConfigConsoleContext,
  question: string,
  maximum: number,
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
      `Choose a number from 1 to ${String(maximum)}, or q to quit.`,
    );
  }
}

export function formatInspectedFieldValue(
  field: RuntimePluginConfigFieldInspectShape,
): string {
  const value = field.authored.configured
    ? field.authored.value
    : field.effective.value;
  const suffix = field.authored.configured
    ? 'authored'
    : field.effective.source;

  return `${formatCurrentValue(value, field.defaultValueSummary)} [${suffix}]`;
}

export function formatCurrentValue(
  value: RuntimeConfigValue | undefined,
  defaultValueSummary?: string,
): string {
  if (value !== undefined) {
    return formatPreviewValue(value);
  }

  return defaultValueSummary === undefined
    ? '(unset)'
    : `(unset; default: ${redactRuntimeConfigText(defaultValueSummary)})`;
}

export function formatPreviewValue(
  value: RuntimeConfigValue | undefined,
): string {
  return value === undefined ? '(unset)' : JSON.stringify(value);
}

export function writeDiagnostics(
  stdout: NodeJS.WritableStream,
  diagnostics: readonly RuntimeConfigDiagnostic[],
): void {
  if (diagnostics.length === 0) {
    return;
  }

  writeLine(stdout, 'Diagnostics:');
  for (const diagnostic of diagnostics) {
    writeLine(
      stdout,
      `- ${diagnostic.severity}: ${runtimeConfigDiagnosticAttribution(
        diagnostic,
      )}${redactRuntimeConfigText(diagnostic.message)}`,
    );
  }
}

export function runtimeConfigLocation(options: {
  readonly configPath?: string;
  readonly storeRoot?: string;
}): {readonly configPath?: string; readonly storeRoot?: string} {
  return {
    ...(options.configPath === undefined
      ? {}
      : {configPath: options.configPath}),
    ...(options.storeRoot === undefined ? {} : {storeRoot: options.storeRoot}),
  };
}

export function writeLine(stdout: NodeJS.WritableStream, value: string): void {
  stdout.write(`${value}\n`);
}
