import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {
  acquireLocalRuntimeMutationLocks,
  acquireLocalRuntimeMutationLock,
  acquireLocalRuntimeMutationLockSync,
  createLocalRuntimeMutationLockOwnerToken,
  LocalRuntimeMutationLockBusyError,
  reclaimObservedLocalRuntimeMutationLock,
} from '../../src/runtime/storage/mutation-lock.ts';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async root => {
      await rm(root, {force: true, recursive: true});
    }),
  );
});

describe('local runtime mutation locks', () => {
  it('excludes the same resource without blocking unrelated resources', async () => {
    const locksRoot = await createTempLocksRoot();
    const first = await acquireLocalRuntimeMutationLock({
      locksRoot,
      resourceKey: 'session-writer:alpha',
      waitTimeoutMs: 0,
    });

    await expect(
      acquireLocalRuntimeMutationLock({
        locksRoot,
        resourceKey: 'session-writer:alpha',
        waitTimeoutMs: 0,
      }),
    ).rejects.toBeInstanceOf(LocalRuntimeMutationLockBusyError);

    const unrelated = await acquireLocalRuntimeMutationLock({
      locksRoot,
      resourceKey: 'session-writer:beta',
      waitTimeoutMs: 0,
    });

    await unrelated.release();
    await first.release();

    const reacquired = await acquireLocalRuntimeMutationLock({
      locksRoot,
      resourceKey: 'session-writer:alpha',
      waitTimeoutMs: 0,
    });

    await reacquired.release();
  });

  it('allows only callers carrying the same owner token to reenter', async () => {
    const locksRoot = await createTempLocksRoot();
    const ownerToken = createLocalRuntimeMutationLockOwnerToken();
    const outer = await acquireLocalRuntimeMutationLock({
      locksRoot,
      resourceKey: 'session-writer:alpha',
      ownerToken,
      waitTimeoutMs: 0,
    });
    const nested = await acquireLocalRuntimeMutationLock({
      locksRoot,
      resourceKey: 'session-writer:alpha',
      ownerToken,
      waitTimeoutMs: 0,
    });

    await expect(
      acquireLocalRuntimeMutationLock({
        locksRoot,
        resourceKey: 'session-writer:alpha',
        waitTimeoutMs: 0,
      }),
    ).rejects.toBeInstanceOf(LocalRuntimeMutationLockBusyError);

    await nested.release();
    await expect(
      acquireLocalRuntimeMutationLock({
        locksRoot,
        resourceKey: 'session-writer:alpha',
        waitTimeoutMs: 0,
      }),
    ).rejects.toBeInstanceOf(LocalRuntimeMutationLockBusyError);

    await outer.release();
    const next = await acquireLocalRuntimeMutationLock({
      locksRoot,
      resourceKey: 'session-writer:alpha',
      waitTimeoutMs: 0,
    });
    await next.release();
  });

  it('acquires multiple resources in canonical order', async () => {
    const locksRoot = await createTempLocksRoot();
    const lease = await acquireLocalRuntimeMutationLocks({
      locksRoot,
      resourceKeys: ['äther', 'zeta', 'alpha', 'zeta'],
      waitTimeoutMs: 0,
    });

    expect(lease.resourceKeys).toEqual(['alpha', 'zeta', 'äther']);
    await expect(
      acquireLocalRuntimeMutationLock({
        locksRoot,
        resourceKey: 'alpha',
        waitTimeoutMs: 0,
      }),
    ).rejects.toBeInstanceOf(LocalRuntimeMutationLockBusyError);

    await lease.release();
  });

  it('reclaims a same-host lock whose owner process is dead', async () => {
    const locksRoot = await createTempLocksRoot();
    const abandoned = await acquireLocalRuntimeMutationLock({
      locksRoot,
      resourceKey: 'session-writer:dead-owner',
      waitTimeoutMs: 0,
    });
    const ownerPath = join(abandoned.lockPath, 'owner.json');
    const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as Record<
      string,
      unknown
    >;
    await writeFile(
      ownerPath,
      `${JSON.stringify({...owner, pid: 2_147_483_647})}\n`,
      'utf8',
    );

    const recovered = await acquireLocalRuntimeMutationLock({
      locksRoot,
      resourceKey: 'session-writer:dead-owner',
      waitTimeoutMs: 0,
    });

    await abandoned.release();
    await expect(
      acquireLocalRuntimeMutationLock({
        locksRoot,
        resourceKey: 'session-writer:dead-owner',
        waitTimeoutMs: 0,
      }),
    ).rejects.toBeInstanceOf(LocalRuntimeMutationLockBusyError);
    await recovered.release();
  });

  it('does not let a stale dead-owner observation reclaim a newer live generation', async () => {
    const locksRoot = await createTempLocksRoot();
    const resourceKey = 'session-writer:generation-swap';
    const first = await acquireLocalRuntimeMutationLock({
      locksRoot,
      resourceKey,
      waitTimeoutMs: 0,
    });
    const firstOwner = JSON.parse(
      await readFile(join(first.lockPath, 'owner.json'), 'utf8'),
    ) as Record<string, unknown>;
    await writeFile(
      join(first.lockPath, 'owner.json'),
      `${JSON.stringify({...firstOwner, pid: 2_147_483_647})}\n`,
      'utf8',
    );
    const staleDeadOwner = JSON.parse(
      await readFile(join(first.lockPath, 'owner.json'), 'utf8'),
    ) as Record<string, unknown>;

    await first.release();
    const current = await acquireLocalRuntimeMutationLock({
      locksRoot,
      resourceKey,
      waitTimeoutMs: 0,
    });

    await expect(
      reclaimObservedLocalRuntimeMutationLock(
        {locksRoot, resourceKey, waitTimeoutMs: 0},
        staleDeadOwner,
      ),
    ).resolves.toBe(false);
    await expect(
      acquireLocalRuntimeMutationLock({
        locksRoot,
        resourceKey,
        waitTimeoutMs: 0,
      }),
    ).rejects.toBeInstanceOf(LocalRuntimeMutationLockBusyError);

    await current.release();
  });

  it('blocks a new live generation until every stale reclaimer leaves the destructive boundary', async () => {
    const locksRoot = await createTempLocksRoot();
    const resourceKey = 'session-writer:overlapping-reclaimers';
    const abandoned = await acquireLocalRuntimeMutationLock({
      locksRoot,
      resourceKey,
      waitTimeoutMs: 0,
    });
    const ownerFile = join(abandoned.lockPath, 'owner.json');
    const owner = JSON.parse(await readFile(ownerFile, 'utf8')) as Record<
      string,
      unknown
    >;
    await writeFile(
      ownerFile,
      `${JSON.stringify({...owner, pid: 2_147_483_647})}\n`,
      'utf8',
    );
    const staleDeadOwner = JSON.parse(
      await readFile(ownerFile, 'utf8'),
    ) as Record<string, unknown>;
    let nestedReclaim: Promise<boolean> | undefined;

    const outerReclaim = reclaimObservedLocalRuntimeMutationLock(
      {locksRoot, resourceKey, waitTimeoutMs: 0},
      staleDeadOwner,
      {
        afterValidation() {
          nestedReclaim = reclaimObservedLocalRuntimeMutationLock(
            {locksRoot, resourceKey, waitTimeoutMs: 0},
            staleDeadOwner,
          );

          expect(() =>
            acquireLocalRuntimeMutationLockSync({
              locksRoot,
              resourceKey,
              waitTimeoutMs: 0,
            }),
          ).toThrow(LocalRuntimeMutationLockBusyError);
        },
      },
    );

    await expect(outerReclaim).resolves.toBe(true);
    await expect(nestedReclaim).resolves.toBe(true);
    await abandoned.release();

    const current = await acquireLocalRuntimeMutationLock({
      locksRoot,
      resourceKey,
      waitTimeoutMs: 0,
    });
    await current.release();
  });

  it('reclaims malformed owner metadata only after its grace period', async () => {
    const locksRoot = await createTempLocksRoot();
    const abandoned = await acquireLocalRuntimeMutationLock({
      locksRoot,
      resourceKey: 'session-writer:malformed-owner',
      waitTimeoutMs: 0,
    });
    await writeFile(
      join(abandoned.lockPath, 'owner.json'),
      '{broken\n',
      'utf8',
    );

    await expect(
      acquireLocalRuntimeMutationLock({
        locksRoot,
        resourceKey: 'session-writer:malformed-owner',
        incompleteGraceMs: 30_000,
        waitTimeoutMs: 0,
      }),
    ).rejects.toBeInstanceOf(LocalRuntimeMutationLockBusyError);

    const recovered = await acquireLocalRuntimeMutationLock({
      locksRoot,
      resourceKey: 'session-writer:malformed-owner',
      incompleteGraceMs: 0,
      waitTimeoutMs: 0,
    });

    await abandoned.release();
    await expect(
      acquireLocalRuntimeMutationLock({
        locksRoot,
        resourceKey: 'session-writer:malformed-owner',
        waitTimeoutMs: 0,
      }),
    ).rejects.toBeInstanceOf(LocalRuntimeMutationLockBusyError);
    await recovered.release();
  });

  it('reclaims a uniquely named dead reclamation intent without blocking future owners', async () => {
    const locksRoot = await createTempLocksRoot();
    const resourceKey = 'session-writer:dead-reclamation-intent';
    const lease = await acquireLocalRuntimeMutationLock({
      locksRoot,
      resourceKey,
      waitTimeoutMs: 0,
    });
    const lockOwner = JSON.parse(
      await readFile(join(lease.lockPath, 'owner.json'), 'utf8'),
    ) as Record<string, unknown>;
    const intentPath = `${lease.lockPath}.reclaim-dead-fixture`;
    await mkdir(intentPath);
    await writeFile(
      join(intentPath, 'owner.json'),
      `${JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        hostname: lockOwner['hostname'],
        createdAt: lockOwner['acquiredAt'],
      })}\n`,
      'utf8',
    );
    await lease.release();

    const next = await acquireLocalRuntimeMutationLock({
      locksRoot,
      resourceKey,
      waitTimeoutMs: 0,
    });

    expect(await readdir(locksRoot)).not.toContain(
      intentPath.split('/').at(-1),
    );
    await next.release();
  });

  it('never steals a valid lock owned on another host', async () => {
    const locksRoot = await createTempLocksRoot();
    const foreign = await acquireLocalRuntimeMutationLock({
      locksRoot,
      resourceKey: 'session-writer:foreign-owner',
      waitTimeoutMs: 0,
    });
    const ownerPath = join(foreign.lockPath, 'owner.json');
    const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as Record<
      string,
      unknown
    >;
    await writeFile(
      ownerPath,
      `${JSON.stringify({
        ...owner,
        hostname: 'remote-host.invalid',
        pid: 2_147_483_647,
      })}\n`,
      'utf8',
    );

    await expect(
      acquireLocalRuntimeMutationLock({
        locksRoot,
        resourceKey: 'session-writer:foreign-owner',
        incompleteGraceMs: 0,
        waitTimeoutMs: 0,
      }),
    ).rejects.toBeInstanceOf(LocalRuntimeMutationLockBusyError);
    await foreign.release();
  });
});

async function createTempLocksRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'project02-mutation-lock-'));
  tempRoots.push(root);
  return join(root, 'locks');
}
