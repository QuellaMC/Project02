// The depcruise CLI refuses odd-numbered Node versions; its JS API does not.
import {cruise} from 'dependency-cruiser';
import extractDepcruiseConfig from 'dependency-cruiser/config-utl/extract-depcruise-config';

const CONFIG_FILE = './.dependency-cruiser.mjs';
const CRUISE_SCOPE = [
  'packages/page/src',
  'packages/wire/src',
  'tests/conformance',
  'tests/browser',
];

async function main() {
  const config = await extractDepcruiseConfig(CONFIG_FILE);
  /** @type {import('dependency-cruiser').ICruiseOptions} */
  const cruiseOptions = {
    ...config.options,
    ruleSet: {forbidden: config.forbidden ?? []},
    validate: true,
    outputType: 'err',
  };
  const result = await cruise(CRUISE_SCOPE, cruiseOptions);

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
