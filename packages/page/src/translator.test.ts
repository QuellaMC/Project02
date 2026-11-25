import {describe, expect, it} from 'vitest';

import {placeholderOf} from './settings-model.ts';
import {home, operationFor, rowKey} from './settings.ts';
import type {Settings} from './store.ts';
import {
  languageAt,
  languageName,
  notesHeld,
  notesShown,
  notesText,
  sameAsHers,
  toneRow,
  translated,
  translatorChanges,
  translatorChoice,
  translatorModelRow,
  translatorRow,
  translatorWords,
  wordsRow,
  yourLanguageRow,
} from './translator.ts';
import type {
  CharacterSummary,
  ConfigView,
  JsonValue,
  ModelService,
  RuntimeConfigFieldInspectShape,
} from '@project02/wire/contract';

type OkView = Extract<ConfigView, {status: 'ok'}>;
type Field = RuntimeConfigFieldInspectShape;

/** A field with nothing of its own set, its value in effect `value` when one is given. */
function field(
  name: string,
  shape: Partial<Field> = {},
  value?: JsonValue,
): Field {
  return {
    name,
    description: `${name}.`,
    secret: false,
    valueType: 'string',
    agentMutable: false,
    authored: {configured: false},
    effectiveSource: 'default',
    effective: {
      name,
      secret: false,
      source: value === undefined ? 'missing' : 'default',
      resolved: true,
      ...(value === undefined ? {} : {value}),
    },
    ...shape,
  };
}

/** A field the target's own document sets to `value`. */
function own(name: string, value: JsonValue, shape: Partial<Field>): Field {
  return field(name, {
    ...shape,
    authored: {configured: true, value},
    effective: {name, secret: false, source: 'config', resolved: true, value},
  });
}

/** The languages the person's field suggests, each under its own name. */
const languages = {
  en: 'English',
  'zh-Hans': '简体中文',
  'zh-Hant': '繁體中文',
  ja: '日本語',
  ko: '한국어',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
};

const openaiModels = {
  'gpt-6-astra': 'GPT-6 Astra',
  'gpt-6.1-sol': 'GPT-6.1 Sol',
  'gpt-6.1-terra': 'GPT-6.1 Terra',
  'gpt-6-luna': 'GPT-6 Luna',
};

/** A service as a view lists it, by its id, name and model field, connected or not. */
function service(
  id: ModelService['id'],
  name: string,
  connected: boolean,
): ModelService {
  const model = `${id}Model`;

  return {id, name, summary: name, connected, model, fields: [model]};
}

/** The fields of the home's view this page reads, each as its declaration shapes it. */
const shapes: Readonly<
  Record<string, readonly [Partial<Field>, JsonValue | undefined]>
> = {
  userLanguage: [
    {
      label: 'Your Language',
      suggestedValues: Object.keys(languages),
      choices: languages,
    },
    undefined,
  ],
  openaiModel: [
    {
      label: 'Model',
      suggestedValues: Object.keys(openaiModels),
      choices: openaiModels,
    },
    'gpt-6-luna',
  ],
  nvidiaModel: [{label: 'Model', placeholder: "NVIDIA's Default"}, undefined],
  translatorProvider: [
    {
      label: 'Service',
      valueType: 'enum',
      allowedValues: ['chatgpt', 'openai', 'anthropic', 'nvidia'],
    },
    undefined,
  ],
  translatorModel: [{label: 'Model'}, undefined],
};

/** The home's view, its own values those `held` gives, with the OpenAI API and NVIDIA connected. */
function homeView(held: Readonly<Record<string, JsonValue>> = {}): OkView {
  return {
    status: 'ok',
    fingerprint: 'f1',
    diagnostics: [],
    model: {ready: true},
    services: [
      service('chatgpt', 'ChatGPT Plan', false),
      service('openai', 'OpenAI API', true),
      service('anthropic', 'Claude API', false),
      service('nvidia', 'NVIDIA', true),
    ],
    project02: Object.entries(shapes).map(([name, [shape, value]]) => {
      const mine = held[name];

      return mine === undefined
        ? field(name, shape, value)
        : own(name, mine, shape);
    }),
    sections: [],
  };
}

/** Kana's view, her words as `words` holds them, none when it is none. */
function hersView(words?: JsonValue): OkView {
  const shape = {valueType: 'array'} as const;

  return {
    ...homeView(),
    services: [],
    project02: [
      words === undefined
        ? field('translationWords', shape)
        : own('translationWords', words, shape),
      field('translationTone'),
    ],
  };
}

function settingsOf(
  views: Readonly<Record<string, ConfigView>>,
  edits: Readonly<Record<string, string>> = {},
): Settings {
  return {
    screen: {kind: 'window', page: {kind: 'you'}},
    views: new Map(Object.entries(views)),
    edits: new Map(Object.entries(edits)),
    problems: new Map(),
    phones: new Map(),
    catalogs: new Map(),
  };
}

const mira: CharacterSummary = {
  id: 'mira',
  displayName: 'Mira',
  enabled: true,
  builtIn: true,
  state: 'ready',
};

describe('the translator in the settings', () => {
  it('shows nothing of the translator until a character of the home speaks another language, and names a language as the browser knows it in that language, or by its tag where it knows none', () => {
    expect(translated([])).toBe(false);
    expect(translated([mira])).toBe(false);
    expect(
      translated([
        mira,
        {...mira, id: 'kana', displayName: 'Kana', language: 'ja'},
      ]),
    ).toBe(true);
    expect(languageName('ja')).toBe('日本語');
    expect(languageName('zh-Hant')).toBe('繁體中文');
    expect(languageName('abcd')).toBe('abcd');
  });

  it("offers a language, as Your Language, as a menu of the languages its field suggests, under the names it gives them, then one it holds that it does not suggest, under that language's own name; Automatic holds none, and a choice writes the language, or on Automatic unsets it", () => {
    const menu = (
      held: Readonly<Record<string, JsonValue>>,
      edits?: Readonly<Record<string, string>>,
    ) => languageAt(settingsOf({home: homeView(held)}, edits), yourLanguageRow);
    const suggested = Object.entries(languages).map(([value, label]) => ({
      value,
      label,
    }));

    expect(menu({})).toEqual({
      field: expect.objectContaining({name: 'userLanguage'}) as Field,
      options: suggested,
    });
    expect(menu({userLanguage: 'ja'})).toMatchObject({
      value: 'ja',
      options: suggested,
    });
    expect(menu({userLanguage: 'pt-BR'})?.options).toEqual([
      ...suggested,
      {value: 'pt-BR', label: languageName('pt-BR')},
    ]);
    expect(languageName('pt-BR')).not.toBe('pt-BR');
    // Automatic just chosen shows at once.
    expect(
      menu({userLanguage: 'ja'}, {[rowKey(yourLanguageRow)]: ''}),
    ).not.toHaveProperty('value');
    expect(languageAt(settingsOf({}), yourLanguageRow)).toBeUndefined();
    expect(operationFor(yourLanguageRow.place, 'ja')).toEqual({
      kind: 'set',
      path: 'project02.userLanguage',
      value: 'ja',
    });
    expect(operationFor(yourLanguageRow.place, undefined)).toEqual({
      kind: 'unset',
      path: 'project02.userLanguage',
    });
  });

  it('shows her words and phrases as they are typed and not yet saved, a pair with a box still empty among them, else as her settings hold them, which her page counts; anything there that is no pair is none', () => {
    const darling = {hers: 'ダーリン', shown: 'Darling'};
    const half = {hers: '叫竜', shown: ''};
    const held = settingsOf({
      'character:kana': hersView([darling, 'stray', {hers: '叫竜'}]),
    });
    const typed = settingsOf(
      {'character:kana': hersView([darling])},
      {[rowKey(wordsRow('kana'))]: notesText([darling, half])},
    );

    expect(notesHeld(held, 'kana')).toEqual([darling]);
    expect(notesShown(held, 'kana')).toEqual([darling]);
    expect(notesShown(typed, 'kana')).toEqual([darling, half]);
    expect(notesHeld(typed, 'kana')).toEqual([darling]);
    expect(notesHeld(settingsOf({}), 'kana')).toEqual([]);
    expect(rowKey(toneRow('kana'))).toBe(
      'character:kana/project02.translationTone',
    );
  });

  it("offers what does the translating: Same AI Model as Hers while no service is chosen, the services connected and the one chosen, and with one chosen its model, offered that service's models in their words and showing the model that service has in the home's settings; another service takes away the model chosen, and Same AI Model as Hers takes away both", () => {
    const of = (held: Readonly<Record<string, JsonValue>> = {}) =>
      settingsOf({home: homeView(held)});
    const connected = [
      {value: 'openai', label: 'OpenAI API'},
      {value: 'nvidia', label: 'NVIDIA'},
    ];
    const openai = of({translatorProvider: 'openai'});
    const terra = of({
      translatorProvider: 'openai',
      translatorModel: 'gpt-6.1-terra',
    });
    const modelOf = (settings: Settings) => {
      const {model} = translatorChoice(settings);

      if (model === undefined) {
        throw new Error('Expected a model.');
      }

      return model;
    };

    expect(translatorChoice(of())).toEqual({options: connected});
    expect(translatorWords(of())).toBe(sameAsHers);
    expect(sameAsHers).toBe('Same AI Model as Hers');
    expect(translatorWords(openai)).toBe('OpenAI API');
    expect(modelOf(openai)).toMatchObject({
      name: 'translatorModel',
      authored: {configured: false},
      suggestedValues: Object.keys(openaiModels),
      choices: openaiModels,
      effective: {value: 'gpt-6-luna'},
    });
    expect(modelOf(terra)).toMatchObject({
      authored: {configured: true},
      choices: openaiModels,
      effective: {value: 'gpt-6.1-terra'},
    });
    // A service whose models no list holds: an empty box, saying the
    // model the home's settings give it, or, giving none, its default.
    expect(
      placeholderOf(modelOf(of({translatorProvider: 'nvidia'})), home),
    ).toBe("NVIDIA's Default");
    expect(
      placeholderOf(
        modelOf(of({translatorProvider: 'nvidia', nvidiaModel: 'meta/llama'})),
        home,
      ),
    ).toBe('meta/llama');
    // One chosen while it is not connected is offered too.
    expect(
      translatorChoice(of({translatorProvider: 'anthropic'})).options,
    ).toEqual([
      connected[0],
      {value: 'anthropic', label: 'Claude API'},
      connected[1],
    ]);
    expect(translatorChoice(settingsOf({}))).toEqual({options: []});

    expect(translatorChanges(openai, 'nvidia')).toEqual([
      {row: translatorRow, value: 'nvidia'},
    ]);
    expect(translatorChanges(terra, 'nvidia')).toEqual([
      {row: translatorModelRow},
      {row: translatorRow, value: 'nvidia'},
    ]);
    expect(translatorChanges(terra, undefined)).toEqual([
      {row: translatorModelRow},
      {row: translatorRow},
    ]);
  });
});
