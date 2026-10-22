/**
 * The wire's contract as the daemon's own Rust types write it, into the
 * schema beside the declarations the clients compile against: every answer
 * the wire client reads and every frame the stream reader reads is held to
 * it, so every row proves the contract as it runs. A mismatch fails the
 * test that produced it, naming the answer or the frame and what is wrong.
 */
import {Ajv2020, type ValidateFunction} from 'ajv/dist/2020.js';

import schema from '../../../src/gateway/api/generated/schema.json' with {type: 'json'};
import {failure} from './wait.ts';

/** What a route answers under 200: a definition of the contract, or a list of one. */
export type Answer = string | {readonly listOf: string};

// The formats name Rust's integer widths, which `type` and `minimum`
// already hold a JSON number to.
const ajv = new Ajv2020({formats: {int64: true, uint32: true}});

ajv.addSchema(schema, 'contract');

const validators = new Map<string, ValidateFunction>();

/** What `name` is held to, compiled once. */
function held(what: string, name: string, shape: object, value: unknown): void {
  let validate = validators.get(name);

  if (validate === undefined) {
    validate = ajv.compile(shape);
    validators.set(name, validate);
  }

  if (!validate(value)) {
    const shown = JSON.stringify(value);

    throw failure(
      `${what} is not the contract's ${name}: ${ajv.errorsText(validate.errors)}. ` +
        `It was ${shown.length > 1000 ? `${shown.slice(0, 1000)}…` : shown}`,
    );
  }
}

function parsed(what: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw failure(`${what} is something other than JSON: ${text}`);
  }
}

/** An answer as its status says it is: the route's outcome under 200, the error envelope otherwise. */
export function checkAnswer(
  what: string,
  answer: Answer,
  status: number,
  body: string,
): void {
  const value = parsed(`${what}'s answer`, body);

  if (status !== 200) {
    held(
      what,
      'GatewayErrorBody',
      {$ref: 'contract#/$defs/GatewayErrorBody'},
      value,
    );
  } else if (typeof answer === 'string') {
    held(what, answer, {$ref: `contract#/$defs/${answer}`}, value);
  } else {
    held(
      what,
      `list of ${answer.listOf}`,
      {type: 'array', items: {$ref: `contract#/$defs/${answer.listOf}`}},
      value,
    );
  }
}

/** A frame as its event says it is: `ready`, `resumed`, or the event of that kind. */
export function checkFrame(event: string | undefined, data: string): void {
  const what = `The frame "${event ?? ''}"`;
  const value = parsed(what, data);

  if (event === 'ready') {
    held(what, 'GatewayReady', {$ref: 'contract#/$defs/GatewayReady'}, value);
  } else if (event === 'resumed') {
    held(what, 'resumed frame', {const: {}}, value);
  } else {
    const branch = schema.$defs.GatewayEvent.oneOf.findIndex(
      kind => kind.properties.kind.const === event,
    );

    if (branch === -1) {
      throw failure(`${what} is no event the contract names: ${data}`);
    }

    held(
      what,
      `${event ?? ''} event`,
      {$ref: `contract#/$defs/GatewayEvent/oneOf/${String(branch)}`},
      value,
    );
  }
}
