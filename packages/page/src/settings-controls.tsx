/**
 * The settings window's own controls, each drawn as the approved design
 * draws it: icons and tiles, avatars, the switch, the boxes a value is
 * typed or pasted into, the segmented control, pills, a select, and the
 * cards and rows they sit in; and the icons, solid tiles, faces and the way
 * back that her windows draw too. They hold no rule: what each shows comes
 * from the settings model, or a window's, and each reports a change through
 * the props it is given.
 */
import {useRef, useState, type ReactNode} from 'react';

import {
  avatarColor,
  iconOf,
  iconPath,
  initialOf,
  tintOf,
  type IconName,
  type Tint,
} from './look.ts';
import type {Option} from './settings-model.ts';

export function Icon({
  name,
  size,
  weight = 1.9,
  className,
}: {
  readonly name: IconName;
  readonly size: number;
  readonly weight?: number;
  readonly className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={weight}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d={iconPath(name)} />
    </svg>
  );
}

/** A tile's icon at each size a tile is drawn: its size, and its stroke, finer on a large tile. */
const tileGlyphs = {
  side: {size: 15, weight: 1.9},
  row: {size: 17, weight: 1.9},
  note: {size: 15, weight: 1.9},
  chip: {size: 15, weight: 1.9},
  app: {size: 24, weight: 1.7},
  page: {size: 27, weight: 1.7},
  welcome: {size: 30, weight: 1.7},
} as const;

/** An icon on its tint's tile, at a row's size, the sidebar's, an app's on her page or a page header's. */
export function Tile({
  icon,
  tint,
  size = 'row',
}: {
  readonly icon: IconName;
  readonly tint: Tint;
  readonly size?: keyof typeof tileGlyphs;
}) {
  const glyph = tileGlyphs[size];

  return (
    <span className={`tile tile-${size} tint-${tint}`} aria-hidden="true">
      <Icon name={icon} size={glyph.size} weight={glyph.weight} />
    </span>
  );
}

/** A solid tile's icon at each size a window draws one: its size, and its stroke, finer on a larger tile. */
const solidGlyphs = {
  22: {size: 13, weight: 2},
  24: {size: 15, weight: 1.9},
  28: {size: 16, weight: 1.9},
  40: {size: 22, weight: 1.7},
  44: {size: 24, weight: 1.7},
  56: {size: 30, weight: 1.7},
  68: {size: 36, weight: 1.6},
} as const;

/**
 * An icon white on its tint, at a size a window of hers draws a tile: an
 * app's on her phone, a place's or a thing's in her world. An icon or a
 * tint the page does not know falls back to its plainest.
 */
export function SolidTile({
  icon,
  tint,
  size,
}: {
  readonly icon: string;
  readonly tint: string;
  readonly size: keyof typeof solidGlyphs;
}) {
  const glyph = solidGlyphs[size];

  return (
    <span
      className={`tile tile-solid ui-tile-${String(size)} tint-${tintOf(tint)}`}
      aria-hidden="true"
    >
      <Icon name={iconOf(icon)} size={glyph.size} weight={glyph.weight} />
    </span>
  );
}

/** A character's initial on her colour, the same wherever she appears. */
export function Face({
  id,
  name,
  size,
}: {
  readonly id: string;
  readonly name: string;
  readonly size: 'crowd' | 'bar' | 'side' | 'line' | 'row' | 'page' | 'welcome';
}) {
  return (
    <span
      className={`face face-${size}`}
      style={{background: avatarColor(id)}}
      aria-hidden="true"
    >
      {initialOf(name)}
    </span>
  );
}

/** A person's initial on gray: the person themselves, or an account. */
export function PersonFace({
  name,
  size,
}: {
  readonly name: string;
  readonly size: 'you' | 'row' | 'page';
}) {
  return (
    <span className={`face face-${size} face-person`} aria-hidden="true">
      {initialOf(name)}
    </span>
  );
}

export function Chevron() {
  return (
    <svg
      viewBox="0 0 8 14"
      width="7"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="chevron"
    >
      <path d="M1.5 1.5L6.5 7L1.5 12.5" />
    </svg>
  );
}

/** The arrow from one word to the word it is put as. */
export function Arrow() {
  return (
    <svg
      viewBox="0 0 20 10"
      width="20"
      height="10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="arrow"
    >
      <path d="M1 5h17M14 1l4 4-4 4" />
    </svg>
  );
}

/**
 * A button that opens the system's file chooser for one file of the types
 * it accepts, and hands over the file chosen; choosing the same file again
 * is news again.
 */
export function FileButton({
  className,
  accept,
  current = false,
  onChoose,
  children,
}: {
  readonly className: string;
  /** The file chooser's own list of types, as an input's `accept` says it. */
  readonly accept: string;
  readonly current?: boolean;
  readonly onChoose: (file: File) => void;
  readonly children: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);

  return (
    <>
      <button
        type="button"
        className={className}
        aria-current={current ? 'page' : undefined}
        onClick={() => {
          input.current?.click();
        }}
      >
        {children}
      </button>
      <input
        ref={input}
        type="file"
        accept={accept}
        hidden
        onChange={event => {
          const file = event.currentTarget.files?.[0];

          event.currentTarget.value = '';

          if (file !== undefined) {
            onChoose(file);
          }
        }}
      />
    </>
  );
}

/** The way back in a window of hers: a round button, its chevron in the link's colour. */
export function RoundBack({
  label,
  onClick,
  className,
}: {
  readonly label: string;
  readonly onClick: () => void;
  /** Where the window places it. */
  readonly className?: string;
}) {
  return (
    <button
      type="button"
      className={`ui-round ui-round-link ui-round-back${className === undefined ? '' : ` ${className}`}`}
      aria-label={label}
      onClick={onClick}
    >
      <svg
        viewBox="0 0 10 18"
        width="9"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M8 2L2 9l6 7" />
      </svg>
    </button>
  );
}

export function BackButton({
  label,
  onClick,
}: {
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <button type="button" className="back" onClick={onClick}>
      <svg
        viewBox="0 0 10 18"
        width="9"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M8 2L2 9l6 7" />
      </svg>
      {label}
    </button>
  );
}

export function Switch({
  on,
  label,
  onToggle,
}: {
  readonly on: boolean;
  readonly label: string;
  readonly onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className="switch"
      onClick={onToggle}
    >
      <span className="switch-track" aria-hidden="true">
        <span className="switch-knob" />
      </span>
    </button>
  );
}

/**
 * The green check in a box: for a moment after a change landed, keyed by
 * that change so the next one shows it again, or steady while a key is
 * stored.
 */
export function Check({
  steady = false,
  select = false,
}: {
  readonly steady?: boolean;
  readonly select?: boolean;
}) {
  return (
    <Icon
      name="check"
      size={15}
      weight={2.4}
      className={`box-check${steady ? '' : ' box-check-fading'}${select ? ' box-check-select' : ''}`}
    />
  );
}

/** A page's header: its tile or avatar, its title, and a line under it. */
export function PageHeader({
  art,
  title,
  subtitle,
  aside,
}: {
  readonly art: ReactNode;
  readonly title: string;
  readonly subtitle?: ReactNode;
  readonly aside?: ReactNode;
}) {
  return (
    <header className="page-header">
      {art}
      <div className="page-heading">
        <h2 className="page-title">{title}</h2>
        {subtitle === undefined ? null : (
          <p className="page-subtitle">{subtitle}</p>
        )}
      </div>
      {aside}
    </header>
  );
}

/** A sub-page's header: the way back, its title, and a line under it. */
export function SubHeader({
  back,
  onBack,
  title,
  blurb,
}: {
  readonly back: string;
  readonly onBack: () => void;
  readonly title: string;
  readonly blurb?: string;
}) {
  return (
    <header className="sub-header">
      <BackButton label={back} onClick={onBack} />
      <h2 className="page-title">{title}</h2>
      {blurb === undefined ? null : <p className="page-subtitle">{blurb}</p>}
    </header>
  );
}

/** A group of rows: a title over a card, what the daemon said of the card's one value under it, and a footer under that. */
export function Group({
  title,
  titleId,
  footer,
  problems,
  children,
}: {
  readonly title?: string;
  readonly titleId?: string;
  readonly footer?: ReactNode;
  readonly problems?: readonly string[];
  readonly children: ReactNode;
}) {
  return (
    <section className="group">
      {title === undefined ? null : (
        <h3 className="group-title" id={titleId}>
          {title}
        </h3>
      )}
      <div className="panel">{children}</div>
      <Problems problems={problems} />
      {footer === undefined || footer === '' ? null : (
        <p className="group-footer">{footer}</p>
      )}
    </section>
  );
}

/** What the daemon said at a row, under it. */
export function Problems({
  problems,
}: {
  readonly problems: readonly string[] | undefined;
}) {
  return (
    <>
      {(problems ?? []).map(problem => (
        <p className="cell-problem" role="alert" key={problem}>
          {problem}
        </p>
      ))}
    </>
  );
}

/**
 * A row of a card. `field` lays a label beside a box, wrapping it under
 * the label when the window is narrow; `tall` holds a second line.
 */
export function Cell({
  kind = 'plain',
  problems,
  children,
}: {
  readonly kind?:
    'plain' | 'field' | 'switch' | 'tall' | 'person' | 'note' | 'pair';
  readonly problems?: readonly string[];
  readonly children: ReactNode;
}) {
  return (
    <div className="cell">
      <div className={`line line-${kind}`}>{children}</div>
      <Problems problems={problems} />
    </div>
  );
}

/** A row that opens something: the whole row is the button, its value and a chevron at its end. */
export function LinkCell({
  onClick,
  value,
  tone = 'plain',
  tall = false,
  children,
}: {
  readonly onClick: () => void;
  readonly value?: string;
  readonly tone?: 'link' | 'plain' | 'problem';
  /** A row whose label has a second line. */
  readonly tall?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <button type="button" className="cell cell-link" onClick={onClick}>
      <span className={`line line-plain${tall ? ' line-plain-tall' : ''}`}>
        {children}
        {value === undefined ? null : (
          <span className={`value value-${tone}`}>{value}</span>
        )}
        <Chevron />
      </span>
    </button>
  );
}

/** A row's name, with a second line under it when it has one; `strong`, the name of a row that offers to do something. */
export function Label({
  name,
  detail,
  strong = false,
}: {
  readonly name: string;
  readonly detail?: string;
  readonly strong?: boolean;
}) {
  return detail === undefined ? (
    <span className={strong ? 'label label-strong' : 'label'}>{name}</span>
  ) : (
    <span className="label label-two">
      <span className={strong ? 'label-strong' : undefined}>{name}</span>
      <span className="detail">{detail}</span>
    </span>
  );
}

/**
 * A text box. It saves when the person presses Return or leaves it, which
 * `onCommit` is told; `check` shows once a change of it landed. `focused`
 * takes the focus as it appears, for a box the person just asked for. A
 * box no label names is called `label` to a reader of the screen; `lang`
 * is the language of what is typed in it, when it is known; and it takes
 * `limit` characters at most.
 */
export function TextBox({
  id,
  label,
  lang,
  limit,
  value,
  placeholder,
  numeric = false,
  focused = false,
  check,
  onChange,
  onCommit,
}: {
  readonly id?: string;
  readonly label?: string;
  readonly lang?: string;
  readonly limit?: number;
  readonly value: string;
  readonly placeholder?: string;
  readonly numeric?: boolean;
  readonly focused?: boolean;
  readonly check?: number;
  readonly onChange: (text: string) => void;
  readonly onCommit: () => void;
}) {
  return (
    <span className="box">
      <input
        id={id}
        type="text"
        className={`input${numeric ? ' input-numeric' : ''}`}
        aria-label={label}
        lang={lang}
        maxLength={limit}
        value={value}
        placeholder={placeholder}
        inputMode={numeric ? 'numeric' : undefined}
        autoComplete="off"
        autoFocus={focused}
        onChange={event => {
          onChange(event.currentTarget.value);
        }}
        onBlur={onCommit}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.currentTarget.blur();
          }
        }}
      />
      {check === undefined ? null : <Check key={check} />}
    </span>
  );
}

/**
 * A box of several lines, which is its card, named by `labelledBy`. It
 * saves when the person leaves it, which `onCommit` is told, since Return
 * starts a new line; `check` shows once a change of it landed; and it
 * takes `limit` characters at most.
 */
export function TextLines({
  labelledBy,
  value,
  limit,
  check,
  onChange,
  onCommit,
}: {
  readonly labelledBy: string;
  readonly value: string;
  readonly limit: number;
  readonly check?: number;
  readonly onChange: (text: string) => void;
  readonly onCommit: () => void;
}) {
  return (
    <span className="lines-field">
      <textarea
        className="lines-input"
        aria-labelledby={labelledBy}
        value={value}
        maxLength={limit}
        onChange={event => {
          onChange(event.currentTarget.value);
        }}
        onBlur={onCommit}
      />
      {check === undefined ? null : <Check key={check} />}
    </span>
  );
}

/**
 * A key box is always empty: a stored key shows as dots and keeps its
 * check, and one pasted in goes when the person presses Return or leaves
 * the box, the tab keeping no copy. While the box of a stored key is in
 * use and empty, `remove` puts a button in the check's place that takes
 * the key away, one saved a moment ago as much as any other; a key taken
 * away shows the passing check of a change that landed.
 */
export function KeyBox({
  id,
  text,
  stored,
  placeholder,
  check,
  remove,
  onChange,
  onCommit,
}: {
  readonly id: string;
  readonly text: string;
  readonly stored: boolean;
  readonly placeholder: (focused: boolean) => string;
  readonly check?: number;
  readonly remove?: {readonly label: string; readonly onClick: () => void};
  readonly onChange: (text: string) => void;
  readonly onCommit: () => void;
}) {
  const [focused, setFocused] = useState(false);

  return (
    <span
      className="box"
      onFocus={() => {
        setFocused(true);
      }}
      onBlur={event => {
        // The box is in use while its input or its button holds the focus.
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocused(false);
        }
      }}
    >
      <input
        id={id}
        type="password"
        className="input"
        value={text}
        placeholder={placeholder(focused)}
        autoComplete="off"
        onChange={event => {
          onChange(event.currentTarget.value);
        }}
        onBlur={onCommit}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.currentTarget.blur();
          }
        }}
      />
      {text !== '' ? null : !stored ? (
        check === undefined ? null : (
          <Check key={check} />
        )
      ) : !focused ? (
        <Check steady />
      ) : remove === undefined ? null : (
        <button
          type="button"
          className="box-remove"
          aria-label={remove.label}
          onClick={remove.onClick}
        >
          <Icon name="cross" size={11} weight={2.6} />
        </button>
      )}
    </span>
  );
}

/**
 * A select; it saves at the choice. `none`, when given, is its first
 * entry, which chooses nothing; `other`, when given, its last, which
 * chooses nothing listed and is told so.
 */
export function SelectBox({
  id,
  value,
  options,
  none,
  other,
  check,
  onChoose,
}: {
  readonly id: string;
  readonly value: string | undefined;
  readonly options: readonly Option[];
  readonly none?: string;
  readonly other?: {readonly label: string; readonly onChoose: () => void};
  readonly check?: number;
  readonly onChoose: (value: string | undefined) => void;
}) {
  return (
    <span className="box">
      <select
        id={id}
        className="input select"
        value={value ?? ''}
        onChange={event => {
          const select = event.currentTarget;

          // Known by its place, so no value of the field is taken for it.
          if (
            other !== undefined &&
            select.selectedIndex === select.options.length - 1
          ) {
            other.onChoose();

            return;
          }

          onChoose(select.value === '' ? undefined : select.value);
        }}
      >
        {none === undefined ? null : <option value="">{none}</option>}
        {options.map(option => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
        {other === undefined ? null : (
          <option value={other.label}>{other.label}</option>
        )}
      </select>
      {check === undefined ? null : <Check key={check} select />}
      <Icon name="updown" size={14} weight={2} className="box-updown" />
    </span>
  );
}

/** A segmented control: each value a segment, the chosen one raised; it saves at the click. */
export function Segmented({
  labelledBy,
  value,
  options,
  onChoose,
}: {
  readonly labelledBy: string;
  readonly value: string | undefined;
  readonly options: readonly Option[];
  readonly onChoose: (value: string) => void;
}) {
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="segmented">
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className="segment"
          onClick={() => {
            onChoose(option.value);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A row of pills, the chosen one filled; it saves at the click. */
export function Pills({
  labelledBy,
  value,
  options,
  onChoose,
}: {
  readonly labelledBy: string;
  readonly value: string | undefined;
  readonly options: readonly Option[];
  readonly onChoose: (value: string) => void;
}) {
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="pills">
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className="choice"
          onClick={() => {
            onChoose(option.value);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
