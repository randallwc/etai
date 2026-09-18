/**
 * Transport tests for the only Ambiguous call the frontend makes:
 * storing the call transcript as a workspace document. Minimum
 * because sendConversation is the api module's only export.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

async function loadModule(key) {
  vi.resetModules();
  vi.stubEnv("VITE_AMBIGUOUS_API_KEY", key ?? "");
  return import("./ambiguous.js");
}

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllGlobals());

describe("sendConversation", () => {
  it("resolves mocked without an API key and never fetches", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const m = await loadModule("");
    expect(
      await m.sendConversation({ agentId: "a", transcript: "t", endedAt: "e" })
    ).toEqual({ ok: true, mocked: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the transcript as a document", async () => {
    const fetchMock = vi.fn(async (url, options) => {
      const parsed = JSON.parse(options.body);
      expect(url).toContain("/documents");
      expect(parsed.type).toBe("doc");
      expect(parsed.content).toContain("transcript here");
      return { ok: true, json: async () => ({ id: "d1" }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const m = await loadModule("ak_test");
    const res = await m.sendConversation({
      agentId: "etai",
      transcript: "transcript here",
      endedAt: "2026-01-01T00:00:00Z",
    });
    expect(res).toEqual({ ok: true, docId: "d1" });
  });

  it("returns ok:false when the request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }))
    );
    const m = await loadModule("ak_test");
    const res = await m.sendConversation({
      agentId: "a",
      transcript: "t",
      endedAt: "e",
    });
    expect(res.ok).toBe(false);
  });
});
