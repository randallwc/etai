import { describe, it, expect, beforeEach } from "vitest";
import { loadBoard, saveBoard, seedBoard, transition } from "./jobs.js";

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
    expect(board.customers.length).toBeGreaterThanOrEqual(3);
    expect(board.jobs.length).toBeGreaterThanOrEqual(3);
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
    localStorage.setItem("etai.board.v3", "{not json");
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
    const enRoute = board.jobs.find((j) => j.status === "en_route");
    const next = board.jobs.find((j) => j.status === "confirmed");
    board = transition(board, next.id, "depart");
    expect(board.jobs.find((j) => j.id === next.id).status).toBe("en_route");
    expect(board.jobs.find((j) => j.id === enRoute.id).status).toBe(
      "confirmed"
    );
  });
});
