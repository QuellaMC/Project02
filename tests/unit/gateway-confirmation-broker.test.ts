import {describe, expect, it} from 'vitest';

import type {GatewayEvent} from '../../src/gateway/index.ts';
import {createConfirmationBroker} from '../../src/gateway/runtime/confirmation-broker.ts';

const request = {
  pluginId: 'demo.plugin',
  toolName: 'demo_tool',
  summary: 'Do the thing',
  preview: {},
};

function createBrokerHarness() {
  const events: Extract<GatewayEvent, {kind: 'confirmation_requested'}>[] = [];
  const broker = createConfirmationBroker({
    characterId: 'mira',
    emit(event) {
      if (event.kind === 'confirmation_requested') {
        events.push(event);
      }
    },
  });
  const ask = (signal?: AbortSignal) =>
    broker.handler(request, {
      signal: signal ?? new AbortController().signal,
      deadlineAt: 1_000,
    });

  return {broker, events, ask};
}

describe('gateway confirmation broker', () => {
  it('parks a request behind a unique id and resolves it by that id alone', async () => {
    const {broker, events, ask} = createBrokerHarness();
    const first = ask();
    const second = ask();

    expect(events).toHaveLength(2);
    expect(events[0]?.id).not.toBe(events[1]?.id);
    expect(events[0]).toMatchObject({
      characterId: 'mira',
      request,
      deadlineAt: 1_000,
    });

    broker.answer(events[0]?.id ?? '', 'approved');
    broker.answer(events[1]?.id ?? '', 'denied');

    await expect(first).resolves.toEqual({status: 'approved'});
    await expect(second).resolves.toEqual({status: 'denied'});
  });

  it("settles as cancelled when the host's deadline aborts, and a late answer is a no-op", async () => {
    const {broker, events, ask} = createBrokerHarness();
    const abort = new AbortController();
    const decision = ask(abort.signal);

    abort.abort();

    await expect(decision).resolves.toEqual({status: 'cancelled'});
    broker.answer(events[0]?.id ?? '', 'approved');
    await expect(decision).resolves.toEqual({status: 'cancelled'});
  });

  it('cancels everything still parked on cancelAll', async () => {
    const {broker, ask} = createBrokerHarness();
    const first = ask();
    const second = ask();

    broker.cancelAll();

    await expect(first).resolves.toEqual({status: 'cancelled'});
    await expect(second).resolves.toEqual({status: 'cancelled'});
  });
});
