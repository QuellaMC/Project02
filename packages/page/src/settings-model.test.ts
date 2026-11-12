import {describe, expect, it} from 'vitest';

import {avatarColor, iconOf, iconPath, initialOf, tintOf} from './look.ts';
import {
  accessLines,
  artOf,
  botStored,
  botWords,
  cardsShown,
  characterStatus,
  choiceWords,
  comesWithOf,
  controlOf,
  featureControl,
  featureValue,
  featuresPlaced,
  findings,
  keyPlaceholder,
  labelOf,
  marks,
  offerOf,
  ownModelExtras,
  ownModelRows,
  parentOf,
  placeholderOf,
  readinessOf,
  sectionsListed,
  serviceArt,
  serviceChoice,
  servicesListed,
  setupPage,
  sidebarOf,
  suggestedChoices,
  switchedOn,
  telegramNotRunning,
  telegramOn,
  usedBy,
  valueNow,
  welcomeKey,
  welcomeReady,
  type CharacterPreview,
  type ListedService,
} from './settings-model.ts';
import {characterTarget, home, rowKey, type Row} from './settings.ts';
import type {Settings, SettingsPage} from './store.ts';
import type {
  CharacterSummary,
  ConfigView,
  GatewayHealth,
  JsonValue,
  ModelService,
  RuntimeConfigDiagnostic,
  RuntimeConfigFieldInspectShape,
  RuntimeConfigSectionInspectShape,
} from '@project02/wire/contract';

type OkView = Extract<ConfigView, {status: 'ok'}>;
type Field = RuntimeConfigFieldInspectShape;
type Section = RuntimeConfigSectionInspectShape;

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

/** A field the target's own document sets. */
function own(
  name: string,
  value: JsonValue,
  shape: Partial<Field> = {},
): Field {
  return field(name, {
    ...shape,
    authored: {configured: true, value},
    effective: {name, secret: false, source: 'config', resolved: true, value},
  });
}

function section(id: string, shape: Partial<Section> = {}): Section {
  return {
    namespace: 'plugins',
    id,
    displayName: id,
    version: '1.0.0',
    enabled: true,
    enabledSource: 'default',
    activation: {enabled: true, status: 'active', reasons: []},
    setup: {ready: true},
    fields: [],
    layout: [],
    diagnostics: [],
    ...shape,
  };
}

const kept = field(
  'backend',
  {
    label: 'Kept At',
    allowedValues: ['platform', 'server', 'oss'],
    choices: {
      platform: 'Mem0 Cloud',
      server: 'Your Server',
      oss: 'This Computer',
    },
  },
  'platform',
);

/** Long-Term Memory as the home's view shows it: its place, a key for the cloud, a server's address, and what most leave alone. */
function memory(
  shape: Partial<Section> = {},
  fields: readonly Field[] = [],
): Section {
  return section('mem0', {
    displayName: 'Long-Term Memory',
    page: {
      summary: 'Remembers across all chats',
      icon: 'archive',
      tint: 'brown',
      placement: 'mind_body',
      order: 3,
      connection: 'Memory',
    },
    access: {network: 'write', model_input: 'write', turn_context: 'none'},
    fields: [
      kept,
      field('apiKey', {secret: true}),
      field('baseUrl'),
      field('userId', {}, 'project02-user'),
      ...fields,
    ],
    layout: [
      {advanced: false, rows: [{field: 'backend'}]},
      {
        advanced: false,
        when: {field: 'backend', is: ['platform']},
        footer: 'Get a key at app.mem0.ai.',
        rows: [{field: 'apiKey'}],
      },
      {
        advanced: false,
        when: {field: 'backend', is: ['server']},
        rows: [{field: 'baseUrl'}, {field: 'apiKey'}],
      },
      {
        advanced: true,
        title: 'Advanced',
        rows: [
          {field: 'userId'},
          {field: 'baseUrl', when: {field: 'backend', is: ['platform']}},
        ],
      },
    ],
    ...shape,
  });
}

const telegram = section('telegram', {
  namespace: 'connectors',
  displayName: 'Telegram',
  fields: [field('managementBotToken', {secret: true})],
});

/** Her phone, whose one field the home may set for everyone: settings of hers, not an account. */
const phone = section('phone', {
  displayName: 'Phone',
  fields: [field('askToInstall', {valueType: 'boolean'}, true)],
});

/** The services as a view lists them, the OpenAI API's and NVIDIA's each connected or not. */
function services(openai: boolean, nvidia: boolean): ModelService[] {
  return [
    {
      id: 'openai',
      name: 'OpenAI API',
      summary: 'Pay as you go, with an API key',
      keyFrom: 'Get one at platform.openai.com.',
      connected: openai,
      model: 'openaiModel',
      fields: ['openaiApiKey', 'openaiModel'],
    },
    {
      id: 'nvidia',
      name: 'NVIDIA',
      summary: 'An API key, or a server of your own',
      keyFrom: 'Get one at build.nvidia.com.',
      connected: nvidia,
      model: 'nvidiaModel',
      fields: ['nvidiaApiKey', 'nvidiaModel', 'nvidiaBaseUrl'],
    },
  ];
}

const openaiModels = {
  'gpt-6-astra': 'GPT-6 Astra',
  'gpt-6.1-sol': 'GPT-6.1 Sol',
  'gpt-6.1-terra': 'GPT-6.1 Terra',
  'gpt-6-luna': 'GPT-6 Luna',
};

/** The OpenAI model as its declaration shapes it: its models suggested, in their words. */
const openaiModel: Partial<Field> = {
  label: 'Model',
  suggestedValues: Object.keys(openaiModels),
  choices: openaiModels,
};

/** Each field of the services, as its declaration shapes it. */
const serviceShapes: Readonly<Record<string, Partial<Field>>> = {
  roleModelProvider: {
    label: 'Service',
    valueType: 'enum',
    allowedValues: ['openai', 'nvidia'],
    choices: {openai: 'OpenAI API', nvidia: 'NVIDIA'},
  },
  openaiApiKey: {label: 'API Key', secret: true},
  openaiModel,
  nvidiaApiKey: {label: 'API Key', secret: true},
  nvidiaModel: {label: 'Model', placeholder: "NVIDIA's Default"},
  nvidiaBaseUrl: {label: 'Server Address'},
};

/**
 * The fields of the services as a view shows them: the target's own value
 * where `held` names one, else the value it takes from beneath where
 * `beneath` names one, the OpenAI model's default otherwise; a key's
 * values are [redacted].
 */
function serviceFields(
  held: Readonly<Record<string, string>>,
  beneath: Readonly<Record<string, string>> = {},
): Field[] {
  return Object.entries(serviceShapes).map(([name, shape]) => {
    const value = held[name];

    return value === undefined
      ? field(
          name,
          shape,
          beneath[name] ?? (name === 'openaiModel' ? 'gpt-6-luna' : undefined),
        )
      : own(name, value, shape);
  });
}

/** The home on NVIDIA with its key, unless `shape` says otherwise. */
function homeView(shape: Partial<OkView> = {}): OkView {
  return {
    status: 'ok',
    fingerprint: 'f1',
    diagnostics: [],
    model: {ready: true},
    services: services(false, true),
    project02: [
      field('userDisplayName', {}, 'You'),
      ...serviceFields({
        roleModelProvider: 'nvidia',
        nvidiaApiKey: '[redacted]',
      }),
    ],
    sections: [memory(), telegram],
    ...shape,
  };
}

function herView(
  shape: Partial<OkView> = {},
  sections?: readonly Section[],
): OkView {
  return {
    status: 'ok',
    fingerprint: 'f1',
    diagnostics: [],
    model: {ready: true},
    services: [],
    project02: [own('enabled', true, {valueType: 'boolean'})],
    sections: sections ?? [
      section('session-history', {
        displayName: 'Look Back',
        page: {
          summary: 'Searches your past chats',
          icon: 'history',
          tint: 'cyan',
          placement: 'mind_body',
          order: 2,
        },
      }),
      section('reply-style', {
        displayName: 'Reply Style',
        enabled: false,
        activation: {enabled: false, status: 'disabled', reasons: []},
        page: {
          summary: 'How she writes',
          icon: 'bubble',
          tint: 'mint',
          placement: 'mind_body',
          order: 5,
        },
        fields: [
          field('tone', {
            allowedValues: ['neutral', 'warm', 'formal', 'playful'],
            choices: {warm: 'Warm'},
          }),
        ],
        layout: [{advanced: false, rows: [{field: 'tone'}]}],
      }),
      memory({fields: []}),
      section('runtime.plugin', {
        displayName: 'Ask to Change Settings',
        page: {
          summary: 'Lets her ask',
          icon: 'shield',
          tint: 'gray',
          placement: 'permission',
          order: 1,
        },
      }),
      {...telegram, fields: [field('botToken', {secret: true})]},
    ],
    ...shape,
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
const nova: CharacterSummary = {
  id: 'nova',
  displayName: 'Nova',
  enabled: false,
  builtIn: false,
  state: 'not_started',
};

function health(
  connected: boolean,
  bots: GatewayHealth['connectors'][number]['bots'] = [],
  accounts: GatewayHealth['accounts'] = [],
): GatewayHealth {
  return {
    protocolVersion: 14,
    homeRoot: '/home/person/.project02',
    config: {diagnostics: []},
    packages: {diagnostics: []},
    characters: [mira, nova],
    connectors: [{id: 'telegram', connected, bots}],
    accounts,
  };
}

/** The person's Tavily account as health says it, its key set or not. */
function tavily(hasKey: boolean): GatewayHealth['accounts'][number] {
  return {
    id: 'tavily',
    name: 'Tavily',
    hasKey,
    keyFrom: 'Get a free key at tavily.com.',
  };
}

const nothingFound = {rows: new Map(), sections: new Map(), notes: []};

describe('settings model', () => {
  it('gives each field the control its shape takes: a key box, a switch, a segmented choice of up to three, pills beyond, a select of the values it suggests, a text box otherwise', () => {
    expect(controlOf(field('apiKey', {secret: true}))).toBe('key');
    expect(controlOf(field('mirror', {valueType: 'boolean'}))).toBe('switch');
    expect(controlOf(kept)).toBe('segmented');
    expect(
      controlOf(field('tone', {allowedValues: ['a', 'b', 'c', 'd']})),
    ).toBe('pills');
    expect(controlOf(field('openaiModel', openaiModel))).toBe('select');
    expect(controlOf(field('model'))).toBe('text');
    expect(labelOf(kept)).toBe('Kept At');
    expect(labelOf(field('model'))).toBe('model');
    expect(choiceWords(kept, 'oss')).toBe('This Computer');
    expect(choiceWords(kept, 'elsewhere')).toBe('elsewhere');
  });

  it('never hides a value in effect: when hides a card only for another choice, advanced hides only rows with no value of their own while the switch is off, a row with something said at it shows, and a card left empty is not drawn', () => {
    const drawn = (
      shown: Section,
      advanced: boolean,
      current: string | undefined,
      said = '',
    ) =>
      cardsShown(shown, {
        advanced,
        current: name => (name === 'backend' ? current : undefined),
        said: name => name === said,
      }).map(card => card.fields.map(shownField => shownField.name));

    expect(drawn(memory(), false, 'platform')).toEqual([
      ['backend'],
      ['apiKey'],
    ]);
    expect(drawn(memory(), false, 'server')).toEqual([
      ['backend'],
      ['baseUrl', 'apiKey'],
    ]);
    expect(drawn(memory(), true, 'platform')).toEqual([
      ['backend'],
      ['apiKey'],
      ['userId', 'baseUrl'],
    ]);
    // A choice with no value at all hides nothing.
    expect(drawn(memory(), false, undefined)).toEqual([
      ['backend'],
      ['apiKey'],
      ['baseUrl', 'apiKey'],
    ]);
    // Its own value shows an advanced row; a finding shows any row.
    const owned = memory({
      fields: memory().fields.map(shownField =>
        shownField.name === 'userId' ? own('userId', 'sam') : shownField,
      ),
    });

    expect(drawn(owned, false, 'oss')).toEqual([['backend'], ['userId']]);
    expect(drawn(memory(), false, 'oss', 'baseUrl')).toEqual([
      ['backend'],
      ['baseUrl'],
      ['baseUrl'],
    ]);
    expect(
      cardsShown(memory(), {
        advanced: false,
        current: () => 'platform',
        said: () => false,
      })[1],
    ).toEqual({
      footer: 'Get a key at app.mem0.ai.',
      fields: [memory().fields[1]],
    });
  });

  it('shows in an empty box what a character takes from the home, and the home its own hint or its default; a key box shows a stored key as dots', () => {
    const inherited = field(
      'userDisplayName',
      {placeholder: 'Your name'},
      'Sam',
    );

    expect(placeholderOf(inherited, characterTarget('mira'))).toBe('Sam');
    expect(placeholderOf(inherited, home)).toBe('Your name');
    expect(placeholderOf(field('contextWindowTokens', {}, 32768), home)).toBe(
      '32768',
    );
    expect(placeholderOf(own('nvidiaModel', 'llama'), home)).toBe('');
    expect(
      placeholderOf(
        field('model', {placeholder: 'Default'}),
        characterTarget('mira'),
      ),
    ).toBe('Default');

    const stored = own('apiKey', '[redacted]', {secret: true});

    expect(keyPlaceholder(stored, false)).toBe('••••••••••••');
    expect(keyPlaceholder(stored, true)).toBe('Paste a new key');
    expect(keyPlaceholder(field('apiKey', {secret: true}), false)).toBe(
      'Paste key',
    );
    expect(
      keyPlaceholder(
        field('apiKey', {secret: true, placeholder: 'Paste from @BotFather'}),
        false,
      ),
    ).toBe('Paste from @BotFather');
  });

  it('draws her plugins in their order: Set Up while one is not set up, her page of one whose fields her view lists, said by its first choice, and her switch otherwise', () => {
    const view = herView();
    const placed = featuresPlaced(view, 'mind_body');

    expect(placed.map(shown => shown.id)).toEqual([
      'session-history',
      'mem0',
      'reply-style',
    ]);
    expect(featuresPlaced(view, 'permission').map(shown => shown.id)).toEqual([
      'runtime.plugin',
    ]);
    expect(placed.map(featureControl)).toEqual(['switch', 'switch', 'drill']);
    expect(featureControl(memory({setup: {ready: false}}))).toBe('setup');

    const reply = placed[2];

    if (reply === undefined) {
      throw new Error('Expected Reply Style.');
    }

    expect(featureValue(reply, false, () => 'warm')).toBe('Off');
    expect(featureValue(reply, true, () => 'warm')).toBe('Warm');
    expect(featureValue(reply, true, () => undefined)).toBe('On');
    expect(featureValue(section('notebook'), true, () => undefined)).toBe('On');

    const settings = settingsOf({home: homeView()});

    expect(setupPage(settings, 'mem0')).toEqual({
      kind: 'connection',
      pluginId: 'mem0',
    });
    expect(setupPage(settings, 'notebook')).toEqual({
      kind: 'plugin',
      namespace: 'plugins',
      id: 'notebook',
    });
  });

  it('says the sidebar: the name in effect, each character off or not, AI Model by the service connected and Set Up with a dot while the home gives no model, Telegram on or off, a plugin that says it is an account set up once by its first choice, Set Up while a character wants it, off otherwise, an account her apps use on once its key is set and not at all before, and a dot on what has a problem', () => {
    const sidebar = (
      views: Readonly<Record<string, ConfigView>>,
      found: Parameters<typeof sidebarOf>[2] = nothingFound,
      accounts: GatewayHealth['accounts'] = [],
    ) => sidebarOf(settingsOf(views), health(true, [], accounts), found, true);
    const ready = sidebar({
      home: homeView({sections: [memory(), phone, telegram]}),
      'character:mira': herView(),
    });

    expect(ready.you).toBe('You');
    expect(ready.characters.map(entry => [entry.label, entry.value])).toEqual([
      ['Mira', ''],
      ['Nova', 'Off'],
    ]);
    expect(
      ready.connections.map(entry => [entry.label, entry.value, entry.dot]),
    ).toEqual([
      ['AI Model', 'NVIDIA', false],
      ['Telegram', 'On', false],
      ['Memory', 'Mem0 Cloud', false],
    ]);
    expect(ready.advanced).toMatchObject({value: 'On', dot: false});

    const unready = sidebar({
      home: homeView({
        model: {ready: false},
        sections: [
          memory({setup: {ready: false}}),
          {...telegram, enabled: false},
        ],
      }),
      'character:mira': herView(),
    });

    expect(unready.connections.map(entry => [entry.value, entry.dot])).toEqual([
      ['Set Up', true],
      ['Off', false],
      ['Set Up', true],
    ]);

    const unwanted = sidebar({
      home: homeView({sections: [memory({setup: {ready: false}})]}),
      'character:mira': herView({}, [memory({enabled: false})]),
    });

    expect(unwanted.connections[2]).toMatchObject({value: 'Off', dot: false});

    const keyed = (hasKey: boolean) =>
      sidebar({home: homeView()}, nothingFound, [tavily(hasKey)]).connections;

    expect(keyed(true).map(entry => [entry.label, entry.value])).toEqual([
      ['AI Model', 'NVIDIA'],
      ['Telegram', 'On'],
      ['Memory', 'Mem0 Cloud'],
      ['Tavily', 'On'],
    ]);
    expect(keyed(true).at(-1)).toMatchObject({
      page: {kind: 'account', accountId: 'tavily'},
      icon: 'key',
      tint: 'graphite',
      dot: false,
    });
    expect(keyed(false).map(entry => entry.label)).not.toContain('Tavily');

    // A plugin with no entry of its own, whether it has home settings or
    // not, has its problem said on Advanced.
    const wrong = sidebar(
      {home: homeView({sections: [memory(), section('notebook'), phone]})},
      {
        rows: new Map(),
        sections: new Map([
          ['home/plugins/phone', ['Broken.']],
          ['character:mira/plugins/reply-style', ['Broken.']],
        ]),
        notes: [],
      },
    );

    expect(wrong.characters.map(entry => entry.dot)).toEqual([true, false]);
    expect(wrong.advanced.dot).toBe(true);
    expect(sidebar({}).connections.map(entry => entry.value)).toEqual(['', '']);
  });

  it("lists the services on AI Model: once one is connected, what every character thinks with over those connected, each by its key or a server of the person's own and In Use on the one chosen; then the rest by what each is, under Add a Service, or Services while none is; and the sidebar says the one connected or how many, and Set Up while a character has no model", () => {
    const rows = (listed: readonly ListedService[]) =>
      listed.map(entry => [entry.service.name, entry.line, entry.inUse]);
    const page = (view: OkView) => {
      const {connected, others} = servicesListed(settingsOf({home: view}));

      return {
        connected: rows(connected),
        others: {...others, services: rows(others.services)},
      };
    };
    const word = (view: OkView) =>
      sidebarOf(settingsOf({home: view}), health(true), nothingFound, false)
        .connections[0];
    const offer = {
      openai: ['OpenAI API', 'Pay as you go, with an API key', false],
      nvidia: ['NVIDIA', 'An API key, or a server of your own', false],
    };
    const none = homeView({
      model: {ready: false, message: 'Choose an AI service.'},
      services: services(false, false),
      project02: serviceFields({}),
    });

    expect(page(none)).toEqual({
      connected: [],
      others: {
        title: 'Services',
        footer: 'Connect one to start. You can connect more than one.',
        services: [offer.openai, offer.nvidia],
      },
    });
    expect(word(none)).toMatchObject({value: 'Set Up', dot: true});

    expect(page(homeView())).toEqual({
      connected: [['NVIDIA', 'Key saved', true]],
      others: {title: 'Add a Service', services: [offer.openai]},
    });
    expect(word(homeView())).toMatchObject({value: 'NVIDIA', dot: false});

    const both = homeView({
      services: services(true, true),
      project02: serviceFields({
        roleModelProvider: 'openai',
        openaiApiKey: '[redacted]',
        nvidiaBaseUrl: 'http://localhost:1234/v1',
      }),
    });
    const everyone = serviceChoice(settingsOf({home: both}), home);

    expect(page(both)).toEqual({
      connected: [
        ['OpenAI API', 'Key saved', true],
        ['NVIDIA', 'Your server', false],
      ],
      others: {title: 'Add a Service', services: []},
    });
    expect(word(both)).toMatchObject({value: '2 Services', dot: false});
    expect(everyone.chosen?.id).toBe('openai');
    expect(everyone.options).toEqual([
      {value: 'openai', label: 'OpenAI API'},
      {value: 'nvidia', label: 'NVIDIA'},
    ]);
    expect(everyone.model?.name).toBe('openaiModel');

    // The key of the service in use taken away: it is no longer In Use or
    // connected, yet still what is chosen, and the sidebar says a model is
    // to be set up.
    const keyless = homeView({
      model: {ready: false, message: 'Add your OpenAI API key.'},
      services: services(false, true),
      project02: serviceFields({
        roleModelProvider: 'openai',
        nvidiaBaseUrl: 'http://localhost:1234/v1',
      }),
    });

    expect(page(keyless)).toEqual({
      connected: [['NVIDIA', 'Your server', false]],
      others: {title: 'Add a Service', services: [offer.openai]},
    });
    expect(
      serviceChoice(settingsOf({home: keyless}), home).options.map(
        option => option.value,
      ),
    ).toEqual(['openai', 'nvidia']);
    expect(word(keyless)).toMatchObject({value: 'Set Up', dot: true});
    expect([serviceArt('openai'), serviceArt('nvidia')]).toEqual([
      {icon: 'key', tint: 'graphite'},
      {icon: 'grid', tint: 'teal'},
    ]);
    expect(serviceArt('elsewhere')).toEqual({icon: 'grid', tint: 'gray'});
  });

  it('offers a model from the list its service suggests, in their words, and one typed in among them as it is', () => {
    const model = field('openaiModel', openaiModel, 'gpt-6-luna');
    const listed = Object.entries(openaiModels).map(([value, label]) => ({
      value,
      label,
    }));

    expect(suggestedChoices(model, 'gpt-6-luna')).toEqual(listed);
    expect(suggestedChoices(model, undefined)).toEqual(listed);
    expect(suggestedChoices(model, 'gpt-7-preview')).toEqual([
      ...listed,
      {value: 'gpt-7-preview', label: 'gpt-7-preview'},
    ]);
  });

  it("gives her a service of her own: the one she chose, else the one she thinks with while she holds its model of her own, else everyone's; offers those connected for her and hers while it is not; and Same as Everyone takes away her service and every model of hers", () => {
    const fromHome = {
      roleModelProvider: 'nvidia',
      openaiApiKey: '[redacted]',
      nvidiaApiKey: '[redacted]',
    };
    const hers = (
      held: Readonly<Record<string, string>>,
      connected: readonly ModelService[] = services(true, true),
    ) =>
      herView({
        services: [...connected],
        project02: [
          own('enabled', true, {valueType: 'boolean'}),
          ...serviceFields(held, fromHome),
        ],
      });
    const choice = (
      view: OkView,
      edits: Readonly<Record<string, string>> = {},
    ) =>
      serviceChoice(
        settingsOf({home: homeView(), 'character:mira': view}, edits),
        characterTarget('mira'),
      );
    const terra = hers({
      roleModelProvider: 'openai',
      openaiModel: 'gpt-6.1-terra',
      nvidiaModel: 'meta/llama',
    });

    expect(choice(hers({}))).toEqual({
      options: [
        {value: 'openai', label: 'OpenAI API'},
        {value: 'nvidia', label: 'NVIDIA'},
      ],
    });
    expect(choice(terra)).toMatchObject({
      chosen: {id: 'openai'},
      model: {name: 'openaiModel', effective: {value: 'gpt-6.1-terra'}},
    });
    expect(choice(hers({nvidiaModel: 'meta/llama'})).chosen?.id).toBe('nvidia');
    expect(choice(hers({openaiModel: 'gpt-6.1-terra'})).chosen).toBeUndefined();
    // Same as Everyone just chosen is what she shows at once.
    expect(
      choice(terra, {'character:mira/project02.roleModelProvider': ''}).chosen,
    ).toBeUndefined();
    expect(
      choice(
        hers({roleModelProvider: 'openai'}, services(false, true)),
      ).options.map(option => option.value),
    ).toEqual(['openai', 'nvidia']);
    expect(
      ownModelRows(settingsOf({'character:mira': terra}), 'mira').map(rowKey),
    ).toEqual([
      'character:mira/project02.roleModelProvider',
      'character:mira/project02.openaiModel',
      'character:mira/project02.nvidiaModel',
    ]);
    expect(
      ownModelRows(settingsOf({'character:mira': hers({})}), 'mira'),
    ).toEqual([]);
  });

  it("shows what else of her AI model she holds of her own, a service's other fields under its name and the context size under Advanced, and never the model her page already offers", () => {
    const hers = (project02: readonly Field[]) =>
      herView({
        services: services(true, true),
        project02: [own('enabled', true, {valueType: 'boolean'}), ...project02],
      });
    const extras = (view: OkView) =>
      ownModelExtras(
        settingsOf({home: homeView(), 'character:mira': view}),
        'mira',
      ).map(held => [held.title, held.rows.map(({row}) => rowKey(row))]);

    expect(
      extras(
        hers([
          ...serviceFields({
            roleModelProvider: 'nvidia',
            nvidiaModel: 'meta/llama',
            nvidiaApiKey: '[redacted]',
            nvidiaBaseUrl: 'http://localhost:1234/v1',
            openaiModel: 'gpt-6.1-terra',
          }),
          own('contextWindowTokens', 4096, {valueType: 'number'}),
        ]),
      ),
    ).toEqual([
      ['OpenAI API', ['character:mira/project02.openaiModel']],
      [
        'NVIDIA',
        [
          'character:mira/project02.nvidiaApiKey',
          'character:mira/project02.nvidiaBaseUrl',
        ],
      ],
      ['Advanced', ['character:mira/project02.contextWindowTokens']],
    ]);
    expect(extras(hers(serviceFields({})))).toEqual([]);
  });

  it('says how a character stands: off, needing an AI model with what to do, ready with any warning, or her state with why she failed', () => {
    expect(characterStatus(nova, undefined)).toEqual({
      word: 'Off',
      tone: 'off',
      model: false,
    });
    expect(
      characterStatus(
        {...mira, state: 'needs_model', diagnostic: 'Choose an AI service.'},
        undefined,
      ),
    ).toEqual({
      word: 'Needs an AI model',
      tone: 'warn',
      model: true,
      note: 'Choose an AI service.',
    });
    expect(
      characterStatus(
        mira,
        herView({model: {ready: false, message: 'Add your NVIDIA API key.'}}),
      ),
    ).toMatchObject({model: true, note: 'Add your NVIDIA API key.'});
    expect(
      characterStatus(
        {...mira, diagnostic: 'Memory is not set up.'},
        herView(),
      ),
    ).toEqual({
      word: 'Ready',
      tone: 'ready',
      model: false,
      note: 'Memory is not set up.',
    });
    expect(
      characterStatus(
        {...mira, state: 'failed', diagnostic: 'Broken.'},
        herView(),
      ),
    ).toMatchObject({word: "Can't Start", tone: 'problem', note: 'Broken.'});
    expect(
      characterStatus({...mira, state: 'starting'}, herView()),
    ).toMatchObject({
      word: 'Starting',
      tone: 'busy',
    });
  });

  it('says a bot as health says it stands: to add, its name, a problem with what to do, connecting, or the connector not running', () => {
    const hers = characterTarget('mira');

    expect(botWords(health(true), hers, false)).toEqual({
      value: 'Add',
      tone: 'link',
    });
    expect(botWords(health(false), hers, true)).toEqual({
      value: 'Not Running',
      tone: 'plain',
      sentence: telegramNotRunning,
    });
    expect(botWords(health(true), hers, true)).toEqual({
      value: 'Connecting…',
      tone: 'plain',
    });
    expect(
      botWords(
        health(true, [{target: hers, username: 'mira_bot', state: 'on'}]),
        hers,
        true,
      ).value,
    ).toBe('@mira_bot');
    expect(
      botWords(health(true, [{target: home, state: 'on'}]), home, true).value,
    ).toBe('On');

    for (const [state, value] of [
      ['refused', 'Token Refused'],
      ['unreachable', "Can't Reach Telegram"],
      ['conflict', 'In Use Elsewhere'],
      ['webhook', 'Set to a Webhook'],
    ] as const) {
      const words = botWords(health(true, [{target: hers, state}]), hers, true);

      expect(words).toMatchObject({value, tone: 'problem'});
      expect(words.sentence).toBeDefined();
    }

    const settings = settingsOf({
      home: homeView(),
      'character:mira': herView({}, [
        {...telegram, fields: [own('botToken', '[redacted]', {secret: true})]},
      ]),
    });

    expect(botStored(settings, hers)).toBe(true);
    expect(botStored(settings, home)).toBe(false);
    expect(telegramOn(settings)).toBe(true);
    expect(telegramOn(settingsOf({}))).toBe(false);
  });

  it('lists every plugin and connector once, by where it sits, with who runs it and what it can do', () => {
    const settings = settingsOf({
      home: homeView(),
      'character:mira': herView(),
      'character:nova': {
        status: 'refused',
        reason: 'config_unloadable',
        message: 'No.',
      },
    });

    expect(sectionsListed(settings).map(listed => listed.id)).toEqual([
      'session-history',
      'mem0',
      'reply-style',
      'runtime.plugin',
      'telegram',
    ]);
    expect(
      usedBy(settings, [mira, nova], 'plugins', 'session-history'),
    ).toEqual([mira]);
    expect(usedBy(settings, [mira, nova], 'plugins', 'reply-style')).toEqual(
      [],
    );
    expect(accessLines(memory())).toEqual([
      'Sends your chats to the service you set up for it',
      'Adds to what she knows',
    ]);
    expect(
      accessLines(
        section('notebook', {
          access: {session_history: 'read', trusted_context: 'write'},
        }),
      ),
    ).toEqual(['Reads your chats with her', 'Adds notes she trusts']);
    expect(accessLines(telegram)).toEqual([
      'Sends and receives Telegram messages',
    ]);
    expect(artOf(memory())).toEqual({icon: 'archive', tint: 'brown'});
    expect(artOf(telegram)).toEqual({icon: 'plane', tint: 'blue'});
    expect(artOf(section('notebook'))).toEqual({icon: 'grid', tint: 'gray'});
  });

  it("says each finding once where it belongs: an error at the field it names, one about a section on its page, and everything else as a note, a character's named", () => {
    const invalid = {
      severity: 'error',
      code: 'runtime_config_value_invalid',
    } as const;
    const atHost: RuntimeConfigDiagnostic = {
      ...invalid,
      message: 'Context Size must be a number.',
      path: 'project02.contextWindowTokens',
      scope: 'global',
    };
    const atField: RuntimeConfigDiagnostic = {
      ...invalid,
      message: 'Kept At must be one of these.',
      scope: 'section',
      namespace: 'plugins',
      id: 'mem0',
      field: 'backend',
    };
    const atSection: RuntimeConfigDiagnostic = {
      ...invalid,
      message: 'Its switch must be on or off.',
      scope: 'section',
      namespace: 'plugins',
      id: 'reply-style',
      origin: {scope: 'character', characterId: 'mira', path: 'config.json'},
    };
    const document: RuntimeConfigDiagnostic = {
      ...invalid,
      message: 'The settings must be an object.',
      path: 'plugins',
      scope: 'global',
    };
    const warning: RuntimeConfigDiagnostic = {
      severity: 'warning',
      code: 'character_plugin_not_running',
      message:
        'Long-Term Memory is not set up yet, so she is running without it.',
      scope: 'section',
      namespace: 'plugins',
      id: 'mem0',
    };
    const found = findings(
      settingsOf({
        home: homeView({diagnostics: [atHost, atField, document]}),
        'character:mira': herView({
          diagnostics: [atHost, atField, document, atSection, warning],
        }),
        'character:nova': {
          status: 'refused',
          reason: 'unknown_character',
          message: 'Gone.',
        },
      }),
      id => (id === 'mira' ? 'Mira' : id),
    );

    expect([...found.rows]).toEqual([
      [
        rowKey({
          target: home,
          place: {kind: 'host', name: 'contextWindowTokens'},
        }),
        ['Context Size must be a number.'],
      ],
      [
        rowKey({
          target: home,
          place: {
            kind: 'field',
            namespace: 'plugins',
            id: 'mem0',
            name: 'backend',
          },
        }),
        ['Kept At must be one of these.'],
      ],
    ]);
    expect([...found.sections]).toEqual([
      ['character:mira/plugins/reply-style', ['Its switch must be on or off.']],
    ]);
    expect(found.notes).toEqual([
      'The settings must be an object.',
      'Mira: Long-Term Memory is not set up yet, so she is running without it.',
    ]);
  });

  it("reads a row as it shows now: a click not yet landed, else the view; and opens the welcome's next step once a service is chosen and its own key is stored or typed", () => {
    const service: Row = {
      target: home,
      place: {kind: 'host', name: 'roleModelProvider'},
    };
    const provider = homeView().project02[1];

    if (provider === undefined) {
      throw new Error('Expected the provider.');
    }

    expect(valueNow(settingsOf({home: homeView()}), service, provider)).toBe(
      'nvidia',
    );
    expect(
      valueNow(
        settingsOf({home: homeView()}, {[rowKey(service)]: ''}),
        service,
        provider,
      ),
    ).toBeUndefined();
    expect(
      switchedOn(
        settingsOf({}, {'home/plugins/mem0': 'false'}),
        home,
        memory(),
      ),
    ).toBe(false);
    expect(switchedOn(settingsOf({}), home, memory())).toBe(true);

    const unready = homeView({model: {ready: false}});
    const keyless = homeView({
      model: {ready: false},
      services: services(false, false),
      project02: serviceFields({roleModelProvider: 'nvidia'}),
    });
    const openai = {'home/project02.roleModelProvider': 'openai'};

    expect(welcomeReady(settingsOf({home: unready}))).toBe(true);
    expect(welcomeReady(settingsOf({home: keyless}))).toBe(false);
    expect(
      welcomeReady(
        settingsOf({home: keyless}, {'home/project02.nvidiaApiKey': 'nvapi-1'}),
      ),
    ).toBe(true);
    // Another service chosen asks for a key of its own, with where to get one.
    expect(welcomeKey(settingsOf({home: keyless}, openai))).toMatchObject({
      row: {target: home, place: {kind: 'host', name: 'openaiApiKey'}},
      service: {keyFrom: 'Get one at platform.openai.com.'},
    });
    expect(
      welcomeReady(
        settingsOf(
          {home: keyless},
          {...openai, 'home/project02.nvidiaApiKey': 'nvapi-1'},
        ),
      ),
    ).toBe(false);
    expect(
      welcomeReady(
        settingsOf(
          {home: keyless},
          {...openai, 'home/project02.openaiApiKey': 'sk-1'},
        ),
      ),
    ).toBe(true);
    expect(welcomeReady(settingsOf({home: homeView()}))).toBe(true);
    expect(welcomeReady(settingsOf({}))).toBe(false);
  });

  it('knows the page a sub-page opens from, which the sidebar marks', () => {
    const hers = characterTarget('mira');

    expect(
      parentOf({kind: 'feature', characterId: 'mira', pluginId: 'reply-style'}),
    ).toEqual({
      kind: 'character',
      characterId: 'mira',
    });
    expect(parentOf({kind: 'character-model', characterId: 'mira'})).toEqual({
      kind: 'character',
      characterId: 'mira',
    });
    expect(parentOf({kind: 'bot', target: hers, from: 'character'})).toEqual({
      kind: 'character',
      characterId: 'mira',
    });
    expect(parentOf({kind: 'bot', target: hers, from: 'telegram'})).toEqual({
      kind: 'telegram',
    });
    expect(parentOf({kind: 'bot', target: home, from: 'character'})).toEqual({
      kind: 'telegram',
    });
    expect(
      parentOf({kind: 'plugin', namespace: 'plugins', id: 'mem0'}),
    ).toEqual({
      kind: 'advanced',
    });
    expect(parentOf({kind: 'service', serviceId: 'openai'})).toEqual({
      kind: 'model',
    });
    expect(parentOf({kind: 'remove', characterId: 'nova'})).toEqual({
      kind: 'character',
      characterId: 'nova',
    });
    expect(
      parentOf({kind: 'app', characterId: 'mira', appId: 'clock'}),
    ).toEqual({kind: 'character', characterId: 'mira'});
    expect(parentOf({kind: 'get-apps', characterId: 'mira'})).toEqual({
      kind: 'character',
      characterId: 'mira',
    });

    const appFile: SettingsPage = {
      kind: 'app-file',
      characterId: 'mira',
      fileName: 'notes.js',
      preview: {status: 'failed', message: 'No.'},
    };

    expect(parentOf(appFile)).toEqual({kind: 'get-apps', characterId: 'mira'});

    // An account's page goes back to the app it was opened from, and is a
    // page of the sidebar's own when opened from Connections.
    const fromApp: SettingsPage = {
      kind: 'account',
      accountId: 'tavily',
      from: {characterId: 'mira', appId: 'search'},
    };

    expect(parentOf(fromApp)).toEqual({
      kind: 'app',
      characterId: 'mira',
      appId: 'search',
    });
    expect(marks(fromApp, {kind: 'character', characterId: 'mira'})).toBe(true);
    expect(parentOf({kind: 'account', accountId: 'tavily'})).toBeUndefined();
    expect(parentOf({kind: 'you'})).toBeUndefined();
    expect(
      marks(
        {kind: 'plugin', namespace: 'plugins', id: 'mem0'},
        {kind: 'advanced'},
      ),
    ).toBe(true);
    // Her entry is marked however deep under her page the window is.
    expect(marks(appFile, {kind: 'character', characterId: 'mira'})).toBe(true);
    expect(marks({kind: 'you'}, {kind: 'advanced'})).toBe(false);
  });

  it('offers by where she stands here: Add when she is new, saying so when her chats from before are still here; Update for another version; her page when this very version is here; and nothing to add for one that comes with the app', () => {
    const nova: CharacterPreview = {
      status: 'ok',
      id: 'nova',
      displayName: 'Nova',
      version: '1.0.0',
      comesWith: [],
      installed: 'none',
      hasData: false,
    };

    expect(offerOf(nova)).toEqual({button: 'Add Nova'});
    expect(offerOf({...nova, hasData: true})).toEqual({
      button: 'Add Nova',
      line: 'Her chats and memories from before are still here.',
    });
    expect(
      offerOf({...nova, installed: 'other_version', hasData: true}),
    ).toEqual({
      button: 'Update Nova',
      line: 'Nova is here in another version.',
    });
    expect(offerOf({...nova, installed: 'same', hasData: true})).toEqual({
      line: 'Nova is already here.',
      link: 'Open Nova',
    });
    expect(offerOf({...nova, installed: 'built_in', hasData: true})).toEqual({
      line: 'Nova comes with the app.',
    });
  });

  it('draws what she comes with in the order her page shows it, each on its tile and none for a plugin her page has no row for, says once what this app does not have, and what she would find set up', () => {
    const settings = settingsOf({
      home: homeView({
        sections: [
          memory(),
          telegram,
          section('phone', {displayName: 'Phone'}),
        ],
      }),
      'character:mira': herView(),
    });

    expect(
      comesWithOf(settings, [
        {
          kind: 'plugin',
          id: 'runtime.plugin',
          displayName: 'Ask to Change Settings',
        },
        {kind: 'unknown', id: 'astronomy'},
        {kind: 'plugin', id: 'weather', displayName: 'Weather'},
        {kind: 'plugin', id: 'phone', displayName: 'Phone'},
        {kind: 'plugin', id: 'session-history', displayName: 'Look Back'},
        {kind: 'unknown', id: 'clock'},
      ]),
    ).toEqual({
      chips: [
        {
          id: 'session-history',
          name: 'Look Back',
          icon: 'history',
          tint: 'cyan',
        },
        {
          id: 'runtime.plugin',
          name: 'Ask to Change Settings',
          icon: 'shield',
          tint: 'gray',
        },
        {id: 'weather', name: 'Weather', icon: 'grid', tint: 'gray'},
      ],
      lacking: 'This app does not have: astronomy, clock.',
    });
    expect(comesWithOf(settings, [])).toEqual({chips: []});
    expect(readinessOf(settings)).toEqual([
      {label: 'AI Model', value: 'Ready'},
      {label: 'Long-Term Memory', value: 'Ready'},
    ]);
    expect(
      readinessOf(
        settingsOf({
          home: homeView({
            model: {ready: false},
            sections: [memory({setup: {ready: false}}), telegram],
          }),
        }),
      ),
    ).toEqual([
      {label: 'AI Model', value: 'Set Up First'},
      {label: 'Long-Term Memory', value: 'Optional'},
    ]);
    expect(readinessOf(settingsOf({}))).toEqual([]);
  });

  it('draws a plugin by the icon and tint it names, the plainest for one the page lacks, and each character on the same colour wherever she appears', () => {
    expect(iconOf('archive')).toBe('archive');
    expect(iconPath(iconOf('archive'))).toMatch(/^M/u);
    expect(iconOf('rocket')).toBe('grid');
    expect(iconOf(undefined)).toBe('grid');
    expect(tintOf('mint')).toBe('mint');
    expect(tintOf('chartreuse')).toBe('gray');
    expect(avatarColor('mira')).toBe(avatarColor('mira'));
    expect(avatarColor('mira')).not.toBe(avatarColor('nova'));
    expect(initialOf(' mira')).toBe('M');
  });
});
