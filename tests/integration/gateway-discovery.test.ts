import {existsSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {claimDaemonHome} from '../../src/gateway/index.ts';
import {readDaemonRecord} from '../../src/shared/daemon-record.ts';
import {createGatewayTestHome} from '../support/gateway-fixtures.ts';

describe("the daemon's claim on a home", () => {
  it('is held by one claimant at a time, keeps the token and the port across claims, and reports a port that moved', async () => {
    const homeRoot = await createGatewayTestHome('project02-discovery-');
    const first = await claimDaemonHome({homeRoot});

    if (first.status !== 'claimed') {
      expect.fail('the first claim was not taken');
    }

    // Nothing is written until the address is known.
    expect(first.claim.port).toBeUndefined();
    expect(readDaemonRecord({homeRoot})).toEqual({status: 'absent'});
    await expect(claimDaemonHome({homeRoot})).resolves.toEqual({
      status: 'held',
    });

    // A replacement a killed writer left behind goes with the first write.
    const abandoned = join(
      homeRoot,
      '.daemon.json.4242.00000000-0000-4000-8000-000000000000.tmp',
    );

    writeFileSync(abandoned, '{');
    expect(first.claim.publish(4310)).toBeUndefined();
    expect(existsSync(abandoned)).toBe(false);
    await expect(claimDaemonHome({homeRoot})).resolves.toMatchObject({
      status: 'held',
      record: {
        token: first.claim.token,
        port: 4310,
        running: {pid: process.pid},
      },
    });
    await expect(first.claim.release()).resolves.toBeUndefined();
    expect(readDaemonRecord({homeRoot})).toEqual({
      status: 'ok',
      record: {protocolVersion: 6, token: first.claim.token, port: 4310},
    });

    const second = await claimDaemonHome({homeRoot});

    if (second.status !== 'claimed') {
      expect.fail('the second claim was not taken');
    }

    expect(second.claim.token).toBe(first.claim.token);
    expect(second.claim.port).toBe(4310);
    // Bound elsewhere: the port the record held is reported as moved.
    expect(second.claim.publish(4311)).toBe(4310);
    await expect(second.claim.release()).resolves.toBeUndefined();
  });
});
