import {mkdirSync, rmdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {readDaemonRecord} from '../../src/shared/daemon-record.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

describe("the daemon's record", () => {
  it('reads as absent with no file, as unreadable naming the file when what is there is not a record, and as the record itself when it is', () => {
    const homeRoot = createTestTempRoot('project02-daemon-record-');
    const path = join(homeRoot, 'daemon.json');
    const unreadable = {
      status: 'unreadable',
      message: expect.stringContaining(path) as string,
    };

    expect(readDaemonRecord({homeRoot})).toEqual({status: 'absent'});

    mkdirSync(path);
    expect(readDaemonRecord({homeRoot})).toEqual(unreadable);
    rmdirSync(path);

    for (const body of [
      '{"protocolVersion": 6, "token": "abc", "port": 43',
      JSON.stringify({protocolVersion: 6, port: 4310}),
      JSON.stringify({
        protocolVersion: 6,
        token: 'abc',
        port: 4310,
        running: {pid: 0, startedAt: '2026-10-17T09:00:00.000Z'},
      }),
    ]) {
      writeFileSync(path, body);
      expect(readDaemonRecord({homeRoot})).toEqual(unreadable);
    }

    const stopped = {protocolVersion: 6, token: 'abc', port: 4310};
    const running = {
      ...stopped,
      running: {pid: 4242, startedAt: '2026-10-17T09:00:00.000Z'},
    };

    for (const record of [stopped, running]) {
      writeFileSync(path, JSON.stringify(record));
      expect(readDaemonRecord({homeRoot})).toEqual({status: 'ok', record});
    }
  });
});
