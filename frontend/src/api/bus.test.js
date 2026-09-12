import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

async function loadModule(url) {
  vi.resetModules();
  vi.stubEnv("VITE_BUS_URL", url ?? "");
  return import("./bus.js");
}

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllGlobals());

describe("voiceTurn", () => {
  it("posts { from, body } to {VITE_BUS_URL}/voice/turn and resolves the reply", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ reply: "Locked in for 9am." }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const m = await loadModule("http://localhost:4010");
    const reply = await m.voiceTurn({ from: "+15551234567", body: "9am works" });
    expect(reply).toBe("Locked in for 9am.");
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:4010/voice/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: "+15551234567", body: "9am works" }),
    });
  });

  it("resolves null without fetching when VITE_BUS_URL is unset", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const m = await loadModule("");
    expect(
      await m.voiceTurn({ from: "+15551234567", body: "hi" })
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves null when fetch rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("service down");
      })
    );
    const m = await loadModule("http://localhost:4010");
    expect(
      await m.voiceTurn({ from: "+15551234567", body: "hi" })
    ).toBeNull();
  });

  it("resolves null on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500 }))
    );
    const m = await loadModule("http://localhost:4010");
    expect(
      await m.voiceTurn({ from: "+15551234567", body: "hi" })
    ).toBeNull();
  });

  it("resolves null when the reply field is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) }))
    );
    const m = await loadModule("http://localhost:4010");
    expect(
      await m.voiceTurn({ from: "+15551234567", body: "hi" })
    ).toBeNull();
  });
});

describe("synthSpeech", () => {
  it("posts text to {VITE_BUS_URL}/tts and resolves the audio blob", async () => {
    const blob = { fake: "mp3" };
    const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => blob }));
    vi.stubGlobal("fetch", fetchMock);
    const m = await loadModule("http://localhost:4010");
    expect(await m.synthSpeech("hello")).toBe(blob);
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:4010/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
  });

  it("resolves null when the bus is unset, errors, or is unreachable", async () => {
    const unset = await loadModule("");
    expect(await unset.synthSpeech("hi")).toBeNull();

    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 })));
    let m = await loadModule("http://localhost:4010");
    expect(await m.synthSpeech("hi")).toBeNull();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("down");
      })
    );
    m = await loadModule("http://localhost:4010");
    expect(await m.synthSpeech("hi")).toBeNull();
  });
});

describe("fetchBoard", () => {
  it("gets {VITE_BUS_URL}/state and resolves the parsed object", async () => {
    const board = { jobs: [{ id: "j1" }], threads: {} };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => board,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const m = await loadModule("http://localhost:4010");
    expect(await m.fetchBoard()).toEqual(board);
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:4010/state");
  });

  it("resolves null without fetching when VITE_BUS_URL is unset", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const m = await loadModule("");
    expect(await m.fetchBoard()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves null when fetch rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("service down");
      })
    );
    const m = await loadModule("http://localhost:4010");
    expect(await m.fetchBoard()).toBeNull();
  });

  it("resolves null on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404 }))
    );
    const m = await loadModule("http://localhost:4010");
    expect(await m.fetchBoard()).toBeNull();
  });
});
