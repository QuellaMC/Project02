/**
 * The source a spawned child runs to wait for the start file its test
 * writes, named by the child's process argument at `index`, so children
 * that must collide begin together. A child gives up when no start comes:
 * a test run killed before writing the file would leave it polling for
 * good.
 */
export function awaitStartFile(index: number): string {
  return [
    '{',
    "  const {existsSync} = process.getBuiltinModule('node:fs');",
    '  const tick = new Int32Array(new SharedArrayBuffer(4));',
    '  const giveUp = Date.now() + 10_000;',
    `  while (!existsSync(process.argv[${String(index)}])) {`,
    '    if (Date.now() > giveUp) process.exit(3);',
    '    Atomics.wait(tick, 0, 0, 5);',
    '  }',
    '}',
  ].join('\n');
}
