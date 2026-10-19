/**
 * The page the daemon serves, built once before the suite when the
 * checkout has none: transport.page-files reads it, whichever command
 * runs the suite.
 */
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';

export default function buildPage(): void {
  if (!existsSync(new URL('../../../dist/web/index.html', import.meta.url))) {
    execFileSync('pnpm', ['build:web'], {stdio: 'inherit'});
  }
}
