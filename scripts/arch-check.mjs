/**
 * Architecture gate runner (`pnpm arch:check` / `pnpm arch:baseline`).
 *
 * Drives dependency-cruiser through its JS API rather than the `depcruise`
 * CLI: the CLI refuses odd-numbered Node versions (for example 25.x) while
 * this repo's engines field and CI target even-numbered releases, and the
 * API carries no such gate. Behavior mirrors
 * `depcruise src --config .dependency-cruiser.mjs --ignore-known`, and with
 * `--baseline` it mirrors `--output-type baseline --output-to <file>`.
 *
 * Known violations in `.dependency-cruiser-known-violations.json` are the
 * ratchet: matching violations are reported as ignored and do not fail the
 * gate; any new violating edge does. Regenerate the baseline (shrink only)
 * with `pnpm arch:baseline` in the same PR that removes violations.
 */
import {existsSync, readFileSync, writeFileSync} from 'node:fs';

import {cruise} from 'dependency-cruiser';
import extractDepcruiseConfig from 'dependency-cruiser/config-utl/extract-depcruise-config';
import extractTsConfig from 'dependency-cruiser/config-utl/extract-ts-config';

const CONFIG_FILE = './.dependency-cruiser.mjs';
const KNOWN_VIOLATIONS_FILE = '.dependency-cruiser-known-violations.json';
const CRUISE_SCOPE = ['src'];

/**
 * @return {Promise<number>} process exit code.
 */
async function main() {
  const baselineMode = process.argv.includes('--baseline');
  const config = await extractDepcruiseConfig(CONFIG_FILE);
  const tsConfig = extractTsConfig(config.options.tsConfig.fileName);

  /** @type {import('dependency-cruiser').ICruiseOptions} */
  const cruiseOptions = {
    ...config.options,
    ruleSet: {forbidden: config.forbidden ?? []},
    validate: true,
    outputType: baselineMode ? 'baseline' : 'err',
  };
  if (!baselineMode && existsSync(KNOWN_VIOLATIONS_FILE)) {
    cruiseOptions.knownViolations = JSON.parse(
      readFileSync(KNOWN_VIOLATIONS_FILE, 'utf8'),
    );
  }

  const result = await cruise(CRUISE_SCOPE, cruiseOptions, undefined, {
    tsConfig,
  });

  if (baselineMode) {
    const violations = JSON.parse(String(result.output));
    writeFileSync(KNOWN_VIOLATIONS_FILE, `${String(result.output)}\n`);
    process.stdout.write(
      `arch:baseline wrote ${violations.length} known violation(s) to ` +
        `${KNOWN_VIOLATIONS_FILE}\n`,
    );
    return 0;
  }

  process.stdout.write(`${String(result.output)}\n`);
  return result.exitCode > 0 ? 1 : 0;
}

main().then(
  exitCode => {
    process.exitCode = exitCode;
  },
  error => {
    console.error(error);
    process.exitCode = 1;
  },
);
