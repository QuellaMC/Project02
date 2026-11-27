/**
 * Her world's window, as the approved design draws it: the bar of a window
 * of hers, with her world's name and who lives there; and on its panel the
 * view the person is on, its title and Leave Something on one line, the
 * three tabs floating at its foot, and a sheet over it all, a thing's card
 * or the sheet for leaving something; or, when her world cannot be shown,
 * the daemon's sentence in its place. Each name and note is the person's
 * form of it where it has one, and her own words stand under it where the
 * design has room: at the head of a place and of a thing's card, and under
 * a note. It holds no rule: what it shows comes from the window's store,
 * and what the person does goes to the session.
 */
import {useEffect, useSyncExternalStore} from 'react';

import type {WorldPlace, WorldThing} from '@project02/wire/contract';
import {AddressRefused} from './app.tsx';
import {tintOf, type IconName} from './look.ts';
import {
  Chevron,
  Face,
  Icon,
  RoundBack,
  SolidTile,
} from './settings-controls.tsx';
import type {Clock, Drawn} from './thread-layout.ts';
import {WindowBar} from './window-bar.tsx';
import {
  drawnWords,
  hereNow,
  isUnseen,
  journalOf,
  nowOf,
  placesOf,
  thingCard,
  toLeave,
  toRemove,
  type HerWorld,
  type Line,
  type Living,
  type Sheet,
  type Shows,
  type ThingCard,
  type WorldState,
} from './world.ts';
import type {WorldSession} from './world-session.ts';

/** The window's tabs: the view each opens, what it is called, and its icon. */
const tabs: readonly {
  readonly kind: 'now' | 'places' | 'journal';
  readonly name: string;
  readonly icon: IconName;
}[] = [
  {kind: 'now', name: 'Now', icon: 'clock'},
  {kind: 'places', name: 'Places', icon: 'mappin'},
  {kind: 'journal', name: 'Journal', icon: 'notebook'},
];

export function WorldWindow({session}: {readonly session: WorldSession}) {
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const {connection, world, frame, language} = state;
  const said =
    connection.status === 'refused' ? (
      <AddressRefused message={connection.message} />
    ) : (
      state.unread
    );
  const name =
    world === undefined ? undefined : drawnWords(world.name, language);
  const title = name?.text;

  useEffect(() => {
    if (title !== undefined) {
      document.title = title;
    }
  }, [title]);

  return (
    <div className="world-window">
      <WindowBar
        lead={
          world === undefined ? undefined : (
            <SolidTile icon="globe" tint="green" size={24} />
          )
        }
        title={title}
        titleLang={name?.lang}
        end={world === undefined ? undefined : <LivesHere world={world} />}
        frame={frame}
        verbs={session}
        closeLabel="Close her world"
      />
      <div className="ui-panel world-panel">
        {said === undefined ? (
          world === undefined ? null : (
            <Views state={state} world={world} session={session} />
          )
        ) : (
          <p className="world-said" role="status">
            {said}
          </p>
        )}
      </div>
    </div>
  );
}

/** Who lives in her world, their faces side by side. */
function LivesHere({world}: {readonly world: HerWorld}) {
  const names = world.characters.map(her => her.displayName);

  return names.length === 0 ? null : (
    <span
      className="world-faces world-faces-bar"
      role="img"
      aria-label={`${names.join(' and ')} ${names.length === 1 ? 'lives' : 'live'} here`}
    >
      {world.characters.map(her => (
        <Face key={her.id} id={her.id} name={her.displayName} size="crowd" />
      ))}
    </span>
  );
}

/** The view the person is on, the tabs, and the sheet over them, which leaves nothing under it to press. */
function Views({
  state,
  world,
  session,
}: {
  readonly state: WorldState;
  readonly world: HerWorld;
  readonly session: WorldSession;
}) {
  const {shows, sheet, language} = state;
  const {locale, timeZone} = Intl.DateTimeFormat().resolvedOptions();
  const clock: Clock = {now: Date.now(), locale, timeZone};
  const covered = sheet !== undefined;

  return (
    <>
      <div
        key={shows.kind === 'place' ? `place ${shows.placeId}` : shows.kind}
        className="ui-scroll world-scroll"
        inert={covered}
      >
        <div className="ui-top">
          {shows.kind === 'place' ? (
            <RoundBack
              label="Back to Places"
              onClick={() => {
                session.look({kind: 'places'});
              }}
            />
          ) : (
            <h2 className="ui-large">
              {tabs.find(tab => tab.kind === shows.kind)?.name}
            </h2>
          )}
          {covered ? null : (
            <button
              type="button"
              className="ui-btn ui-btn-m ui-btn-tinted"
              onClick={session.openLeave}
            >
              <Icon name="plus" size={14} weight={2.6} />
              <span className="ui-label">Leave Something</span>
            </button>
          )}
        </div>
        <View
          shows={shows}
          world={world}
          clock={clock}
          language={language}
          session={session}
        />
      </div>
      <nav
        className="ui-tabs world-tabs"
        aria-label="Her world"
        inert={covered}
      >
        {tabs.map(tab => (
          <button
            key={tab.kind}
            type="button"
            className="ui-tab"
            aria-current={
              tab.kind === shows.kind ||
              (tab.kind === 'places' && shows.kind === 'place')
                ? 'page'
                : undefined
            }
            onClick={() => {
              session.look({kind: tab.kind});
            }}
          >
            <Icon name={tab.icon} size={22} weight={1.8} />
            <span className="ui-tab-name">{tab.name}</span>
          </button>
        ))}
      </nav>
      {sheet === undefined ? null : (
        <SheetOver
          state={state}
          world={world}
          sheet={sheet}
          clock={clock}
          session={session}
        />
      )}
    </>
  );
}

/** A sheet over the panel, on its veil; Escape closes it, as its cross does. */
function SheetOver({
  state,
  world,
  sheet,
  clock,
  session,
}: {
  readonly state: WorldState;
  readonly world: HerWorld;
  readonly sheet: Sheet;
  readonly clock: Clock;
  readonly session: WorldSession;
}) {
  const {characterId, language} = state;
  const card =
    sheet.kind === 'thing'
      ? thingCard(world, characterId, sheet.thingId, clock, language)
      : undefined;
  const shown =
    sheet.kind === 'leave' ? (
      <LeaveSheet
        world={world}
        sheet={sheet}
        language={language}
        session={session}
      />
    ) : card === undefined ? undefined : (
      <ThingSheet
        world={world}
        card={card}
        sheet={sheet}
        language={language}
        session={session}
      />
    );

  return shown === undefined ? null : (
    <div
      className="ui-veil"
      onKeyDown={event => {
        if (event.key === 'Escape') {
          session.closeSheet();
        }
      }}
    >
      {shown}
    </div>
  );
}

/** What every view is drawn from: her world, the viewer's clock, the language she speaks, which her words are marked with, and the session. */
type ViewProps = {
  readonly world: HerWorld;
  readonly clock: Clock;
  readonly language: string | undefined;
  readonly session: WorldSession;
};

function View({shows, ...props}: ViewProps & {readonly shows: Shows}) {
  switch (shows.kind) {
    case 'now':
      return <NowView {...props} />;
    case 'places':
      return <PlacesView {...props} />;
    case 'place':
      return <PlaceView {...props} placeId={shows.placeId} />;
    case 'journal':
      return <JournalView {...props} />;
  }
}

/**
 * Now: a card for each place somebody is in, its head opening the place,
 * who is there since when, and what is there; the things the person left
 * that nobody living there has seen, each opening its card; and the newest
 * lines of the journal, which See All opens whole. A section with nothing
 * in it is not drawn.
 */
function NowView({world, clock, language, session}: ViewProps) {
  const {here, waiting, lately} = nowOf(world, clock, language);

  return (
    <>
      <div className="world-cards">
        {here.map(({place, living, around, more}) => (
          <div key={place.id} className="ui-card">
            <button
              type="button"
              className={`world-here-head tint-${tintOf(place.tint)}`}
              onClick={() => {
                session.look({kind: 'place', placeId: place.id});
              }}
            >
              <SolidTile icon={place.icon} tint={place.tint} size={44} />
              <Words
                className="world-here-name"
                drawn={drawnWords(place.name, language)}
              />
              <Chevron />
            </button>
            <div className="world-lined">
              <LivingRows living={living} />
            </div>
            {around.length === 0 ? null : (
              <div className="world-lined world-tokens">
                {around.map(thing => (
                  <Token key={thing.id} thing={thing} language={language} />
                ))}
                {more === 0 ? null : (
                  <span className="ui-detail">{`+${String(more)}`}</span>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      {waiting.length === 0 ? null : (
        <section className="ui-section">
          <h3 className="ui-head">Waiting to Be Found</h3>
          <div className="ui-card world-lead-28">
            {waiting.map(thing => (
              <ThingRow
                key={thing.id}
                thing={thing}
                language={language}
                unseen
                onOpen={() => {
                  session.openThing(thing.id);
                }}
              />
            ))}
          </div>
        </section>
      )}
      {lately.length === 0 ? null : (
        <section className="ui-section">
          <div className="ui-head">
            <h3>Lately</h3>
            <button
              type="button"
              className="ui-head-action"
              onClick={() => {
                session.look({kind: 'journal'});
              }}
            >
              See All
            </button>
          </div>
          <div className="ui-card world-lead-28">
            {lately.map((line, at) => (
              <LineRow key={at} line={line} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

/** Places: a card for each place in the world's order, who is there, its first things and how many more, and New when something there is not seen yet. */
function PlacesView({world, clock, language, session}: ViewProps) {
  return (
    <div className="world-cards">
      {placesOf(world, clock).map(({place, living, peek, more, fresh}) => (
        <button
          key={place.id}
          type="button"
          className="ui-card world-place"
          onClick={() => {
            session.look({kind: 'place', placeId: place.id});
          }}
        >
          <span className="world-place-head">
            <SolidTile icon={place.icon} tint={place.tint} size={44} />
            <Words
              className="world-place-name"
              drawn={drawnWords(place.name, language)}
            />
            {living.length === 0 ? null : (
              <span
                className="world-faces"
                role="img"
                aria-label={`${living.map(her => her.name).join(' and ')} ${living.length === 1 ? 'is' : 'are'} here`}
              >
                {living.map(her => (
                  <Face key={her.id} id={her.id} name={her.name} size="line" />
                ))}
              </span>
            )}
            <Chevron />
          </span>
          {peek.length === 0 ? null : (
            <span className="world-place-things">
              {peek.map(thing => (
                <Token key={thing.id} thing={thing} language={language} />
              ))}
              {more === 0 ? null : (
                <span className="ui-detail">{`+${String(more)}`}</span>
              )}
              {fresh ? <span className="ui-badge world-new">New</span> : null}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/** A place: its tile and its name, large, with her own words for it under it; who is here now; and its things, each opening its card. */
function PlaceView({
  world,
  placeId,
  clock,
  language,
  session,
}: ViewProps & {readonly placeId: string}) {
  const place = world.places.find(held => held.id === placeId);

  if (place === undefined) {
    return null;
  }

  const living = hereNow(world, placeId, clock);
  const name = drawnWords(place.name, language);

  return (
    <>
      <div className="world-place-top">
        <SolidTile icon={place.icon} tint={place.tint} size={56} />
        <div className="world-head-words">
          <h2 className="world-place-title" lang={name.lang}>
            {name.text}
          </h2>
          <Hers drawn={name} />
        </div>
      </div>
      {living.length === 0 ? null : (
        <section className="ui-section">
          <h3 className="ui-head">Here Now</h3>
          <div className="ui-card">
            <LivingRows living={living} />
          </div>
        </section>
      )}
      <PlaceThings
        place={place}
        world={world}
        language={language}
        session={session}
      />
    </>
  );
}

function PlaceThings({
  place,
  world,
  language,
  session,
}: {
  readonly place: WorldPlace;
  readonly world: HerWorld;
  readonly language: string | undefined;
  readonly session: WorldSession;
}) {
  return place.things.length === 0 ? null : (
    <section className="ui-section">
      <h3 className="ui-head">Things</h3>
      <div className="ui-card world-lead-28">
        {place.things.map(thing => (
          <ThingRow
            key={thing.id}
            thing={thing}
            language={language}
            unseen={isUnseen(world, thing)}
            chevron
            onOpen={() => {
              session.openThing(thing.id);
            }}
          />
        ))}
      </div>
    </section>
  );
}

/** The journal, by day, newest first. */
function JournalView({world, clock, language}: ViewProps) {
  return journalOf(world, clock, language).map(({day, lines}) => (
    <section key={day} className="ui-section">
      <h3 className="ui-head">{day}</h3>
      <div className="ui-card world-lead-28">
        {lines.map((line, at) => (
          <LineRow key={at} line={line} />
        ))}
      </div>
    </section>
  ));
}

/** Each character there: her face, her name, and since when. */
function LivingRows({living}: {readonly living: readonly Living[]}) {
  return living.map(her => (
    <div key={her.id} className="ui-row world-living">
      <Face id={her.id} name={her.name} size="line" />
      <span className="world-name">{her.name}</span>
      <span className="ui-value">{her.since}</span>
    </div>
  ));
}

/** A thing among others: its round tile and its name. */
function Token({
  thing,
  language,
}: {
  readonly thing: WorldThing;
  readonly language: string | undefined;
}) {
  return (
    <span className="ui-token">
      <SolidTile icon={thing.icon} tint={thing.tint} size={22} />
      <Words className="ui-label" drawn={drawnWords(thing.name, language)} />
    </span>
  );
}

/** A thing as a row, opening its card: its tile, its name, and whether it is not seen yet. */
function ThingRow({
  thing,
  language,
  unseen,
  chevron = false,
  onOpen,
}: {
  readonly thing: WorldThing;
  readonly language: string | undefined;
  readonly unseen: boolean;
  readonly chevron?: boolean;
  readonly onOpen: () => void;
}) {
  return (
    <button type="button" className="ui-row" onClick={onOpen}>
      <SolidTile icon={thing.icon} tint={thing.tint} size={28} />
      <Words className="world-name" drawn={drawnWords(thing.name, language)} />
      {unseen ? <span className="ui-badge">Not seen yet</span> : null}
      {chevron ? <Chevron /> : null}
    </button>
  );
}

/** A line of the journal: who, what happened with the name in semibold, and when. A reader of the screen hears who it was. */
function LineRow({line}: {readonly line: Line}) {
  const {who} = line;

  return (
    <div className="ui-row">
      {who.kind === 'character' ? (
        <Face id={who.id} name={who.name} size="line" />
      ) : who.kind === 'person' ? (
        <span className="face face-line world-you" aria-hidden="true">
          <Icon name="person" size={16} weight={2} />
        </span>
      ) : (
        <SolidTile icon="globe" tint="green" size={28} />
      )}
      <span className="world-name">
        <span className="visually-hidden">{`${who.name}: `}</span>
        {`${line.what} `}
        <b lang={line.name.lang}>{line.name.text}</b>
      </span>
      <span className="ui-value">{line.when}</span>
    </div>
  );
}

/**
 * A thing's card: its tile and its name, her own words for it under it; its
 * note, when it has one, hers under it past a hairline; its facts; and the
 * one button, Remove from her world, which asks again in place before it
 * removes, and says above it why it could not.
 */
function ThingSheet({
  world,
  card,
  sheet,
  language,
  session,
}: {
  readonly world: HerWorld;
  readonly card: ThingCard;
  readonly sheet: Extract<Sheet, {readonly kind: 'thing'}>;
  readonly language: string | undefined;
  readonly session: WorldSession;
}) {
  const {thing, name, note, facts} = card;

  return (
    <div
      className="ui-sheet"
      role="dialog"
      aria-modal="true"
      aria-label={name.text}
    >
      <div className="ui-sheet-head">
        <span className="ui-grabber" aria-hidden="true" />
        <span />
        <span />
        <button
          type="button"
          className="ui-round"
          aria-label="Close"
          autoFocus
          onClick={session.closeSheet}
        >
          <Icon name="cross" size={16} weight={2.1} />
        </button>
      </div>
      <div className="world-thing-top">
        <SolidTile icon={thing.icon} tint={thing.tint} size={56} />
        <div className="world-head-words">
          <h2 className="world-thing-name" lang={name.lang}>
            {name.text}
          </h2>
          <Hers drawn={name} />
        </div>
      </div>
      {note === undefined ? null : (
        <div className="ui-card world-note">
          <p lang={note.lang}>{note.text}</p>
          {note.translation === undefined ? null : (
            <p className="world-note-hers" lang={note.translation.lang}>
              {note.translation.text}
            </p>
          )}
        </div>
      )}
      <div className="ui-card world-facts">
        {facts.map(fact => (
          <div key={fact.label} className="ui-row world-fact">
            <span>{fact.label}</span>
            <Words className="world-fact-value" drawn={fact.value} />
          </div>
        ))}
      </div>
      <Problem problem={sheet.problem} />
      {sheet.confirming ? (
        <div className="world-sheet-end world-confirm">
          <button
            type="button"
            className="ui-btn ui-btn-card"
            disabled={sheet.sending}
            onClick={session.keep}
          >
            <span className="ui-label">Cancel</span>
          </button>
          <button
            type="button"
            className="ui-btn ui-btn-filled ui-btn-danger"
            disabled={toRemove(sheet) === undefined}
            onClick={session.remove}
          >
            <span className="ui-label">Remove</span>
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="ui-btn ui-btn-wide ui-btn-card ui-btn-danger world-sheet-end"
          onClick={session.remove}
        >
          <span className="ui-label">
            {'Remove from '}
            <Words drawn={drawnWords(world.name, language)} />
          </span>
        </button>
      )}
    </div>
  );
}

/**
 * Leaving something: its name, in a large box; its kind, among the
 * world's, as tiles; where, among the places, as chips; a note; and the one
 * button, which leaves it there once it has a name, and says above it what
 * the daemon refused.
 */
function LeaveSheet({
  world,
  sheet,
  language,
  session,
}: {
  readonly world: HerWorld;
  readonly sheet: Extract<Sheet, {readonly kind: 'leave'}>;
  readonly language: string | undefined;
  readonly session: WorldSession;
}) {
  const {draft} = sheet;
  const place = world.places.find(held => held.id === draft.place);

  return (
    <form
      className="ui-sheet"
      role="dialog"
      aria-modal="true"
      aria-label="Leave Something"
      onSubmit={event => {
        event.preventDefault();
        session.leave();
      }}
    >
      <div className="ui-sheet-head">
        <span className="ui-grabber" aria-hidden="true" />
        <button
          type="button"
          className="ui-round"
          aria-label="Cancel"
          onClick={session.closeSheet}
        >
          <Icon name="cross" size={16} weight={2.1} />
        </button>
        <h2 className="ui-sheet-title">Leave Something</h2>
        <span />
      </div>
      <input
        type="text"
        className="ui-field ui-field-big world-what"
        aria-label="What it is"
        placeholder="What is it?"
        autoComplete="off"
        autoFocus
        maxLength={128}
        value={draft.name}
        onChange={event => {
          session.draft({name: event.currentTarget.value});
        }}
      />
      <section className="ui-section" role="group" aria-label="Kind">
        <h3 className="ui-head">Kind</h3>
        <div className="ui-card world-kinds">
          {world.kinds.map(kind => (
            <button
              key={kind.id}
              type="button"
              className="world-kind"
              aria-pressed={kind.id === draft.kind}
              onClick={() => {
                session.draft({kind: kind.id});
              }}
            >
              <SolidTile icon={kind.icon} tint={kind.tint} size={40} />
              <span className="world-kind-name">{kind.name}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="ui-section" role="group" aria-label="Where">
        <h3 className="ui-head">Where</h3>
        <div className="ui-chips world-wheres">
          {world.places.map(held => (
            <button
              key={held.id}
              type="button"
              className="ui-chip ui-chip-led"
              aria-pressed={held.id === draft.place}
              onClick={() => {
                session.draft({place: held.id});
              }}
            >
              <SolidTile icon={held.icon} tint={held.tint} size={22} />
              <Words
                className="ui-label"
                drawn={drawnWords(held.name, language)}
              />
            </button>
          ))}
        </div>
      </section>
      <textarea
        className="ui-area world-note-box"
        aria-label="A note with it"
        placeholder="Add a note"
        maxLength={280}
        value={draft.note}
        onChange={event => {
          session.draft({note: event.currentTarget.value});
        }}
      />
      <Problem problem={sheet.problem} />
      <button
        type="submit"
        className="ui-btn ui-btn-wide ui-btn-filled world-sheet-end"
        disabled={toLeave(sheet) === undefined}
      >
        <span className="ui-label">
          {'Leave It in '}
          {place === undefined ? null : (
            <Words drawn={drawnWords(place.name, language)} />
          )}
        </span>
      </button>
    </form>
  );
}

/** A name or a note on one line, as the person reads it, marked with her language when it is in hers. */
function Words({
  drawn,
  className,
}: {
  readonly drawn: Drawn;
  readonly className?: string;
}) {
  return (
    <span className={className} lang={drawn.lang}>
      {drawn.text}
    </span>
  );
}

/** Her own words under the person's form of them, a size smaller in the secondary colour, where there are both. */
function Hers({drawn}: {readonly drawn: Drawn}) {
  return drawn.translation === undefined ? null : (
    <p className="world-hers" lang={drawn.translation.lang}>
      {drawn.translation.text}
    </p>
  );
}

/** What the daemon refused, or why it failed, in its own sentence, above the sheet's button. */
function Problem({problem}: {readonly problem: string | undefined}) {
  return problem === undefined ? null : (
    <p className="world-problem" role="alert">
      {problem}
    </p>
  );
}
