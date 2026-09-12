import { describe, it, expect } from "vitest";
import { formatMiles, etaLabel, etaClock } from "./eta.js";

describe("formatMiles", () => {
  it("converts meters to one-decimal miles", () => {
    expect(formatMiles(5150)).toBe("3.2 mi");
  });

  it("handles zero", () => {
    expect(formatMiles(0)).toBe("0.0 mi");
  });
});

describe("etaLabel", () => {
  it("rounds and prefixes minutes", () => {
    expect(etaLabel(25)).toBe("~25 min");
    expect(etaLabel(24.6)).toBe("~25 min");
  });

  it("says arriving under two minutes", () => {
    expect(etaLabel(1)).toBe("arriving");
    expect(etaLabel(0)).toBe("arriving");
  });
});

describe("etaClock", () => {
  it("adds minutes to now and formats h:mm AM/PM", () => {
    expect(etaClock(12, new Date(2026, 8, 13, 10, 30))).toBe("10:42 AM");
  });

  it("rolls past noon and midnight correctly", () => {
    expect(etaClock(20, new Date(2026, 8, 13, 23, 50))).toBe("12:10 AM");
    expect(etaClock(5, new Date(2026, 8, 13, 12, 0))).toBe("12:05 PM");
    expect(etaClock(0, new Date(2026, 8, 13, 0, 5))).toBe("12:05 AM");
  });
});
