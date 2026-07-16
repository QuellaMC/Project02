/**
 * Gate rule 6: additions to `src/shared` need approved consumers.
 *
 * `src/shared/consumers.json` maps each shared file to the top-level src
 * modules approved to import it. This script fails when:
 *
 * 1. a file exists in `src/shared` with no manifest entry (a shared
 *    addition without recorded approval),
 * 2. a manifest entry names fewer than two consumer modules (a
 *    single-consumer utility belongs inside its consumer, not in shared),
 * 3. a manifest entry points at a shared file that no longer exists
 *    (stale approval), or
 * 4. a module outside the approved set imports the shared file.
 *
 * Adding to shared therefore requires a reviewed diff to consumers.json
 * naming at least two consumers — the "approved consumers" gate from
 * docs/plan/repo-structure-migration-2026-07-16.md, Slice 0.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC_DIRECTORY = 'src';
const SHARED_DIRECTORY = 'src/shared';
const MANIFEST_FILE = 'src/shared/consumers.json';
const MINIMUM_APPROVED_MODULES = 2;

const IMPORT_SPECIFIER_PATTERN =
  /(?:^|\n)\s*(?:import|export)\s[^;'"]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;

/**
 * Recursively lists TypeScript files under a directory.
 *
 * @param {string} directory
 * @return {string[]} paths relative to the repository root.
 */
function listTypeScriptFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTypeScriptFiles(entryPath));
    } else if (entry.name.endsWith('.ts')) {
      files.push(entryPath);
    }
  }
  return files;
}

/**
 * @param {string} filePath path relative to the repository root.
 * @return {string} the top-level src module ('runtime', 'cli', …), or
 *     'root' for files directly under src/.
 */
function moduleOf(filePath) {
  const segments = relative(SRC_DIRECTORY, filePath).split('/');
  return segments.length === 1 ? 'root' : segments[0];
}

/**
 * @param {string} source TypeScript source text.
 * @return {string[]} shared file names (e.g. 'json-boundary.ts') the
 *     source imports.
 */
function importedSharedFileNames(source) {
  const names = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER_PATTERN)) {
    const specifier = match[1] ?? match[2];
    const sharedMatch = /(?:^|\/)shared\/([^/]+\.ts)$/.exec(specifier ?? '');
    if (sharedMatch) {
      names.push(sharedMatch[1]);
    }
  }
  return names;
}

function main() {
  /** @type {Record<string, string[]>} */
  const manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'));
  const sharedFiles = readdirSync(SHARED_DIRECTORY).filter((name) =>
    name.endsWith('.ts')
  );
  const failures = [];

  for (const name of sharedFiles) {
    const approved = manifest[name];
    if (approved === undefined) {
      failures.push(
        `${SHARED_DIRECTORY}/${name} has no entry in ${MANIFEST_FILE}; ` +
          'shared additions need approved consumers (name at least ' +
          `${MINIMUM_APPROVED_MODULES} consumer modules).`
      );
    } else if (approved.length < MINIMUM_APPROVED_MODULES) {
      failures.push(
        `${MANIFEST_FILE} entry for ${name} names ${approved.length} ` +
          `consumer module(s); at least ${MINIMUM_APPROVED_MODULES} are ` +
          'required — a single-consumer utility belongs inside its consumer.'
      );
    }
  }

  for (const name of Object.keys(manifest)) {
    if (!sharedFiles.includes(name)) {
      failures.push(
        `${MANIFEST_FILE} entry for ${name} is stale: ` +
          `${SHARED_DIRECTORY}/${name} does not exist.`
      );
    }
  }

  for (const filePath of listTypeScriptFiles(SRC_DIRECTORY)) {
    const consumerModule = moduleOf(filePath);
    if (consumerModule === 'shared') {
      continue;
    }
    const source = readFileSync(filePath, 'utf8');
    for (const name of importedSharedFileNames(source)) {
      const approved = manifest[name] ?? [];
      if (!approved.includes(consumerModule)) {
        failures.push(
          `${filePath} (module '${consumerModule}') imports shared/${name} ` +
            `but is not an approved consumer (approved: ` +
            `${approved.join(', ') || 'none'}). Extend the entry in ` +
            `${MANIFEST_FILE} in a reviewed diff, or move the code.`
        );
      }
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      process.stderr.write(`shared-consumers: ${failure}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `shared-consumers: ${sharedFiles.length} shared file(s) verified ` +
      'against approved consumers.\n'
  );
}

main();
