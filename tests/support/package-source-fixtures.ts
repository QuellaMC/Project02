import {utimesSync} from 'node:fs';

/**
 * Backdates a package source root so discovery can see it change.
 *
 * Discovery rejects a source root that was modified between enumerating it
 * and resolving its packages, and a directory's recorded modification time
 * is what says so. That time only advances once per filesystem tick — 4 ms
 * on ext4 — so a fixture written microseconds before the mutation reads as
 * untouched, and the swap the test stages goes unnoticed. A real source
 * root was written long before any scan of it; this gives the fixture the
 * same history.
 */
export function agePackageSourceRoot(sourceRoot: string): void {
  const aged = new Date(Date.now() - 60_000);

  utimesSync(sourceRoot, aged, aged);
}
