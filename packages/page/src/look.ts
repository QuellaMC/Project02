/**
 * The page's own look as data: its icons, the tints an icon's tile takes,
 * and the colour of each character's avatar. A plugin, and an app on her
 * phone, names an icon and a tint of these; one the page does not know
 * falls back to its plainest.
 */

/** Each icon a path in a 24-unit square, drawn as a stroke. */
const icons = {
  check: 'M5 12.5l4.5 4.5L19 7.5',
  cross: 'M7.5 7.5l9 9 M16.5 7.5l-9 9',
  plus: 'M12 6v12 M6 12h12',
  updown: 'M8 9l4-4 4 4 M8 15l4 4 4-4',
  sparkle:
    'M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9-1.9 5.1-1.9-5.1-5.1-1.9 5.1-1.9z M18.5 15.5l.8 1.7 1.7.8-1.7.8-.8 1.7-.8-1.7-1.7-.8 1.7-.8z',
  plane: 'M21 3.5L3 10.8l7 2.7 2.7 7z M10 13.5L21 3.5',
  archive: 'M4 5h16v4H4z M5.5 9v9.5a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9 M10 13h4',
  sliders:
    'M4 8h9 M17 8h3 M4 16h3 M11 16h9 M17 8a2 2 0 1 1-4 0a2 2 0 1 1 4 0z M11 16a2 2 0 1 1-4 0a2 2 0 1 1 4 0z',
  notebook:
    'M7.5 4h9a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M9 9h6 M9 12.5h6 M9 16h3.5',
  history: 'M4.5 12a7.5 7.5 0 1 0 2.2-5.3 M4.5 4.5v3.5H8 M12 8.5v4l2.5 1.5',
  heart:
    'M12 19.5s-7-4.3-7-9.6A3.9 3.9 0 0 1 12 7.6a3.9 3.9 0 0 1 7 2.3c0 5.3-7 9.6-7 9.6z',
  bubble:
    'M5 6.8A2.8 2.8 0 0 1 7.8 4h8.4A2.8 2.8 0 0 1 19 6.8v5.4a2.8 2.8 0 0 1-2.8 2.8H11l-4 3.5V15A2.2 2.2 0 0 1 5 12.8z',
  shield:
    'M12 3.5l6.5 2.6v5c0 4.2-2.8 7.6-6.5 9.4-3.7-1.8-6.5-5.2-6.5-9.4v-5z M9 12l2 2 4-4',
  person:
    'M15.5 9a3.5 3.5 0 1 1-7 0a3.5 3.5 0 1 1 7 0z M5.5 19.5a6.5 6.5 0 0 1 13 0',
  grid: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z',
  doc: 'M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 6 20V4a.5.5 0 0 1 .5-.5z M14 3.5V8h4',
  download: 'M12 4v11 M7.5 10.5L12 15l4.5-4.5 M5 19.5h14',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 7v5l3 2',
  globe:
    'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M3 12h18 M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z',
  alarm:
    'M12 6.5a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M12 10v3.5l2.2 1.5 M5 4.5L2.8 6.6 M19 4.5l2.2 2.1',
  stopwatch:
    'M12 7a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M12 11v3 M10 3.5h4 M12 3.5V7',
  timer: 'M12 5a8 8 0 1 0 8 8 M12 13V5 M12 13l5-5',
  bag: 'M6 8h12l1 12H5L6 8z M9 8V7a3 3 0 0 1 6 0v1',
  list: 'M9.5 6H20 M9.5 12H20 M9.5 18H20 M4.5 6h.01 M4.5 12h.01 M4.5 18h.01',
  magnifier: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M20 20l-3.9-3.9',
  sun: 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z M12 3.5V5 M12 19v1.5 M3.5 12H5 M19 12h1.5 M6 6l1.1 1.1 M16.9 16.9L18 18 M6 18l1.1-1.1 M16.9 7.1L18 6',
  bulb: 'M9 18h6 M10 21h4 M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z M12 9.3a2.7 2.7 0 1 0 0 5.4 2.7 2.7 0 0 0 0-5.4z',
  phone:
    'M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M10.5 18h3',
  pin: 'M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6z M12 15v5',
} as const;

export type IconName = keyof typeof icons;

export function iconPath(name: IconName): string {
  return icons[name];
}

/** The icon a plugin names, or the plainest when the page has none of that name. */
export function iconOf(name: string | undefined): IconName {
  return name !== undefined && Object.hasOwn(icons, name)
    ? (name as IconName)
    : 'grid';
}

const tints = [
  'indigo',
  'blue',
  'brown',
  'gray',
  'orange',
  'cyan',
  'pink',
  'mint',
  'graphite',
] as const;

export type Tint = (typeof tints)[number];

/** The tint a plugin names, or gray when the page has none of that name. */
export function tintOf(name: string | undefined): Tint {
  return tints.find(tint => tint === name) ?? 'gray';
}

/** Avatar colours white reads on, in light and dark alike. */
const avatarColors = [
  '#1E6EF4',
  '#C55300',
  '#564ADE',
  '#008575',
  '#E7124D',
  '#956D51',
  '#007EAE',
  '#B02FC2',
  '#008198',
] as const;

/** A character's avatar colour, picked by her id: the same wherever she appears. */
export function avatarColor(id: string): string {
  let hash = 0x811c9dc5;

  for (const character of id) {
    hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 0x01000193) >>> 0;
  }

  return avatarColors[hash % avatarColors.length] ?? avatarColors[0];
}

/** The first letter of a name, as an avatar shows it. */
export function initialOf(name: string): string {
  return name.trim().charAt(0).toUpperCase();
}
