import type {RoleModelReplyDelta} from '../api/adapter.ts';
import type {RoleModelProviderToolNameMapping} from '../api/chat-wire.ts';
import {visibleReplyModelToolName} from '../api/model-tools.ts';
import {
  createReasoningBlockFilter,
  type ReasoningBlockFilter,
} from '../api/reasoning.ts';
import {runtimeToolNameForProviderToolName} from '../prompt/tool-wire.ts';
import type {NvidiaStreamObserver} from './nvidia-stream.ts';

export type JsonStringFieldScanner = {
  /** The value's next decoded characters, as far as the fragment reaches into it. */
  push(fragment: string): string;
};

type ScannerState = 'brace' | 'key' | 'colon' | 'quote' | 'value' | 'done';

const simpleEscapes: Readonly<Record<string, string>> = Object.freeze({
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
});

/**
 * Follows one string field of a flat JSON object as it arrives in
 * fragments — `{"text": "…"}` — decoding the value as far as the fragments
 * reach: an escape is decoded whole, a high surrogate waits for its pair,
 * and anything that is not that object, or comes after the value's closing
 * quote, is silence. The parser judges the whole object later; this only
 * reads ahead of it.
 */
export function createJsonStringFieldScanner(
  field: string,
): JsonStringFieldScanner {
  let state: ScannerState = 'brace';
  let pending = '';
  let highSurrogate = '';

  const expect = (character: string, next: ScannerState): boolean => {
    pending = pending.trimStart();

    if (pending.length === 0) {
      return false;
    }

    if (pending.startsWith(character)) {
      pending = pending.slice(1);
      state = next;
    } else {
      state = 'done';
    }

    return true;
  };

  const readKey = (): boolean => {
    pending = pending.trimStart();

    if (pending.length === 0) {
      return false;
    }

    if (!pending.startsWith('"')) {
      state = 'done';
      return true;
    }

    const close = pending.indexOf('"', 1);

    if (close === -1) {
      return false;
    }

    // An escaped key is not the plain one the field is named by.
    const key = pending.slice(1, close);

    state = key === field && !key.includes('\\') ? 'colon' : 'done';
    pending = pending.slice(close + 1);
    return true;
  };

  /** Decodes value characters until the fragment runs out, the value closes, or an escape is cut. */
  const readValue = (): string => {
    let out = '';

    while (pending.length > 0) {
      const character = pending.charAt(0);

      if (character === '"') {
        pending = '';
        state = 'done';
        break;
      }

      if (character !== '\\') {
        out += highSurrogate + character;
        highSurrogate = '';
        pending = pending.slice(1);
        continue;
      }

      const escaped = pending.charAt(1);

      if (escaped === '') {
        break;
      }

      if (escaped === 'u') {
        const hex = pending.slice(2, 6);

        if (hex.length < 4) {
          break;
        }

        if (!/^[0-9a-fA-F]{4}$/u.test(hex)) {
          pending = '';
          state = 'done';
          break;
        }

        pending = pending.slice(6);
        out += decodeCodeUnit(String.fromCharCode(Number.parseInt(hex, 16)));
        continue;
      }

      const simple = simpleEscapes[escaped];

      if (simple === undefined) {
        pending = '';
        state = 'done';
        break;
      }

      out += highSurrogate + simple;
      highSurrogate = '';
      pending = pending.slice(2);
    }

    return out;
  };

  const decodeCodeUnit = (unit: string): string => {
    const code = unit.charCodeAt(0);

    if (code >= 0xd800 && code <= 0xdbff) {
      const orphan = highSurrogate;

      highSurrogate = unit;
      return orphan;
    }

    const paired = highSurrogate + unit;

    highSurrogate = '';
    return paired;
  };

  return {
    push(fragment) {
      pending += fragment;

      for (;;) {
        switch (state) {
          case 'brace':
            if (!expect('{', 'key')) {
              return '';
            }

            break;
          case 'key':
            if (!readKey()) {
              return '';
            }

            break;
          case 'colon':
            if (!expect(':', 'quote')) {
              return '';
            }

            break;
          case 'quote':
            if (!expect('"', 'value')) {
              return '';
            }

            break;
          case 'value':
            return readValue();
          case 'done':
            pending = '';
            return '';
        }
      }
    },
  };
}

type Draft = {
  readonly number: number;
  readonly filter: ReasoningBlockFilter;
  readonly scanner?: JsonStringFieldScanner;
};

export type NvidiaReplyDrafts = {
  readonly observer: NvidiaStreamObserver;
  /**
   * For each visible reply of the reassembled decision, in order, the draft
   * it was spoken as: content alone is the one reply; beside any tool call
   * it is the model's note, and the visible_reply calls are the replies.
   * Undefined when nothing could be spoken.
   */
  readonly replyDrafts: () => readonly number[] | undefined;
};

/**
 * What the NVIDIA adapter speaks while the model writes, numbered in the
 * order drafts begin: content, and each native visible_reply call's
 * arguments, each behind its own reasoning filter, as the parser will
 * filter the whole. Which drafts became the decision's replies is known
 * only once the message is whole, and said then. Silent when no one
 * listens.
 */
export function createNvidiaReplyDrafts(options: {
  readonly toolNameMappings: readonly RoleModelProviderToolNameMapping[];
  readonly onReplyDelta?: (delta: RoleModelReplyDelta) => void;
}): NvidiaReplyDrafts {
  const speak = options.onReplyDelta;

  if (speak === undefined) {
    return {observer: {}, replyDrafts: () => undefined};
  }

  let begun = 0;
  let content: Draft | undefined;
  let anyCall = false;
  const calls = new Map<number, Draft>();
  const begin = (scanner?: JsonStringFieldScanner): Draft => {
    const draft: Draft = {
      number: begun,
      filter: createReasoningBlockFilter(),
      ...(scanner === undefined ? {} : {scanner}),
    };

    begun += 1;
    return draft;
  };
  const speakPassed = (draft: Draft, text: string): void => {
    const passed = draft.filter.push(text);

    if (passed.length > 0) {
      speak({reply: draft.number, text: passed});
    }
  };

  return {
    observer: {
      onContent(text) {
        content ??= begin();
        speakPassed(content, text);
      },
      onToolCallArguments(fragment) {
        anyCall = true;

        if (
          runtimeToolNameForProviderToolName(
            fragment.name,
            options.toolNameMappings,
          ) !== visibleReplyModelToolName
        ) {
          return;
        }

        let draft = calls.get(fragment.index);

        if (draft === undefined) {
          draft = begin(createJsonStringFieldScanner('text'));
          calls.set(fragment.index, draft);
        }

        speakPassed(draft, draft.scanner?.push(fragment.text) ?? '');
      },
    },
    replyDrafts() {
      if (anyCall) {
        return [...calls.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, draft]) => draft.number);
      }

      return content === undefined ? [] : [content.number];
    },
  };
}
