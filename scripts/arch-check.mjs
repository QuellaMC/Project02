// The depcruise CLI refuses odd-numbered Node versions; its JS API does not.
import {existsSync, readFileSync, writeFileSync} from 'node:fs';

import {cruise} from 'dependency-cruiser';
import extractDepcruiseConfig from 'dependency-cruiser/config-utl/extract-depcruise-config';
import extractTsConfig from 'dependency-cruiser/config-utl/extract-ts-config';

const CONFIG_FILE = './.dependency-cruiser.mjs';
const KNOWN_VIOLATIONS_FILE = '.dependency-cruiser-known-violations.json';
const CRUISE_SCOPE = ['src', 'tests/conformance', 'tests/browser'];

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
