/**
 * Her phone's window, as the approved design draws it: a bar saying whose
 * phone it is, that the person is watching, and a way to close the window,
 * which in a window without a frame of its own also moves the window and
 * keeps it on top of others; her phone, or a sentence in its place saying
 * why it cannot be shown; and a line under it saying what she last did. It
 * holds no rule: what it shows comes from the window's store, and what the
 * person does goes to the session.
 */
import {useEffect, useState, useSyncExternalStore} from 'react';

import {AddressRefused} from './app.tsx';
import {lineOf} from './phone.ts';
import {PhoneDevice} from './phone-device.tsx';
import type {PhoneSession} from './phone-session.ts';
import {Face, Icon} from './settings-controls.tsx';

export function PhoneWindow({session}: {readonly session: PhoneSession}) {
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const now = useNow(1000);
  const {connection, name, frame} = state;
  const said =
    connection.status === 'refused' ? (
      <AddressRefused message={connection.message} />
    ) : (
      state.unread
    );
  const line = lineOf(state, now);

  useEffect(() => {
    if (name !== undefined) {
      document.title = `${name}'s Phone`;
    }
  }, [name]);

  return (
    <div className="phone-window">
      <header
        className={`phone-bar${frame === undefined ? '' : ' phone-bar-moves'}`}
        onMouseDown={
          frame === undefined
            ? undefined
            : event => {
                // The bar moves the window, but for its buttons.
                if (
                  event.button === 0 &&
                  !(
                    event.target instanceof Element &&
                    event.target.closest('button') !== null
                  )
                ) {
                  event.preventDefault();
                  session.startDragging();
                }
              }
        }
      >
        {name === undefined ? null : (
          <>
            <Face id={state.characterId} name={name} size="bar" />
            <h1 className="phone-bar-title">{`${name}'s Phone`}</h1>
          </>
        )}
        {said === undefined ? (
          <span className="phone-watching">
            <Icon name="eye" size={13} />
            Watching
          </span>
        ) : null}
        {frame === undefined ? null : (
          <button
            type="button"
            className="phone-pin"
            aria-label="Keep on top of other windows"
            aria-pressed={frame.pinned}
            onClick={() => {
              session.pin(!frame.pinned);
            }}
          >
            <Icon name="pin" size={15} />
          </button>
        )}
        <button
          type="button"
          className="phone-close"
          aria-label="Close her phone"
          onClick={session.close}
        >
          <Icon name="cross" size={19} weight={1.65} />
        </button>
      </header>
      {said === undefined ? (
        <PhoneDevice state={state} now={now} session={session} />
      ) : (
        <p className="phone-said" role="status">
          {said}
        </p>
      )}
      {line === undefined ? null : (
        <p className="phone-line">
          <span
            className={`phone-line-dot${line.lit ? ' phone-line-dot-lit' : ''}`}
            aria-hidden="true"
          />
          <span className="phone-line-what">{line.what}</span>
          {line.when === undefined ? null : <span>{line.when}</span>}
        </p>
      )}
    </div>
  );
}

/** The moment now, again every `period` milliseconds while the window is drawn. */
function useNow(period: number): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, period);

    return () => {
      clearInterval(timer);
    };
  }, [period]);

  return now;
}
