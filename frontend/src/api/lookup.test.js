import { describe, it, expect, vi, afterEach } from "vitest";
import { geocode, driveMinutes, precipAt } from "./lookup.js";

afterEach(() => vi.unstubAllGlobals());

const ok = (body) => ({ ok: true, json: async () => body });
const stub = (body) => vi.stubGlobal("fetch", vi.fn(async () => ok(body)));

describe("geocode", () => {
  it("returns lat/lon for a hit", async () => {
    stub([{ lat: "47.6", lon: "-122.3" }]);
    expect(await geocode("Seattle")).toEqual({ lat: 47.6, lon: -122.3 });
  });

  it("returns null when nothing is found", async () => {
    stub([]);
    expect(await geocode("nowhere")).toBeNull();
  });
});

describe("driveMinutes", () => {
  it("rounds OSRM duration to minutes", async () => {
    stub({ routes: [{ duration: 1530 }] });
    expect(await driveMinutes({ lat: 1, lon: 2 }, { lat: 3, lon: 4 })).toBe(26);
  });

  it("returns null without a route", async () => {
    stub({});
    expect(await driveMinutes({ lat: 1, lon: 2 }, { lat: 3, lon: 4 })).toBeNull();
  });
});

describe("precipAt", () => {
  it("returns the probability nearest the requested hour", async () => {
    stub({
      hourly: {
        time: ["2026-09-13T14:00", "2026-09-13T15:00"],
        precipitation_probability: [80, 20],
      },
    });
    expect(
      await precipAt(47.6, -122.3, new Date("2026-09-13T15:10:00"))
    ).toBe(20);
  });

  it("returns null when hourly data is missing", async () => {
    stub({});
    expect(await precipAt(0, 0, new Date())).toBeNull();
  });
});
