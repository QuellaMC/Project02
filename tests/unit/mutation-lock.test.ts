import {createHash} from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  acquireLocalRuntimeMutationLocksSync,
  acquireLocalRuntimeMutationLock,
  acquireLocalRuntimeMutationLockSync,
  createLocalRuntimeMutationLockOwnerToken,
  localRuntimeMutationLockOwnerOwnsResource,
  LocalRuntimeMutationLockBusyError,
  LocalRuntimeMutationLocksAcquireError,
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
  it('treats a landed rename as released even when the remains linger', async () => {
    const locksRoot = await createTempLocksRoot();
    const lease = await acquireLocalRuntimeMutationLock({
      locksRoot,
      resourceKey: 'session-writer:remains',
      waitTimeoutMs: 0,
    });

    // Read-only lock contents block only the post-rename removal; the
    // rename itself rewrites the parent and frees the resource.
    await chmod(lease.lockPath, 0o500);

    try {
      await expect(lease.release()).resolves.toBeUndefined();
    } finally {
      for (const entry of await readdir(locksRoot)) {
        await chmod(join(locksRoot, entry), 0o755);
      }
    }

    const reacquired = await acquireLocalRuntimeMutationLock({
      locksRoot,
      resourceKey: 'session-writer:remains',
      waitTimeoutMs: 0,
    });

    await reacquired.release();
  });

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

  it('reenters an awaited lock from the synchronous entry point', async () => {
    const locksRoot = await createTempLocksRoot();
    const ownerToken = createLocalRuntimeMutationLockOwnerToken();
    const outer = await acquireLocalRuntimeMutationLock({
      locksRoot,
      resourceKey: 'session-writer:alpha',
      ownerToken,
      waitTimeoutMs: 0,
    });
    const nested = acquireLocalRuntimeMutationLockSync({
      locksRoot,
      resourceKey: 'session-writer:alpha',
      ownerToken,
      waitTimeoutMs: 0,
    });

    expect(nested.lockPath).toBe(outer.lockPath);
    nested.release();
    expect(() =>
      acquireLocalRuntimeMutationLockSync({
        locksRoot,
        resourceKey: 'session-writer:alpha',
        waitTimeoutMs: 0,
      }),
    ).toThrow(LocalRuntimeMutationLockBusyError);

    await outer.release();
    const next = acquireLocalRuntimeMutationLockSync({
      locksRoot,
      resourceKey: 'session-writer:alpha',
      waitTimeoutMs: 0,
    });
    next.release();
  });

  it('reenters the same physical lock root through filesystem aliases', async () => {
    const {aliasLocksRoot, physicalLocksRoot} =
      await createAliasedTempLocksRoots();
    const ownerToken = createLocalRuntimeMutationLockOwnerToken();
    const outer = await acquireLocalRuntimeMutationLock({
      locksRoot: physicalLocksRoot,
      resourceKey: 'session-writer:alpha',
      ownerToken,
      waitTimeoutMs: 0,
    });

    expect(
      localRuntimeMutationLockOwnerOwnsResource({
        locksRoot: aliasLocksRoot,
        resourceKey: 'session-writer:alpha',
        ownerToken,
      }),
    ).toBe(true);

    const nested = await acquireLocalRuntimeMutationLock({
      locksRoot: aliasLocksRoot,
      resourceKey: 'session-writer:alpha',
      ownerToken,
      waitTimeoutMs: 0,
    });

    expect(nested.lockPath).toBe(outer.lockPath);
    await nested.release();
    await outer.release();
  });

  it('acquires multiple resources in canonical order', async () => {
    const locksRoot = await createTempLocksRoot();
    const lease = acquireLocalRuntimeMutationLocksSync({
      targets: ['äther', 'zeta', 'alpha', 'zeta'].map(resourceKey => ({
        locksRoot,
        resourceKey,
      })),
      waitTimeoutMs: 0,
    });

    expect(lease.targets.map(target => target.resourceKey).sort()).toEqual([
      'alpha',
      'zeta',
      'äther',
    ]);
    await expect(
      acquireLocalRuntimeMutationLock({
        locksRoot,
        resourceKey: 'alpha',
        waitTimeoutMs: 0,
      }),
    ).rejects.toBeInstanceOf(LocalRuntimeMutationLockBusyError);

    lease.release();

    const reversed = acquireLocalRuntimeMutationLocksSync({
      targets: ['alpha', 'zeta', 'äther'].map(resourceKey => ({
        locksRoot,
        resourceKey,
      })),
      waitTimeoutMs: 0,
    });

    expect(reversed.targets).toEqual(lease.targets);
    reversed.release();
  });

  it('deduplicates aliased physical lock roots before ordering batches', async () => {
    const {aliasLocksRoot, physicalLocksRoot} =
      await createAliasedTempLocksRoots();
    const otherLocksRoot = await createTempLocksRoot();
    const forward = acquireLocalRuntimeMutationLocksSync({
      targets: [
        {locksRoot: aliasLocksRoot, resourceKey: 'shared'},
        {locksRoot: otherLocksRoot, resourceKey: 'other'},
        {locksRoot: physicalLocksRoot, resourceKey: 'shared'},
      ],
      waitTimeoutMs: 0,
    });

    expect(forward.targets).toHaveLength(2);
    expect(
      forward.targets.filter(target => target.resourceKey === 'shared'),
    ).toHaveLength(1);
    await expect(
      acquireLocalRuntimeMutationLock({
        locksRoot: aliasLocksRoot,
        resourceKey: 'shared',
        waitTimeoutMs: 0,
      }),
    ).rejects.toBeInstanceOf(LocalRuntimeMutationLockBusyError);
    forward.release();

    const reversed = acquireLocalRuntimeMutationLocksSync({
      targets: [
        {locksRoot: physicalLocksRoot, resourceKey: 'shared'},
        {locksRoot: otherLocksRoot, resourceKey: 'other'},
        {locksRoot: aliasLocksRoot, resourceKey: 'shared'},
      ],
      waitTimeoutMs: 0,
    });

    expect(reversed.targets).toEqual(forward.targets);
    reversed.release();
  });

  it('keeps the same resource key distinct across lock roots', async () => {
    const firstRoot = await createTempLocksRoot();
    const secondRoot = await createTempLocksRoot();
    const lease = acquireLocalRuntimeMutationLocksSync({
      targets: [
        {locksRoot: secondRoot, resourceKey: 'shared'},
        {locksRoot: firstRoot, resourceKey: 'shared'},
        {locksRoot: secondRoot, resourceKey: 'shared'},
      ],
      waitTimeoutMs: 0,
    });

    expect(lease.targets).toHaveLength(2);
    for (const locksRoot of [firstRoot, secondRoot]) {
      await expect(
        acquireLocalRuntimeMutationLock({
          locksRoot,
          resourceKey: 'shared',
          waitTimeoutMs: 0,
        }),
      ).rejects.toBeInstanceOf(LocalRuntimeMutationLockBusyError);
    }

    lease.release();
  });

  it('reports the failed batch target and rolls back earlier locks', async () => {
    const locksRoot = await createTempLocksRoot();
    const targets = ['batch-first', 'batch-blocked']
      .map(resourceKey => ({locksRoot, resourceKey}))
      .sort((left, right) =>
        lockPathForTarget(left).localeCompare(lockPathForTarget(right)),
      );
    const first = targets[0];
    const blocked = targets[1];

    if (first === undefined || blocked === undefined) {
      throw new TypeError('Expected two mutation lock targets.');
    }

    const blocker = await acquireLocalRuntimeMutationLock({
      ...blocked,
      waitTimeoutMs: 0,
    });
    let failure: unknown;

    try {
      acquireLocalRuntimeMutationLocksSync({
        targets,
        waitTimeoutMs: 0,
      });
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(LocalRuntimeMutationLocksAcquireError);
    expect(
      failure instanceof LocalRuntimeMutationLocksAcquireError
        ? failure.target
        : undefined,
    ).toEqual(blocked);

    const reacquired = await acquireLocalRuntimeMutationLock({
      ...first,
      waitTimeoutMs: 0,
    });

    await reacquired.release();
    await blocker.release();
  });

  it('rejects the blocked batch target once its stall budget runs out', async () => {
    const locksRoot = await createTempLocksRoot();
    const targets = ['budget-first', 'budget-blocked']
      .map(resourceKey => ({locksRoot, resourceKey}))
      .sort((left, right) =>
        lockPathForTarget(left).localeCompare(lockPathForTarget(right)),
      );
    const blocked = targets[1];

    if (blocked === undefined) {
      throw new TypeError('Expected a blocked mutation lock target.');
    }

    const blocker = await acquireLocalRuntimeMutationLock({
      ...blocked,
      waitTimeoutMs: 0,
    });
    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(75)
      .mockReturnValueOnce(75)
      .mockReturnValueOnce(100)
      .mockReturnValue(200);

    let failure: unknown;

    try {
      try {
        acquireLocalRuntimeMutationLocksSync({targets, waitTimeoutMs: 100});
      } catch (error: unknown) {
        failure = error;
      }

      expect(failure).toMatchObject({target: blocked});
      expect(clock).toHaveBeenCalledTimes(6);
    } finally {
      clock.mockRestore();
      await blocker.release();
    }
  });

  it('deduplicates and reenters heterogeneous sync batches', async () => {
    const firstRoot = await createTempLocksRoot();
    const secondRoot = await createTempLocksRoot();
    const ownerToken = createLocalRuntimeMutationLockOwnerToken();
    const ownedTarget = {locksRoot: firstRoot, resourceKey: 'owned'};
    const otherTarget = {locksRoot: secondRoot, resourceKey: 'other'};
    const outer = acquireLocalRuntimeMutationLockSync({
      ...ownedTarget,
      ownerToken,
      waitTimeoutMs: 0,
    });
    const batch = acquireLocalRuntimeMutationLocksSync({
      targets: [otherTarget, ownedTarget, otherTarget],
      ownerToken,
      waitTimeoutMs: 0,
    });

    expect(batch.targets).toHaveLength(2);
    batch.release();
    expect(() =>
      acquireLocalRuntimeMutationLockSync({
        ...ownedTarget,
        waitTimeoutMs: 0,
      }),
    ).toThrow(LocalRuntimeMutationLockBusyError);

    outer.release();
    const next = acquireLocalRuntimeMutationLockSync({
      ...ownedTarget,
      waitTimeoutMs: 0,
    });
    next.release();
  });

  it('reenters aliased physical lock roots in sync batches', async () => {
    const {aliasLocksRoot, physicalLocksRoot} =
      await createAliasedTempLocksRoots();
    const ownerToken = createLocalRuntimeMutationLockOwnerToken();
    const outer = acquireLocalRuntimeMutationLockSync({
      locksRoot: physicalLocksRoot,
      resourceKey: 'owned',
      ownerToken,
      waitTimeoutMs: 0,
    });
    const nested = acquireLocalRuntimeMutationLocksSync({
      targets: [{locksRoot: aliasLocksRoot, resourceKey: 'owned'}],
      ownerToken,
      waitTimeoutMs: 0,
    });

    expect(nested.targets).toHaveLength(1);
    nested.release();
    expect(() =>
      acquireLocalRuntimeMutationLockSync({
        locksRoot: aliasLocksRoot,
        resourceKey: 'owned',
        waitTimeoutMs: 0,
      }),
    ).toThrow(LocalRuntimeMutationLockBusyError);

    outer.release();
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

    expect(
      reclaimObservedLocalRuntimeMutationLock(
        {locksRoot, resourceKey, waitTimeoutMs: 0},
        staleDeadOwner,
      ),
    ).toBe(false);
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
    let nestedReclaim: boolean | undefined;

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

    expect(outerReclaim).toBe(true);
    expect(nestedReclaim).toBe(true);
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

  it('restarts the wait budget while the lock keeps changing hands', async () => {
    const locksRoot = await createTempLocksRoot();
    const target = {locksRoot, resourceKey: 'draining-queue'};
    const waitTimeoutMs = 200;
    const handOffCount = 4;
    const holder = await acquireLocalRuntimeMutationLock({
      ...target,
      waitTimeoutMs: 0,
    });
    const ownerFile = join(lockPathForTarget(target), 'owner.json');
    const heldOwner = JSON.parse(await readFile(ownerFile, 'utf8')) as Record<
      string,
      unknown
    >;
    // A fresh nonce under the same live pid is what a contender sees when the
    // queue hands the lock on; the lock itself stays held throughout.
    const handOffs = (async () => {
      for (let index = 0; index < handOffCount; index += 1) {
        await delay(waitTimeoutMs / 2);
        await writeFile(
          ownerFile,
          `${JSON.stringify({...heldOwner, nonce: `hand-off-${String(index)}`})}\n`,
          'utf8',
        );
      }
    })();
    const startedAt = Date.now();

    // A stall budget gives up only once the hand-offs stop.
    await expect(
      acquireLocalRuntimeMutationLock({...target, waitTimeoutMs}),
    ).rejects.toBeInstanceOf(LocalRuntimeMutationLockBusyError);
    expect(Date.now() - startedAt).toBeGreaterThan(
      (waitTimeoutMs / 2) * handOffCount,
    );

    await handOffs;
    await holder.release();
  });

  it('rejects a contender once the holder stops making progress', async () => {
    const locksRoot = await createTempLocksRoot();
    const target = {locksRoot, resourceKey: 'stalled-holder'};
    // Never released, so the owner nonce never changes.
    const holder = await acquireLocalRuntimeMutationLock({
      ...target,
      waitTimeoutMs: 0,
    });
    const startedAt = Date.now();

    await expect(
      acquireLocalRuntimeMutationLock({...target, waitTimeoutMs: 200}),
    ).rejects.toBeInstanceOf(LocalRuntimeMutationLockBusyError);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);

    await holder.release();
  });
});

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>(resolveDelay => {
    setTimeout(resolveDelay, milliseconds);
  });
}

function lockPathForTarget(target: {
  readonly locksRoot: string;
  readonly resourceKey: string;
}): string {
  const hash = createHash('sha256').update(target.resourceKey).digest('hex');

  return join(target.locksRoot, `${hash}.lock`);
}

async function createTempLocksRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'project02-mutation-lock-'));
  tempRoots.push(root);
  return join(root, 'locks');
}

async function createAliasedTempLocksRoots(): Promise<{
  readonly aliasLocksRoot: string;
  readonly physicalLocksRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'project02-mutation-lock-alias-'));
  const physicalRoot = join(root, 'physical');

  tempRoots.push(root);
  await mkdir(physicalRoot);
  await symlink(physicalRoot, join(root, 'alias'), 'dir');

  return {
    aliasLocksRoot: join(root, 'alias', '.locks'),
    physicalLocksRoot: join(physicalRoot, '.locks'),
  };
}
