import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

function mockFetch(routes) {
  return vi.fn(async (url, options = {}) => {
    const path = url.replace("https://app.ambiguous.ai/api", "").replace(/^\/api/, "");
    for (const [key, responder] of Object.entries(routes)) {
      const [method, prefix] = key.split(" ");
      if (options.method === method || (method === "GET" && !options.method)) {
        if (path.startsWith(prefix)) {
          const body = responder(path, options.body);
          if (body == null) throw new Error("boom");
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
  it("reports disabled and returns null/mocked results", async () => {
    const m = await loadModule("");
    expect(m.ambiguousEnabled).toBe(false);
    expect(await m.fetchCoworkers()).toBeNull();
    expect(await m.fetchDaySummary()).toBeNull();
    expect(await m.handleRequest("schedule a meeting")).toBeNull();
    expect(await m.createTask("x")).toEqual({ mocked: true, title: "x" });
    expect(await m.sendConversation({ agentId: "a", transcript: "t", endedAt: "e" }))
      .toEqual({ ok: true, mocked: true });
  });
});

describe("coworkerToPersona", () => {
  it("maps an Ambiguous user to a persona", async () => {
    const m = await loadModule("ak_test");
    const p = m.coworkerToPersona(
      {
        id: "u1",
        type: "agent",
        display_name: "Nova",
        workspace_email: "n@w.ambi.cc",
        focus_areas: ["calendar", "mail", "tasks", "crm"],
      },
      0
    );
    expect(p.name).toBe("Nova");
    expect(p.role).toBe("AI Coworker");
    expect(p.initials).toBe("N");
    expect(p.greeting).toContain("Nova");
    expect(p.skills).toEqual(["calendar", "mail", "tasks"]);
    expect(p.voice).toEqual({ pitch: 0.85, rate: 1 });
  });

  it("falls back to default skills without focus_areas", async () => {
    const m = await loadModule("ak_test");
    const p = m.coworkerToPersona(
      { id: "u2", type: "agent", display_name: "Sage" },
      2
    );
    expect(p.skills).toEqual(["scheduling", "tasks"]);
    expect(p.voice.pitch).toBeCloseTo(1.09);
  });
});

describe("fetchCoworkers", () => {
  it("filters agents from /users", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /users": () => ({
          data: [
            { id: "1", type: "agent", display_name: "Nova" },
            { id: "2", type: "human", display_name: "Albin" },
          ],
        }),
      })
    );
    const m = await loadModule("ak_test");
    const list = await m.fetchCoworkers();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("Nova");
  });
});

describe("fetchDaySummary", () => {
  it("combines events and open tasks", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /calendars/events": () => ({
          data: [{ title: "Standup", start_at: "2026-09-12T16:30:00Z" }],
        }),
        "GET /tasks": () => ({
          data: [
            { title: "Ship it", status: "todo" },
            { title: "Old", status: "done" },
          ],
        }),
      })
    );
    const m = await loadModule("ak_test");
    const text = await m.fetchDaySummary();
    expect(text).toContain("Standup");
    expect(text).toContain("Ship it");
    expect(text).not.toContain("Old");
  });

  it("handles empty day gracefully", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /calendars/events": () => ({ data: [] }),
        "GET /tasks": () => ({ data: [] }),
      })
    );
    const m = await loadModule("ak_test");
    expect(await m.fetchDaySummary()).toContain("clear");
  });
});

describe("handleRequest", () => {
  it("speaks the assistant reply for non-scheduling requests", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "POST /assistant/chat": (path, body) => {
          const { message } = JSON.parse(body);
          return { response: `Assistant handled: ${message}` };
        },
      })
    );
    const m = await loadModule("ak_test");
    expect(await m.handleRequest("what's on the docket?")).toBe(
      "Assistant handled: what's on the docket?"
    );
  });

  it("strips markdown from assistant replies", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "POST /assistant/chat": () => ({
          response:
            'Try instead: - **"Will it run?"** - _"Is it up?"_ — `so soon`',
        }),
      })
    );
    const m = await loadModule("ak_test");
    const reply = await m.handleRequest("how should I phrase this?");
    expect(reply).toBe('Try instead: "Will it run?" "Is it up?" - so soon');
  });

  it("falls back to a task when the assistant has no reply", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "POST /assistant/chat": () => ({ status: "success" }),
        "POST /tasks": () => ({ task: { title: "buy milk", status: "todo" } }),
      })
    );
    const m = await loadModule("ak_test");
    const reply = await m.handleRequest("buy milk");
    expect(reply).toContain("buy milk");
  });

  it("creates a task for non-scheduling requests", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "POST /tasks": () => ({ task: { title: "buy milk", status: "todo" } }),
      })
    );
    const m = await loadModule("ak_test");
    const reply = await m.handleRequest("buy milk");
    expect(reply).toContain("buy milk");
    expect(reply).toContain("Is that all?");
  });

  it("books an event for scheduling requests", async () => {
    let posted;
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /users": () => ({
          data: [{ id: "u9", type: "human", display_name: "Albin" }],
        }),
        "GET /calendars/availability": () => ({ availability: { u9: [] } }),
        "GET /calendars": () => ({
          data: [{ id: "cal1", is_default: true }],
        }),
        "POST /calendars": (path, body) => {
          posted = JSON.parse(body);
          return { id: "ev1" };
        },
      })
    );
    const m = await loadModule("ak_test");
    const reply = await m.handleRequest(
      "schedule a meeting tomorrow morning with Albin"
    );
    expect(reply).toContain("Albin");
    expect(reply).toContain("Is that all?");
    expect(posted.title).toContain("Albin");
    expect(posted.attendees).toEqual([{ user_id: "u9" }]);
  });

  it("warns when the attendee isn't in the workspace", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /users": () => ({ data: [] }),
        "GET /calendars": () => ({ data: [{ id: "cal1" }] }),
        "POST /calendars": () => ({ id: "ev1" }),
      })
    );
    const m = await loadModule("ak_test");
    const reply = await m.handleRequest("meeting tomorrow with Ghost");
    expect(reply).toContain("isn't in the workspace");
  });

  it("matches an attendee by username when display_name misses", async () => {
    let posted;
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /users": () => ({
          data: [
            { id: "u7", type: "human", display_name: "A. Shrestha", username: "albin" },
          ],
        }),
        "GET /calendars/availability": () => ({ availability: { u7: [] } }),
        "GET /calendars": () => ({ data: [{ id: "cal1", is_default: true }] }),
        "POST /calendars": (path, body) => {
          posted = JSON.parse(body);
          return { id: "ev2" };
        },
      })
    );
    const m = await loadModule("ak_test");
    const reply = await m.handleRequest("meeting tomorrow with Albin");
    expect(reply).toContain("A. Shrestha");
    expect(posted.attendees).toEqual([{ user_id: "u7" }]);
  });
});

describe("sendConversation", () => {
  it("stores the transcript as a document", async () => {
    let posted;
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "POST /documents": (path, body) => {
          posted = JSON.parse(body);
          return { id: "doc1" };
        },
      })
    );
    const m = await loadModule("ak_test");
    const res = await m.sendConversation({
      agentId: "a1",
      transcript: "agent: hi",
      endedAt: "2026-09-12T19:00:00Z",
    });
    expect(res.ok).toBe(true);
    expect(posted.title).toContain("Call transcript");
    expect(posted.content).toContain("agent: hi");
  });

  it("returns ok:false on API failure instead of throwing", async () => {
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
