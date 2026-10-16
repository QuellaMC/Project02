import type {RuntimeConfigFieldDeclaration} from '../../plugins/api/index.ts';
import {ownJsonRecordValue} from '../../shared/json-boundary.ts';
import {createRuntimeConfigDiagnostic} from './diagnostic.ts';
import {runtimeConfigSectionPath} from './path.ts';
import {
  runtimeConfigSectionNamespaces,
  type Project02RuntimeConfig,
  type Project02RuntimeSectionConfig,
  type RuntimeConfigDiagnostic,
  type RuntimeConfigFieldScope,
  type RuntimeConfigSectionDeclaration,
  type RuntimeConfigSectionNamespace,
  type RuntimeConfigSections,
  type RuntimeConfigValue,
} from './types.ts';

/** One section as each layer authored it. */
export type RuntimeSectionLayers = Readonly<
  Record<RuntimeConfigFieldScope, Project02RuntimeSectionConfig | undefined>
>;

/** A section's switch, or one of its declared fields. */
type RuntimeSectionValue = {
  readonly declaration: RuntimeConfigSectionDeclaration;
  /** Absent for the section's switch. */
  readonly field?: RuntimeConfigFieldDeclaration;
};

/**
 * The documents that may supply a section's switch or field to a target,
 * nearest first. A scope that only the screens and the change verb honored
 * would be one a hand edit walks around, so every reader takes values by
 * this: the merge, the views, and the rule that refuses a write.
 */
export function runtimeSectionValueLayers(
  options: RuntimeSectionValue & {readonly target: RuntimeConfigFieldScope},
): readonly RuntimeConfigFieldScope[] {
  switch (options.field?.scope ?? options.declaration.config.scope) {
    case 'character_only':
      return options.target === 'character' ? ['character'] : [];
    case 'global_only':
      return ['global'];
    case 'global_with_character_overrides':
      return options.target === 'character'
        ? ['character', 'global']
        : ['global'];
  }
}

/** A target authors exactly the values its own document supplies to it. */
export function runtimeSectionValueAuthorable(
  options: RuntimeSectionValue & {readonly target: RuntimeConfigFieldScope},
): boolean {
  return runtimeSectionValueLayers(options).includes(options.target);
}

/**
 * The layer whose authored value a switch or field takes in an effective
 * document. The home's sources are a character's less the overlay, so one
 * answer serves both: without an overlay it is the home's.
 */
export function runtimeSectionSupplyingLayer(
  options: RuntimeSectionValue & {readonly layers: RuntimeSectionLayers},
): RuntimeConfigFieldScope | undefined {
  return runtimeSectionValueLayers({...options, target: 'character'}).find(
    layer =>
      authoredSectionValue(options.layers[layer], options.field) !== undefined,
  );
}

function authoredSectionValue(
  section: Project02RuntimeSectionConfig | undefined,
  field: RuntimeConfigFieldDeclaration | undefined,
): RuntimeConfigValue | undefined {
  return field === undefined
    ? section?.enabled
    : ownJsonRecordValue(section?.config, field.name);
}

export type RuntimeSectionScopeOperation =
  | {readonly kind: 'activation'}
  | {readonly kind: 'field'; readonly fieldName: string};

export type RuntimeSectionScopeViolation = {
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly fieldName?: string;
};

/** Judged in both directions, by a field's own scope, else its section's. */
export function runtimeSectionScopeViolation(options: {
  readonly namespace: RuntimeConfigSectionNamespace;
  readonly declaration: RuntimeConfigSectionDeclaration;
  readonly authoredScope: RuntimeConfigFieldScope;
  readonly operation: RuntimeSectionScopeOperation;
}): RuntimeSectionScopeViolation | undefined {
  const {namespace, declaration, authoredScope, operation} = options;
  const field =
    operation.kind === 'field'
      ? declaration.config.fields.find(
          candidate => candidate.name === operation.fieldName,
        )
      : undefined;

  // An undeclared field is the field validation's to refuse.
  if (operation.kind === 'field' && field === undefined) {
    return undefined;
  }

  if (
    runtimeSectionValueAuthorable({
      declaration,
      ...(field === undefined ? {} : {field}),
      target: authoredScope,
    })
  ) {
    return undefined;
  }

  const owner =
    authoredScope === 'global'
      ? {name: 'a character', settings: "a character's", other: "the home's"}
      : {name: 'the home', settings: "the home's", other: "a character's"};

  return Object.freeze({
    code: 'runtime_config_authored_outside_scope',
    ...(field === undefined
      ? {
          path: `${runtimeConfigSectionPath(namespace, declaration.id)}.enabled`,
          message:
            `The switch of "${declaration.id}" belongs to ${owner.name}: ` +
            `only ${owner.settings} settings may turn it on or off, and ` +
            `${owner.other} choice is never used.`,
        }
      : {
          path: runtimeConfigSectionPath(namespace, declaration.id, field.name),
          message:
            `Setting "${field.name}" of "${declaration.id}" belongs to ` +
            `${owner.name}: only ${owner.settings} settings may set it, and ` +
            `${owner.other} value is never used.`,
          fieldName: field.name,
        }),
  });
}

/**
 * Takes one raw document; a merged one hides which layer authored a value.
 * A value found outside its scope is a warning: the merge already keeps it
 * from every reader, and blocking its section would stop that section over
 * a value that cannot act.
 */
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
          section: ownJsonRecordValue(
            options.config?.[namespace],
            declaration.id,
          ),
          namespace,
          declaration,
          authoredScope: options.authoredScope,
        }),
      ),
  );

  return Object.freeze(diagnostics);
}

function sectionScopeDiagnostics(options: {
  readonly section: Project02RuntimeSectionConfig | undefined;
  readonly namespace: RuntimeConfigSectionNamespace;
  readonly declaration: RuntimeConfigSectionDeclaration;
  readonly authoredScope: RuntimeConfigFieldScope;
}): readonly RuntimeConfigDiagnostic[] {
  const {section, namespace, declaration} = options;

  if (section === undefined) {
    return [];
  }

  const activation: readonly RuntimeSectionScopeOperation[] =
    section.enabled === undefined ? [] : [{kind: 'activation'}];
  const fields: readonly RuntimeSectionScopeOperation[] =
    declaration.config.fields
      .filter(field => authoredSectionValue(section, field) !== undefined)
      .map(field => ({kind: 'field', fieldName: field.name}));

  return [...activation, ...fields].flatMap(operation => {
    const violation = runtimeSectionScopeViolation({
      namespace,
      declaration,
      authoredScope: options.authoredScope,
      operation,
    });

    return violation === undefined
      ? []
      : [
          createRuntimeConfigDiagnostic(
            'warning',
            violation.code,
            violation.message,
            violation.path,
            {
              namespace,
              id: declaration.id,
              ...(violation.fieldName === undefined
                ? {}
                : {field: violation.fieldName}),
            },
          ),
        ];
  });
}
