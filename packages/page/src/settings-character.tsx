/**
 * A character's pages: hers, with her switch, what makes up her mind and
 * body, her heartbeat, her bot, what she may do and what is hers alone; a
 * plugin's own page for her; and her own AI model. Each draws her view,
 * and writes only what her view lists.
 */
import type {CharacterSummary} from '@project02/wire/contract';
import {
  Cell,
  Chevron,
  Face,
  Group,
  Label,
  LinkCell,
  PageHeader,
  SubHeader,
  Switch,
  Tile,
} from './settings-controls.tsx';
import {
  FieldRow,
  LayoutCards,
  ServiceRow,
  problemsAt,
  sectionRow,
  type Ctx,
} from './settings-fields.tsx';
import {
  artOf,
  botStored,
  botWords,
  characterStatus,
  featureControl,
  featureValue,
  featuresPlaced,
  setupPage,
  switchedOn,
  telegramOn,
  valueNow,
  type BotWords,
} from './settings-model.ts';
import {
  characterTarget,
  fieldAt,
  sectionOf,
  targetKey,
  viewOf,
  type OkView,
  type Row,
  type Section,
} from './settings.ts';
import type {SettingsPage} from './store.ts';

/** The host fields that make a character's AI model, in the order her page shows them. */
const modelFields = [
  'roleModelProvider',
  'nvidiaApiKey',
  'nvidiaModel',
  'nvidiaBaseUrl',
  'contextWindowTokens',
] as const;

function characterOf(
  ctx: Ctx,
  characterId: string,
): CharacterSummary | undefined {
  return ctx.state.health?.characters.find(
    character => character.id === characterId,
  );
}

function hostRow(characterId: string, name: string): Row {
  return {target: characterTarget(characterId), place: {kind: 'host', name}};
}

export function CharacterPage({
  ctx,
  characterId,
  removing,
}: {
  readonly ctx: Ctx;
  readonly characterId: string;
  /** Her page asking whether to remove her. */
  readonly removing?: Extract<SettingsPage, {kind: 'remove'}>;
}) {
  const character = characterOf(ctx, characterId);
  const target = characterTarget(characterId);
  const read = ctx.settings.views.get(targetKey(target));
  const view = viewOf(ctx.settings, target);

  if (character === undefined) {
    return null;
  }

  const enabled =
    view === undefined
      ? undefined
      : fieldAt(view, hostRow(characterId, 'enabled').place);
  const on =
    enabled === undefined
      ? character.enabled
      : valueNow(ctx.settings, hostRow(characterId, 'enabled'), enabled) ===
        'true';

  return (
    <>
      <CharacterHeader
        ctx={ctx}
        character={character}
        view={view}
        on={on}
        {...(read?.status === 'refused' ? {refused: read.message} : {})}
      />
      {view === undefined ? null : on ? (
        <CharacterCards ctx={ctx} character={character} view={view} />
      ) : (
        <p className="page-note">
          She won&apos;t start or reply while she&apos;s off.
        </p>
      )}
      {character.builtIn ? null : (
        <RemoveCharacter
          ctx={ctx}
          character={character}
          {...(removing === undefined ? {} : {removing})}
        />
      )}
    </>
  );
}

/**
 * Remove, at the bottom of the page of a character a person added. It
 * asks first, saying that her chats and memories stay, with the focus on
 * Cancel so a key pressed by mistake removes nothing; and says in the
 * daemon's words why she was not removed when she was not.
 */
function RemoveCharacter({
  ctx,
  character,
  removing,
}: {
  readonly ctx: Ctx;
  readonly character: CharacterSummary;
  readonly removing?: Extract<SettingsPage, {kind: 'remove'}>;
}) {
  const {session} = ctx;
  const name = character.displayName;

  if (removing === undefined) {
    return (
      <button
        type="button"
        className="button-danger"
        onClick={() => {
          session.goTo({kind: 'remove', characterId: character.id});
        }}
      >
        Remove {name}…
      </button>
    );
  }

  return (
    <div
      role="alertdialog"
      aria-labelledby="remove-title"
      aria-describedby="remove-text"
      className="confirm"
    >
      <div className="confirm-words">
        <span id="remove-title" className="confirm-title">
          Remove {name}?
        </span>
        <span id="remove-text" className="page-note">
          She leaves your character list. Her chats and memories stay on this
          computer, so adding her again brings them back.
        </span>
      </div>
      <div className="confirm-buttons">
        <button
          type="button"
          className="button-pill button-destructive"
          onClick={() => {
            void session.removeCharacter(character.id);
          }}
        >
          Remove
        </button>
        <button
          type="button"
          className="button-pill"
          autoFocus
          onClick={() => {
            session.goTo({kind: 'character', characterId: character.id});
          }}
        >
          Cancel
        </button>
      </div>
      {removing.problem === undefined ? null : (
        <p className="page-problem" role="alert">
          {removing.problem}
        </p>
      )}
    </div>
  );
}

/**
 * Her avatar, name and how she stands, her switch beside them; under
 * them, her note when she carries one, and what is wrong with a section
 * of hers. A view the daemon refuses takes the page's place, and its
 * sentence the note's, which says the same.
 */
function CharacterHeader({
  ctx,
  character,
  view,
  on,
  refused,
}: {
  readonly ctx: Ctx;
  readonly character: CharacterSummary;
  readonly view: OkView | undefined;
  readonly on: boolean;
  readonly refused?: string;
}) {
  const status = characterStatus({...character, enabled: on}, view);
  const row = hostRow(character.id, 'enabled');
  const word = (
    <>
      <span className={`status-dot status-${status.tone}`} aria-hidden="true" />
      {status.word}
    </>
  );
  const prefix = `${targetKey(row.target)}/`;
  const wrong = [...ctx.findings.sections]
    .filter(([key]) => key.startsWith(prefix))
    .flatMap(([, said]) => said);

  return (
    <>
      <PageHeader
        art={
          <Face id={character.id} name={character.displayName} size="page" />
        }
        title={character.displayName}
        subtitle={
          status.model ? (
            <button
              type="button"
              className="status status-link"
              onClick={() => {
                ctx.session.goTo({kind: 'model'});
              }}
            >
              {word}
            </button>
          ) : (
            <span className="status">{word}</span>
          )
        }
        aside={
          view === undefined ? null : (
            <div className="power">
              <span className="power-word">{on ? 'On' : 'Off'}</span>
              <Switch
                on={on}
                label={`${character.displayName} is on`}
                onToggle={() => {
                  void ctx.session.choose(row, !on);
                }}
              />
            </div>
          )
        }
      />
      {refused === undefined ? (
        status.note === undefined ? null : (
          <p
            className={status.tone === 'problem' ? 'page-problem' : 'page-note'}
          >
            {status.note}
          </p>
        )
      ) : (
        <p className="page-problem">{refused}</p>
      )}
      {[...wrong, ...problemsAt(ctx, row)].map(problem => (
        <p className="page-problem" key={problem}>
          {problem}
        </p>
      ))}
    </>
  );
}

function CharacterCards({
  ctx,
  character,
  view,
}: {
  readonly ctx: Ctx;
  readonly character: CharacterSummary;
  readonly view: OkView;
}) {
  const target = characterTarget(character.id);
  const permissions = featuresPlaced(view, 'permission');

  return (
    <>
      <Group title="Mind & Body">
        {featuresPlaced(view, 'mind_body').map(section => (
          <FeatureCell
            key={section.id}
            ctx={ctx}
            characterId={character.id}
            section={section}
          />
        ))}
      </Group>
      <HerHeartbeat ctx={ctx} characterId={character.id} view={view} />
      <Group title="Telegram">
        <HerBot ctx={ctx} characterId={character.id} />
      </Group>
      {permissions.length === 0 ? null : (
        <Group
          title="Permissions"
          footer="You approve each change she asks for."
        >
          {permissions.map(section => (
            <SectionSwitch
              key={section.id}
              ctx={ctx}
              row={{
                target,
                place: {kind: 'switch', namespace: 'plugins', id: section.id},
              }}
              section={section}
            />
          ))}
        </Group>
      )}
      <HerOwn ctx={ctx} character={character} view={view} />
    </>
  );
}

/** A plugin of hers: Set Up while it is not, her page of it when her view lists its fields, and her switch otherwise. */
function FeatureCell({
  ctx,
  characterId,
  section,
}: {
  readonly ctx: Ctx;
  readonly characterId: string;
  readonly section: Section;
}) {
  const target = characterTarget(characterId);
  const art = artOf(section);
  const row: Row = {
    target,
    place: {kind: 'switch', namespace: 'plugins', id: section.id},
  };
  const on = switchedOn(ctx.settings, target, section);
  const go = (page: SettingsPage) => () => {
    ctx.session.goTo(page);
  };

  return (
    <Cell kind="tall" problems={problemsAt(ctx, row)}>
      <Tile icon={art.icon} tint={art.tint} />
      <Label
        name={section.displayName}
        {...(section.page === undefined ? {} : {detail: section.page.summary})}
      />
      {featureControl(section) === 'setup' ? (
        <button
          type="button"
          className="button-setup"
          onClick={go(setupPage(ctx.settings, section.id))}
        >
          Set Up
        </button>
      ) : featureControl(section) === 'drill' ? (
        <button
          type="button"
          className="drill"
          aria-label={section.displayName}
          onClick={go({kind: 'feature', characterId, pluginId: section.id})}
        >
          {featureValue(section, on, name =>
            currentOf(ctx, target, section, name),
          )}
          <Chevron />
        </button>
      ) : (
        <Switch
          on={on}
          label={section.displayName}
          onToggle={() => {
            void ctx.session.choose(row, !on);
          }}
        />
      )}
    </Cell>
  );
}

function currentOf(
  ctx: Ctx,
  target: Row['target'],
  section: Section,
  name: string,
): string | undefined {
  const field = section.fields.find(candidate => candidate.name === name);

  return field === undefined
    ? undefined
    : valueNow(ctx.settings, sectionRow(target, section, name), field);
}

/** A switch of hers for a whole plugin, on its tile. */
function SectionSwitch({
  ctx,
  row,
  section,
}: {
  readonly ctx: Ctx;
  readonly row: Row;
  readonly section: Section;
}) {
  const art = artOf(section);
  const on = switchedOn(ctx.settings, row.target, section);

  return (
    <Cell kind="switch" problems={problemsAt(ctx, row)}>
      <Tile icon={art.icon} tint={art.tint} />
      <Label name={section.displayName} />
      <Switch
        on={on}
        label={section.displayName}
        onToggle={() => {
          void ctx.session.choose(row, !on);
        }}
      />
    </Cell>
  );
}

/** How often she gets a moment of her own while the person is quiet: her row of choices. */
function HerHeartbeat({
  ctx,
  characterId,
  view,
}: {
  readonly ctx: Ctx;
  readonly characterId: string;
  readonly view: OkView;
}) {
  const row = hostRow(characterId, 'heartbeat');
  const field = fieldAt(view, row.place);

  return field === undefined ? null : (
    <Group
      title="Heartbeat"
      footer="While you're quiet, she gets a moment this often to think, use what she has, or write to you. Each one uses your AI model."
    >
      <FieldRow ctx={ctx} row={row} field={field} />
    </Group>
  );
}

/** Her bot's row: Telegram off, to be added, or how health says it stands. */
function HerBot({
  ctx,
  characterId,
}: {
  readonly ctx: Ctx;
  readonly characterId: string;
}) {
  const target = characterTarget(characterId);
  const on = telegramOn(ctx.settings);
  const words: BotWords = on
    ? botWords(ctx.state.health, target, botStored(ctx.settings, target))
    : {value: 'Telegram Is Off', tone: 'plain'};

  return (
    <LinkCell
      value={words.value}
      tone={words.tone}
      onClick={() => {
        ctx.session.goTo(
          on ? {kind: 'bot', target, from: 'character'} : {kind: 'telegram'},
        );
      }}
    >
      <Tile icon="plane" tint="blue" />
      <Label name="Her Bot" />
    </LinkCell>
  );
}

/**
 * What is hers alone, under Advanced: her own AI model and what she calls
 * the person. Shown while the Advanced switch is on, and a row she holds a
 * value for shows without it.
 */
function HerOwn({
  ctx,
  character,
  view,
}: {
  readonly ctx: Ctx;
  readonly character: CharacterSummary;
  readonly view: OkView;
}) {
  const {advanced} = ctx.state;
  const holds = (name: string) =>
    fieldAt(view, hostRow(character.id, name).place)?.authored.configured ===
    true;
  const model = fieldAt(view, hostRow(character.id, 'nvidiaModel').place);
  const ownModel = modelFields.some(holds);
  const callsYou = fieldAt(
    view,
    hostRow(character.id, 'userDisplayName').place,
  );
  const showModel = advanced || ownModel;
  const showName =
    callsYou !== undefined && (advanced || holds('userDisplayName'));

  if (!showModel && !showName) {
    return null;
  }

  const modelValue =
    model?.authored.configured === true &&
    typeof model.authored.value === 'string'
      ? model.authored.value
      : ownModel
        ? 'Custom'
        : 'Same as Settings';

  return (
    <Group
      title="Advanced"
      footer={`Only for ${character.displayName}. Empty uses your settings.`}
    >
      {showModel ? (
        <LinkCell
          value={modelValue}
          onClick={() => {
            ctx.session.goTo({
              kind: 'character-model',
              characterId: character.id,
            });
          }}
        >
          <Tile icon="sparkle" tint="indigo" />
          <Label name="AI Model" />
        </LinkCell>
      ) : null}
      {showName ? (
        <FieldRow
          ctx={ctx}
          row={hostRow(character.id, 'userDisplayName')}
          field={{...callsYou, label: 'Calls You'}}
          leading={<Tile icon="person" tint="gray" />}
        />
      ) : null}
    </Group>
  );
}

/** A plugin's own page for her: its switch, and while it is on, its cards from her view. */
export function FeaturePage({
  ctx,
  characterId,
  pluginId,
}: {
  readonly ctx: Ctx;
  readonly characterId: string;
  readonly pluginId: string;
}) {
  const character = characterOf(ctx, characterId);
  const target = characterTarget(characterId);
  const view = viewOf(ctx.settings, target);
  const section =
    view === undefined ? undefined : sectionOf(view, 'plugins', pluginId);

  if (character === undefined || section === undefined) {
    return null;
  }

  const row: Row = {
    target,
    place: {kind: 'switch', namespace: 'plugins', id: pluginId},
  };
  const on = switchedOn(ctx.settings, target, section);

  return (
    <>
      <SubHeader
        back={character.displayName}
        onBack={() => {
          ctx.session.goTo({kind: 'character', characterId});
        }}
        title={section.displayName}
      />
      <Group
        {...(section.page === undefined ? {} : {footer: section.page.summary})}
      >
        <Cell kind="switch" problems={problemsAt(ctx, row)}>
          <Label name={section.displayName} />
          <Switch
            on={on}
            label={section.displayName}
            onToggle={() => {
              void ctx.session.choose(row, !on);
            }}
          />
        </Cell>
      </Group>
      {on ? <LayoutCards ctx={ctx} target={target} section={section} /> : null}
    </>
  );
}

/** Her own AI model: the model always, and each other part of it she holds a value of her own for. */
export function CharacterModelPage({
  ctx,
  characterId,
}: {
  readonly ctx: Ctx;
  readonly characterId: string;
}) {
  const character = characterOf(ctx, characterId);
  const view = viewOf(ctx.settings, characterTarget(characterId));

  if (character === undefined || view === undefined) {
    return null;
  }

  const rows = modelFields.flatMap(name => {
    const row = hostRow(characterId, name);
    const field = fieldAt(view, row.place);

    return field !== undefined &&
      (name === 'nvidiaModel' ||
        field.authored.configured ||
        problemsAt(ctx, row).length > 0)
      ? [{row, field}]
      : [];
  });

  return (
    <>
      <SubHeader
        back={character.displayName}
        onBack={() => {
          ctx.session.goTo({kind: 'character', characterId});
        }}
        title={`AI Model for ${character.displayName}`}
      />
      <Group
        footer={`Only for ${character.displayName}. Empty uses your settings.`}
      >
        {rows.map(({row, field}) =>
          field.name === 'roleModelProvider' ? (
            <ServiceRow key={field.name} ctx={ctx} row={row} field={field} />
          ) : (
            <FieldRow key={field.name} ctx={ctx} row={row} field={field} />
          ),
        )}
      </Group>
    </>
  );
}
