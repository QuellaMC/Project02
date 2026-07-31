/**
 * Scaffold for `pnpm character:new <id>`: stamps a data-only character
 * package under src/characters/packages/<id>/ — one schema-linked
 * descriptor, nothing else. The stamped descriptor must always satisfy
 * schemas/project02.character.schema.json and the runtime validator;
 * tests/unit/character-package-schema.test.ts pins that.
 */
import {mkdirSync, readdirSync, rmdirSync, writeFileSync} from 'node:fs';
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

  // Claim the directory first, then look around from inside the claim.
  // Scanning first and creating second leaves a window where a concurrent
  // run stamps the sibling this one just decided was absent — and
  // `recursive: true` reports success on a directory it did not create,
  // so the loser would overwrite the winner's descriptor. Exclusive
  // create is the one step that cannot be raced: exactly one caller gets
  // the directory, everyone else gets EEXIST.
  mkdirSync(packagesRoot, {recursive: true});

  try {
    mkdirSync(packageRoot);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      // On a case-insensitive filesystem the claim is what catches a fold
      // collision, and the directory in the way is not the one asked for.
      // Naming the existing one is what tells the operator whether they
      // repeated themselves or collided with different casing.
      throw packageDirectoryExists(
        collidingPackageDirectoryName({id, packagesRoot}) ?? id,
        packagesRoot,
      );
    }
    throw error;
  }

  // On a case-sensitive filesystem the claim succeeds and the fold
  // collision is still ahead, so the sibling list decides — now that this
  // run's own directory is in it and a concurrent claimant either lost
  // its exclusive create or is here to be found.
  const conflicting = collidingPackageDirectoryName({id, packagesRoot});

  if (conflicting !== undefined) {
    // Give the claim back. A directory left behind for an id the scaffold
    // refused would make the *next* attempt fail with EEXIST and report a
    // package that was never stamped.
    rmdirSync(packageRoot);
    throw packageDirectoryExists(conflicting, packagesRoot);
  }

  writeFileSync(
    join(packageRoot, 'project02.character.json'),
    `${JSON.stringify(
      descriptorTemplate({
        id,
        displayName: displayNameFromProject02Identifier(id),
      }),
      null,
      2,
    )}\n`,
    'utf8',
  );

  return {packageRoot};
}

/**
 * @param {string} directoryName
 * @param {string} packagesRoot
 * @return {Error}
 */
function packageDirectoryExists(directoryName, packagesRoot) {
  return new Error(
    `Character package directory already exists: ${join(packagesRoot, directoryName)}`,
  );
}

/**
 * The name of a *different* sibling package directory this id folds onto,
 * or undefined when the id is free. Called while holding the claim on
 * `<packagesRoot>/<id>`, so that entry is expected and skipped.
 *
 * An exact-path check is not the question, which is why this survives the
 * exclusive create above rather than being replaced by it. Discovery
 * folds character ids with project02IdentifierCollisionKey, so on a
 * case-sensitive filesystem `character:new Mira` beside an existing
 * `mira` stamps a package that mkdir accepts and discovery then reports
 * as a duplicate — making *both* undiscoverable, including the bundled
 * default. The scaffold has to refuse under the same fold discovery
 * judges by.
 *
 * @param {{id: string, packagesRoot: string}} options
 * @return {string | undefined}
 */
function collidingPackageDirectoryName({id, packagesRoot}) {
  const collisionKey = project02IdentifierCollisionKey(id);

  return readdirSync(packagesRoot, {withFileTypes: true}).find(
    entry =>
      entry.name !== id &&
      project02IdentifierCollisionKey(entry.name) === collisionKey,
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
