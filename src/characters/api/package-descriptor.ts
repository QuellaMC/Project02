/**
 * Single owner of the project02.character.json descriptor shape: the pure
 * parser the character loader uses at discovery. Character packages are
 * data-only — a descriptor and nothing else — so unlike plugin packages
 * there is no entry module and no factory contract. "$schema" is allowed
 * and ignored so descriptors can reference the editor schema in schemas/.
 */
import {
  characterLength,
  freezeCharacterProfile,
  isValidSpeakerDisplayName,
  maxSpeakerDisplayNameLength,
  type CharacterProfile,
} from '../../core/index.ts';
import {createJsonBoundaryObjectSnapshot} from '../../shared/json-boundary.ts';
import {isProject02Identifier} from '../../shared/identifier.ts';
import {nestedSecretMarkerPath} from '../../shared/secret-marker.ts';

export const characterPackageDescriptorFormat = 'project02.character.v1';
export const characterPackageDescriptorFileName = 'project02.character.json';

export const maxCharacterPersonaSections = 16;
export const maxCharacterPersonaSectionLength = 4000;

// Bounded per component: the version is copied into `characterRef.version` on
// every role-model I/O snapshot and persisted in raw evidence, so an unbounded
// digit count would let one package field add kilobytes to every turn. Nine
// digits per component is far beyond any real semantic version.
const characterVersionPattern = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/u;

export const maxCharacterPluginExpectations = 32;

const characterPackageDescriptorFields = new Set([
  '$schema',
  'format',
  'identity',
  'persona',
  'meta',
  'plugins',
]);
const characterIdentityFields = new Set(['id', 'displayName']);
const characterPersonaFields = new Set(['system']);
const characterMetaFields = new Set(['version']);
const characterPluginsFields = new Set(['required', 'recommended', 'config']);

export type CharacterPersona = {
  readonly system: readonly string[];
};

export type CharacterMeta = {
  readonly version: string;
};

/**
 * Plugins a character declares: required ids block activation when
 * missing or disabled, recommended ids only warn, and config carries
 * package-authored defaults for the character overlay. Shape-only here
 * — whether a plugin id or field exists is judged by the app layer
 * against the installed catalog.
 */
export type CharacterPluginExpectations = {
  readonly required: readonly string[];
  readonly recommended: readonly string[];
  readonly config: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
};

export type CharacterDefinition = {
  readonly identity: CharacterProfile;
  readonly persona: CharacterPersona;
  readonly meta: CharacterMeta;
  readonly plugins?: CharacterPluginExpectations;
};

export type CharacterPackageDescriptorIssue = {
  readonly code:
    | 'invalid_descriptor'
    | 'invalid_identity'
    | 'invalid_persona'
    | 'invalid_meta'
    | 'invalid_plugins';
  readonly message: string;
};

export type CharacterPackageDescriptorParseResult =
  | {
      readonly status: 'accepted';
      readonly definition: CharacterDefinition;
    }
  | {
      readonly status: 'rejected';
      readonly issue: CharacterPackageDescriptorIssue;
    };

export function parseCharacterPackageDescriptor(
  value: unknown,
): CharacterPackageDescriptorParseResult {
  if (!isRecord(value)) {
    return rejectedDescriptor(
      'invalid_descriptor',
      'Character package descriptor must be an object.',
    );
  }

  let descriptor;

  try {
    descriptor = createJsonBoundaryObjectSnapshot(value, {
      field: 'Character package descriptor',
    });
  } catch {
    return rejectedDescriptor(
      'invalid_descriptor',
      'Character package descriptor exceeds safe JSON limits.',
    );
  }

  const unknownDescriptorField = Object.keys(descriptor)
    .sort(compareDescriptorText)
    .find(field => !characterPackageDescriptorFields.has(field));

  if (unknownDescriptorField !== undefined) {
    return rejectedDescriptor(
      'invalid_descriptor',
      `Character package descriptor contains unknown field "${unknownDescriptorField}".`,
    );
  }
  if (descriptor['format'] !== characterPackageDescriptorFormat) {
    return rejectedDescriptor(
      'invalid_descriptor',
      `Character package format must be "${characterPackageDescriptorFormat}".`,
    );
  }

  const identityResult = parseCharacterIdentity(descriptor['identity']);

  if (identityResult.status === 'rejected') {
    return identityResult;
  }

  const personaResult = parseCharacterPersona(descriptor['persona']);

  if (personaResult.status === 'rejected') {
    return personaResult;
  }

  const metaResult = parseCharacterMeta(descriptor['meta']);

  if (metaResult.status === 'rejected') {
    return metaResult;
  }

  const pluginsResult = parseCharacterPlugins(descriptor['plugins']);

  if (pluginsResult.status === 'rejected') {
    return pluginsResult;
  }

  return Object.freeze({
    status: 'accepted',
    definition: Object.freeze({
      identity: identityResult.identity,
      persona: personaResult.persona,
      meta: metaResult.meta,
      ...(pluginsResult.plugins === undefined
        ? {}
        : {plugins: pluginsResult.plugins}),
    } satisfies CharacterDefinition),
  });
}

type CharacterIdentityParseResult =
  | {readonly status: 'accepted'; readonly identity: CharacterProfile}
  | {
      readonly status: 'rejected';
      readonly issue: CharacterPackageDescriptorIssue;
    };

function parseCharacterIdentity(value: unknown): CharacterIdentityParseResult {
  if (!isRecord(value)) {
    return rejectedDescriptor(
      'invalid_identity',
      'Character package identity must be an object.',
    );
  }

  const unknownField = Object.keys(value)
    .sort(compareDescriptorText)
    .find(field => !characterIdentityFields.has(field));

  if (unknownField !== undefined) {
    return rejectedDescriptor(
      'invalid_identity',
      `Character package identity contains unknown field "${unknownField}".`,
    );
  }

  const id = value['id'];

  if (typeof id !== 'string' || !isProject02Identifier(id)) {
    return rejectedDescriptor(
      'invalid_identity',
      'Character package identity.id must start with a letter and use only ' +
        'letters, numbers, dots, underscores, or hyphens (max 128 chars).',
    );
  }

  const displayName = value['displayName'];

  // Shared with the user speaker: both are stamped into `speakerName`, and both
  // are interpolated before a colon in chat and relay output, so a multiline
  // name would let an accepted package forge extra lines.
  if (!isValidSpeakerDisplayName(displayName)) {
    return rejectedDescriptor(
      'invalid_identity',
      'Character package identity.displayName must be a non-empty ' +
        `single-line string of at most ${String(maxSpeakerDisplayNameLength)} ` +
        'characters with no leading or trailing whitespace.',
    );
  }

  return Object.freeze({
    status: 'accepted',
    identity: freezeCharacterProfile({id, displayName}),
  });
}

type CharacterPersonaParseResult =
  | {readonly status: 'accepted'; readonly persona: CharacterPersona}
  | {
      readonly status: 'rejected';
      readonly issue: CharacterPackageDescriptorIssue;
    };

function parseCharacterPersona(value: unknown): CharacterPersonaParseResult {
  if (!isRecord(value)) {
    return rejectedDescriptor(
      'invalid_persona',
      'Character package persona must be an object.',
    );
  }

  const unknownField = Object.keys(value)
    .sort(compareDescriptorText)
    .find(field => !characterPersonaFields.has(field));

  if (unknownField !== undefined) {
    return rejectedDescriptor(
      'invalid_persona',
      `Character package persona contains unknown field "${unknownField}".`,
    );
  }

  const system = value['system'];

  if (
    !Array.isArray(system) ||
    system.length === 0 ||
    system.length > maxCharacterPersonaSections
  ) {
    return rejectedDescriptor(
      'invalid_persona',
      'Character package persona.system must be an array of 1 to ' +
        `${String(maxCharacterPersonaSections)} sections.`,
    );
  }

  const sections: string[] = [];

  for (const [index, section] of system.entries()) {
    if (
      typeof section !== 'string' ||
      section.trim().length === 0 ||
      // Code points, matching the published schema's `maxLength`. Counting
      // UTF-16 units would reject an editor-valid package whose sections use
      // astral characters at half the documented length.
      characterLength(section) > maxCharacterPersonaSectionLength
    ) {
      return rejectedDescriptor(
        'invalid_persona',
        `Character package persona.system[${String(index)}] must be a ` +
          'non-blank string of at most ' +
          `${String(maxCharacterPersonaSectionLength)} characters.`,
      );
    }

    sections.push(section);
  }

  return Object.freeze({
    status: 'accepted',
    persona: Object.freeze({
      system: Object.freeze(sections),
    } satisfies CharacterPersona),
  });
}

type CharacterMetaParseResult =
  | {readonly status: 'accepted'; readonly meta: CharacterMeta}
  | {
      readonly status: 'rejected';
      readonly issue: CharacterPackageDescriptorIssue;
    };

function parseCharacterMeta(value: unknown): CharacterMetaParseResult {
  if (!isRecord(value)) {
    return rejectedDescriptor(
      'invalid_meta',
      'Character package meta must be an object.',
    );
  }

  const unknownField = Object.keys(value)
    .sort(compareDescriptorText)
    .find(field => !characterMetaFields.has(field));

  if (unknownField !== undefined) {
    return rejectedDescriptor(
      'invalid_meta',
      `Character package meta contains unknown field "${unknownField}".`,
    );
  }

  const version = value['version'];

  if (typeof version !== 'string' || !characterVersionPattern.test(version)) {
    return rejectedDescriptor(
      'invalid_meta',
      'Character package meta.version must be a semantic version like "1.0.0".',
    );
  }

  return Object.freeze({
    status: 'accepted',
    meta: Object.freeze({version} satisfies CharacterMeta),
  });
}

type CharacterPluginsParseResult =
  | {
      readonly status: 'accepted';
      readonly plugins: CharacterPluginExpectations | undefined;
    }
  | {
      readonly status: 'rejected';
      readonly issue: CharacterPackageDescriptorIssue;
    };

function parseCharacterPlugins(value: unknown): CharacterPluginsParseResult {
  if (value === undefined) {
    return Object.freeze({status: 'accepted', plugins: undefined});
  }

  if (!isRecord(value)) {
    return rejectedDescriptor(
      'invalid_plugins',
      'Character package plugins must be an object.',
    );
  }

  const unknownField = Object.keys(value)
    .sort(compareDescriptorText)
    .find(field => !characterPluginsFields.has(field));

  if (unknownField !== undefined) {
    return rejectedDescriptor(
      'invalid_plugins',
      `Character package plugins contains unknown field "${unknownField}".`,
    );
  }

  const required = parseCharacterPluginIdList(value['required'], 'required');

  if (!Array.isArray(required)) {
    return required;
  }

  const recommended = parseCharacterPluginIdList(
    value['recommended'],
    'recommended',
  );

  if (!Array.isArray(recommended)) {
    return recommended;
  }

  const rawConfig = value['config'];

  if (rawConfig !== undefined && !isRecord(rawConfig)) {
    return rejectedDescriptor(
      'invalid_plugins',
      'Character package plugins.config must be an object keyed by plugin id.',
    );
  }

  const config: Record<string, Readonly<Record<string, unknown>>> = {};

  for (const [pluginId, pluginConfig] of Object.entries(rawConfig ?? {}).sort(
    ([left], [right]) => compareDescriptorText(left, right),
  )) {
    if (!isProject02Identifier(pluginId)) {
      return rejectedDescriptor(
        'invalid_plugins',
        `Character package plugins.config key "${pluginId}" is not a valid plugin id.`,
      );
    }

    if (!isRecord(pluginConfig)) {
      return rejectedDescriptor(
        'invalid_plugins',
        `Character package plugins.config["${pluginId}"] must be an object.`,
      );
    }

    const configPath = `plugins.config["${pluginId}"]`;
    const unsafeSecretPath = nestedSecretMarkerPath(pluginConfig, configPath, {
      rejectPlaintextAllowanceMarker: true,
    });

    if (unsafeSecretPath !== undefined) {
      return rejectedDescriptor(
        'invalid_plugins',
        `Character package ${unsafeSecretPath} must not contain secret references or plaintext-secret markers.`,
      );
    }

    config[pluginId] = pluginConfig;
  }

  return Object.freeze({
    status: 'accepted',
    plugins: Object.freeze({
      required: Object.freeze(required),
      recommended: Object.freeze(recommended),
      config: Object.freeze(config),
    } satisfies CharacterPluginExpectations),
  });
}

function parseCharacterPluginIdList(
  value: unknown,
  fieldName: 'required' | 'recommended',
):
  | string[]
  | {
      readonly status: 'rejected';
      readonly issue: CharacterPackageDescriptorIssue;
    } {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || value.length > maxCharacterPluginExpectations) {
    return rejectedDescriptor(
      'invalid_plugins',
      `Character package plugins.${fieldName} must be an array of at most ` +
        `${String(maxCharacterPluginExpectations)} plugin ids.`,
    );
  }

  const pluginIds: string[] = [];

  for (const entry of value) {
    if (typeof entry !== 'string' || !isProject02Identifier(entry)) {
      return rejectedDescriptor(
        'invalid_plugins',
        `Character package plugins.${fieldName} entries must be valid plugin ids.`,
      );
    }

    if (pluginIds.includes(entry)) {
      return rejectedDescriptor(
        'invalid_plugins',
        `Character package plugins.${fieldName} lists plugin "${entry}" more than once.`,
      );
    }

    pluginIds.push(entry);
  }

  return pluginIds;
}

function rejectedDescriptor(
  code: CharacterPackageDescriptorIssue['code'],
  message: string,
): {
  readonly status: 'rejected';
  readonly issue: CharacterPackageDescriptorIssue;
} {
  return Object.freeze({
    status: 'rejected',
    issue: Object.freeze({code, message}),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareDescriptorText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
