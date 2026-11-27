/**
 * Her phone's window, as the approved design draws it: the bar of a window
 * of hers, saying whose phone it is and that the person is watching; her
 * phone, or a sentence in its place saying why it cannot be shown; and a
 * line under it saying what she last did. It holds no rule: what it shows
 * comes from the window's store, and what the person does goes to the
 * session.
 */
import {useEffect, useState, useSyncExternalStore} from 'react';

import {AddressRefused} from './app.tsx';
import {lineOf} from './phone.ts';
import {PhoneDevice} from './phone-device.tsx';
import type {PhoneSession} from './phone-session.ts';
import {Face, Icon} from './settings-controls.tsx';
import {WindowBar} from './window-bar.tsx';

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
      <WindowBar
        lead={
          name === undefined ? undefined : (
            <Face id={state.characterId} name={name} size="bar" />
          )
        }
        title={name === undefined ? undefined : `${name}'s Phone`}
        beside={
          said === undefined ? (
            <span className="ui-badge ui-badge-quiet phone-watching">
              <Icon name="eye" size={13} />
              <span>Watching</span>
            </span>
          ) : undefined
        }
        frame={frame}
        verbs={session}
        closeLabel="Close her phone"
      />
      {said === undefined ? (
        <PhoneDevice state={state} now={now} session={session} />
      ) : (
        <div className="ui-panel phone-said">
          <p role="status">{said}</p>
        </div>
      )}
      {line === undefined ? null : (
        <p className="phone-line">
          <span
            className={`phone-line-dot${line.lit ? ' phone-line-dot-lit' : ''}`}
            aria-hidden="true"
          />
          <span className="phone-line-what">{line.what}</span>
          {line.when === undefined ? null : (
            <span className="phone-line-when">{line.when}</span>
          )}
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
