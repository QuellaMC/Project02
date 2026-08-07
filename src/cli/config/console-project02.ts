import {
  applyRuntimeConfigControlOperation,
  getRedactedRuntimeConfigValueAtPath,
  project02RuntimeConfigFieldDefinitions,
  redactRuntimeConfigValue,
  resolveRuntimeConfigScopeTarget,
  type Project02ConfigFieldDefinition,
  type RuntimeConfigControlOperation,
  type RuntimeConfigValue,
} from '../../runtime/config/index.ts';
import {
  askForFieldValue,
  askForNumber,
  cancelled,
  ensureConsoleCommitTarget,
  formatCurrentValue,
  previewAndCommitChange,
  writeLine,
  type RuntimeConfigConsoleContext,
  type RuntimeConfigConsoleSnapshot,
  type StagedRuntimeConfigChange,
} from './console-shared.ts';

export async function runProject02ConfigSection(
  context: RuntimeConfigConsoleContext,
  snapshot: RuntimeConfigConsoleSnapshot,
): Promise<void> {
  const fields =
    snapshot.scope === 'global'
      ? project02RuntimeConfigFieldDefinitions()
      : project02RuntimeConfigFieldDefinitions().filter(field =>
          field.scopes.includes('character'),
        );
  const displayConfig = snapshot.scopedConfig ?? snapshot.config;

  writeLine(context.stdout, '');
  writeLine(context.stdout, 'Project02');
  fields.forEach((field, index) => {
    const currentValue = getRedactedRuntimeConfigValueAtPath(
      displayConfig,
      field.path,
    );

    writeLine(
      context.stdout,
      `${String(index + 1)}) ${field.label}: ${formatCurrentValue(currentValue, field.defaultValueSummary)}`,
    );
  });

  const selected = await askForNumber(
    context,
    'Select a Project02 field: ',
    fields.length,
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
  field: Project02ConfigFieldDefinition,
): Promise<StagedRuntimeConfigChange | undefined> {
  writeLine(context.stdout, '1) Set');
  writeLine(context.stdout, '2) Unset');
  writeLine(context.stdout, '3) Cancel');

  const action = await askForNumber(context, 'Choose an action: ', 3);

  if (action === undefined || action === 3) {
    writeLine(context.stdout, 'Change cancelled.');
    return undefined;
  }

  const oldValue = getRedactedRuntimeConfigValueAtPath(
    snapshot.scopedConfig ?? snapshot.config,
    field.path,
  );
  let operation: RuntimeConfigControlOperation;
  let newValue: RuntimeConfigValue | undefined;

  if (action === 2) {
    operation = {kind: 'unset', path: field.path};
  } else {
    const value = await askForFieldValue(context, field);

    if (value === cancelled) {
      writeLine(context.stdout, 'Change cancelled.');
      return undefined;
    }

    newValue = redactRuntimeConfigValue(value, {key: field.name});
    operation = {kind: 'set', path: field.path, value};
  }

  return {
    target: field.path,
    oldValue,
    newValue,
    reloadRequired: field.reloadRequired,
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
        expectedFingerprint: snapshot.fingerprint,
        request: {kind: 'document', operation},
      });
    },
  };
}
