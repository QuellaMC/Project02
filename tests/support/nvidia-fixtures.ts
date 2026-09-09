/**
 * Responses the way the NVIDIA endpoint sends them, for the fetch seam the
 * adapter takes: a streamed completion is a run of `data:` chunks and the
 * terminator, an error is a plain body with its status.
 */
export function sseText(chunks: readonly unknown[]): string {
  return chunks
    .map(
      chunk =>
        `data: ${typeof chunk === 'string' ? chunk : JSON.stringify(chunk)}\n\n`,
    )
    .join('');
}

export function sseResponse(
  chunks: readonly unknown[],
  status = 200,
): Response {
  return new Response(sseText(chunks), {
    status,
    headers: {'content-type': 'text/event-stream'},
  });
}

/**
 * A whole completion, streamed as the endpoint would stream it: one delta
 * carrying the message and its finish reason, a usage chunk when the
 * completion has one, then the terminator.
 */
export function streamed(
  completion: Readonly<Record<string, unknown>>,
  status = 200,
): Response {
  const choices = completion['choices'];
  const choice: unknown = Array.isArray(choices) ? choices[0] : undefined;
  const message = recordOf(recordOf(choice)?.['message']);
  const toolCalls = message?.['tool_calls'];
  const delta: Record<string, unknown> = {
    role: 'assistant',
    ...(message?.['content'] === undefined
      ? {}
      : {content: message['content']}),
    ...(Array.isArray(toolCalls)
      ? {
          tool_calls: toolCalls.map((call: unknown, index) => ({
            index,
            ...(recordOf(call) ?? {}),
          })),
        }
      : {}),
  };

  return sseResponse(
    [
      {
        choices: [
          {
            index: 0,
            delta,
            finish_reason: recordOf(choice)?.['finish_reason'] ?? null,
          },
        ],
      },
      ...(completion['usage'] === undefined
        ? []
        : [{choices: [], usage: completion['usage']}]),
      '[DONE]',
    ],
    status,
  );
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json'},
  });
}

export function textResponse(text: string, status: number): Response {
  return new Response(text, {status});
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
