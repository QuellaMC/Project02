import {describe, expect, it} from 'vitest';

import {
  createSseFrameSplitter,
  parseSseFrame,
} from '../../src/gateway/client/sse.ts';

describe('gateway client SSE parsing', () => {
  it('reassembles frames split across chunks, whatever the line ending', () => {
    const splitter = createSseFrameSplitter();

    expect(
      splitter.push('event: ready\ndata: {"protocolVersion":1}\n'),
    ).toEqual([]);
    expect(splitter.push('\nevent: turn_completed\r\ndata: {"a":1}\r')).toEqual(
      [{event: 'ready', data: '{"protocolVersion":1}'}],
    );
    expect(splitter.push('\n\r\n: ping\n\n')).toEqual([
      {event: 'turn_completed', data: '{"a":1}'},
      {comment: 'ping'},
    ]);
  });

  it('joins multi-line data, strips one leading space, reads the id, and skips unknown fields', () => {
    expect(
      parseSseFrame(
        'event:state_changed\ndata: {"kind":\ndata:  "x"}\nid: 7\nretry',
      ),
    ).toEqual({id: '7', event: 'state_changed', data: '{"kind":\n "x"}'});
  });
});
