import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

async function loadModule(url) {
  vi.resetModules();
  vi.stubEnv("VITE_BUS_URL", url ?? "");
  return import("./speak.js");
}

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubSynth(voices = [{ name: "Google US English", lang: "en-US" }]) {
  const spoken = [];
  vi.stubGlobal(
    "SpeechSynthesisUtterance",
    class {
      constructor(text) {
        this.text = text;
        spoken.push(this);
      }
    }
  );
  vi.stubGlobal("speechSynthesis", {
    getVoices: () => voices,
    speak: (u) => u.onend?.(),
    cancel: vi.fn(),
  });
  return spoken;
}

describe("pickVoice", () => {
  it("prefers known natural voices, then remote en, then any en", async () => {
    const { pickVoice } = await loadModule("");
    expect(
      pickVoice([
        { name: "Fred", lang: "en-US" },
        { name: "Google US English", lang: "en-US" },
      ])?.name
    ).toBe("Google US English");
    expect(
      pickVoice([{ name: "Net en", lang: "en-GB", localService: false }])?.name
    ).toBe("Net en");
    expect(pickVoice([{ name: "Fred", lang: "en-US" }])?.name).toBe("Fred");
    expect(pickVoice([{ name: "Klara", lang: "de-DE" }])).toBeNull();
  });
});

describe("speak", () => {
  it("plays bus audio when the bus synthesizes speech", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, blob: async () => ({ mp3: true }) }))
    );
    const played = [];
    vi.stubGlobal(
      "Audio",
      class {
        constructor(url) {
          this.url = url;
        }
        async play() {
          played.push(this.url);
          this.onended?.();
        }
        pause() {}
      }
    );
    URL.createObjectURL = vi.fn(() => "blob:fake");
    URL.revokeObjectURL = vi.fn();

    const { speak } = await loadModule("http://localhost:4010");
    const onEnd = vi.fn();
    await speak("hello there", {}, { onEnd });
    expect(played).toEqual(["blob:fake"]);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("falls back to speechSynthesis with a picked voice when the bus has none", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 })));
    const spoken = stubSynth();
    const { speak } = await loadModule("http://localhost:4010");
    const onEnd = vi.fn();
    await speak("hi", { pitch: 1.05, rate: 1 }, { onEnd });
    expect(spoken[0].text).toBe("hi");
    expect(spoken[0].voice?.name).toBe("Google US English");
    expect(spoken[0].pitch).toBeCloseTo(1.05);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("times out the line when neither tts nor speechSynthesis exists", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 })));
    const { speak } = await loadModule("");
    const onEnd = vi.fn();
    await speak("hi", {}, { onEnd });
    await new Promise((r) => setTimeout(r, 1100));
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("stopSpeaking cancels synth and audio", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 })));
    const spoken = stubSynth();
    const { speak, stopSpeaking } = await loadModule("");
    stopSpeaking();
    expect(globalThis.speechSynthesis.cancel).toHaveBeenCalled();
    await speak("hi", {}, {});
    expect(spoken[0].text).toBe("hi");
  });
});
