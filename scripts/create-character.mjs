/**
 * Scaffold for `pnpm character:new <id>`: stamps a data-only character
 * package under src/characters/packages/<id>/ — one schema-linked
 * descriptor, nothing else. The stamped descriptor must always satisfy
 * schemas/project02.character.schema.json and the runtime validator;
 * tests/unit/character-package-schema.test.ts pins that.
 */
import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const characterIdPattern = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;

export function scaffoldCharacterPackage({id, packagesRoot}) {
  if (!characterIdPattern.test(id)) {
    throw new Error(
      `Character id "${id}" must start with a letter and use only letters, numbers, dots, underscores, or hyphens.`,
    );
  }

  const packageRoot = join(packagesRoot, id);

  if (existsSync(packageRoot)) {
    throw new Error(
      `Character package directory already exists: ${packageRoot}`,
    );
  }

  const displayName = id
    .split(/[._-]/u)
    .filter(part => part.length > 0)
    .map(part => part[0].toUpperCase() + part.slice(1))
    .join(' ');

  mkdirSync(packageRoot, {recursive: true});
  writeFileSync(
    join(packageRoot, 'project02.character.json'),
    `${JSON.stringify(descriptorTemplate({id, displayName}), null, 2)}\n`,
    'utf8',
  );

  return {packageRoot};
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
    console.log(
      '  3. Select it for a fresh store (one store stays bound to one character).',
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
