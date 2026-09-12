import { describe, it, expect, vi, afterEach } from "vitest";
import { geocode, driveMinutes, route, precipAt } from "./lookup.js";

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

describe("route", () => {
  it("returns rounded meters and minutes", async () => {
    stub({ routes: [{ distance: 5123.7, duration: 1530 }] });
    expect(await route({ lat: 1, lon: 2 }, { lat: 3, lon: 4 })).toEqual({
      meters: 5124,
      minutes: 26,
    });
  });

  it("calls OSRM driving with lon,lat order and overview off", async () => {
    const f = vi.fn(async () =>
      ok({ routes: [{ distance: 100, duration: 60 }] })
    );
    vi.stubGlobal("fetch", f);
    await route({ lat: 1, lon: 2 }, { lat: 3, lon: 4 });
    expect(f.mock.calls[0][0]).toContain(
      "router.project-osrm.org/route/v1/driving/2,1;4,3?overview=false"
    );
  });

  it("returns null without a route", async () => {
    stub({});
    expect(await route({ lat: 1, lon: 2 }, { lat: 3, lon: 4 })).toBeNull();
  });

  it("returns null when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })));
    expect(await route({ lat: 1, lon: 2 }, { lat: 3, lon: 4 })).toBeNull();
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
