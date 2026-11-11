// A tiny app: alarms the phone rings, and the weather the phone fetches.
// It reaches nothing but `phone`.

function set_alarm({ time, label }) {
  if (typeof time !== "string") {
    throw new TypeError("set_alarm needs a time like 07:30");
  }
  const alarms = phone.storage.get("alarms") ?? [];
  alarms.push({ time, label });
  phone.storage.set("alarms", alarms);
  phone.ring(time, label);
  return { set: { time, label }, count: alarms.length };
}

async function weather({ city }) {
  const body = await phone.fetch(
    `https://weather.example/today?city=${encodeURIComponent(city)}`,
  );
  const report = JSON.parse(body);
  return { city: report.city, summary: report.today.summary };
}

function screen() {
  const alarms = phone.storage.get("alarms") ?? [];
  return {
    title: "Alarms",
    rows: alarms.map(({ time, label }) => `${time} ${label}`),
  };
}
