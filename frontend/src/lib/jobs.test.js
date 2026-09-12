import { describe, it, expect, beforeEach } from "vitest";
import {
  loadBoard,
  mergeCalendarJobs,
  saveBoard,
  seedBoard,
  transition,
} from "./jobs.js";

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    clear: () => data.clear(),
  };
}

beforeEach(() => {
  globalThis.localStorage = memoryStorage();
});

describe("seedBoard", () => {
  it("returns the locksmith demo board", () => {
    const board = seedBoard();
    expect(board.contractor.trade).toBe("locksmith");
    expect(board.customers.length).toBeGreaterThanOrEqual(1);
    expect(board.jobs.length).toBeGreaterThanOrEqual(1);
  });

  it("returns a fresh copy on each call", () => {
    const board = seedBoard();
    board.jobs[0].status = "canceled";
    expect(seedBoard().jobs[0].status).not.toBe("canceled");
  });

  it("anchors the earliest active job to today", () => {
    const starts = seedBoard()
      .jobs.filter((j) => j.status !== "done" && j.status !== "canceled")
      .map((j) => new Date(j.window.start));
    expect(new Date(Math.min(...starts)).toDateString()).toBe(
      new Date().toDateString()
    );
  });

  it("seeds at most one en_route job", () => {
    const n = seedBoard().jobs.filter((j) => j.status === "en_route").length;
    expect(n).toBeLessThanOrEqual(1);
  });
});

describe("loadBoard and saveBoard", () => {
  it("falls back to the seed when storage is empty", () => {
    expect(loadBoard()).toEqual(seedBoard());
  });

  it("round-trips a saved board", () => {
    const board = transition(seedBoard(), "job_lockout", "depart");
    saveBoard(board);
    expect(loadBoard()).toEqual(board);
  });

  it("falls back to the seed on corrupt JSON", () => {
    localStorage.setItem("etai.board.v4", "{not json");
    expect(loadBoard()).toEqual(seedBoard());
  });

  it("does not throw when localStorage is unavailable", () => {
    delete globalThis.localStorage;
    expect(() => saveBoard(seedBoard())).not.toThrow();
    expect(loadBoard()).toEqual(seedBoard());
  });
});

describe("transition", () => {
  it.each([
    ["depart", "en_route"],
    ["resolve", "done"],
    ["cancel", "canceled"],
  ])("maps %s to %s", (action, status) => {
    const board = seedBoard();
    const jobId = board.jobs[0].id;
    const next = transition(board, jobId, action);
    expect(next.jobs.find((job) => job.id === jobId).status).toBe(status);
  });

  it("does not mutate the input board", () => {
    const board = seedBoard();
    const jobId = board.jobs[0].id;
    const before = board.jobs[0].status;
    transition(board, jobId, "depart");
    expect(board.jobs[0].status).toBe(before);
  });

  it("returns the same board on an unknown action", () => {
    const board = seedBoard();
    expect(transition(board, board.jobs[0].id, "teleport")).toBe(board);
  });

  it("returns the same board on an unknown jobId", () => {
    const board = seedBoard();
    expect(transition(board, "job_nope", "depart")).toBe(board);
  });

  it("demotes the other en_route job when a second job departs", () => {
    let board = seedBoard();
    const next = board.jobs.find((j) => j.status === "confirmed");
    board.jobs.push({ ...next, id: "job_other", status: "en_route" });
    board = transition(board, next.id, "depart");
    expect(board.jobs.find((j) => j.id === next.id).status).toBe("en_route");
    expect(board.jobs.find((j) => j.id === "job_other").status).toBe(
      "confirmed"
    );
  });
});

describe("mergeCalendarJobs", () => {
  const NOW = new Date("2026-09-12T18:00:00Z");
  const base = {
    contractor: { id: "contractor" },
    customers: [
      { id: "cust_a", name: "Marta Reyes", phone: "+15550101010" },
    ],
    jobs: [],
  };
  const ev = (over = {}) => ({
    id: "ev1",
    title: "Meeting with Dana",
    start_at: "2026-09-13T16:00:00Z",
    end_at: "2026-09-13T17:00:00Z",
    ...over,
  });

  it("turns an event into a job and a customer from the Client line", () => {
    const board = mergeCalendarJobs(
      base,
      [
        ev({
          description: "fix lock\nClient: Dana Kim +15559877655",
          location: "12 Main St",
        }),
      ],
      [],
      NOW
    );
    const job = board.jobs[0];
    expect(job.ambiguousEventId).toBe("ev1");
    expect(job.status).toBe("confirmed");
    expect(job.address).toBe("12 Main St");
    expect(job.description).toBe("fix lock");
    const cust = board.customers.find((c) => c.id === job.customerId);
    expect(cust.name).toBe("Dana Kim");
    expect(cust.phone).toBe("+15559877655");
  });

  it("matches an existing customer by phone digits and keeps crm id", () => {
    const contacts = [{ id: "crm-9", name: "Marta R", phone: "1 (555) 010-1010" }];
    const board = mergeCalendarJobs(
      base,
      [ev({ title: "lockout +15550101010", description: "Client: unknown" })],
      contacts,
      NOW
    );
    expect(board.jobs[0].customerId).toBe("cust_a");
    expect(board.customers.length).toBe(1);
    expect(board.customers[0].ambiguousCrmId).toBeUndefined();
  });

  it("marks past events done and cancelled events canceled", () => {
    const board = mergeCalendarJobs(
      base,
      [
        ev({ id: "old", end_at: "2026-09-12T10:00:00Z" }),
        ev({ id: "gone", status: "cancelled", title: "x" }),
      ],
      [],
      NOW
    );
    expect(board.jobs.find((j) => j.ambiguousEventId === "old").status).toBe("done");
    expect(board.jobs.find((j) => j.ambiguousEventId === "gone").status).toBe("canceled");
  });

  it("keeps local status for a tracked event and drops vanished ones", () => {
    const seeded = {
      ...base,
      jobs: [
        {
          id: "job_1",
          customerId: "cust_a",
          contractorId: "contractor",
          ambiguousEventId: "ev1",
          status: "en_route",
          window: { start: "s", end: "e" },
          description: "lockout",
          source: "message",
          eta: "eta1",
        },
        {
          id: "job_2",
          customerId: "cust_a",
          contractorId: "contractor",
          ambiguousEventId: "ev_gone",
          status: "confirmed",
          window: { start: "s", end: "e" },
          description: "old",
          source: "message",
        },
        {
          id: "job_local",
          customerId: "cust_a",
          contractorId: "contractor",
          status: "confirmed",
          window: { start: "s", end: "e" },
          description: "local only",
          source: "message",
        },
      ],
    };
    const board = mergeCalendarJobs(seeded, [ev()], [], NOW);
    const kept = board.jobs.find((j) => j.ambiguousEventId === "ev1");
    expect(kept.id).toBe("job_1");
    expect(kept.status).toBe("en_route");
    expect(kept.eta).toBe("eta1");
    expect(kept.source).toBe("message");
    expect(board.jobs.some((j) => j.ambiguousEventId === "ev_gone")).toBe(false);
    expect(board.jobs.some((j) => j.id === "job_local")).toBe(true);
  });
});
