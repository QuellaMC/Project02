// Reminders: things to do on a day and at a time, once or repeating, which
// ring her phone when they are due.
//
// It keeps, in phone.storage: `reminders`, each with the title, the day and
// the time she gave it (`year`, `month`, `day`, `hour` and `minute`), how it
// `repeats`, and `due`, the moment it is next due; and `issued`, how many ids
// it has given, so that none is given twice. A reminder rings, under its own
// id, at the moment it is due: one that repeats then moves on to its next
// time, done or not, and any other stays on the list, due, until it is done.

export const manifest = {
  format: 'project02.app.v1',
  id: 'reminders',
  name: 'Reminders',
  summary: 'Things to do, on a day and time',
  version: '1.0.0',
  icon: 'list',
  tint: 'orange',
  wakes: true,
  views: [{id: 'reminders', title: 'Reminders', icon: 'list'}],
  opensOn: 'reminders',
  actions: [
    {
      name: 'add_reminder',
      description:
        'Add a reminder for a day and a time, once or repeating: your phone rings when it is due.',
      did: 'Added a reminder',
      view: 'reminders',
      input: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description:
              'What there is to do, in one line of 120 characters at most.',
          },
          year: {type: 'integer'},
          month: {type: 'integer', minimum: 1, maximum: 12},
          day: {type: 'integer', minimum: 1, maximum: 31},
          hour: {
            type: 'integer',
            minimum: 0,
            maximum: 23,
            description: 'On a 24-hour clock.',
          },
          minute: {type: 'integer', minimum: 0, maximum: 59},
          repeats: {
            type: 'string',
            enum: ['never', 'daily', 'weekly', 'monthly', 'yearly'],
            description:
              'Daily, weekly on its weekday, monthly on its day of the month, or yearly on its date; never unless you say.',
          },
        },
        required: ['title', 'year', 'month', 'day', 'hour', 'minute'],
        additionalProperties: false,
      },
    },
    {
      name: 'mark_done',
      description:
        'Mark a reminder done: it leaves the list. One that repeats stays, and rings again at its next time.',
      did: 'Marked a reminder done',
      view: 'reminders',
      input: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: "The reminder's id, as the Reminders view shows it.",
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
    {
      name: 'remove_reminder',
      description: 'Remove a reminder, and with it every time it would repeat.',
      did: 'Removed a reminder',
      view: 'reminders',
      input: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: "The reminder's id, as the Reminders view shows it.",
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
  ],
};

const WEEKDAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
// The days of a month whose words do not end in "th".
const ORDINALS = {
  1: '1st',
  2: '2nd',
  3: '3rd',
  21: '21st',
  22: '22nd',
  23: '23rd',
  31: '31st',
};
// The most characters a reminder's title has: what a ring's body holds.
const TITLE_LENGTH = 120;
const DAY = 24 * 60 * 60 * 1000;

export function screen() {
  const today = dayNumber(phone.time.local());
  const reminders = items().toSorted((one, other) => one.due - other.due);
  const dueToday = reminder =>
    dayNumber(phone.time.local(reminder.due)) <= today;
  const todays = reminders.filter(dueToday);
  const scheduled = reminders.filter(reminder => !dueToday(reminder));
  const lists = [...list('Today', todays), ...list('Scheduled', scheduled)];

  return {
    items: lists.length > 0 ? lists : [{kind: 'text', text: 'No Reminders'}],
  };
}

// A ring of a reminder's was told to her: one that repeats moves on to its
// next time and rings again then, and any other stays on the list, due,
// until it is done.
export function rang({id}) {
  const reminder = items().find(kept => kept.id === id);

  if (reminder !== undefined && reminder.repeats !== 'never') {
    const moved = {...reminder, due: dueAfter(reminder, phone.time.now())};

    keep(moved);
    setRing(moved);
  }
}

export function add_reminder({
  title,
  year,
  month,
  day,
  hour,
  minute,
  repeats = 'never',
}) {
  const given = {title: titled(title), year, month, day, hour, minute, repeats};
  const reminder = {id: issue(), ...given, due: firstDue(given)};

  keep(reminder);
  setRing(reminder);
  return about(reminder);
}

// One that repeats has moved on by the time its ring is told, so done takes
// nothing from it: its next time is never skipped.
export function mark_done({id}) {
  const reminder = found(id);

  if (reminder.repeats === 'never') {
    drop(reminder);
  }
  return {...about(reminder), done: true};
}

export function remove_reminder({id}) {
  const reminder = found(id);

  drop(reminder);
  return {...about(reminder), removed: true};
}

// A list of `reminders` under `header`, each its title with when it is due
// under it; nothing when there are none.
function list(header, reminders) {
  const rows = reminders.map(reminder => ({
    id: reminder.id,
    title: reminder.title,
    subtitle: whenDue(reminder),
  }));

  return rows.length > 0 ? [{kind: 'list', header, rows}] : [];
}

// A reminder as an answer says it: its id, its title and when it is due.
function about(reminder) {
  return {id: reminder.id, title: reminder.title, due: whenDue(reminder)};
}

// When a reminder is due, in words: one that repeats as it repeats, at its
// time, and any other at the moment it is due, as her phone's clock reads it.
function whenDue(reminder) {
  if (reminder.repeats === 'never') {
    return dayAndTime(phone.time.local(reminder.due));
  }

  const time = clockTime(reminder);

  switch (reminder.repeats) {
    case 'daily':
      return `Every day, ${time}`;
    case 'weekly':
      return `Every ${WEEKDAYS[weekdayOf(reminder) - 1]}, ${time}`;
    case 'monthly':
      return `Every month on the ${ordinal(reminder.day)}, ${time}`;
    case 'yearly':
      return `Every year on ${dateOf(reminder)}, ${time}`;
  }
}

// A clock's reading, `then`, in words: its time alone today, after its
// weekday in the six days after today, and after its date on any other day,
// with the year when it is not this one.
function dayAndTime(then) {
  const today = phone.time.local();
  const ahead = dayNumber(then) - dayNumber(today);
  const time = clockTime(then);

  if (ahead === 0) {
    return time;
  }
  if (ahead > 0 && ahead < 7) {
    return `${WEEKDAYS[then.weekday - 1]}, ${time}`;
  }
  return then.year === today.year
    ? `${dateOf(then)}, ${time}`
    : `${dateOf(then)}, ${then.year}, ${time}`;
}

// The first moment after `after` at which a reminder that repeats is due:
// its time on its day of the day, week, month or year `after` falls in, or
// of the next one when that has passed.
function dueAfter(reminder, after) {
  const from = phone.time.local(after);
  const dueIn = later =>
    phone.time.at({
      ...dayIn(reminder, from, later),
      hour: reminder.hour,
      minute: reminder.minute,
    });
  const soonest = dueIn(0);

  return soonest > after ? soonest : dueIn(1);
}

// The day a reminder that repeats falls on, counting from the day of the
// reading `from`: in that day, week, month or year, as it repeats, or in the
// one `later` of them on.
function dayIn(reminder, from, later) {
  switch (reminder.repeats) {
    case 'daily':
      return onCalendar(from.year, from.month, from.day + later);
    case 'weekly': {
      const ahead = (weekdayOf(reminder) - from.weekday + 7) % 7;

      return onCalendar(from.year, from.month, from.day + ahead + 7 * later);
    }
    case 'monthly':
      return inMonth(from.year, from.month + later, reminder.day);
    case 'yearly':
      return inMonth(from.year + later, reminder.month, reminder.day);
  }
}

// The day `year`, `month` and `day` come to on the calendar, counting on past
// a month's end and a year's: the 32nd of December is the 1st of January.
function onCalendar(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));

  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

// The `day` of a month, counting on past a year's end, or the month's last
// day when it has no such day.
function inMonth(year, month, day) {
  const last = onCalendar(year, month + 1, 0);

  return {...last, day: Math.min(day, last.day)};
}

// The day of the week a day on the calendar falls on, 1 (Monday) to 7
// (Sunday), which Date counts as 0.
function weekdayOf({year, month, day}) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
}

// The moment a reminder is first due: when her phone's clock reads its time
// on the day she gave it, or, for one that repeats from a time already past,
// the next time it repeats, so that it does not ring the moment it is added.
// A day the calendar does not have is refused.
function firstDue(given) {
  const {year, month, day, hour, minute} = given;
  const now = phone.time.now();
  let due;

  try {
    due = phone.time.at({year, month, day, hour, minute});
  } catch {
    throw new Error(`There is no ${MONTHS[month - 1]} ${day}, ${year}.`);
  }
  return given.repeats === 'never' || due > now ? due : dueAfter(given, now);
}

// `title`, once a reminder can have it: one line, not blank, no longer than
// a ring's body holds.
function titled(title) {
  if (title.trim() === '') {
    throw new Error('A reminder needs a title: what there is to do.');
  }
  if (/[\n\r]/.test(title) || [...title].length > TITLE_LENGTH) {
    throw new Error(
      `A reminder's title is one line of ${TITLE_LENGTH} characters at most.`,
    );
  }
  return title;
}

function setRing(reminder) {
  phone.rings.set({
    id: reminder.id,
    at: reminder.due,
    title: 'Reminder',
    body: reminder.title,
  });
}

// Takes a reminder off the list, and its ring with it.
function drop({id}) {
  const left = items().filter(kept => kept.id !== id);

  phone.storage.set('reminders', left);
  phone.rings.cancel(id);
}

// The reminders it keeps, none before it keeps any.
function items() {
  return phone.storage.get('reminders') ?? [];
}

// The reminder with `id`, or a refusal saying there is none.
function found(id) {
  const reminder = items().find(kept => kept.id === id);

  if (reminder === undefined) {
    throw new Error(`There is no reminder with the id "${id}".`);
  }
  return reminder;
}

// Keeps `reminder` in place of the one with its id, or after the rest when
// it is new.
function keep(reminder) {
  const kept = items();
  const index = kept.findIndex(other => other.id === reminder.id);

  phone.storage.set(
    'reminders',
    index === -1 ? [...kept, reminder] : kept.with(index, reminder),
  );
}

// A new id: r1, then r2.
function issue() {
  const issued = (phone.storage.get('issued') ?? 0) + 1;

  phone.storage.set('issued', issued);
  return `r${issued}`;
}

// The days since the epoch of a day on the calendar, to count the days
// between two.
function dayNumber({year, month, day}) {
  return Date.UTC(year, month - 1, day) / DAY;
}

// A day of the year in words: November 20.
function dateOf({month, day}) {
  return `${MONTHS[month - 1]} ${day}`;
}

// A day of a month in words: 1st, 2nd, 11th, 23rd.
function ordinal(day) {
  return ORDINALS[day] ?? `${day}th`;
}

// A time of day as a clock shows it: 7:00 AM.
function clockTime({hour, minute}) {
  return `${hour % 12 || 12}:${pad(minute)} ${hour < 12 ? 'AM' : 'PM'}`;
}

function pad(number) {
  return String(number).padStart(2, '0');
}
