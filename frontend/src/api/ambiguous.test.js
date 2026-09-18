import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

function mockFetch(routes) {
  return vi.fn(async (url, options = {}) => {
    const path = url
      .replace("https://app.ambiguous.ai/api", "")
      .replace(/^\/api/, "");
    for (const [key, responder] of Object.entries(routes)) {
      const [method, prefix] = key.split(" ");
      if (options.method === method || (method === "GET" && !options.method)) {
        if (path.startsWith(prefix)) {
          const body = responder(path, options.body);
          return { ok: true, json: async () => body };
        }
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

async function loadModule(key) {
  vi.resetModules();
  vi.stubEnv("VITE_AMBIGUOUS_API_KEY", key ?? "");
  return import("./ambiguous.js");
}

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllGlobals());

describe("offline (no API key)", () => {
  it("returns null/mocked results", async () => {
    const m = await loadModule("");
    expect(await m.fetchCalendarJobs()).toBeNull();
    expect(
      await m.sendConversation({ agentId: "a", transcript: "t", endedAt: "e" })
    ).toEqual({ ok: true, mocked: true });
  });
});

describe("fetchCalendarJobs", () => {
  it("returns events and contacts", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /calendars/events": () => ({ data: [{ id: "e1" }] }),
        "GET /crm/contacts": () => ({ data: [{ id: "c1" }] }),
      })
    );
    const m = await loadModule("ak_test");
    const res = await m.fetchCalendarJobs();
    expect(res.events).toEqual([{ id: "e1" }]);
    expect(res.contacts).toEqual([{ id: "c1" }]);
  });

  it("returns empty contacts when CRM fails", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /calendars/events": () => ({ data: [{ id: "e1" }] }),
      })
    );
    const m = await loadModule("ak_test");
    const res = await m.fetchCalendarJobs();
    expect(res.contacts).toEqual([]);
  });
});

describe("sendConversation", () => {
  it("posts the transcript as a document", async () => {
    const f = mockFetch({
      "POST /documents": (path, body) => {
        const parsed = JSON.parse(body);
        expect(parsed.type).toBe("doc");
        expect(parsed.content).toContain("transcript here");
        return { id: "d1" };
      },
    });
    vi.stubGlobal("fetch", f);
    const m = await loadModule("ak_test");
    const res = await m.sendConversation({
      agentId: "etai",
      transcript: "transcript here",
      endedAt: "2026-01-01T00:00:00Z",
    });
    expect(res).toEqual({ ok: true, docId: "d1" });
  });

  it("returns ok:false when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })));
    const m = await loadModule("ak_test");
    const res = await m.sendConversation({
      agentId: "a",
      transcript: "t",
      endedAt: "e",
    });
    expect(res.ok).toBe(false);
  });
});
