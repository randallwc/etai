const METERS_PER_MILE = 1609.344;

export function formatMiles(meters) {
  return `${(meters / METERS_PER_MILE).toFixed(1)} mi`;
}

export function etaLabel(minutes) {
  return minutes < 2 ? "arriving" : `~${Math.round(minutes)} min`;
}

export function etaClock(minutes, now = new Date()) {
  const t = new Date(now.getTime() + minutes * 60000);
  const ampm = t.getHours() >= 12 ? "PM" : "AM";
  const h = t.getHours() % 12 || 12;
  const m = String(t.getMinutes()).padStart(2, "0");
  return `${h}:${m} ${ampm}`;
}
