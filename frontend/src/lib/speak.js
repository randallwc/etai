import { synthSpeech } from "../api/bus.js";

const VOICE_PREFER = [
  "Google US English",
  "Microsoft Aria",
  "Microsoft Jenny",
  "Microsoft Ava",
  "Samantha",
  "Alex",
];

let gen = 0;
let current = null;

export function stopSpeaking() {
  gen++;
  current?.pause();
  current = null;
  globalThis.speechSynthesis?.cancel();
}

export function pickVoice(voices) {
  for (const name of VOICE_PREFER) {
    const v = voices.find((v) => v.name.includes(name));
    if (v) return v;
  }
  return (
    voices.find((v) => v.lang?.startsWith("en") && v.localService === false) ??
    voices.find((v) => v.lang?.startsWith("en")) ??
    null
  );
}

/**
 * Speak one agent line: bus neural TTS when wired, else the best
 * installed speechSynthesis voice, else a timed stub so the pin still
 * animates. onEnd fires at most once per call; a newer speak or
 * stopSpeaking silences the previous one.
 */
export async function speak(text, voice = {}, { onEnd } = {}) {
  const g = ++gen;
  let done = false;
  const finish = () => {
    if (done || g !== gen) return;
    done = true;
    clearTimeout(guard);
    onEnd?.();
  };
  const guard = setTimeout(finish, Math.min(15000, 2000 + text.length * 100));

  const blob = await synthSpeech(text);
  if (g !== gen) return;
  if (blob) {
    try {
      const url = URL.createObjectURL(blob);
      const audio = new globalThis.Audio(url);
      current = audio;
      audio.onended = audio.onerror = () => {
        URL.revokeObjectURL(url);
        if (current === audio) current = null;
        finish();
      };
      await audio.play();
      return;
    } catch {
      current = null;
    }
  }

  const synth = globalThis.speechSynthesis;
  if (!synth) {
    setTimeout(finish, Math.min(4000, 800 + text.length * 30));
    return;
  }
  const u = new globalThis.SpeechSynthesisUtterance(text);
  u.voice = pickVoice(synth.getVoices?.() ?? []);
  u.pitch = voice?.pitch ?? 1;
  u.rate = voice?.rate ?? 1;
  u.onend = u.onerror = finish;
  synth.speak(u);
}
