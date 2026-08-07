// A raw control byte makes grep classify a file as binary and skip it, so
// its symbols disappear from repository-wide search.
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';

const TEXT_FILE_PATTERN = /\.(?:ts|mts|cts|mjs|cjs|js|json|md|html|yml|yaml)$/;

const trackedFiles = execFileSync('git', ['ls-files', '-z'], {
  encoding: 'utf8',
})
  .split('\0')
  .filter(path => path !== '' && TEXT_FILE_PATTERN.test(path))
  // The index still lists files already deleted from the working tree.
  .filter(path => existsSync(path));

const violations = [];

for (const path of trackedFiles) {
  const data = readFileSync(path);

  for (let index = 0; index < data.length; index += 1) {
    const byte = data[index];

    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
      violations.push(
        `${path}: raw control byte 0x${byte.toString(16).padStart(2, '0')} at offset ${String(index)}`,
      );
      break;
    }
  }
}

if (violations.length > 0) {
  console.error('Source files must not contain raw control bytes:');
  for (const violation of violations) {
    console.error(`  ${violation}`);
  }
  console.error('Spell control characters as escape sequences instead.');
  process.exit(1);
}

console.log(
  `source-text: ${String(trackedFiles.length)} tracked text file(s) contain no raw control bytes.`,
);
