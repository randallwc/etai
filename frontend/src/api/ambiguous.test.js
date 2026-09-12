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

  it("uses the username and Teammate role for non-agent users", async () => {
    const m = await loadModule("ak_test");
    const p = m.coworkerToPersona(
      { id: "u3", type: "human", username: "albin" },
      1
    );
    expect(p.name).toBe("albin");
    expect(p.role).toBe("Teammate");
    expect(p.tagline).toContain("the workspace");
    expect(p.skills).toEqual(["scheduling", "tasks"]);
  });

  it("names the persona Coworker when no name fields exist", async () => {
    const m = await loadModule("ak_test");
    const p = m.coworkerToPersona({ id: "u4", type: "agent" });
    expect(p.name).toBe("Coworker");
    expect(p.initials).toBe("C");
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

  it("returns an empty list when /users has no data", async () => {
    vi.stubGlobal("fetch", mockFetch({ "GET /users": () => ({}) }));
    const m = await loadModule("ak_test");
    expect(await m.fetchCoworkers()).toEqual([]);
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

  it("leaves cancelled tasks out of the open list", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /calendars/events": () => ({ data: [] }),
        "GET /tasks": () => ({
          data: [{ title: "Nope", status: "cancelled" }],
        }),
      })
    );
    const m = await loadModule("ak_test");
    expect(await m.fetchDaySummary()).not.toContain("Nope");
  });

  it("reports a clear day when both fetches fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }))
    );
    const m = await loadModule("ak_test");
    expect(await m.fetchDaySummary()).toBe("Your calendar is clear today.");
  });
});

describe("createTask", () => {
  it("posts to /tasks when enabled", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "POST /tasks": () => ({ task: { title: "x", status: "todo" } }),
      })
    );
    const m = await loadModule("ak_test");
    expect(await m.createTask("x")).toEqual({ title: "x", status: "todo" });
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

  it("strips links, bullets, and headings from assistant replies", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "POST /assistant/chat": () => ({
          response:
            "## Plan\n- first item\n1. second item\nsee [the docs](https://example.com)",
        }),
      })
    );
    const m = await loadModule("ak_test");
    const reply = await m.handleRequest("write this up");
    expect(reply).toBe("Plan\nfirst item\nsecond item\nsee the docs");
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

  it("repeats the request text when the created task has no title", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "POST /assistant/chat": () => ({ status: "success" }),
        "POST /tasks": () => ({ task: null }),
      })
    );
    const m = await loadModule("ak_test");
    const reply = await m.handleRequest("buy milk");
    expect(reply).toContain('task "buy milk"');
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

  it("uses the request name when the attendee has no display_name", async () => {
    let posted;
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /users": () => ({
          data: [
            { id: "u6", type: "human" },
            { id: "u5", type: "human", username: "albin" },
          ],
        }),
        "GET /calendars/events": () => ({ data: [] }),
        "GET /calendars": () => ({ data: [{ id: "cal1", is_default: true }] }),
        "POST /calendars": (path, body) => {
          posted = JSON.parse(body);
          return { id: "ev3" };
        },
      })
    );
    const m = await loadModule("ak_test");
    const reply = await m.handleRequest("meeting tomorrow with Albin");
    expect(reply).toContain("with Albin");
    expect(posted.title).toBe("Meeting with Albin");
  });

  it("still warns when the user lookup itself fails", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /calendars/events": () => ({ data: [] }),
        "GET /calendars": () => ({ data: [{ id: "cal1", is_default: true }] }),
        "POST /calendars": () => ({ id: "ev4" }),
      })
    );
    const m = await loadModule("ak_test");
    const reply = await m.handleRequest("meeting tomorrow with Nobody");
    expect(reply).toContain("isn't in the workspace");
  });

  it("warns when the workspace returns no user list", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /users": () => ({}),
        "GET /calendars/events": () => ({ data: [] }),
        "GET /calendars": () => ({ data: [{ id: "cal1", is_default: true }] }),
        "POST /calendars": () => ({ id: "ev5" }),
      })
    );
    const m = await loadModule("ak_test");
    const reply = await m.handleRequest("meeting tomorrow with Ghost");
    expect(reply).toContain("isn't in the workspace");
  });

  it("says fully booked when no slot is free that day", async () => {
    const start = new Date();
    start.setDate(start.getDate() + 1);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setHours(23, 59, 0, 0);
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /calendars/events": () => ({
          data: [
            {
              title: "All day",
              start_at: start.toISOString(),
              end_at: end.toISOString(),
            },
          ],
        }),
        "GET /calendars": () => ({ data: [{ id: "cal1", is_default: true }] }),
        "POST /calendars": () => ({ id: "ev6" }),
      })
    );
    const m = await loadModule("ak_test");
    const reply = await m.handleRequest("schedule a meeting tomorrow");
    expect(reply).toContain("fully booked");
  });

  it("titles a slot with no attendee or location as Appointment", async () => {
    let posted;
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /calendars/events": () => ({}),
        "GET /calendars": () => ({ data: [{ id: "cal2", is_default: false }] }),
        "POST /calendars": (path, body) => {
          posted = JSON.parse(body);
          return { id: "ev7" };
        },
      })
    );
    const m = await loadModule("ak_test");
    const reply = await m.handleRequest("schedule a call tomorrow");
    expect(posted.title).toBe("Appointment");
    expect(posted.attendees).toEqual([]);
    expect(reply).toContain("Done - booked");
    expect(reply).not.toContain(" with ");
  });

  it("adds drive and rain checks for a job at a location", async () => {
    let posted;
    const prevStart = new Date();
    prevStart.setDate(prevStart.getDate() + 1);
    prevStart.setHours(8, 0, 0, 0);
    const prevEnd = new Date(prevStart);
    prevEnd.setHours(8, 30, 0, 0);
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /calendars/events": () => ({
          data: [
            {
              title: "Install",
              start: prevStart.toISOString(),
              end: prevEnd.toISOString(),
              location: "Old Site",
            },
          ],
        }),
        "GET /calendars": () => ({ data: [{ id: "cal1", is_default: true }] }),
        "POST /calendars": (path, body) => {
          posted = JSON.parse(body);
          return { id: "ev8" };
        },
        "GET https://nominatim.openstreetmap.org/search": (path) =>
          path.includes("Old")
            ? [{ lat: "41", lon: "-73" }]
            : [{ lat: "40.7", lon: "-74" }],
        "GET https://router.project-osrm.org": () => ({
          routes: [{ duration: 1800 }],
        }),
        "GET https://api.open-meteo.com": () => ({
          hourly: {
            time: ["2000-01-01T00:00"],
            precipitation_probability: [80],
          },
        }),
      })
    );
    const m = await loadModule("ak_test");
    const reply = await m.handleRequest("book a job at Downtown Plaza tomorrow");
    expect(posted.title).toBe("Job at Downtown Plaza");
    expect(posted.location).toBe("Downtown Plaza");
    expect(reply).toContain("drive");
    expect(reply).toContain("rain");
    expect(reply).toContain("Is that all?");
  });

  it("skips travel when the previous job has no location", async () => {
    const prevStart = new Date();
    prevStart.setDate(prevStart.getDate() + 1);
    prevStart.setHours(8, 0, 0, 0);
    const prevEnd = new Date(prevStart);
    prevEnd.setHours(8, 30, 0, 0);
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /calendars/events": () => ({
          data: [
            {
              title: "Call",
              start_at: prevStart.toISOString(),
              end_at: prevEnd.toISOString(),
            },
          ],
        }),
        "GET /calendars": () => ({ data: [{ id: "cal1", is_default: true }] }),
        "POST /calendars": () => ({ id: "ev9" }),
        "GET https://nominatim.openstreetmap.org/search": () => [
          { lat: "40.7", lon: "-74" },
        ],
        "GET https://api.open-meteo.com": () => ({
          hourly: {
            time: ["2000-01-01T00:00"],
            precipitation_probability: [10],
          },
        }),
      })
    );
    const m = await loadModule("ak_test");
    const reply = await m.handleRequest("book a job at Downtown Plaza tomorrow");
    expect(reply).toContain("10% chance of rain");
    expect(reply).not.toContain("drive");
  });

  it("books anyway when the weather lookup fails", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /calendars/events": () => ({ data: [] }),
        "GET /calendars": () => ({ data: [{ id: "cal1", is_default: true }] }),
        "POST /calendars": () => ({ id: "ev10" }),
        "GET https://nominatim.openstreetmap.org/search": () => [
          { lat: "40.7", lon: "-74" },
        ],
      })
    );
    const m = await loadModule("ak_test");
    const reply = await m.handleRequest("book a job at Downtown Plaza tomorrow");
    expect(reply).toContain("Done - booked");
    expect(reply).toContain("Is that all?");
  });

  it("books anyway when geocoding the location fails", async () => {
    let posted;
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /calendars/events": () => ({ data: [] }),
        "GET /calendars": () => ({ data: [{ id: "cal1", is_default: true }] }),
        "POST /calendars": (path, body) => {
          posted = JSON.parse(body);
          return { id: "ev11" };
        },
      })
    );
    const m = await loadModule("ak_test");
    const reply = await m.handleRequest("book a job at Downtown Plaza tomorrow");
    expect(posted.title).toBe("Job at Downtown Plaza");
    expect(reply).toContain("Done - booked");
  });

  it("rejects when the workspace has no calendars", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /calendars": () => ({}),
      })
    );
    const m = await loadModule("ak_test");
    await expect(
      m.handleRequest("schedule a call tomorrow")
    ).rejects.toThrow();
  });
});

describe("api base", () => {
  it("targets the production host when DEV is off", async () => {
    vi.stubEnv("DEV", "");
    let seen;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        seen = url;
        return { ok: true, json: async () => ({ data: [] }) };
      })
    );
    const m = await loadModule("ak_test");
    await m.fetchCoworkers();
    expect(seen).toBe("https://app.ambiguous.ai/api/users");
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

describe("createJobPacket", () => {
  const PACKET_ROUTES = {
    "POST /forms": (path, body) => ({
      id: "form1",
      slug: "intake-x",
      workspace_slug: "etai-workspace",
      ...JSON.parse(body),
    }),
    "POST /documents": (path, body) => ({ id: "doc1", ...JSON.parse(body) }),
    "POST /sign": () => ({ document: { id: "sign1", status: "draft" } }),
    "POST /tasks": (path, body) => ({ task: { id: "task1", ...JSON.parse(body) } }),
  };

  it("creates the intake form, work order, sign draft, and task", async () => {
    const seen = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, options = {}) => {
        const path = url
          .replace("https://app.ambiguous.ai/api", "")
          .replace(/^\/api/, "");
        seen.push(`${options.method ?? "GET"} ${path}`);
        for (const [key, responder] of Object.entries(PACKET_ROUTES)) {
          const [method, prefix] = key.split(" ");
          if (options.method === method && path.startsWith(prefix)) {
            return { ok: true, json: async () => responder(path, options.body) };
          }
        }
        return { ok: false, status: 404, json: async () => ({}) };
      })
    );
    const m = await loadModule("ak_test");
    const p = await m.createJobPacket({
      title: "Sink fix - Marta",
      location: "22 main st",
      when: "tomorrow 9:00 AM",
    });
    expect(p.formUrl).toBe(
      "https://app.ambiguous.ai/f/etai-workspace/intake-x"
    );
    expect(p.documentId).toBe("doc1");
    expect(p.signDocumentId).toBe("sign1");
    expect(p.errors).toEqual([]);
    expect(seen).toContain("POST /sign");
    expect(seen).toContain("POST /tasks");
  });

  it("is non-fatal per step and skips sign without a doc", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "POST /forms": () => null,
        "POST /documents": () => null,
        "POST /tasks": (path, body) => ({ task: { id: "t" } }),
      })
    );
    const m = await loadModule("ak_test");
    const p = await m.createJobPacket({ title: "x", when: "y" });
    expect(p.formUrl).toBeUndefined();
    expect(p.signDocumentId).toBeUndefined();
    expect(p.errors.map((e) => e.step).sort()).toEqual(["form", "work_order"]);
  });

  it("returns null without an API key", async () => {
    const m = await loadModule("");
    expect(await m.createJobPacket({ title: "x", when: "y" })).toBeNull();
  });
});
