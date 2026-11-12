// Weather: what it is like in a place now, over the next hours and the days
// ahead, as Open-Meteo forecasts it. She looks a place up by its name: the
// app finds it, reads its forecast and keeps that reading, which its screen
// shows with when it was read, since a screen never reaches the internet.
//
// It keeps, in phone.storage, `weather`: the `place` looked up last, its
// `name`, with its `region` and its `country` when it has them; the `degrees`
// it was read in, `celsius` or `fahrenheit`; when it was `read`, in
// milliseconds since the epoch; and the reading, in whole degrees: `now`, its
// `temperature` and the service's `code` for the weather, `hours`, each hour
// after now by its `time` on a clock there, with its `temperature`, and
// `days`, each day from today there by its `date`, with its `code`, its `low`
// and its `high`.

export const manifest = {
  format: 'project02.app.v1',
  id: 'weather',
  name: 'Weather',
  summary: 'Today and the week ahead',
  version: '1.0.0',
  icon: 'sun',
  tint: 'blue',
  wakes: false,
  reaches: ['api.open-meteo.com', 'geocoding-api.open-meteo.com'],
  views: [{id: 'weather', title: 'Weather', icon: 'sun'}],
  opensOn: 'weather',
  actions: [
    {
      name: 'look_up',
      description:
        'Look up the weather in a place: what it is like now, over the next hours and the days ahead.',
      did: 'Looked up the weather',
      view: 'weather',
      input: {
        type: 'object',
        properties: {
          place: {
            type: 'string',
            pattern: '^[^\\n\\r]*\\S[^\\n\\r]*$',
            maxLength: 100,
            description:
              'The place by its name, a city, with its region or country after a comma when more than one place has that name: Portland, Maine.',
          },
          degrees: {
            type: 'string',
            enum: ['celsius', 'fahrenheit'],
            description:
              'The degrees to read it in: the same as last time unless you say, Celsius the first time.',
          },
        },
        required: ['place'],
        additionalProperties: false,
      },
    },
  ],
};

// Open-Meteo's search for a place by its name, and its forecast for one.
const SEARCH = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST = 'https://api.open-meteo.com/v1/forecast';
// The hours it reads, from the one it is now, and the days, from today.
const HOURS = 6;
const DAYS = 6;
// What Open-Meteo's licence asks to be said beside its data.
const CREDIT = 'Weather data by Open-Meteo.com';
// The refusal of an answer that is no success, or not one the service's
// pages say it gives.
const UNANSWERED =
  'The weather service did not answer as it should. Try again in a while.';
// The letter each kind of degrees is written with.
const SCALES = {celsius: 'C', fahrenheit: 'F'};
// A time and a day as the service writes them, in the place's own time.
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d$/;
const DATE = /^\d{4}-\d\d-\d\d$/;
// The days of the week as Date counts them, from Sunday.
const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
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
// The weather in a few words, by the code the service gives it, the World
// Meteorological Organization's.
const SKIES = {
  0: 'Clear',
  1: 'Mostly Clear',
  2: 'Partly Cloudy',
  3: 'Cloudy',
  45: 'Fog',
  48: 'Freezing Fog',
  51: 'Light Drizzle',
  53: 'Drizzle',
  55: 'Heavy Drizzle',
  56: 'Freezing Drizzle',
  57: 'Heavy Freezing Drizzle',
  61: 'Light Rain',
  63: 'Rain',
  65: 'Heavy Rain',
  66: 'Freezing Rain',
  67: 'Heavy Freezing Rain',
  71: 'Light Snow',
  73: 'Snow',
  75: 'Heavy Snow',
  77: 'Snow Grains',
  80: 'Light Showers',
  81: 'Showers',
  82: 'Heavy Showers',
  85: 'Snow Showers',
  86: 'Heavy Snow Showers',
  95: 'Thunderstorms',
  96: 'Thunderstorms with Hail',
  99: 'Thunderstorms with Heavy Hail',
};

export function screen() {
  const weather = phone.storage.get('weather');

  if (weather === null) {
    return {items: [{kind: 'text', text: 'No Place Looked Up'}]};
  }

  const {place, read, now, hours, days} = weather;
  const [today] = days;

  return {
    items: [
      {
        kind: 'glance',
        title: place.name,
        text: shown(now.temperature),
        caption: skyOf(now.code),
        detail: `H: ${shown(today.high)}  L: ${shown(today.low)}`,
      },
      {
        kind: 'strip',
        cells: [
          {label: 'Now', value: shown(now.temperature)},
          ...hours.map(hour => ({
            label: hourOf(hour),
            value: shown(hour.temperature),
          })),
        ],
      },
      {kind: 'ranges', rows: ranges(days)},
      {kind: 'note', text: `Updated ${whenRead(read)} · ${CREDIT}`},
    ],
  };
}

// The weather in `place`, in `degrees`: those of the look-up before unless
// she says, and Celsius the first time. It is kept in place of the one
// before.
export function look_up({
  place,
  degrees = phone.storage.get('weather')?.degrees ?? 'celsius',
}) {
  const found = placeNamed(place.trim());
  const weather = {
    place: {name: found.name, region: found.admin1, country: found.country},
    degrees,
    read: phone.time.now(),
    ...forecastAt(found, degrees),
  };

  phone.storage.set('weather', weather);
  return told(weather);
}

// The place the service's search finds first by `name`, refused, saying so,
// when it finds none.
function placeNamed(name) {
  const found = answered(
    phone.net.fetch({
      url: `${SEARCH}?name=${encodeURIComponent(name)}&count=1&language=en&format=json`,
    }),
  ).results?.[0];

  if (found === undefined) {
    throw new Error(
      `No place called "${name}" was found. Its country after a comma may help, as in "Paris, France".`,
    );
  }
  if (
    typeof found?.name !== 'string' ||
    !isNumber(found.latitude) ||
    !isNumber(found.longitude)
  ) {
    throw new Error(UNANSWERED);
  }
  return found;
}

// The reading of the forecast at a place, in `degrees`, refused when the
// service does not answer one.
function forecastAt({latitude, longitude}, degrees) {
  const reading = readingOf(
    answered(
      phone.net.fetch({
        url:
          `${FORECAST}?latitude=${latitude}&longitude=${longitude}` +
          '&current=temperature_2m,weather_code&hourly=temperature_2m' +
          '&daily=weather_code,temperature_2m_max,temperature_2m_min' +
          `&timezone=auto&forecast_days=${DAYS}&forecast_hours=${HOURS}` +
          `&temperature_unit=${degrees}`,
      }),
    ),
  );

  if (reading === undefined) {
    throw new Error(UNANSWERED);
  }
  return reading;
}

// The reading a forecast holds, in whole degrees: now, the hours after now
// and the days from today. None when the answer is not a forecast as the
// service's pages give one, its times written as they write them and its
// temperatures in numbers, with an hour after now and a day among them.
function readingOf({current, hourly, daily}) {
  const hours = rows(hourly, ['time', 'temperature_2m'])?.filter(
    ([time]) => time > current?.time,
  );
  const days = rows(daily, [
    'time',
    'weather_code',
    'temperature_2m_min',
    'temperature_2m_max',
  ]);
  const forecast =
    TIME.test(current?.time) &&
    isNumber(current.temperature_2m) &&
    hours?.length > 0 &&
    hours.every(
      ([time, temperature]) => TIME.test(time) && isNumber(temperature),
    ) &&
    days?.length > 0 &&
    days.every(
      ([date, , low, high]) =>
        DATE.test(date) && isNumber(low) && isNumber(high),
    );

  if (!forecast) {
    return undefined;
  }
  return {
    now: {
      temperature: Math.round(current.temperature_2m),
      code: current.weather_code,
    },
    hours: hours.map(([time, temperature]) => ({
      time,
      temperature: Math.round(temperature),
    })),
    days: days.map(([date, code, low, high]) => ({
      date,
      code,
      low: Math.round(low),
      high: Math.round(high),
    })),
  };
}

// The rows of a table the service answers as arrays side by side, by their
// `names`: each row the values at one place in each. None unless each is an
// array, all of one length.
function rows(table, names) {
  const columns = names.map(name => table?.[name]);
  const [first] = columns;

  return columns.every(
    column => Array.isArray(column) && column.length === first.length,
  )
    ? first.map((_, at) => columns.map(column => column[at]))
    : undefined;
}

// What a page of the service answered, read as the JSON object it answers
// with success; refused when it answered no success, or no such object.
function answered({status, body}) {
  const answer = status === 200 ? parsed(body) : undefined;

  if (typeof answer !== 'object' || answer === null) {
    throw new Error(UNANSWERED);
  }
  return answer;
}

// `text` read as JSON, or undefined when it is not JSON.
function parsed(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// The reading as she would say it back: the place by its full name, what it
// is like now, today's low and high, the hours and the days, in words and in
// degrees.
function told({place, degrees, now, hours, days}) {
  const worded = temperature => `${temperature}°${SCALES[degrees]}`;
  const [today] = days;

  return {
    place: [place.name, place.region, place.country]
      .filter(part => part !== undefined)
      .join(', '),
    now: {temperature: worded(now.temperature), sky: skyOf(now.code)},
    today: {low: worded(today.low), high: worded(today.high)},
    hours: hours.map(hour => ({
      at: hourOf(hour),
      temperature: worded(hour.temperature),
    })),
    days: days.map((day, at) => ({
      day: at === 0 ? 'Today' : weekdayOf(day),
      sky: skyOf(day.code),
      low: worded(day.low),
      high: worded(day.high),
    })),
  };
}

// The days as ranges, each its bar placed between the lowest low and the
// highest high of them all.
function ranges(days) {
  const lowest = Math.min(...days.map(day => day.low));
  const highest = Math.max(...days.map(day => day.high));
  const placed = temperature =>
    Math.round(((temperature - lowest) / Math.max(highest - lowest, 1)) * 100);

  return days.map((day, at) => ({
    label: at === 0 ? 'Today' : weekdayOf(day).slice(0, 3),
    low: shown(day.low),
    high: shown(day.high),
    from: placed(day.low),
    to: placed(day.high),
  }));
}

// When a reading was read, as her phone's clock reads it: its time alone
// today, and after its date on any other day, with the year when it is not
// this one.
function whenRead(at) {
  const then = phone.time.local(at);
  const today = phone.time.local();
  const time = clockTime(then.hour, then.minute);
  const date = `${MONTHS[then.month - 1]} ${then.day}`;

  if (then.year !== today.year) {
    return `${date}, ${then.year}, ${time}`;
  }
  return then.month === today.month && then.day === today.day
    ? time
    : `${date}, ${time}`;
}

// A temperature as the screen shows it: 12°.
function shown(temperature) {
  return `${temperature}°`;
}

// The weather of a code of the service's in words, none for a code it has no
// words for.
function skyOf(code) {
  return Object.hasOwn(SKIES, code) ? SKIES[code] : undefined;
}

// The hour of a time of the service's, as a clock there says it: 3 PM.
function hourOf({time}) {
  return clockTime(Number(time.slice(11, 13)));
}

// The day of the week of a day of the service's, by its name: Thursday.
function weekdayOf({date}) {
  return WEEKDAYS[new Date(date).getUTCDay()];
}

// A time of day as a clock says it, with its minute when it is given:
// 9:41 AM, or 3 PM.
function clockTime(hour, minute) {
  const minutes =
    minute === undefined ? '' : `:${String(minute).padStart(2, '0')}`;

  return `${hour % 12 || 12}${minutes} ${hour < 12 ? 'AM' : 'PM'}`;
}

function isNumber(value) {
  return typeof value === 'number';
}
