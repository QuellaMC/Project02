// The stamped descriptor must satisfy schemas/project02.character.schema.json
// and the runtime validator.
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

  mkdirSync(packagesRoot, {recursive: true});

  // A non-recursive mkdir is the one claim two concurrent runs cannot both win.
  try {
    mkdirSync(packageRoot);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw packageDirectoryExists(
        collidingPackageDirectoryName({id, packagesRoot}) ?? id,
        packagesRoot,
      );
    }
    throw error;
  }

  // On a case-sensitive filesystem the claim succeeds despite a fold collision.
  const conflicting = collidingPackageDirectoryName({id, packagesRoot});

  if (conflicting !== undefined) {
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

function packageDirectoryExists(directoryName, packagesRoot) {
  return new Error(
    `Character package directory already exists: ${join(packagesRoot, directoryName)}`,
  );
}

// Discovery folds character ids, so a case-variant package would make both
// it and the package it folds onto undiscoverable.
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
