export type ScrubReasoningBlocksResult =
  | {
      readonly status: 'accepted';
      readonly text: string;
    }
  | {
      readonly status: 'rejected';
    };

export type ReasoningBlockFilter = {
  /**
   * Passes the text outside reasoning blocks, at once; what could still
   * open or close a block is held until it cannot.
   */
  push(text: string): string;
  /**
   * Releases what was held as text — a `<` that never became a tag — or
   * rejects: a block left open, or a tag outside any block.
   */
  end(): ScrubReasoningBlocksResult;
};

const reasoningTagNames: readonly string[] = Object.freeze([
  'think',
  'reasoning',
]);

type TagMatch =
  | {
      readonly status: 'tag';
      /** The index just past the closing `>`. */
      readonly end: number;
      readonly closing: boolean;
      readonly name: string;
      /** Nothing but whitespace between the name and the `>`: the only shape that closes a block. */
      readonly bare: boolean;
    }
  | {readonly status: 'partial'}
  | {readonly status: 'none'};

const partialTag: TagMatch = Object.freeze({status: 'partial'});
const noTag: TagMatch = Object.freeze({status: 'none'});

/**
 * One grammar for the reasoning a model leaks into its text: a block opens
 * on `<think …>` or `<reasoning …>` (any case, whitespace and attributes
 * allowed) and closes on the first bare `</think>` of the same name; the
 * block is dropped whole, nested tags and all. A tag outside a block — a
 * closer with no block, an opener never closed — is a reasoning leak the
 * text cannot be cleaned of, and is rejected. The filter reads text as it
 * arrives, so a draft can be shown while the model still writes.
 */
export function createReasoningBlockFilter(): ReasoningBlockFilter {
  let buffer = '';
  let openBlock: string | undefined;
  let stray = false;

  return {
    push(text) {
      buffer += text;

      let passed = '';
      let cursor = 0;

      for (;;) {
        const tagStart = buffer.indexOf('<', cursor);

        if (tagStart === -1) {
          if (openBlock === undefined) {
            passed += buffer.slice(cursor);
          }

          buffer = '';
          return passed;
        }

        if (openBlock === undefined) {
          passed += buffer.slice(cursor, tagStart);
        }

        const match = matchReasoningTag(buffer, tagStart);

        if (match.status === 'partial') {
          buffer = buffer.slice(tagStart);
          return passed;
        }

        if (match.status === 'none') {
          if (openBlock === undefined) {
            passed += '<';
          }

          cursor = tagStart + 1;
          continue;
        }

        cursor = match.end;

        if (openBlock === undefined) {
          if (match.closing) {
            stray = true;
          } else {
            openBlock = match.name;
          }
        } else if (match.closing && match.bare && match.name === openBlock) {
          openBlock = undefined;
        }
      }
    },
    end() {
      if (openBlock !== undefined || stray) {
        return Object.freeze({status: 'rejected'});
      }

      const text = buffer;

      buffer = '';
      return Object.freeze({status: 'accepted', text});
    },
  };
}

export function scrubReasoningBlocks(text: string): ScrubReasoningBlocksResult {
  const filter = createReasoningBlockFilter();
  const passed = filter.push(text);
  const ended = filter.end();

  return ended.status === 'rejected'
    ? ended
    : Object.freeze({status: 'accepted', text: passed + ended.text});
}

function matchReasoningTag(buffer: string, start: number): TagMatch {
  let index = skipWhitespace(buffer, start + 1);

  if (index === buffer.length) {
    return partialTag;
  }

  const closing = buffer[index] === '/';

  if (closing) {
    index = skipWhitespace(buffer, index + 1);
  }

  const name = matchTagName(buffer, index);

  if (name.status !== 'name') {
    return name;
  }

  index += name.name.length;

  if (index === buffer.length) {
    return partialTag;
  }

  // The name must end here: `<thinking>` is not a reasoning tag.
  if (isWordCharacter(buffer.charCodeAt(index))) {
    return noTag;
  }

  const tagEnd = buffer.indexOf('>', index);

  if (tagEnd === -1) {
    return partialTag;
  }

  return Object.freeze({
    status: 'tag',
    end: tagEnd + 1,
    closing,
    name: name.name,
    bare: buffer.slice(index, tagEnd).trim().length === 0,
  });
}

function matchTagName(
  buffer: string,
  start: number,
): {readonly status: 'name'; readonly name: string} | TagMatch {
  const available = buffer.slice(start).toLowerCase();

  for (const name of reasoningTagNames) {
    if (available.startsWith(name)) {
      return Object.freeze({status: 'name', name});
    }

    if (available.length < name.length && name.startsWith(available)) {
      return partialTag;
    }
  }

  return noTag;
}

function skipWhitespace(buffer: string, start: number): number {
  let index = start;

  while (index < buffer.length && /\s/u.test(buffer.charAt(index))) {
    index += 1;
  }

  return index;
}

function isWordCharacter(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}
