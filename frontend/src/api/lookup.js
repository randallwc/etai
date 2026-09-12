async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

/** Free key-less lookups for scheduling checks. All callers .catch to null. */
export async function geocode(place) {
  const [hit] = await fetchJson(
    `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(place)}`
  );
  return hit ? { lat: Number(hit.lat), lon: Number(hit.lon) } : null;
}

export async function driveMinutes(from, to) {
  const j = await fetchJson(
    `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`
  );
  const seconds = j.routes?.[0]?.duration;
  return seconds == null ? null : Math.round(seconds / 60);
}

export async function precipAt(lat, lon, when) {
  const date = when.toISOString().slice(0, 10);
  const j = await fetchJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=precipitation_probability&start_date=${date}&end_date=${date}&timezone=auto`
  );
  const times = j.hourly?.time ?? [];
  const probs = j.hourly?.precipitation_probability ?? [];
  let best = null;
  let bestDiff = Infinity;
  times.forEach((t, i) => {
    const diff = Math.abs(new Date(t) - when);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = probs[i];
    }
  });
  return best;
}
