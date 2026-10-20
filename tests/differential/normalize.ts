/**
 * One run's recording reduced to the text the differential run compares.
 * Every rule that lets a run of one build stand beside a run of another
 * is here, with what it takes out and why; everything else is compared
 * as it came.
 *
 * The run's own values, which differ between any two runs of one build:
 * - Places: the home's path and the stand-in servers' addresses are
 *   named, since another run lives elsewhere.
 * - Ids: each UUID is numbered by its first appearance, since ids are
 *   minted at random; equal ones stay equal, and their prefixes and the
 *   ids composed from them are compared.
 * - Fingerprints: each string found under a key that names a fingerprint
 *   is numbered by its first appearance, wherever it then turns up, since
 *   a fingerprint hashes documents that name the run's places and its
 *   spelling is the daemon's own (plan, "Kept identical").
 * - Moments: an ISO timestamp, a day in either spelling the reference
 *   writes, and a number under a key that ends in `At` are marked, since
 *   two runs read two clocks; a moment spelled otherwise still shows.
 * - Frames: pings, which come on a timer, and frame ids, which count
 *   under a random run id, are dropped.
 *
 * The differences the owner permits a port in what the model is shown
 * (plan Q7: rows 14, 17 and 18 of its differences table), wherever what
 * the model was shown appears, in a request or in inspect's copy of one:
 * - The window (row 17): a request's messages after its leading system
 *   frames go in groups, each opened by a user message — a continued
 *   session's recollection, the replayed turns, then this turn — so a
 *   window that holds one turn more or less, as one estimated in code
 *   points may, shows as that turn.
 * - Tool payloads (row 18): a chat message's tool-call arguments and tool
 *   content are JSON texts, shown as the values they spell, so the order
 *   of integer-like keys and the spelling of a number go.
 * - Rejection wording (row 14): what the runtime said of a reply it could
 *   not use is `<rejection>`, in the note the next round carries and in
 *   inspect's account of the round, since the port writes those sentences
 *   anew; the sentence that carries them stays.
 * - Prompt measures: inspect's count of each round's prompt is
 *   `<measured>`, since it counts in the unit row 17 changes and moves
 *   with every difference above; the requests it measures are compared.
 *
 * Spelling: each JSON text is compared as its value, and a text that is
 * not that value as the reference spells its kind — compact on the wire,
 * indented by two with a closing line feed from inspect — keeps the
 * stretch where it parts from that spelling, so outside the permitted
 * differences the comparison is byte for byte.
 */
import type {Frame} from '../conformance/harness/events.ts';

/** Where a run lived: its home, and the ports on 127.0.0.1 of the stand-in servers it pointed the daemon at. */
export type Places = {
  readonly home: string;
  readonly modelServerPort: string;
  readonly memoryServerPort: string;
};

/** What one run of the scenario left, as it came. */
export type Recording = {
  readonly places: Places;
  readonly modelRequests: readonly {
    readonly path: string;
    readonly authorization: string | undefined;
    readonly text: string;
  }[];
  readonly memoryRequests: readonly {
    readonly method: string;
    readonly path: string;
    readonly text: string;
  }[];
  readonly frames: readonly Frame[];
  readonly historyPages: readonly string[];
  readonly reports: readonly Report[];
};

/** One `inspect` the run made, with what it printed. */
export type Report = {
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

/** One thing the run left: what it is, and what its text holds. */
type Part = {
  readonly title: string;
  /** The value its JSON text spells, the text itself when it spells none, or nothing when it was empty. */
  readonly value?: unknown;
  /** Where its text parts from the reference's spelling of its value, when it does. */
  readonly spelling?: string;
};

const unusableReply = 'Your last reply could not be used. The runtime said: ';
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu;
const isoMoment = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/gu;
const longDay =
  /(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day, (?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}/gu;
const isoDay = /\d{4}-\d{2}-\d{2}/gu;

export function normalize(recording: Recording): string {
  const parts = partsOf(recording);
  const {text, shown} = runValues(
    recording.places,
    fingerprintsIn(parts.map(part => part.value)),
  );

  return parts
    .map(part =>
      [
        `── ${text(part.title)}`,
        ...('value' in part ? [JSON.stringify(part.value, shown, 2)] : []),
        ...(part.spelling === undefined
          ? []
          : [`spelled otherwise ${text(part.spelling)}`]),
      ].join('\n'),
    )
    .join('\n');
}

function partsOf(recording: Recording): Part[] {
  const wire = (value: unknown): string => JSON.stringify(value);
  const report = (value: unknown): string =>
    `${JSON.stringify(value, null, 2)}\n`;

  return [
    ...recording.modelRequests.map(request => ({
      title: `model request ${request.path}, authorization ${String(request.authorization)}`,
      ...partOf(request.text, wire, inWindow),
    })),
    ...recording.memoryRequests.map(request => ({
      title: `memory request ${request.method} ${request.path}`,
      ...partOf(request.text, wire),
    })),
    ...recording.frames
      .filter(frame => frame.comment === undefined)
      .map(frame => ({
        title: `frame ${String(frame.event)}`,
        ...partOf(frame.data ?? '', wire),
      })),
    ...recording.historyPages.map(page => ({
      title: 'history page',
      ...partOf(page, wire),
    })),
    ...recording.reports.flatMap(run => [
      {
        title: `inspect ${run.args.join(' ')}, exited ${String(run.exitCode)}`,
        ...partOf(run.stdout, report),
      },
      ...(run.stderr === '' ? [] : [{title: 'stderr', value: run.stderr}]),
    ]),
  ];
}

/** A text as the value it spells, seen through the permitted differences, with where its spelling parts from the reference's. */
function partOf(
  text: string,
  spelling: (value: unknown) => string,
  view: (value: unknown) => unknown = value => value,
): Omit<Part, 'title'> {
  if (text === '') {
    return {};
  }

  const json = parsed(text);

  if (json === undefined) {
    return {value: text};
  }

  const value = JSON.parse(
    JSON.stringify(view(json.value), permitted),
  ) as unknown;
  const expected = spelling(json.value);

  if (text === expected) {
    return {value};
  }

  let at = 0;

  while (text[at] === expected[at]) {
    at += 1;
  }

  return {
    value,
    spelling: `from character ${String(at)}: ${text.slice(Math.max(0, at - 40), at + 40)}`,
  };
}

/** A chat request's messages as its leading system frames and the groups each user message opens. */
function inWindow(body: unknown): unknown {
  if (!isRecord(body) || !Array.isArray(body['messages'])) {
    return body;
  }

  const messages: readonly unknown[] = body['messages'];
  const opening = messages.findIndex(
    message => !isRecord(message) || message['role'] !== 'system',
  );
  const frames = opening === -1 ? messages : messages.slice(0, opening);
  const turns: unknown[][] = [];

  for (const message of messages.slice(frames.length)) {
    const turn = turns.at(-1);

    if (
      turn === undefined ||
      (isRecord(message) && message['role'] === 'user')
    ) {
      turns.push([message]);
    } else {
      turn.push(message);
    }
  }

  return {...body, messages: {frames, turns}};
}

/**
 * A value under its key with the permitted differences taken out, as
 * `JSON.stringify` visits each one, a replacement's own parts included.
 */
function permitted(key: string, value: unknown): unknown {
  if (key === 'promptSize') {
    return '<measured>';
  }

  if (key === 'rejectionDetails' && typeof value === 'string') {
    return '<rejection>';
  }

  return isRecord(value) && typeof value['role'] === 'string'
    ? chatMessage(value)
    : value;
}

function chatMessage(
  message: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const {role, content, tool_calls: calls} = message;

  if (role === 'tool' && typeof content === 'string') {
    return {...message, content: valueOf(content)};
  }

  if (
    role === 'system' &&
    typeof content === 'string' &&
    content.startsWith(unusableReply)
  ) {
    return {...message, content: `${unusableReply}<rejection>`};
  }

  return Array.isArray(calls)
    ? {...message, tool_calls: calls.map(toolCall)}
    : message;
}

function toolCall(call: unknown): unknown {
  if (!isRecord(call) || !isRecord(call['function'])) {
    return call;
  }

  const {arguments: input} = call['function'];

  return typeof input === 'string'
    ? {...call, function: {...call['function'], arguments: valueOf(input)}}
    : call;
}

/** Every string under a key that names a fingerprint, by first appearance; `JSON.stringify` visits them all. */
function fingerprintsIn(values: readonly unknown[]): string[] {
  const found = new Set<string>();

  JSON.stringify(values, (key, value: unknown) => {
    if (typeof value === 'string' && /fingerprint$/iu.test(key)) {
      found.add(value);
    }

    return value;
  });

  return [...found];
}

/** The run's own values, named in every string it left and in every moment it counted. */
function runValues(
  places: Places,
  fingerprints: readonly string[],
): {
  readonly text: (from: string) => string;
  /** For `JSON.stringify`, which hands it each value under its key. */
  readonly shown: (key: string, value: unknown) => unknown;
} {
  const ids = new Map<string, number>();
  const id = (found: string): string => {
    const number = ids.get(found) ?? ids.size + 1;

    ids.set(found, number);
    return `<id-${String(number)}>`;
  };
  const text = (from: string): string =>
    fingerprints
      .reduce(
        (to, fingerprint, at) =>
          to.replaceAll(fingerprint, `<fingerprint-${String(at + 1)}>`),
        from,
      )
      .replaceAll(places.home, '<home>')
      .replace(addressOf(places.modelServerPort), '<model-server>')
      .replace(addressOf(places.memoryServerPort), '<memory-server>')
      .replace(uuid, id)
      .replace(isoMoment, '<time>')
      .replace(longDay, '<day>')
      .replace(isoDay, '<day>');

  return {
    text,
    shown: (key, value) => {
      if (typeof value === 'string') {
        return text(value);
      }

      return typeof value === 'number' && key.endsWith('At') ? '<time>' : value;
    },
  };
}

/** A stand-in server's address, its port not running on into another number. */
function addressOf(port: string): RegExp {
  return new RegExp(`http://127\\.0\\.0\\.1:${port}(?!\\d)`, 'gu');
}

function parsed(text: string): {readonly value: unknown} | undefined {
  try {
    return {value: JSON.parse(text) as unknown};
  } catch {
    return undefined;
  }
}

/** A JSON text's value, or the text itself when it is not JSON. */
function valueOf(text: string): unknown {
  const json = parsed(text);

  return json === undefined ? text : json.value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
