import {createJsonBoundarySnapshot} from '../../shared/json-boundary.ts';
import {
  accept,
  acceptedOrThrow,
  firstRejected,
  isRecord,
  reject,
  requiredIdentifier,
  requiredNonEmptyString,
  requiredPositiveInteger,
} from './validation-primitives.ts';
import type {
  RuntimePluginCuratedContextSection,
  RuntimePluginValidationResult,
} from './types.ts';

export type {RuntimePluginCuratedContextSection} from './types.ts';

export const curatedContextSectionTitleCharLimit = 64;
export const curatedContextSectionTextCharLimit = 4096;

/** Newlines are the only control characters a rendered section may carry. */
function containsForbiddenControlCharacter(text: string): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;

    if ((codePoint < 0x20 && codePoint !== 0x0a) || codePoint === 0x7f) {
      return true;
    }
  }

  return false;
}

export function createRuntimePluginCuratedContextSection(
  value: unknown,
): RuntimePluginCuratedContextSection {
  return acceptedOrThrow(validateRuntimePluginCuratedContextSection(value));
}

export function validateRuntimePluginCuratedContextSection(
  value: unknown,
): RuntimePluginValidationResult<RuntimePluginCuratedContextSection> {
  try {
    value = createJsonBoundarySnapshot(value, {
      field: 'Plugin curated context section',
      redact: true,
    });
  } catch (error: unknown) {
    return reject(
      'malformed_curated_context_section',
      error instanceof Error
        ? error.message
        : 'Plugin curated context section exceeds the JSON boundary.',
    );
  }

  if (!isRecord(value)) {
    return reject(
      'malformed_curated_context_section',
      'Plugin curated context section must be an object.',
    );
  }

  const pluginId = requiredIdentifier(value['pluginId'], 'pluginId');
  const id = requiredIdentifier(value['id'], 'id');
  const title = requiredNonEmptyString(value['title'], 'title');
  const text = requiredNonEmptyString(value['text'], 'text');
  const capChars = optionalPositiveInteger(value['capChars'], 'capChars');
  const usedChars = optionalPositiveInteger(value['usedChars'], 'usedChars');

  if (
    pluginId.status === 'rejected' ||
    id.status === 'rejected' ||
    title.status === 'rejected' ||
    text.status === 'rejected' ||
    capChars.status === 'rejected' ||
    usedChars.status === 'rejected'
  ) {
    return firstRejected([pluginId, id, title, text, capChars, usedChars]);
  }

  if (
    title.value.length > curatedContextSectionTitleCharLimit ||
    title.value.includes('\n') ||
    containsForbiddenControlCharacter(title.value)
  ) {
    return reject(
      'malformed_curated_context_section',
      `Plugin curated context section title must be a single line of at most ${String(
        curatedContextSectionTitleCharLimit,
      )} characters.`,
    );
  }

  const normalizedText = text.value
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n');

  if (containsForbiddenControlCharacter(normalizedText)) {
    return reject(
      'malformed_curated_context_section',
      'Plugin curated context section text must not contain control characters.',
    );
  }

  if (normalizedText.length > curatedContextSectionTextCharLimit) {
    return reject(
      'malformed_curated_context_section',
      `Plugin curated context section text exceeds the ${String(
        curatedContextSectionTextCharLimit,
      )}-character limit.`,
    );
  }

  return accept(
    Object.freeze({
      pluginId: pluginId.value,
      id: id.value,
      title: title.value,
      text: normalizedText,
      ...(capChars.value === undefined ? {} : {capChars: capChars.value}),
      ...(usedChars.value === undefined ? {} : {usedChars: usedChars.value}),
    } satisfies RuntimePluginCuratedContextSection),
  );
}

function optionalPositiveInteger(
  value: unknown,
  field: string,
): RuntimePluginValidationResult<number | undefined> {
  if (value === undefined) {
    return accept(undefined);
  }

  return requiredPositiveInteger(value, field);
}
