import {expect, it} from 'vitest';

import {commandOf, typescriptPrograms} from '../conformance/harness/daemon.ts';
import {normalize} from './normalize.ts';
import {record, type Build} from './scenario.ts';

/** The build the environment names under this name, or this checkout's TypeScript programs. */
function buildNamed(name: 'REFERENCE' | 'CANDIDATE'): Build {
  return {
    serve: commandOf(`PROJECT02_${name}_SERVE_CMD`, typescriptPrograms.serve),
    inspect: commandOf(
      `PROJECT02_${name}_INSPECT_CMD`,
      typescriptPrograms.inspect,
    ),
  };
}

/** Where two normalized recordings first part, by the part that holds the line: a diff's hunks carry only line numbers. */
function whereTheyPart(reference: string, candidate: string): string {
  const expected = reference.split('\n');
  const received = candidate.split('\n');
  let line = 0;

  while (line < expected.length && expected[line] === received[line]) {
    line += 1;
  }

  const titles = expected
    .slice(0, line + 1)
    .filter(text => text.startsWith('── '));

  return `They part at line ${String(line + 1)}, in part ${String(titles.length)}: ${titles.at(-1) ?? ''}`;
}

it('the candidate asks the model and mem0, streams, pages history and reports through inspect as the reference does, but for what the normalizer names', async () => {
  const reference = normalize(await record(buildNamed('REFERENCE')));
  const candidate = normalize(await record(buildNamed('CANDIDATE')));

  expect(candidate, whereTheyPart(reference, candidate)).toBe(reference);
});
