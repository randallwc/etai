const BUS_URL = import.meta.env.VITE_BUS_URL;

/**
 * Send one caller turn to the bus per the docs/bus.md /voice/turn
 * contract. Never throws at the UI - resolves the reply string to
 * speak, or null when the bus is unset, unreachable, or errors.
 */
export async function voiceTurn({ from, body }) {
  if (!BUS_URL) return null;
  try {
    const res = await fetch(`${BUS_URL}/voice/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, body }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.reply ?? null;
  } catch {
    return null;
  }
}

/**
 * Ask the bus to synthesize speech (neural voice via Edge read-aloud).
 * Never throws at the UI - resolves an audio Blob (mp3), or null when
 * the bus is unset, unreachable, or errors; caller falls back to
 * speechSynthesis.
 */
export async function synthSpeech(text) {
  if (!BUS_URL) return null;
  try {
    const res = await fetch(`${BUS_URL}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    return res.ok ? res.blob() : null;
  } catch {
    return null;
  }
}

/**
 * Fetch the dispatch board state from the bus. Never throws at the UI -
 * resolves the parsed state object, or null when the bus is unset,
 * unreachable, or errors.
 */
export async function fetchBoard() {
  if (!BUS_URL) return null;
  try {
    const res = await fetch(`${BUS_URL}/state`);
    return res.ok ? res.json() : null;
  } catch {
    return null;
  }
}
