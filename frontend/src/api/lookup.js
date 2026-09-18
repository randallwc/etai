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

export async function route(from, to) {
  try {
    const j = await fetchJson(
      `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`
    );
    const r = j.routes?.[0];
    if (!r) return null;
    return {
      meters: Math.round(r.distance),
      minutes: Math.round(r.duration / 60),
    };
  } catch {
    return null;
  }
}

