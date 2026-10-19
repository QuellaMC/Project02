import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {expect, it} from 'vitest';

import {startDaemon} from './harness/daemon.ts';
import {frameOf, openEvents} from './harness/events.ts';
import {chmod, characterJson, createHome} from './harness/home.ts';
import {saveConfig, wireOf} from './harness/wire.ts';

type Asked = {
  readonly request: {readonly code: string; readonly requestedAt: string};
};

const fixedReplies = {PROJECT02_TEST_PROVIDER: 'deterministic'};
const alice = {id: '381940562', label: 'Alice (@alice)'};
const bob = {id: '987654321', label: 'Bob (@bob)'};

function homeConfig(home: string): string {
  return readFileSync(join(home, 'config.json'), 'utf8');
}

it('pairing.request-pending: an account a connector does not know waits under a six-digit code for an hour, announced on the stream, and asking again returns the same request', async () => {
  const daemon = await startDaemon(createHome());
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);
  const asked = (await wire.pairingRequest('telegram', alice)) as Asked;
  const {request} = asked;

  expect(asked).toEqual({
    status: 'pending',
    request: {
      connectorId: 'telegram',
      code: expect.stringMatching(/^\d{6}$/u) as string,
      subject: alice,
      requestedAt: expect.any(String) as string,
      expiresAt: Date.parse(request.requestedAt) + 60 * 60_000,
    },
  });
  expect(
    JSON.parse((await events.next(frameOf('pairing_requested'))).data ?? ''),
  ).toEqual({kind: 'pairing_requested', ...request});
  expect(await wire.pairingRequest('telegram', alice)).toEqual(asked);
  expect(await wire.pendingPairings()).toEqual([request]);
});

it("pairing.approve-writes-allowlist: an approval writes the account into the home's pairedUsers, which every character reads, says health_changed before pairing_settled, reloads no one, and asking again answers paired", async () => {
  const home = createHome({
    characters: {
      nova: {'project02.character.json': characterJson('nova', 'Nova')},
    },
  });
  const daemon = await startDaemon(home, fixedReplies);
  const wire = wireOf(daemon);

  await wire.start('mira');
  await wire.start('nova');

  const events = await openEvents(daemon);
  const {request} = (await wire.pairingRequest('telegram', alice)) as Asked;

  expect(await wire.pairingAnswer(request.code, 'approved')).toEqual({
    status: 'settled',
    decision: 'approved',
  });
  await events.next(frameOf('pairing_requested', {code: request.code}));
  await events.next(frameOf('health_changed'));
  await events.next(
    frameOf('pairing_settled', {
      connectorId: 'telegram',
      code: request.code,
      subject: alice,
      decision: 'approved',
    }),
  );

  const paired = {pairedUsers: {[alice.id]: alice.label}};

  expect(JSON.parse(homeConfig(home))).toMatchObject({
    connectors: {telegram: {config: paired}},
  });
  expect(await wire.connectorConfig('telegram')).toMatchObject({
    home: {values: paired},
    characters: [
      {characterId: 'mira', values: paired},
      {characterId: 'nova', values: paired},
    ],
  });
  expect(await wire.pairingRequest('telegram', alice)).toEqual({
    status: 'paired',
  });

  // Passes never overlap: once a later one stops Nova, a reload the
  // approval's pass began would be on the stream.
  await saveConfig(
    wire,
    {scope: 'character', characterId: 'nova'},
    {kind: 'set', path: 'project02.enabled', value: false},
  );
  await events.next(
    frameOf('state_changed', {characterId: 'nova', state: 'stopping'}),
  );
  expect(
    events.frames.filter(frameOf('state_changed', {state: 'reloading'})),
  ).toEqual([]);
});

it('pairing.deny: a denial settles denied and writes nothing, a second answer is unknown, and a subject the body cannot take is a 400', async () => {
  const home = createHome();
  const daemon = await startDaemon(home);
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);
  const before = homeConfig(home);
  const {request} = (await wire.pairingRequest('telegram', alice)) as Asked;

  expect(await wire.pairingAnswer(request.code, 'denied')).toEqual({
    status: 'settled',
    decision: 'denied',
  });
  await events.next(
    frameOf('pairing_settled', {code: request.code, decision: 'denied'}),
  );
  expect(homeConfig(home)).toBe(before);
  expect(await wire.pairingAnswer(request.code, 'approved')).toEqual({
    status: 'unknown',
  });
  await expect(
    wire.pairingRequest('telegram', {id: 'two tokens', label: alice.label}),
  ).rejects.toThrow('POST /api/connectors/telegram/pairing answered 400');
});

it('pairing.invalid-subject: pairing is refused unknown_connector for a connector that does not pair and invalid_subject for a label with a line break, and an answer to a code never given is unknown', async () => {
  const wire = wireOf(await startDaemon(createHome()));

  expect(await wire.pairingRequest('discord', alice)).toMatchObject({
    status: 'refused',
    reason: 'unknown_connector',
  });
  expect(
    await wire.pairingRequest('telegram', {
      id: alice.id,
      label: 'Alice\nApproved',
    }),
  ).toMatchObject({status: 'refused', reason: 'invalid_subject'});
  expect(await wire.pairingAnswer('123456', 'approved')).toEqual({
    status: 'unknown',
  });
  expect(await wire.pendingPairings()).toEqual([]);
});

it('pairing.expire: a request nobody answers in time settles expired on the stream, and a later answer is unknown', async () => {
  const daemon = await startDaemon(createHome(), {
    PROJECT02_TEST_DURATIONS: 'pairing=500',
  });
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);
  const asked = performance.now();
  const {request} = (await wire.pairingRequest('telegram', alice)) as Asked;

  await events.next(
    frameOf('pairing_settled', {
      code: request.code,
      subject: alice,
      decision: 'expired',
    }),
  );

  const waited = performance.now() - asked;

  // At its deadline of half a second: neither at once nor long after.
  expect(waited).toBeGreaterThanOrEqual(450);
  expect(waited).toBeLessThan(3_000);
  expect(await wire.pairingAnswer(request.code, 'approved')).toEqual({
    status: 'unknown',
  });
  expect(await wire.pendingPairings()).toEqual([]);
});

it('pairing.approve-write-failed: an approval the home cannot take answers failed with the reason, and the request waits on to its own deadline, announced again', async () => {
  const home = createHome();
  const daemon = await startDaemon(home);
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);
  const {request} = (await wire.pairingRequest('telegram', alice)) as Asked;

  await events.next(frameOf('pairing_requested', {code: request.code}));
  chmod(home, 0o500);

  try {
    expect(await wire.pairingAnswer(request.code, 'approved')).toEqual({
      status: 'failed',
      message: expect.stringContaining(join(home, 'config.json')) as string,
    });
  } finally {
    chmod(home, 0o700);
  }

  expect(
    JSON.parse(
      (await events.next(frameOf('pairing_requested', {code: request.code})))
        .data ?? '',
    ),
  ).toEqual({kind: 'pairing_requested', ...request});
  expect(await wire.pendingPairings()).toEqual([request]);
});

it('pairing.paired-elsewhere-settles: a request whose account another settings window paired meanwhile settles approved, asked again or answered, keeping the name that window gave', async () => {
  const home = createHome();
  const daemon = await startDaemon(home);
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);
  const forAlice = (await wire.pairingRequest('telegram', alice)) as Asked;
  const forBob = (await wire.pairingRequest('telegram', bob)) as Asked;
  const named = {[alice.id]: 'Alice', [bob.id]: 'Bob'};

  await saveConfig(
    wire,
    {scope: 'global'},
    {
      kind: 'section_field_set',
      namespace: 'connectors',
      id: 'telegram',
      field: 'pairedUsers',
      value: named,
    },
  );
  expect(await wire.pairingRequest('telegram', alice)).toEqual({
    status: 'paired',
  });
  await events.next(
    frameOf('pairing_settled', {
      code: forAlice.request.code,
      decision: 'approved',
    }),
  );
  expect(await wire.pairingAnswer(forBob.request.code, 'approved')).toEqual({
    status: 'settled',
    decision: 'approved',
  });
  await events.next(
    frameOf('pairing_settled', {
      code: forBob.request.code,
      decision: 'approved',
    }),
  );
  expect(JSON.parse(homeConfig(home))).toMatchObject({
    connectors: {telegram: {config: {pairedUsers: named}}},
  });
});

it("pairing.not-across-restart: pairing requests live as long as the daemon's run: the ready after a restart carries none, and asking again makes a new one", async () => {
  const home = createHome();
  const first = await startDaemon(home);
  const before = (await wireOf(first).pairingRequest(
    'telegram',
    alice,
  )) as Asked;

  first.signal('SIGINT');
  await first.exit();

  const next = await startDaemon(home);
  const events = await openEvents(next);

  await events.next(frameOf('ready', {pairings: []}));
  expect(
    await wireOf(next).pairingAnswer(before.request.code, 'approved'),
  ).toEqual({status: 'unknown'});

  const again = (await wireOf(next).pairingRequest('telegram', alice)) as Asked;

  await events.next(
    frameOf('pairing_requested', {code: again.request.code, subject: alice}),
  );
  expect(Date.parse(again.request.requestedAt)).toBeGreaterThan(
    Date.parse(before.request.requestedAt),
  );
});
