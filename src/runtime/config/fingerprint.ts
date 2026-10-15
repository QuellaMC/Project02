import type {LoadedProject02CharacterOverlayConfig} from './overlay.ts';
import {
  runtimeConfigSectionNamespaces,
  type Project02RuntimeConfig,
  type RuntimeConfigCharacterScope,
  type RuntimeConfigSectionNamespace,
  type RuntimeConfigSections,
  type RuntimeConfigValue,
} from './types.ts';
import type {JsonBoundaryObject} from '../../shared/json-boundary.ts';
import {createCanonicalJsonFingerprint} from '../../shared/canonical-json.ts';
import {project02RuntimeConfigFieldDefinitions} from './schema.ts';

/**
 * Fingerprints are shown to surfaces that must never see a secret -- the
 * model reads one back from `runtime.plugin.config` -- and an unsalted
 * hash of a mostly-known document lets a weak plaintext secret be guessed
 * offline. Every fingerprint therefore takes the section declarations and
 * replaces authored values of secret-declared fields with a constant:
 * presence is hashed, the value never is.
 */
export function createRuntimeConfigFingerprint(
  value: RuntimeConfigValue | Project02RuntimeConfig | JsonBoundaryObject,
  sections: RuntimeConfigSections,
): string {
  return createCanonicalJsonFingerprint(
    redactAuthoredSecretFields(value, secretFieldsBySection(sections)),
  );
}

/**
 * An absent overlay hashes apart from an empty one, and the layer envelope
 * keeps this value off any single-file fingerprint. An invalid overlay hashes
 * as its authored document, not as one sentinel, so an edit to a broken
 * overlay stays visible; its wrapper stops a collision with a config.
 */
export function createLayeredRuntimeConfigFingerprint(options: {
  readonly globalConfig: Project02RuntimeConfig | JsonBoundaryObject;
  readonly characterId: string;
  readonly overlay: Pick<
    LoadedProject02CharacterOverlayConfig,
    'source' | 'config' | 'authoredDocument'
  >;
  readonly sections: RuntimeConfigSections;
}): string {
  const secretFields = secretFieldsBySection(options.sections);
  const {source, config, authoredDocument} = options.overlay;

  return createCanonicalJsonFingerprint({
    layers: {
      global: redactAuthoredSecretFields(options.globalConfig, secretFields),
      character:
        source === 'none'
          ? null
          : config !== undefined
            ? redactAuthoredSecretFields(config, secretFields)
            : authoredDocument === undefined
              ? {$overlayUnreadable: true}
              : {
                  $overlayInvalid: redactAuthoredSecretFields(
                    authoredDocument,
                    secretFields,
                  ),
                },
    },
    characterId: options.characterId,
  });
}

/** The one composition, so any two sites comparing fingerprints agree. */
export function layeredRuntimeConfigFingerprintForScope(options: {
  readonly globalConfig: Project02RuntimeConfig | JsonBoundaryObject;
  readonly characterScope: RuntimeConfigCharacterScope | undefined;
  readonly overlay: LoadedProject02CharacterOverlayConfig | undefined;
  readonly sections: RuntimeConfigSections;
}): string {
  return options.characterScope === undefined || options.overlay === undefined
    ? createRuntimeConfigFingerprint(options.globalConfig, options.sections)
    : createLayeredRuntimeConfigFingerprint({
        globalConfig: options.globalConfig,
        characterId: options.characterScope.characterId,
        overlay: options.overlay,
        sections: options.sections,
      });
}

type SecretFieldsBySection = ReadonlyMap<
  RuntimeConfigSectionNamespace,
  ReadonlyMap<string, ReadonlySet<string>>
>;

function secretFieldsBySection(
  sections: RuntimeConfigSections,
): SecretFieldsBySection {
  return new Map(
    runtimeConfigSectionNamespaces.map(namespace => [
      namespace,
      new Map(
        sections[namespace].map(declaration => [
          declaration.id,
          new Set(
            declaration.config.fields
              .filter(field => field.secret)
              .map(field => field.name),
          ),
        ]),
      ),
    ]),
  );
}

/**
 * Walks only the well-formed `project02.<field>` and
 * `<namespace>.<id>.config.<field>` positions, so an invalid authored
 * document still fingerprints as its own bytes.
 */
function redactAuthoredSecretFields(
  document: unknown,
  secretFields: SecretFieldsBySection,
): unknown {
  if (!isPlainRecord(document)) {
    return document;
  }

  const project02 = document['project02'];
  const redacted: Record<string, unknown> = {
    ...document,
    ...(isPlainRecord(project02)
      ? {
          project02: Object.fromEntries(
            Object.entries(project02).map(([name, value]) => [
              name,
              secretHostFieldNames.has(name) ? {$secret: 'authored'} : value,
            ]),
          ),
        }
      : {}),
  };

  for (const namespace of runtimeConfigSectionNamespaces) {
    const sections = document[namespace];

    if (isPlainRecord(sections)) {
      redacted[namespace] = redactSectionSecrets(
        sections,
        secretFields.get(namespace),
      );
    }
  }

  return redacted;
}

const secretHostFieldNames: ReadonlySet<string> = new Set(
  project02RuntimeConfigFieldDefinitions()
    .filter(field => field.secret)
    .map(field => field.name),
);

function redactSectionSecrets(
  sections: Record<string, unknown>,
  secretFields: ReadonlyMap<string, ReadonlySet<string>> | undefined,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(sections).map(([id, section]) => {
      const fields = secretFields?.get(id);

      if (
        fields === undefined ||
        fields.size === 0 ||
        !isPlainRecord(section) ||
        !isPlainRecord(section['config'])
      ) {
        return [id, section];
      }

      return [
        id,
        {
          ...section,
          config: Object.fromEntries(
            Object.entries(section['config']).map(([name, value]) => [
              name,
              fields.has(name) ? {$secret: 'authored'} : value,
            ]),
          ),
        },
      ];
    }),
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
