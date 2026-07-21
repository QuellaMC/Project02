/**
 * Single owner of the project02.character.json descriptor shape: the pure
 * parser the character loader uses at discovery. Character packages are
 * data-only — a descriptor and nothing else — so unlike plugin packages
 * there is no entry module and no factory contract. "$schema" is allowed
 * and ignored so descriptors can reference the editor schema in schemas/.
 */
import {
  freezeCharacterProfile,
  type CharacterProfile,
} from '../../core/index.ts';

export const characterPackageDescriptorFormat = 'project02.character.v1';
export const characterPackageDescriptorFileName = 'project02.character.json';

export const maxCharacterPersonaSections = 16;
export const maxCharacterPersonaSectionLength = 4000;

const characterIdPattern = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;
const maxCharacterDisplayNameLength = 128;
const characterVersionPattern = /^\d+\.\d+\.\d+$/u;

const characterPackageDescriptorFields = new Set([
  '$schema',
  'format',
  'identity',
  'persona',
  'meta',
]);
const characterIdentityFields = new Set(['id', 'displayName']);
const characterPersonaFields = new Set(['system']);
const characterMetaFields = new Set(['version']);

export type CharacterPersona = {
  readonly system: readonly string[];
};

export type CharacterMeta = {
  readonly version: string;
};

export type CharacterDefinition = {
  readonly identity: CharacterProfile;
  readonly persona: CharacterPersona;
  readonly meta: CharacterMeta;
};

export type CharacterPackageDescriptorIssue = {
  readonly code:
    | 'invalid_descriptor'
    | 'invalid_identity'
    | 'invalid_persona'
    | 'invalid_meta';
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
  descriptor: unknown,
): CharacterPackageDescriptorParseResult {
  if (!isRecord(descriptor)) {
    return rejectedDescriptor(
      'invalid_descriptor',
      'Character package descriptor must be an object.',
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

  return Object.freeze({
    status: 'accepted',
    definition: Object.freeze({
      identity: identityResult.identity,
      persona: personaResult.persona,
      meta: metaResult.meta,
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

  if (typeof id !== 'string' || !characterIdPattern.test(id)) {
    return rejectedDescriptor(
      'invalid_identity',
      'Character package identity.id must start with a letter and use only ' +
        'letters, numbers, dots, underscores, or hyphens (max 128 chars).',
    );
  }

  const displayName = value['displayName'];

  if (
    typeof displayName !== 'string' ||
    displayName.trim().length === 0 ||
    displayName.length > maxCharacterDisplayNameLength ||
    displayName !== displayName.trim()
  ) {
    return rejectedDescriptor(
      'invalid_identity',
      'Character package identity.displayName must be a non-empty string ' +
        `of at most ${String(maxCharacterDisplayNameLength)} characters ` +
        'with no leading or trailing whitespace.',
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
      section.length > maxCharacterPersonaSectionLength
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
