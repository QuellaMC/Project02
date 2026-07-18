/**
 * Single owner of the project02.plugin.json descriptor shape: the pure
 * parser used by package-loader discovery and the file reader packages
 * use to self-read their manifest. "$schema" is allowed and ignored so
 * descriptors can reference the editor schema in schemas/.
 */
import {readFileSync} from 'node:fs';
import {extname} from 'node:path';

import {createRuntimePluginManifest} from './manifest-validation.ts';
import {isRecord} from './validation-primitives.ts';
import type {RuntimePluginManifest} from './types.ts';

export const runtimePluginPackageDescriptorFormat = 'project02.plugin.v1';

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
    .sort(compareDescriptorText)
    .find(field => !runtimePluginPackageDescriptorFields.has(field));

  if (unknownDescriptorField !== undefined) {
    return rejectedDescriptor(
      'invalid_descriptor',
      `Runtime plugin package descriptor contains unknown field "${unknownDescriptorField}".`,
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

/**
 * Package self-read: packages call this from their plugin module to
 * recover their validated manifest from the descriptor next to them,
 * so the descriptor stays the single authored source of the manifest.
 */
export function readRuntimePluginPackageDescriptor(options: {
  readonly descriptorUrl: URL;
  readonly expectedEntry?: string;
}): ParsedRuntimePluginPackageDescriptor {
  let raw: unknown;

  try {
    raw = JSON.parse(readFileSync(options.descriptorUrl, 'utf8')) as unknown;
  } catch (error: unknown) {
    throw new TypeError(
      'Runtime plugin package descriptor could not be read.',
      {
        cause: error,
      },
    );
  }

  const parsed = parseRuntimePluginPackageDescriptor(raw);

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

function compareDescriptorText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
