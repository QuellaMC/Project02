/**
 * A character's pages: hers, with her switch, what makes up her mind and
 * body, her heartbeat, the language she speaks, her apps, her bot, what
 * she may do and what is hers alone; a plugin's own page for her; her own
 * AI model; and her Translation Notes. Each draws her view, and writes
 * only what her view lists.
 */
import {useState} from 'react';

import type {CharacterSummary} from '@project02/wire/contract';
import {hasPhone, herPhoneRow} from './her-apps.ts';
import {HerApps} from './settings-apps.tsx';
import {
  Arrow,
  BackButton,
  Cell,
  Chevron,
  Face,
  Group,
  Icon,
  Label,
  LinkCell,
  PageHeader,
  SubHeader,
  Switch,
  TextBox,
  Tile,
} from './settings-controls.tsx';
import {
  FieldRow,
  LayoutCards,
  LinesGroup,
  MenuRow,
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
  labelOf,
  ownModelExtras,
  ownModelRows,
  serviceChoice,
  setupPage,
  switchedOn,
  telegramOn,
  valueNow,
  type BotWords,
} from './settings-model.ts';
import {
  characterTarget,
  fieldAt,
  home,
  hostRow,
  sectionOf,
  targetKey,
  viewOf,
  type OkView,
  type Row,
  type Section,
} from './settings.ts';
import type {SettingsPage} from './store.ts';
import {
  languageName,
  mostNotes,
  noteLimit,
  notesHeld,
  notesShown,
  notesText,
  toneLimit,
  toneRow,
  wordsRow,
  type Note,
} from './translator.ts';

function characterOf(
  ctx: Ctx,
  characterId: string,
): CharacterSummary | undefined {
  return ctx.state.health?.characters.find(
    character => character.id === characterId,
  );
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

  const row = hostRow(target, 'enabled');
  const enabled = view === undefined ? undefined : fieldAt(view, row.place);
  const on =
    enabled === undefined
      ? character.enabled
      : valueNow(ctx.settings, row, enabled) === 'true';

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
  const row = hostRow(characterTarget(character.id), 'enabled');
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
      <HerLanguage ctx={ctx} character={character} />
      <HerApps ctx={ctx} characterId={character.id} view={view} />
      <Group title="Telegram">
        <HerBot ctx={ctx} characterId={character.id} />
      </Group>
      <HerPermissions ctx={ctx} characterId={character.id} view={view} />
      <HerOwn ctx={ctx} character={character} view={view} />
    </>
  );
}

/**
 * What she may ask the person for: each plugin placed among her
 * permissions, a switch of hers, and while her settings give her a phone,
 * her phone's Ask to Install Apps.
 */
function HerPermissions({
  ctx,
  characterId,
  view,
}: {
  readonly ctx: Ctx;
  readonly characterId: string;
  readonly view: OkView;
}) {
  const target = characterTarget(characterId);
  const permissions = featuresPlaced(view, 'permission');
  const install = herPhoneRow(characterId, 'askToInstall');
  const installField = hasPhone(view)
    ? fieldAt(view, install.place)
    : undefined;

  return permissions.length === 0 && installField === undefined ? null : (
    <Group
      title="Permissions"
      footer={
        installField === undefined
          ? 'You approve each change she asks for.'
          : 'You approve each change or app she asks for.'
      }
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
      {installField === undefined ? null : (
        <FieldRow
          ctx={ctx}
          row={install}
          field={installField}
          leading={<Tile icon="download" tint="gray" />}
        />
      )}
    </Group>
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
  const row = hostRow(characterTarget(characterId), 'heartbeat');
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

/**
 * For a character who speaks another language than the person: what she
 * speaks, under its own name in its own letterforms, and her Translation
 * Notes, with how many words and phrases she has when she has any.
 */
function HerLanguage({
  ctx,
  character,
}: {
  readonly ctx: Ctx;
  readonly character: CharacterSummary;
}) {
  const {id, language} = character;
  const notes = notesHeld(ctx.settings, id).length;

  return language === undefined ? null : (
    <Group
      title="Language"
      footer="Her words show with a translation under them, and yours reach her in her language. She never sees any of it."
    >
      <Cell>
        <Label name="Speaks" />
        <span className="value value-label" lang={language}>
          {languageName(language)}
        </span>
      </Cell>
      <LinkCell
        {...(notes === 0 ? {} : {value: String(notes)})}
        onClick={() => {
          ctx.session.goTo({kind: 'translation-notes', characterId: id});
        }}
      >
        <Label name="Translation Notes" />
      </LinkCell>
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
 * What is hers alone, under Advanced: her own AI model, by its service,
 * Custom while she holds only other parts of one, or the same as
 * everyone's, and what she calls the person. Shown while the Advanced
 * switch is on, and a row she holds a value for shows without it.
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
  const target = characterTarget(character.id);
  const service = serviceChoice(ctx.settings, target).chosen;
  const custom = ownModelExtras(ctx.settings, character.id).length > 0;
  const callsYouRow = hostRow(target, 'userDisplayName');
  const callsYou = fieldAt(view, callsYouRow.place);
  const showModel = advanced || service !== undefined || custom;
  const showName =
    callsYou !== undefined && (advanced || callsYou.authored.configured);

  if (!showModel && !showName) {
    return null;
  }

  return (
    <Group
      title="Advanced"
      footer={`Only for ${character.displayName}. Empty uses your settings.`}
    >
      {showModel ? (
        <LinkCell
          value={service?.name ?? (custom ? 'Custom' : 'Same as Everyone')}
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
          row={callsYouRow}
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

/**
 * Her own AI model: the service, Same as Everyone naming the one every
 * character thinks with, or one of the services connected; and with a
 * service of her own, its model. Same as Everyone takes away her service
 * and every model of her own, so none stands in for what everyone uses.
 * Under them, whatever else of it she holds a value of her own for, each
 * to be seen and taken away.
 */
export function CharacterModelPage({
  ctx,
  characterId,
}: {
  readonly ctx: Ctx;
  readonly characterId: string;
}) {
  const {settings, session} = ctx;
  const character = characterOf(ctx, characterId);
  const target = characterTarget(characterId);
  const view = viewOf(settings, target);
  const row = hostRow(target, 'roleModelProvider');
  const field = view === undefined ? undefined : fieldAt(view, row.place);

  if (character === undefined || field === undefined) {
    return null;
  }

  const name = character.displayName;
  const {chosen, options, model} = serviceChoice(settings, target);
  const everyone = serviceChoice(settings, home).chosen;

  return (
    <>
      <div className="sub-header">
        <BackButton
          label={name}
          onClick={() => {
            session.goTo({kind: 'character', characterId});
          }}
        />
        <PageHeader
          art={<Tile icon="sparkle" tint="indigo" size="page" />}
          title="AI Model"
          subtitle={`What ${name} thinks with.`}
        />
      </div>
      <Group
        footer={
          chosen === undefined
            ? `${name} thinks with what every character does. Choose a service here to give her one of her own.`
            : `Only for ${name}. Everyone else keeps the one on the AI Model page.`
        }
      >
        <MenuRow
          ctx={ctx}
          row={row}
          field={field}
          value={chosen?.id}
          options={options}
          none={
            everyone === undefined
              ? 'Same as Everyone'
              : `Same as Everyone (${everyone.name})`
          }
          onChoose={value => {
            if (value !== undefined) {
              void session.choose(row, value);

              return;
            }

            for (const own of ownModelRows(settings, characterId)) {
              void session.choose(own, undefined);
            }
          }}
        />
        {chosen === undefined || model === undefined ? null : (
          <FieldRow ctx={ctx} row={hostRow(target, model.name)} field={model} />
        )}
      </Group>
      {ownModelExtras(settings, characterId).map(held => (
        <Group
          key={held.title}
          title={held.title}
          footer={`Only for ${name}. Empty uses everyone's.`}
        >
          {held.rows.map(own => (
            <FieldRow
              key={own.field.name}
              ctx={ctx}
              row={own.row}
              field={own.field}
            />
          ))}
        </Group>
      ))}
    </>
  );
}

/**
 * How her words are put into the person's language, from her page: her
 * words and phrases, and how she sounds, each saved as any box is.
 */
export function TranslationNotesPage({
  ctx,
  characterId,
}: {
  readonly ctx: Ctx;
  readonly characterId: string;
}) {
  const character = characterOf(ctx, characterId);
  const view = viewOf(ctx.settings, characterTarget(characterId));
  const tone = toneRow(characterId);
  const toneField = view === undefined ? undefined : fieldAt(view, tone.place);

  if (character === undefined) {
    return null;
  }

  return (
    <>
      <SubHeader
        back={character.displayName}
        onBack={() => {
          ctx.session.goTo({kind: 'character', characterId});
        }}
        title="Translation Notes"
        blurb="How her words are put into your language."
      />
      {view === undefined ? null : (
        <HerWords ctx={ctx} character={character} view={view} />
      )}
      {toneField === undefined ? null : (
        <LinesGroup
          ctx={ctx}
          row={tone}
          field={toneField}
          limit={toneLimit}
          footer="Anything else the translation should keep. Notes that came with her are here too; what you change is yours."
        />
      )}
    </>
  );
}

/**
 * Her words and phrases, a row a pair: what she writes, in her language,
 * and how it is shown, each pair removable; and, while she has fewer than
 * the most, Add a Note, an empty pair with the focus in its first box.
 * What is typed is kept as the page's own until it is saved, as a box's
 * is: her settings hold the pairs both of whose boxes are filled, and a
 * pair with a box still empty stays on the page until it is.
 */
function HerWords({
  ctx,
  character,
  view,
}: {
  readonly ctx: Ctx;
  readonly character: CharacterSummary;
  readonly view: OkView;
}) {
  const {settings, session} = ctx;
  const row = wordsRow(character.id);
  const field = fieldAt(view, row.place);
  const notes = notesShown(settings, character.id);
  const [added, setAdded] = useState<number>();
  const hers =
    character.language === undefined ? {} : {lang: character.language};
  const typed = (next: readonly Note[]) => {
    session.edit(row, notesText(next));
  };
  const save = () => {
    void session.save(row);
  };

  return field === undefined ? null : (
    <Group
      title={labelOf(field)}
      footer="On the left, what she writes. On the right, how you want to read it, or a few words on what it means."
      problems={problemsAt(ctx, row)}
    >
      {notes.map((note, at) => (
        <Cell kind="pair" key={at}>
          <TextBox
            label="Her words"
            {...hers}
            limit={noteLimit}
            value={note.hers}
            focused={at === added}
            onChange={text => {
              typed(notes.with(at, {...note, hers: text}));
            }}
            onCommit={save}
          />
          <Arrow />
          <TextBox
            label="Shown as"
            limit={noteLimit}
            value={note.shown}
            onChange={text => {
              typed(notes.with(at, {...note, shown: text}));
            }}
            onCommit={save}
          />
          <button
            type="button"
            className="pair-remove"
            aria-label="Remove this note"
            onClick={() => {
              typed(notes.filter((_, other) => other !== at));
              save();
            }}
          >
            <Icon name="cross" size={18} />
          </button>
        </Cell>
      ))}
      {notes.length < mostNotes ? (
        <button
          type="button"
          className="cell cell-link"
          onClick={() => {
            setAdded(notes.length);
            typed([...notes, {hers: '', shown: ''}]);
          }}
        >
          <span className="line line-plain line-add">
            <Icon name="plus" size={17} weight={2.2} />
            <span className="label">Add a Note</span>
          </span>
        </button>
      ) : null}
    </Group>
  );
}
