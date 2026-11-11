/**
 * Her phone, as the approved design draws it: the bezel; the person's own
 * clock at the top; her home screen, a view of an app in the pieces her
 * phone knows with its views as tabs under it, or, over everything, what
 * rings; and the bar at the bottom, which goes to her home screen. It
 * holds no rule: what it draws comes from the window's store, and what the
 * person opens goes to the session. Nothing here changes anything of hers:
 * a switch is drawn, never pressed.
 */
import {useEffect, useState} from 'react';

import type {
  LiveReading,
  PhoneApp,
  PhoneRing,
  ScreenItem,
  ScreenRow,
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
          <span
            className={`phone-app-icon tint-${tintOf(app.tint)}`}
            aria-hidden="true"
          >
            <Icon name={iconOf(app.icon)} size={30} weight={1.7} />
          </span>
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
  const title =
    app.views.find(candidate => candidate.id === viewId)?.title ?? app.name;

  return (
    <>
      <div className="phone-view">
        <h2 className="phone-view-title">{title}</h2>
        <div className="phone-pieces">
          {view.message === undefined ? (
            view.screen?.items.map((item, at) => (
              <Piece key={at} item={item} fresh={view.fresh} />
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

function Piece({
  item,
  fresh,
}: {
  readonly item: ScreenItem;
  readonly fresh: ReadonlySet<string>;
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
              <Row key={at} row={row} fresh={fresh.has(rowKey(row))} />
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
      return <p className="phone-quiet">{item.text}</p>;
  }
}

/**
 * A row: the small line above, its title or else its clock reading, the
 * small line below, and at its end a clock reading beside a title, a value
 * and a switch. A row whose switch is off is dimmed, and one that is new
 * since she did something is tinted and says so.
 */
function Row({row, fresh}: {readonly row: ScreenRow; readonly fresh: boolean}) {
  // A row has a title, a time or both: a time beside a title goes to its end.
  const end = row.title === undefined ? undefined : row.time;

  return (
    <div
      className={`phone-row${end === undefined ? '' : ' phone-row-timed'}${row.switch === false ? ' phone-row-off' : ''}${fresh ? ' phone-row-fresh' : ''}`}
    >
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
      {row.value === undefined ? null : (
        <span className="phone-row-value">{row.value}</span>
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
