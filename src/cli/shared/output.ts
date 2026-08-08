/** Single owner of pretty-printed JSON output for all CLIs. */
export function writeJson(stdout: NodeJS.WritableStream, value: unknown): void {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
