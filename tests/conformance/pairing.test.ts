import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {expect, it} from 'vitest';

import {startDaemon} from './harness/daemon.ts';
import {frameOf, openEvents} from './harness/events.ts';
import {createHome} from './harness/home.ts';
import {wireOf} from './harness/wire.ts';

type Asked = {readonly request: {readonly code: string}};

/** Alice's request, written to Mira's bot. */
const fromAlice = {
  subject: {id: '381940562', label: 'Alice (@alice)'},
  source: 'telegram:mira_bot',
};

function homeConfig(home: string): string {
  return readFileSync(join(home, 'config.json'), 'utf8');
}

it('pairing.deny: a denied account is not paired: the denial settles on the stream and writes nothing, and asking again waits on an answer again', async () => {
  const home = createHome();
  const daemon = await startDaemon(home);
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);
  const before = homeConfig(home);
  const {request} = (await wire.pairingRequest('telegram', fromAlice)) as Asked;

  expect(await wire.pairingAnswer(request.code, 'denied')).toEqual({
    status: 'settled',
    decision: 'denied',
  });
  await events.next(
    frameOf('pairing_settled', {code: request.code, decision: 'denied'}),
  );
  expect(homeConfig(home)).toBe(before);
  expect(await wire.pairingRequest('telegram', fromAlice)).toMatchObject({
    status: 'pending',
  });
});
