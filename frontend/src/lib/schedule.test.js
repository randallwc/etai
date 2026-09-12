import { describe, it, expect } from "vitest";
import { slotStart, firstFreeSlot, formatSlot } from "./schedule.js";

const NOW = new Date("2026-09-12T09:00:00");

describe("slotStart", () => {
  it("returns the requested hour on the offset day", () => {
    const s = slotStart(1, 10, NOW);
    expect(s.getDate()).toBe(13);
    expect(s.getHours()).toBe(10);
    expect(s.getMinutes()).toBe(0);
  });
});

describe("firstFreeSlot", () => {
  it("returns the requested slot when nothing is busy", () => {
    const slot = firstFreeSlot([], 1, 10, NOW);
    expect(slot.start.getHours()).toBe(10);
    expect(slot.end.getHours()).toBe(10);
    expect(slot.end.getMinutes()).toBe(30);
  });

  it("skips past a conflicting busy block", () => {
    const busy = [{ start: "2026-09-13T09:30:00", end: "2026-09-13T10:30:00" }];
    const slot = firstFreeSlot(busy, 1, 10, NOW);
    expect(slot.start.getHours()).toBe(10);
    expect(slot.start.getMinutes()).toBe(30);
  });

  it("accepts start_at/end_at field names from the API", () => {
    const busy = [
      { start_at: "2026-09-13T10:00:00", end_at: "2026-09-13T10:30:00" },
    ];
    const slot = firstFreeSlot(busy, 1, 10, NOW);
    expect(slot.start.getHours()).toBe(10);
    expect(slot.start.getMinutes()).toBe(30);
  });

  it("returns null when the whole workday is busy", () => {
    const busy = [{ start: "2026-09-13T00:00:00", end: "2026-09-13T23:59:59" }];
    expect(firstFreeSlot(busy, 1, 10, NOW)).toBeNull();
  });
});

describe("formatSlot", () => {
  it("renders a human-friendly time", () => {
    expect(
      formatSlot({ start: new Date("2026-09-13T10:00:00") })
    ).toMatch(/10:00/);
  });
});
