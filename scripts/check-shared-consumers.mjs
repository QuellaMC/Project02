// Gate rule 6: a shared file needs a reviewed consumers.json entry naming
// at least two consumer modules.
import {readFileSync, readdirSync} from 'node:fs';
import {basename, dirname, join, relative, resolve} from 'node:path';

const SRC_DIRECTORY = 'src';
const SHARED_DIRECTORY = 'src/shared';
const MANIFEST_FILE = 'src/shared/consumers.json';
const MINIMUM_APPROVED_MODULES = 2;

const IMPORT_SPECIFIER_PATTERN =
  /(?:^|\n)\s*(?:import|export)\s[^;'"]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;

function listTypeScriptFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTypeScriptFiles(entryPath));
    } else if (entry.name.endsWith('.ts')) {
      files.push(entryPath);
    }
  }
  return files;
}

function moduleOf(filePath) {
  const segments = relative(SRC_DIRECTORY, filePath).split('/');
  return segments.length === 1 ? 'root' : segments[0];
}

// Specifiers resolve against the importing file so module-local `shared/`
// directories (cli/shared) do not match.
function importedSharedFileNames(source, filePath) {
  const names = [];
  const sharedRoot = resolve(SHARED_DIRECTORY);
  for (const match of source.matchAll(IMPORT_SPECIFIER_PATTERN)) {
    const specifier = match[1] ?? match[2];
    if (specifier === undefined || !specifier.startsWith('.')) {
      continue;
    }
    const resolved = resolve(dirname(filePath), specifier);
    if (dirname(resolved) === sharedRoot && resolved.endsWith('.ts')) {
      names.push(basename(resolved));
    }
  }
  return names;
}

function main() {
  /** @type {Record<string, string[]>} */
  const manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'));
  const sharedFiles = readdirSync(SHARED_DIRECTORY).filter(name =>
    name.endsWith('.ts'),
  );
  const failures = [];

  for (const name of sharedFiles) {
    const approved = manifest[name];
    if (approved === undefined) {
      failures.push(
        `${SHARED_DIRECTORY}/${name} has no entry in ${MANIFEST_FILE}; ` +
          'shared additions need approved consumers (name at least ' +
          `${MINIMUM_APPROVED_MODULES} consumer modules).`,
      );
    } else if (approved.length < MINIMUM_APPROVED_MODULES) {
      failures.push(
        `${MANIFEST_FILE} entry for ${name} names ${approved.length} ` +
          `consumer module(s); at least ${MINIMUM_APPROVED_MODULES} are ` +
          'required — a single-consumer utility belongs inside its consumer.',
      );
    }
  }

  for (const name of Object.keys(manifest)) {
    if (!sharedFiles.includes(name)) {
      failures.push(
        `${MANIFEST_FILE} entry for ${name} is stale: ` +
          `${SHARED_DIRECTORY}/${name} does not exist.`,
      );
    }
  }

  for (const filePath of listTypeScriptFiles(SRC_DIRECTORY)) {
    const consumerModule = moduleOf(filePath);
    if (consumerModule === 'shared') {
      continue;
    }
    const source = readFileSync(filePath, 'utf8');
    for (const name of importedSharedFileNames(source, filePath)) {
      const approved = manifest[name] ?? [];
      if (!approved.includes(consumerModule)) {
        failures.push(
          `${filePath} (module '${consumerModule}') imports shared/${name} ` +
            `but is not an approved consumer (approved: ` +
            `${approved.join(', ') || 'none'}). Extend the entry in ` +
            `${MANIFEST_FILE} in a reviewed diff, or move the code.`,
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
      'against approved consumers.\n',
  );
}

main();
