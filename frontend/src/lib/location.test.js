import { describe, it, expect, vi, afterEach } from "vitest";
import { currentPosition } from "./location.js";

afterEach(() => vi.unstubAllGlobals());

describe("currentPosition", () => {
  it("resolves lat/lon from geolocation", async () => {
    vi.stubGlobal("navigator", {
      geolocation: {
        getCurrentPosition: (ok) =>
          ok({ coords: { latitude: 47.6, longitude: -122.3 } }),
      },
    });
    expect(await currentPosition()).toEqual({ lat: 47.6, lon: -122.3 });
  });

  it("resolves null when the user denies", async () => {
    vi.stubGlobal("navigator", {
      geolocation: {
        getCurrentPosition: (_ok, err) => err(new Error("denied")),
      },
    });
    expect(await currentPosition()).toBeNull();
  });

  it("resolves null when geolocation is missing", async () => {
    vi.stubGlobal("navigator", undefined);
    expect(await currentPosition()).toBeNull();
  });
});
