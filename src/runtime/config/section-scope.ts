import {ownJsonRecordValue} from '../../shared/json-boundary.ts';
import {createRuntimeConfigDiagnostic} from './diagnostic.ts';
import {runtimeConfigSectionPath} from './path.ts';
import {
  runtimeConfigSectionNamespaces,
  type Project02RuntimeConfig,
  type RuntimeConfigDiagnostic,
  type RuntimeConfigFieldScope,
  type RuntimeConfigSectionDeclaration,
  type RuntimeConfigSectionNamespace,
  type RuntimeConfigSections,
} from './types.ts';

export type RuntimeSectionScopeOperation =
  | {readonly kind: 'activation'}
  | {readonly kind: 'field'; readonly fieldName: string};

export type RuntimeSectionScopeViolation = {
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly fieldName?: string;
};

export function runtimeSectionScopeViolation(options: {
  readonly namespace: RuntimeConfigSectionNamespace;
  readonly declaration: RuntimeConfigSectionDeclaration;
  readonly authoredScope: RuntimeConfigFieldScope;
  readonly operation: RuntimeSectionScopeOperation;
}): RuntimeSectionScopeViolation | undefined {
  const {declaration} = options;

  if (options.operation.kind === 'activation') {
    return options.authoredScope === 'global' &&
      declaration.config.scope === 'character_only'
      ? Object.freeze({
          code: 'runtime_config_character_only_plugin_enabled_globally',
          path: `${runtimeConfigSectionPath(options.namespace, declaration.id)}.enabled`,
          message:
            `Plugin "${declaration.id}" belongs to a character; turn it ` +
            "on or off in that character's settings, not the home's.",
        })
      : undefined;
  }

  const fieldName = options.operation.fieldName;
  const field = declaration.config.fields.find(
    candidate => candidate.name === fieldName,
  );

  if (field === undefined) {
    return undefined;
  }

  const path = runtimeConfigSectionPath(
    options.namespace,
    declaration.id,
    field.name,
  );

  if (
    options.authoredScope === 'global' &&
    declaration.config.scope === 'character_only'
  ) {
    return Object.freeze({
      fieldName: field.name,
      code: 'runtime_config_character_only_plugin_field_globally',
      path,
      message:
        `Setting "${field.name}" of plugin "${declaration.id}" belongs ` +
        "to a character; set it in that character's settings, not the home's.",
    });
  }

  return undefined;
}

/** Takes one raw document; a merged one hides which layer authored a value. */
export function runtimeSectionScopeDiagnostics(options: {
  readonly config: Project02RuntimeConfig | undefined;
  readonly sections: RuntimeConfigSections;
  readonly authoredScope: RuntimeConfigFieldScope;
}): readonly RuntimeConfigDiagnostic[] {
  const diagnostics = runtimeConfigSectionNamespaces.flatMap(namespace =>
    [...options.sections[namespace]]
      .sort((left, right) => left.id.localeCompare(right.id))
      .flatMap(declaration =>
        sectionScopeDiagnostics({
          config: options.config,
          namespace,
          declaration,
          authoredScope: options.authoredScope,
        }),
      ),
  );

  return Object.freeze(diagnostics);
}

function sectionScopeDiagnostics(options: {
  readonly config: Project02RuntimeConfig | undefined;
  readonly namespace: RuntimeConfigSectionNamespace;
  readonly declaration: RuntimeConfigSectionDeclaration;
  readonly authoredScope: RuntimeConfigFieldScope;
}): readonly RuntimeConfigDiagnostic[] {
  const section = ownJsonRecordValue(
    options.config?.[options.namespace],
    options.declaration.id,
  );

  if (section === undefined) {
    return [];
  }

  const diagnostics: RuntimeConfigDiagnostic[] = [];
  const activationViolation = runtimeSectionScopeViolation({
    namespace: options.namespace,
    declaration: options.declaration,
    authoredScope: options.authoredScope,
    operation: {kind: 'activation'},
  });

  if (section.enabled !== undefined && activationViolation !== undefined) {
    diagnostics.push(
      sectionScopeDiagnostic({
        declaration: options.declaration,
        code: activationViolation.code,
        path: activationViolation.path,
        message: activationViolation.message,
      }),
    );
  }

  for (const field of options.declaration.config.fields) {
    if (
      section.config === undefined ||
      !Object.hasOwn(section.config, field.name)
    ) {
      continue;
    }

    const violation = runtimeSectionScopeViolation({
      namespace: options.namespace,
      declaration: options.declaration,
      authoredScope: options.authoredScope,
      operation: {kind: 'field', fieldName: field.name},
    });

    if (violation !== undefined) {
      diagnostics.push(
        sectionScopeDiagnostic({
          declaration: options.declaration,
          fieldName: field.name,
          code: violation.code,
          path: violation.path,
          message: violation.message,
        }),
      );
    }
  }

  return diagnostics;
}

function sectionScopeDiagnostic(options: {
  readonly declaration: RuntimeConfigSectionDeclaration;
  readonly fieldName?: string;
  readonly code: string;
  readonly path: string;
  readonly message: string;
}): RuntimeConfigDiagnostic {
  return createRuntimeConfigDiagnostic(
    'error',
    options.code,
    options.message,
    options.path,
    {
      pluginId: options.declaration.id,
      ...(options.fieldName === undefined
        ? {}
        : {pluginConfigField: options.fieldName}),
    },
  );
}
