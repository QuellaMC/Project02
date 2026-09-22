import {describe, expect, it, vi} from 'vitest';

import type {GatewayEvent} from '../../src/gateway/index.ts';
import {createConfirmationBroker} from '../../src/gateway/runtime/confirmation-broker.ts';

const request = {
  pluginId: 'demo.plugin',
  toolName: 'demo_tool',
  summary: 'Do the thing',
  preview: {},
};

const turn = {conversationId: 'conv-1', source: 'web', clientMessageId: 'm-1'};

function createBrokerHarness() {
  const events: Extract<GatewayEvent, {kind: 'confirmation_requested'}>[] = [];
  const settled: string[] = [];
  const broker = createConfirmationBroker({
    characterId: 'mira',
    turnOf: () => turn,
    emit(event) {
      if (event.kind === 'confirmation_requested') {
        events.push(event);
      }
    },
    onSettled(id, settlement) {
      settled.push(
        settlement.decision === 'cancelled'
          ? `${id}:cancelled:${settlement.reason}`
          : `${id}:${settlement.decision}`,
      );
    },
  });
  const ask = (signal?: AbortSignal, deadlineAt = Date.now() + 60_000) =>
    broker.handler(request, {
      signal: signal ?? new AbortController().signal,
      deadlineAt,
    });

  return {broker, events, settled, ask};
}

describe('gateway confirmation broker', () => {
  it('parks a request behind a unique id and resolves it by that id alone', async () => {
    const {broker, events, settled, ask} = createBrokerHarness();
    const first = ask();
    const second = ask();

    expect(events).toHaveLength(2);
    expect(events[0]?.id).not.toBe(events[1]?.id);
    // Stamped with the turn that raised it, on the event and in the list.
    expect(events[0]).toMatchObject({characterId: 'mira', request, turn});
    expect(events[0]?.deadlineAt).toBeTypeOf('number');
    expect(broker.pending().map(parked => parked.id)).toEqual(
      events.map(event => event.id),
    );
    expect(broker.pending()[0]).toMatchObject({request, turn});

    expect(broker.answer(events[0]?.id ?? '', 'approved')).toBe('answered');
    expect(broker.answer(events[1]?.id ?? '', 'denied')).toBe('answered');
    expect(broker.answer(events[1]?.id ?? '', 'denied')).toBe('unknown');

    await expect(first).resolves.toEqual({status: 'approved'});
    await expect(second).resolves.toEqual({status: 'denied'});
    expect(broker.pending()).toEqual([]);
    expect(settled).toEqual([
      `${events[0]?.id ?? ''}:approved`,
      `${events[1]?.id ?? ''}:denied`,
    ]);
  });

  it("settles as cancelled when the host's deadline aborts, and a late answer is a no-op", async () => {
    const {broker, events, settled, ask} = createBrokerHarness();
    const abort = new AbortController();
    const decision = ask(abort.signal);

    abort.abort();

    await expect(decision).resolves.toEqual({status: 'cancelled'});
    expect(broker.answer(events[0]?.id ?? '', 'approved')).toBe('unknown');
    await expect(decision).resolves.toEqual({status: 'cancelled'});
    expect(settled).toEqual([`${events[0]?.id ?? ''}:cancelled:expired`]);
  });

  it('refuses an answer at the deadline even before the host aborts', async () => {
    vi.useFakeTimers();

    try {
      vi.setSystemTime(10_000);

      const {broker, events, settled, ask} = createBrokerHarness();
      const decision = ask(undefined, 11_000);

      vi.setSystemTime(11_000);

      expect(broker.answer(events[0]?.id ?? '', 'approved')).toBe('expired');
      await expect(decision).resolves.toEqual({status: 'cancelled'});
      expect(settled).toEqual([`${events[0]?.id ?? ''}:cancelled:expired`]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels everything still parked on cancelAll, saying the character stopped', async () => {
    const {broker, events, settled, ask} = createBrokerHarness();
    const first = ask();
    const second = ask();

    broker.cancelAll();

    await expect(first).resolves.toEqual({status: 'cancelled'});
    await expect(second).resolves.toEqual({status: 'cancelled'});
    expect(settled).toEqual(
      events.map(event => `${event.id}:cancelled:stopped`),
    );
  });

  it('settles a request that arrives after shutdown at once, then parks again re-armed', async () => {
    const {broker, events, ask} = createBrokerHarness();

    broker.cancelAll();
    const duringShutdown = ask();

    // A turn draining into an approval-gated tool never parks for the host
    // deadline: no event, settled immediately.
    expect(events).toHaveLength(0);
    await expect(duringShutdown).resolves.toEqual({status: 'cancelled'});

    broker.arm();
    const afterRestart = ask();

    expect(events).toHaveLength(1);
    expect(broker.answer(events[0]?.id ?? '', 'approved')).toBe('answered');
    await expect(afterRestart).resolves.toEqual({status: 'approved'});
  });
});
