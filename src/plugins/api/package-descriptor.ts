/** Single owner of the descriptor shape; "$schema" is allowed but unused. */
import {extname} from 'node:path';

import {
  compareText,
  packageDescriptorSchemaRefIsValid,
  readBoundedPackageJsonFile,
} from '../../shared/package-metadata.ts';
import {createRuntimePluginManifest} from './manifest-validation.ts';
import {isRecord} from './validation-primitives.ts';
import type {RuntimePluginManifest} from './types.ts';

export const runtimePluginPackageDescriptorFormat = 'project02.plugin.v1';
export const maxRuntimePluginPackageMetadataBytes = 256 * 1_024;

export const runtimePluginPackageEntryExtensions = Object.freeze([
  '.ts',
  '.js',
  '.mjs',
]);

const runtimePluginPackageDescriptorFields = new Set([
  '$schema',
  'format',
  'entry',
  'manifest',
]);

export type RuntimePluginPackageDescriptorIssue = {
  readonly code: 'invalid_descriptor' | 'invalid_manifest' | 'invalid_entry';
  readonly message: string;
};

export type ParsedRuntimePluginPackageDescriptor = {
  readonly entry: string;
  readonly manifest: RuntimePluginManifest;
};

export type RuntimePluginPackageDescriptorParseResult =
  | {
      readonly status: 'accepted';
      readonly descriptor: ParsedRuntimePluginPackageDescriptor;
    }
  | {
      readonly status: 'rejected';
      readonly issue: RuntimePluginPackageDescriptorIssue;
    };

export function parseRuntimePluginPackageDescriptor(
  descriptor: unknown,
): RuntimePluginPackageDescriptorParseResult {
  if (!isRecord(descriptor)) {
    return rejectedDescriptor(
      'invalid_descriptor',
      'Runtime plugin package descriptor must be an object.',
    );
  }

  const unknownDescriptorField = Object.keys(descriptor)
    .sort(compareText)
    .find(field => !runtimePluginPackageDescriptorFields.has(field));

  if (unknownDescriptorField !== undefined) {
    return rejectedDescriptor(
      'invalid_descriptor',
      `Runtime plugin package descriptor contains unknown field "${unknownDescriptorField}".`,
    );
  }
  if (!packageDescriptorSchemaRefIsValid(descriptor['$schema'])) {
    return rejectedDescriptor(
      'invalid_descriptor',
      'Runtime plugin package descriptor "$schema" must be a string.',
    );
  }

  let manifest: RuntimePluginManifest;

  try {
    manifest = createRuntimePluginManifest(descriptor['manifest']);
  } catch (error: unknown) {
    return rejectedDescriptor(
      'invalid_manifest',
      error instanceof Error
        ? error.message
        : 'Runtime plugin package manifest is invalid.',
    );
  }
  const entry = descriptor['entry'];

  if (descriptor['format'] !== runtimePluginPackageDescriptorFormat) {
    return rejectedDescriptor(
      'invalid_descriptor',
      `Runtime plugin package format must be "${runtimePluginPackageDescriptorFormat}".`,
    );
  }
  if (typeof entry !== 'string') {
    return rejectedDescriptor(
      'invalid_entry',
      'Runtime plugin package entry must be a string.',
    );
  }
  if (!entry.startsWith('./')) {
    return rejectedDescriptor(
      'invalid_entry',
      'Runtime plugin package entry must stay inside its package directory.',
    );
  }
  if (!runtimePluginPackageEntryExtensions.includes(extname(entry))) {
    return rejectedDescriptor(
      'invalid_entry',
      'Runtime plugin package entry must use .ts, .js, or .mjs.',
    );
  }

  return Object.freeze({
    status: 'accepted',
    descriptor: Object.freeze({entry, manifest}),
  });
}

/** Package self-read, so the descriptor stays the manifest's one source. */
export function readRuntimePluginPackageDescriptor(options: {
  readonly descriptorUrl: URL;
  readonly expectedEntry?: string;
}): ParsedRuntimePluginPackageDescriptor {
  const descriptor = readBoundedPackageJsonFile({
    path: options.descriptorUrl,
    maxBytes: maxRuntimePluginPackageMetadataBytes,
    boundaryField: 'Runtime plugin package descriptor',
  });

  if (descriptor.status === 'rejected') {
    throw new TypeError('Runtime plugin package descriptor could not be read.');
  }

  const parsed = parseRuntimePluginPackageDescriptor(descriptor.value);

  if (parsed.status === 'rejected') {
    throw new TypeError(parsed.issue.message);
  }

  if (
    options.expectedEntry !== undefined &&
    parsed.descriptor.entry !== options.expectedEntry
  ) {
    throw new TypeError(
      `Runtime plugin package entry must be "${options.expectedEntry}".`,
    );
  }

  return parsed.descriptor;
}

function rejectedDescriptor(
  code: RuntimePluginPackageDescriptorIssue['code'],
  message: string,
): RuntimePluginPackageDescriptorParseResult {
  return Object.freeze({
    status: 'rejected',
    issue: Object.freeze({code, message}),
  });
}
