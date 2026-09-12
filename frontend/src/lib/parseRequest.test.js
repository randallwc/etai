import { describe, it, expect } from "vitest";
import { isDoneSignal, parseRequest, offlineReply } from "./parseRequest.js";

describe("isDoneSignal", () => {
  it.each(["yes", "Yeah!", "that's all", "done", "nope", "i'm good"])(
    "accepts %s",
    (s) => expect(isDoneSignal(s)).toBe(true)
  );
  it.each(["yes please schedule", "no wait", "sure thing buddy"])(
    "rejects %s",
    (s) => expect(isDoneSignal(s)).toBe(false)
  );
});

describe("parseRequest", () => {
  it("classifies non-scheduling text as a task", () => {
    expect(parseRequest("buy milk")).toEqual({ kind: "task" });
  });

  it("extracts the attendee name after 'with'", () => {
    const r = parseRequest("schedule a meeting with Albin tomorrow morning");
    expect(r.kind).toBe("schedule");
    expect(r.withName).toBe("Albin");
    expect(r.dayOffset).toBe(1);
    expect(r.hour).toBe(10);
  });

  it("defaults to today and morning when unspecified", () => {
    const r = parseRequest("book a sync");
    expect(r.dayOffset).toBe(0);
    expect(r.hour).toBe(10);
  });

  it("parses explicit times", () => {
    expect(parseRequest("call Sam at 3pm").hour).toBe(15);
    expect(parseRequest("meet at 9:30am with Jo").hour).toBe(9);
  });

  it("handles afternoon, evening, lunch, and next week", () => {
    expect(parseRequest("meeting tomorrow afternoon").hour).toBe(14);
    expect(parseRequest("call tomorrow evening").hour).toBe(18);
    expect(parseRequest("lunch with Ana").hour).toBe(12);
    expect(parseRequest("meeting next week").dayOffset).toBe(7);
  });
});

describe("offlineReply", () => {
  it("confirms a scheduled meeting with name and time", () => {
    const r = offlineReply("schedule a meeting tomorrow morning with Albin");
    expect(r).toContain("Albin");
    expect(r).toContain("10am tomorrow");
    expect(r).toContain("Is that all?");
  });

  it("acknowledges a task", () => {
    expect(offlineReply("buy milk")).toContain("task");
  });
});
