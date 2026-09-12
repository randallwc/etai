const DEFAULT_VOICE = "en-US-EmmaNeural";
const TIMEOUT_MS = 15_000;

/**
 * Neural TTS for the voice call. Uses Edge's read-aloud voices (free, no
 * key) through msedge-tts, lazily required so the bus and its tests still
 * run when the dependency is not installed. Voice via TTS_VOICE.
 */
function createTts({ env = process.env } = {}) {
  const voice = env.TTS_VOICE ?? DEFAULT_VOICE;
  let MsEdgeTTS, OUTPUT_FORMAT;
  try {
    ({ MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts"));
  } catch {
    return null;
  }

  async function synthesize(text) {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(text);
    const chunks = [];
    const collect = (async () => {
      for await (const c of audioStream) chunks.push(c);
    })();
    await Promise.race([
      collect,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("tts timeout")), TIMEOUT_MS)
      ),
    ]);
    return Buffer.concat(chunks);
  }

  return { synthesize, voice };
}

module.exports = { createTts };
