import { describe, it, expect } from "vitest";
import { runChecks, summarizeChecks } from "./checks.js";

const slot = (h, m = 0) => ({
  start: new Date(2026, 8, 13, h, m),
  end: new Date(2026, 8, 13, h, m + 30),
});

describe("runChecks", () => {
  it("passes a slot inside working hours", () => {
    expect(runChecks({ slot: slot(10) })[0].ok).toBe(true);
  });

  it("flags a slot outside working hours", () => {
    const c = runChecks({ slot: slot(19) })[0];
    expect(c.ok).toBe(false);
    expect(c.warn).toContain("working hours");
  });

  it("flags a drive that doesn't fit the gap since the last job", () => {
    const [, travel] = runChecks({
      slot: slot(10),
      prevEnd: new Date(2026, 8, 13, 9, 45),
      travelMinutes: 30,
    });
    expect(travel.ok).toBe(false);
    expect(travel.warn).toContain("15");
  });

  it("passes a short drive with no previous job", () => {
    const [, travel] = runChecks({ slot: slot(10), travelMinutes: 20 });
    expect(travel.ok).toBe(true);
    expect(travel.detail).toContain("20 min");
  });

  it("flags rain above the threshold", () => {
    const checks = runChecks({ slot: slot(10), precipProb: 80 });
    expect(checks.at(-1).name).toBe("weather");
    expect(checks.at(-1).ok).toBe(false);
  });

  it("omits checks whose inputs weren't fetched", () => {
    expect(runChecks({ slot: slot(10) })).toHaveLength(1);
  });
});

describe("summarizeChecks", () => {
  it("joins passing details into one spoken line", () => {
    const text = summarizeChecks(
      runChecks({ slot: slot(10), travelMinutes: 20, precipProb: 10 })
    );
    expect(text).toContain("within working hours");
    expect(text).toContain("20 min drive");
    expect(text).toContain("10% chance of rain");
  });

  it("surfaces failures as heads-up warnings", () => {
    const text = summarizeChecks(runChecks({ slot: slot(19) }));
    expect(text).toContain("heads up");
  });

  it("returns empty string with no checks", () => {
    expect(summarizeChecks([])).toBe("");
  });
});
