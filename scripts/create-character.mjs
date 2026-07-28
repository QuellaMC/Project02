/**
 * Scaffold for `pnpm character:new <id>`: stamps a data-only character
 * package under src/characters/packages/<id>/ — one schema-linked
 * descriptor, nothing else. The stamped descriptor must always satisfy
 * schemas/project02.character.schema.json and the runtime validator;
 * tests/unit/character-package-schema.test.ts pins that.
 */
import {mkdirSync, readdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {
  displayNameFromProject02Identifier,
  isProject02Identifier,
  project02IdentifierCollisionKey,
} from '../src/shared/identifier.ts';

export function scaffoldCharacterPackage({id, packagesRoot}) {
  if (!isProject02Identifier(id)) {
    throw new Error(
      `Character id "${id}" must start with a letter and use only letters, numbers, dots, underscores, or hyphens.`,
    );
  }

  const packageRoot = join(packagesRoot, id);
  const conflicting = existingPackageDirectoryName({id, packagesRoot});

  if (conflicting !== undefined) {
    throw new Error(
      `Character package directory already exists: ${join(packagesRoot, conflicting)}`,
    );
  }

  const displayName = displayNameFromProject02Identifier(id);

  mkdirSync(packageRoot, {recursive: true});
  writeFileSync(
    join(packageRoot, 'project02.character.json'),
    `${JSON.stringify(descriptorTemplate({id, displayName}), null, 2)}\n`,
    'utf8',
  );

  return {packageRoot};
}

/**
 * The name of the sibling package directory a new id would collide with,
 * or undefined when the id is free.
 *
 * An exact-path check is not the question. Discovery folds character ids
 * with project02IdentifierCollisionKey, so on a case-sensitive
 * filesystem `character:new Mira` beside an existing `mira` stamps a
 * package that mkdir accepts and discovery then reports as a duplicate —
 * making *both* undiscoverable, including the bundled default. The
 * scaffold has to refuse under the same fold discovery judges by.
 *
 * @param {{id: string, packagesRoot: string}} options
 * @return {string | undefined}
 */
function existingPackageDirectoryName({id, packagesRoot}) {
  const collisionKey = project02IdentifierCollisionKey(id);
  let entries;

  try {
    entries = readdirSync(packagesRoot, {withFileTypes: true});
  } catch (error) {
    // No packages root yet is no collision; mkdirSync creates it below.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }

  return entries.find(
    entry => project02IdentifierCollisionKey(entry.name) === collisionKey,
  )?.name;
}

function descriptorTemplate({id, displayName}) {
  return {
    $schema: '../../../../schemas/project02.character.schema.json',
    format: 'project02.character.v1',
    identity: {
      id,
      displayName,
    },
    persona: {
      system: [`You are ${displayName}.`],
    },
    meta: {
      version: '1.0.0',
    },
  };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const id = process.argv[2];

  if (id === undefined || id.length === 0) {
    console.error('Usage: pnpm character:new <character-id>');
    process.exit(1);
  }

  try {
    const {packageRoot} = scaffoldCharacterPackage({
      id,
      packagesRoot: fileURLToPath(
        new URL('../src/characters/packages/', import.meta.url),
      ),
    });

    console.log(`Created ${packageRoot}`);
    console.log('Next steps:');
    console.log('  1. Shape the identity and persona sections.');
    console.log('  2. pnpm check');
    console.log(`  3. Select it with --store <home> --character ${id}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
