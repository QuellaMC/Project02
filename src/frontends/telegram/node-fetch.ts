import {request as httpRequest, type IncomingMessage} from 'node:http';
import {Readable} from 'node:stream';

/**
 * A fetch over `node:http` that waits as long as the daemon does: Node's
 * own fetch gives a response five minutes, and a turn parked on a
 * confirmation outlives that. It speaks plain HTTP, as the gateway does on
 * loopback, and follows no redirect.
 */
export function createNodeFetch(): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    if (url.protocol !== 'http:') {
      throw new TypeError(`Only http: is spoken here, not ${url.protocol}`);
    }

    const body = request.body === null ? undefined : await request.bytes();

    if (request.signal.aborted) {
      throw abortReason(request.signal);
    }

    const incoming = await exchange(url, request, body);

    try {
      return new Response(Readable.toWeb(incoming), {
        status: incoming.statusCode ?? 0,
        statusText: incoming.statusMessage ?? '',
        headers: headersOf(incoming),
      });
    } catch (error: unknown) {
      // An answer a Response cannot carry, such as a status past 599, is a
      // failed fetch whose socket goes with it.
      incoming.destroy();
      throw error;
    }
  };
}

/**
 * Settles on the answer's headers. An abort tears the socket down wherever
 * it lands: before the headers the exchange rejects, after them the body
 * breaks off.
 */
function exchange(
  url: URL,
  request: Request,
  body: Uint8Array | undefined,
): Promise<IncomingMessage> {
  const {signal} = request;

  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(url, {
      method: request.method,
      headers: Object.fromEntries(request.headers),
    });
    const abort = (): void => {
      reject(abortReason(signal));
      outgoing.destroy();
    };

    signal.addEventListener('abort', abort, {once: true});
    outgoing.on('close', () => {
      signal.removeEventListener('abort', abort);
    });
    outgoing.on('error', reject);
    outgoing.on('response', resolve);
    outgoing.end(body);
  });
}

function headersOf(incoming: IncomingMessage): Headers {
  const headers = new Headers();

  for (const [name, values] of Object.entries(incoming.headersDistinct)) {
    for (const value of values ?? []) {
      headers.append(name, value);
    }
  }

  return headers;
}

/**
 * The abort's reason, as the platform's fetch rejects with it; one that is
 * not an error becomes the platform's own AbortError.
 */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('This operation was aborted', 'AbortError');
}
