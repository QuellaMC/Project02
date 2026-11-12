/**
 * Her phone, as the approved design draws it: the bezel; the person's own
 * clock at the top; her home screen, a view of an app in the pieces her
 * phone knows with its views as tabs under it, or, over everything, what
 * rings; and the bar at the bottom, which goes to her home screen. It
 * holds no rule: what it draws comes from the window's store, and what the
 * person opens goes to the session. Nothing here changes anything of hers:
 * a switch is drawn, never pressed.
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';

import type {
  LiveReading,
  PhoneApp,
  PhoneRing,
  Screen,
  ScreenCell,
  ScreenItem,
  ScreenRange,
  ScreenRow,
  ScreenTile,
} from '@project02/wire/contract';
import {avatarColor, iconOf, tintOf} from './look.ts';
import {
  clockParts,
  liveAt,
  rowKey,
  screenOf,
  type OnScreen,
  type PhoneState,
} from './phone.ts';
import type {PhoneSession} from './phone-session.ts';
import {Icon} from './settings-controls.tsx';

type View = Extract<OnScreen, {kind: 'view'}>;
type ReadoutItem = Extract<ScreenItem, {kind: 'readout'}>;
type AppItem = Extract<ScreenItem, {kind: 'app'}>;
type GlanceItem = Extract<ScreenItem, {kind: 'glance'}>;
type FieldItem = Extract<ScreenItem, {kind: 'field'}>;

/** An app's tile at each size her phone draws one: its icon's size and its stroke there. */
const tileGlyphs = {
  home: {size: 30, weight: 1.7},
  row: {size: 24, weight: 1.7},
  header: {size: 40, weight: 1.6},
} as const;

/** The length of the ring a timer's readout is drawn in, whose radius is 100. */
const ringLength = 2 * Math.PI * 100;

export function PhoneDevice({
  state,
  now,
  session,
}: {
  readonly state: PhoneState;
  readonly now: number;
  readonly session: PhoneSession;
}) {
  const drawn = screenOf(state);
  // The bar takes the tabs' card under an app's views, her colour at home.
  const tabbed = drawn.kind === 'view' && drawn.app.views.length > 1;

  return (
    <div className="phone">
      <div
        className="phone-screen"
        style={
          drawn.kind === 'home'
            ? {
                background: `color-mix(in srgb, ${avatarColor(state.characterId)} var(--wall-mix), var(--bg))`,
              }
            : undefined
        }
      >
        <div className="phone-status">{clockParts(clockTime(now)).digits}</div>
        <Drawn drawn={drawn} session={session} />
        {drawn.kind === 'blank' || drawn.kind === 'ringing' ? (
          <span className="phone-home-bar" aria-hidden="true">
            <span className="phone-home-indicator" />
          </span>
        ) : (
          <button
            type="button"
            className={`phone-home-bar${tabbed ? ' phone-home-bar-tabbed' : ''}`}
            aria-label="Home"
            onClick={session.goHome}
          >
            <span className="phone-home-indicator" />
          </button>
        )}
      </div>
    </div>
  );
}

function Drawn({
  drawn,
  session,
}: {
  readonly drawn: OnScreen;
  readonly session: PhoneSession;
}) {
  switch (drawn.kind) {
    case 'blank':
      return <div className="phone-blank" />;
    case 'ringing':
      return <Ringing ring={drawn.ring} />;
    case 'home':
      return <Home apps={drawn.apps} session={session} />;
    case 'view':
      return <AppView view={drawn} session={session} />;
  }
}

/** Her apps, four to a row: each opens for the person on the view it opens on. */
function Home({
  apps,
  session,
}: {
  readonly apps: readonly PhoneApp[];
  readonly session: PhoneSession;
}) {
  return (
    <div className="phone-home">
      {apps.map(app => (
        <button
          key={app.id}
          type="button"
          className="phone-app"
          onClick={() => {
            session.look(app.id, app.opensOn);
          }}
        >
          <AppTile tile={app} size="home" />
          <span className="phone-app-name">{app.name}</span>
        </button>
      ))}
    </div>
  );
}

/** A view of an app: its title large, its pieces, and the app's views as tabs when it has more than one. */
function AppView({
  view,
  session,
}: {
  readonly view: View;
  readonly session: PhoneSession;
}) {
  const {app, viewId} = view;
  const pieces = useRef<HTMLDivElement>(null);
  const title =
    app.views.find(candidate => candidate.id === viewId)?.title ?? app.name;

  // A glance at the head of a screen names what the view shows, as the
  // design heads a place's weather: the view's own title over it would
  // say it twice.
  const headed =
    view.message === undefined && view.screen?.items[0]?.kind === 'glance';

  useConversationEnd(pieces, view.screen);

  return (
    <>
      <div className="phone-view">
        {headed ? null : <h2 className="phone-view-title">{title}</h2>}
        <div ref={pieces} className="phone-pieces">
          {view.message === undefined ? (
            view.screen?.items.map((item, at, items) => (
              <Piece
                key={at}
                item={item}
                heads={at === 0}
                alone={items.length === 1}
                fresh={view.fresh}
                waiting={view.waiting}
              />
            ))
          ) : (
            <p className="phone-quiet">{view.message}</p>
          )}
        </div>
      </div>
      {app.views.length > 1 ? (
        <nav className="phone-tabs" aria-label={app.name}>
          {app.views.map(tab => (
            <button
              key={tab.id}
              type="button"
              className="phone-tab"
              aria-current={tab.id === viewId ? 'page' : undefined}
              onClick={() => {
                session.look(app.id, tab.id);
              }}
            >
              <Icon name={iconOf(tab.icon)} size={22} weight={1.7} />
              <span className="phone-tab-title">{tab.title}</span>
            </button>
          ))}
        </nav>
      ) : null}
    </>
  );
}

/**
 * A piece of a screen. Text alone on its screen is a quiet line in the
 * middle of it, as a view with nothing in it yet says so, and among other
 * pieces a paragraph. A row or an app's header carrying the id of an app
 * she waits on the person to install says so in place of its status. A
 * bubble stands at the side of whom it is from.
 */
function Piece({
  item,
  heads,
  alone,
  fresh,
  waiting,
}: {
  readonly item: ScreenItem;
  /** Whether it is the first piece of its screen. */
  readonly heads: boolean;
  /** Whether it is the only piece of its screen. */
  readonly alone: boolean;
  readonly fresh: ReadonlySet<string>;
  readonly waiting: ReadonlySet<string>;
}) {
  switch (item.kind) {
    case 'list':
      return (
        <section className="phone-list">
          {item.header === undefined ? null : (
            <h3 className="phone-list-header">{item.header}</h3>
          )}
          <div className="phone-card">
            {item.rows.map((row, at) => (
              <Row
                key={at}
                row={row}
                fresh={fresh.has(rowKey(row))}
                waiting={row.id !== undefined && waiting.has(row.id)}
              />
            ))}
          </div>
        </section>
      );
    case 'readout':
      return item.live === undefined ? (
        <Readout readout={item} text={item.text} />
      ) : (
        <CountingReadout readout={item} live={item.live} />
      );
    case 'text':
      return (
        <p className={alone ? 'phone-quiet' : 'phone-text'}>{item.text}</p>
      );
    case 'app':
      return <AppHeader app={item} waiting={waiting.has(item.id)} />;
    case 'glance':
      return <Glance glance={item} heads={heads} />;
    case 'strip':
      return <Strip cells={item.cells} />;
    case 'ranges':
      return <Ranges rows={item.rows} />;
    case 'field':
      return <Field field={item} />;
    case 'note':
      return <p className="phone-note">{item.text}</p>;
    case 'bubble':
      return (
        <p className={`phone-bubble phone-bubble-${item.from}`}>{item.text}</p>
      );
  }
}

/**
 * A screen of bubbles shows its end, the newest, as a chat does: the view
 * scrolls there as it opens and as what it says changes, and a read that
 * says nothing new leaves it where the person scrolled it.
 */
function useConversationEnd(
  pieces: RefObject<HTMLDivElement | null>,
  screen: Screen | undefined,
): void {
  const said = useMemo(
    () =>
      screen?.items.some(item => item.kind === 'bubble') === true
        ? JSON.stringify(screen.items)
        : undefined,
    [screen],
  );

  useLayoutEffect(() => {
    const view = pieces.current;

    if (said !== undefined && view !== null) {
      view.scrollTop = view.scrollHeight;
    }
  }, [pieces, said]);
}

/**
 * A row: an app's tile, the small line above, its title or else its clock
 * reading, the small line below, and at its end a clock reading beside a
 * title, a value and a switch. A row whose switch is off is dimmed, one
 * that is new since she did something is tinted and says so, and an app's
 * row, which the App Store lists, says at its end how the app stands on
 * her phone, or that she waits on the person to install it. A row about a
 * page on the web draws its title as a link, which opens nothing: the
 * person watches her phone, and does not use it.
 */
function Row({
  row,
  fresh,
  waiting,
}: {
  readonly row: ScreenRow;
  readonly fresh: boolean;
  readonly waiting: boolean;
}) {
  // A row has a title, a time or both: a time beside a title goes to its end.
  const end = row.title === undefined ? undefined : row.time;
  const value = waiting ? 'Waiting' : row.value;
  const looks = [
    end === undefined ? '' : ' phone-row-timed',
    row.tile === undefined ? '' : ' phone-row-tiled',
    row.url === undefined ? '' : ' phone-row-linked',
    row.switch === false ? ' phone-row-off' : '',
    fresh ? ' phone-row-fresh' : '',
  ].join('');

  return (
    <div className={`phone-row${looks}`}>
      {row.tile === undefined ? null : <AppTile tile={row.tile} size="row" />}
      <span className="phone-row-words">
        {row.caption === undefined ? null : (
          <span className="phone-row-caption">{row.caption}</span>
        )}
        {row.title === undefined ? (
          <Clock time={row.time ?? ''} className="phone-row-time" />
        ) : (
          <span className="phone-row-title">{row.title}</span>
        )}
        {row.subtitle === undefined ? null : (
          <span className="phone-row-subtitle">{row.subtitle}</span>
        )}
        {fresh ? <span className="phone-row-new">New</span> : null}
      </span>
      {end === undefined ? null : (
        <Clock time={end} className="phone-row-end" />
      )}
      {value === undefined ? null : (
        <span className={`phone-row-value${waiting ? ' phone-waiting' : ''}`}>
          {value}
        </span>
      )}
      {row.switch === undefined ? null : (
        <span
          className={`switch-track${row.switch ? ' switch-track-on' : ''}`}
          role="img"
          aria-label={row.switch ? 'On' : 'Off'}
        >
          <span className="switch-knob" />
        </span>
      )}
    </div>
  );
}

/**
 * An app's header, as the App Store draws the app's page: its tile large,
 * its name, the line under it, and how the app stands on her phone, or
 * that she waits on the person to install it. Her phone's window does not
 * know the person's name, so it says she waits for you.
 */
function AppHeader({
  app,
  waiting,
}: {
  readonly app: AppItem;
  readonly waiting: boolean;
}) {
  return (
    <div className="phone-app-header">
      <AppTile tile={app.tile} size="header" />
      <div className="phone-app-header-words">
        <h3 className="phone-app-header-name">{app.name}</h3>
        <span className="phone-app-header-subtitle">{app.subtitle}</span>
        <span className={`phone-pill${waiting ? ' phone-waiting' : ''}`}>
          {waiting ? 'Waiting for you' : app.status}
        </span>
      </div>
    </div>
  );
}

/**
 * A thing at a glance, as the design heads a place's weather: its title,
 * its reading very large, how it is, and a quieter line under that. At the
 * head of its screen its title is the view's heading.
 */
function Glance({
  glance,
  heads,
}: {
  readonly glance: GlanceItem;
  readonly heads: boolean;
}) {
  const Title = heads ? 'h2' : 'h3';

  return (
    <div className="phone-glance">
      <Title className="phone-glance-title">{glance.title}</Title>
      <span className="phone-glance-text">{glance.text}</span>
      {glance.caption === undefined ? null : (
        <span className="phone-glance-caption">{glance.caption}</span>
      )}
      {glance.detail === undefined ? null : (
        <span className="phone-glance-detail">{glance.detail}</span>
      )}
    </div>
  );
}

/** Small readings side by side on one card, in equal columns: each a small label over its value. */
function Strip({cells}: {readonly cells: readonly ScreenCell[]}) {
  return (
    <div className="phone-card phone-strip">
      {cells.map((cell, at) => (
        <span key={at} className="phone-cell">
          <span className="phone-cell-label">{cell.label}</span>
          <span className="phone-cell-value">{cell.value}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * Rows on one card, each its label, the words of its low, a bar from
 * `from` to `to` on the scale the rows share, and the words of its high.
 * The rows share their columns too, so every bar is drawn on one track.
 */
function Ranges({rows}: {readonly rows: readonly ScreenRange[]}) {
  return (
    <div className="phone-card phone-ranges">
      {rows.map((range, at) => (
        <div key={at} className="phone-range">
          <span className="phone-range-label">{range.label}</span>
          <span className="phone-range-low">{range.low}</span>
          <span className="phone-range-track" aria-hidden="true">
            <span
              className="phone-range-bar"
              style={{
                left: `${String(range.from)}%`,
                width: `${String(range.to - range.from)}%`,
              }}
            />
          </span>
          <span className="phone-range-high">{range.high}</span>
        </div>
      ))}
    </div>
  );
}

/** What was typed into a box, such as a search's words, with the icon it names at its start. */
function Field({field}: {readonly field: FieldItem}) {
  return (
    <div className="phone-field">
      {field.icon === undefined ? null : (
        <Icon
          name={iconOf(field.icon)}
          size={16}
          weight={2}
          className="phone-field-icon"
        />
      )}
      <span className="phone-field-text">{field.text}</span>
    </div>
  );
}

/** An app's tile: its icon, white, on its tint, at the size her phone draws it there. */
function AppTile({
  tile,
  size,
}: {
  readonly tile: ScreenTile;
  readonly size: keyof typeof tileGlyphs;
}) {
  const glyph = tileGlyphs[size];

  return (
    <span
      className={`tile-solid phone-tile-${size} tint-${tintOf(tile.tint)}`}
      aria-hidden="true"
    >
      <Icon name={iconOf(tile.icon)} size={glyph.size} weight={glyph.weight} />
    </span>
  );
}

/** A clock reading: its digits large, and a day period after them smaller. */
function Clock({
  time,
  className,
}: {
  readonly time: string;
  readonly className: string;
}) {
  const {digits, period} = clockParts(time);

  return (
    <span className={className}>
      {digits}
      {period === undefined ? null : (
        <span className="phone-period">{` ${period}`}</span>
      )}
    </span>
  );
}

/** A reading that moves, counted from the moments it carries at every frame, without asking again. */
function CountingReadout({
  readout,
  live,
}: {
  readonly readout: ReadoutItem;
  readonly live: LiveReading;
}) {
  const now = useFrameNow();
  const {text, share} = liveAt(live, now);

  return <Readout readout={readout} text={text} share={share} />;
}

/** One large reading with its label and caption; counting down, ringed by what is left of its whole. */
function Readout({
  readout,
  text,
  share,
}: {
  readonly readout: ReadoutItem;
  readonly text: string;
  readonly share?: number | undefined;
}) {
  const words = (
    <>
      {readout.label === undefined ? null : (
        <span className="phone-readout-label">{readout.label}</span>
      )}
      <span className="phone-readout-text">{text}</span>
      {readout.caption === undefined ? null : (
        <span className="phone-readout-caption">{readout.caption}</span>
      )}
    </>
  );

  return share === undefined ? (
    <div className="phone-readout">{words}</div>
  ) : (
    <div className="phone-readout phone-readout-ringed">
      <svg
        viewBox="0 0 216 216"
        width="216"
        height="216"
        fill="none"
        aria-hidden="true"
      >
        <circle
          className="phone-ring-whole"
          cx="108"
          cy="108"
          r="100"
          strokeWidth="8"
        />
        {share > 0 ? (
          <circle
            className="phone-ring-left"
            cx="108"
            cy="108"
            r="100"
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={`${String(share * ringLength)} ${String(ringLength)}`}
            transform="rotate(-90 108 108)"
          />
        ) : null}
      </svg>
      <span className="phone-readout-words">{words}</span>
    </div>
  );
}

/** What rings, over everything, as the design draws an alarm: its title, the time it was set for, its body. */
function Ringing({ring}: {readonly ring: PhoneRing}) {
  return (
    <div className="phone-ringing" role="status">
      <span className="phone-ringing-badge" aria-hidden="true">
        <Icon name="alarm" size={32} weight={1.7} />
      </span>
      <span className="phone-ringing-title">{ring.title}</span>
      <span className="phone-ringing-time">
        {clockParts(clockTime(Date.parse(ring.at))).digits}
      </span>
      {ring.body === undefined ? null : (
        <span className="phone-ringing-body">{ring.body}</span>
      )}
      <span className="phone-ringing-state">Ringing</span>
    </div>
  );
}

/** A moment as the person's own clock reads it, in their language and zone. */
function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** The moment now, again at every frame the browser draws while a reading moves on screen. */
function useFrameNow(): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let frame = 0;
    const tick = (): void => {
      setNow(Date.now());
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
    };
  }, []);

  return now;
}
