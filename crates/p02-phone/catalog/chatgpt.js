// ChatGPT: a stronger model she asks for help, through a connection of the
// person's, their ChatGPT plan or their OpenAI API key, once they allow it.
// Her phone's caller asks through that connection: the app never holds what
// signs it in. She asks a question of her own and reads its answer. Each
// question is asked after the conversation before it, so that a follow-up
// is understood, and the conversation is kept, which its screen shows.
//
// It keeps, in phone.storage, `conversation`: her exchanges, oldest first,
// each her `question` and its `answer`. It keeps the newest that fit, the
// oldest going first: twenty at most, whose questions and answers take
// 32 KiB of UTF-8 at most together, half the text her phone lets an app
// keep, so that what it keeps, its screen and each question it asks stay
// well within her phone's limits.

export const manifest = {
  format: 'project02.app.v1',
  id: 'chatgpt',
  name: 'ChatGPT',
  summary: 'Ask a stronger model for help',
  version: '1.0.0',
  icon: 'bulb',
  tint: 'indigo',
  wakes: false,
  account: 'chatgpt',
  views: [{id: 'chatgpt', title: 'ChatGPT', icon: 'bulb'}],
  opensOn: 'chatgpt',
  actions: [
    {
      name: 'ask',
      description:
        'Ask a stronger model a question of your own and read its answer. It sees the questions you asked it before, with its answers, so you can follow one up.',
      did: 'Asked ChatGPT',
      view: 'chatgpt',
      input: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            pattern: '\\S',
            maxLength: 2000,
            description:
              'Your question, as you would ask it: what is a gentle way to wake someone who hates mornings?',
          },
        },
        required: ['question'],
        additionalProperties: false,
      },
    },
    {
      name: 'clear',
      description:
        'Forget the conversation, your questions and its answers: the next question you ask starts a new one.',
      did: 'Cleared the conversation',
      view: 'chatgpt',
      input: {type: 'object', properties: {}, additionalProperties: false},
    },
  ],
};

// What the model is told: whom it helps, and how to answer her.
const INSTRUCTIONS =
  'You are helping a character think something through. She asks you a question of her own and will put your answer in her own words, so answer it clearly and to the point, in plain text without Markdown. Any questions she asked you before come first, each with your answer, so that you can follow on from them.';
// The most exchanges it keeps, and the most bytes of UTF-8 their questions
// and answers take together. A question is 2,000 characters at most and an
// answer 4,096, so the newest exchange always fits.
const EXCHANGES = 20;
const BYTES = 32 * 1024;

export function screen() {
  const exchanges = conversation();

  if (exchanges.length === 0) {
    return {items: [{kind: 'text', text: 'No Questions'}]};
  }

  return {
    items: exchanges.flatMap(({question, answer}) => [
      {kind: 'bubble', from: 'her', text: question},
      {kind: 'bubble', from: 'them', text: answer},
    ]),
  };
}

// Her question, asked after the conversation before it: it is kept with its
// answer at the end of the conversation, and told her with its answer.
export function ask({question: given}) {
  const question = given.trim();
  const before = conversation();
  const answer = answerTo(question, before);

  phone.storage.set('conversation', newest([...before, {question, answer}]));
  return {question, answer};
}

export function clear() {
  phone.storage.remove('conversation');
  return {cleared: true};
}

// The model's answer to `question`, asked after the exchanges `before` it,
// without white space at its ends. Refused when it answered nothing, and,
// in the sentence her phone's caller gave, when it could not be asked.
function answerTo(question, before) {
  const {text} = phone.ai.ask({
    instructions: INSTRUCTIONS,
    input: conversed(question, before),
  });
  const answer = text.trim();

  if (answer === '') {
    throw new Error('It answered nothing. Try asking again.');
  }
  return answer;
}

// What the model is asked: her question, after the exchanges before it,
// each her question and its answer, as a conversation reads.
function conversed(question, before) {
  return [
    ...before.flatMap(exchange => [
      `Her question: ${exchange.question}`,
      `Your answer: ${exchange.answer}`,
    ]),
    `Her question: ${question}`,
  ].join('\n\n');
}

// The newest of `exchanges` that fit what it keeps, oldest first: twenty at
// most, whose questions and answers take BYTES at most together.
function newest(exchanges) {
  const kept = [];
  let bytes = 0;

  for (const exchange of exchanges.slice(-EXCHANGES).reverse()) {
    bytes += bytesOf(exchange.question) + bytesOf(exchange.answer);

    if (bytes > BYTES) {
      break;
    }
    kept.unshift(exchange);
  }
  return kept;
}

// The conversation it keeps, none before her first question.
function conversation() {
  return phone.storage.get('conversation') ?? [];
}

// The bytes `text` takes in UTF-8, as her phone counts what an app keeps.
function bytesOf(text) {
  let bytes = 0;

  for (const character of text) {
    const code = character.codePointAt(0);

    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}
