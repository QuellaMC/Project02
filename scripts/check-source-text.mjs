/**
 * Source files must stay searchable text.
 *
 * A raw control byte in a tracked file makes grep and ripgrep classify it
 * as binary and silently skip it, so repository-wide searches — the
 * reuse-before-building workflow this project depends on — omit that
 * file's symbols without any visible failure. Formatting, linting, and
 * typechecking all accept such a file, which is exactly how one shipped:
 * a NUL delimiter written as the character itself instead of its
 * escape hid 2,300 lines of validation code from search.
 *
 * This gate rejects raw control bytes (everything below 0x20 except tab,
 * newline, and carriage return) in tracked source text. Control
 * characters that belong in program values are spelled as escapes.
 */
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';

const TEXT_FILE_PATTERN = /\.(?:ts|mts|mjs|js|json|md|html|yml|yaml)$/;

const trackedFiles = execFileSync('git', ['ls-files', '-z'], {
  encoding: 'utf8',
})
  .split('\0')
  .filter(path => path !== '' && TEXT_FILE_PATTERN.test(path))
  // A file deleted from the working tree but still in the index has no
  // content to scan; mid-deletion is an ordinary state to run checks in.
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
