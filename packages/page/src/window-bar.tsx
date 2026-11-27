/**
 * The bar of a window of hers, her phone's and her world's, as the
 * approved design draws it: a capsule floating over the window's panel,
 * with what the window shows at its start, its name, what the window says
 * beside the name, and at its end who it is about and a cross that closes
 * the window. In a window without a frame of its own, which the desktop
 * app draws, the bar moves the window, but for its buttons, and a pin keeps
 * it on top of other windows. It holds no rule: what it shows comes from
 * the window's store, and what the person does goes to the window's
 * session.
 */
import type {ReactNode} from 'react';

import type {Frame} from './her-windows.ts';
import {Icon} from './settings-controls.tsx';
import type {FrameVerbs} from './window-link.ts';

export function WindowBar({
  lead,
  title,
  beside,
  end,
  frame,
  verbs,
  closeLabel,
}: {
  /** What the window shows, at the bar's start: her face, or her world's tile. */
  readonly lead?: ReactNode;
  readonly title?: string | undefined;
  /** What the window says beside its name. */
  readonly beside?: ReactNode;
  /** Who it is about, at the bar's end, before its buttons. */
  readonly end?: ReactNode;
  readonly frame?: Frame | undefined;
  readonly verbs: FrameVerbs;
  readonly closeLabel: string;
}) {
  return (
    <header
      className={`ui-bar${frame === undefined ? '' : ' ui-bar-moves'}`}
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
                verbs.startDragging();
              }
            }
      }
    >
      {lead}
      {title === undefined ? null : (
        <h1 className="ui-bar-title ui-label">{title}</h1>
      )}
      {beside}
      <span className="ui-bar-end">
        {end}
        {frame === undefined ? null : (
          <button
            type="button"
            className="ui-round"
            aria-label="Keep on top of other windows"
            aria-pressed={frame.pinned}
            onClick={() => {
              verbs.pin(!frame.pinned);
            }}
          >
            <Icon name="pin" size={15} />
          </button>
        )}
        <button
          type="button"
          className="ui-round"
          aria-label={closeLabel}
          onClick={verbs.close}
        >
          <Icon name="cross" size={16} weight={2.1} />
        </button>
      </span>
    </header>
  );
}
