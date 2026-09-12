import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

async function loadModule(url, demo) {
  vi.resetModules();
  vi.stubEnv("VITE_MESSAGING_URL", url ?? "");
  vi.stubEnv("VITE_DEMO_PHONE", demo ?? "");
  return import("./notify.js");
}

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllGlobals());

describe("etaMessage", () => {
  it("signs as the contractor's business with the customer name", async () => {
    const m = await loadModule();
    const text = m.etaMessage({
      contractor: { name: "Al's Lock & Key" },
      customer: { name: "Sam" },
      job: { id: "j1" },
      milesText: "4.2 mi",
      etaText: "~10:42 AM",
    });
    expect(text).toBe(
      "Hi Sam, Al's Lock & Key here - on my way, about 4.2 mi out, ETA ~10:42 AM."
    );
  });

  it("greets 'there' when the customer name is null", async () => {
    const m = await loadModule();
    const text = m.etaMessage({
      contractor: { name: "Al's Lock & Key" },
      customer: { name: null },
      job: { id: "j1" },
      milesText: "4.2 mi",
      etaText: "~10:42 AM",
    });
    expect(text).toContain("Hi there,");
    expect(text).toContain("Al's Lock & Key");
  });
});

describe("lateMessage", () => {
  it("states the delay and the new ETA", async () => {
    const m = await loadModule();
    const text = m.lateMessage({
      contractor: { name: "Al's Lock & Key" },
      customer: { name: "Sam" },
      minutes: 15,
      etaText: "2:16 PM",
    });
    expect(text).toBe(
      "Hi Sam, Al's Lock & Key here - running about 15 min late, new ETA 2:16 PM. Sorry for the delay."
    );
  });
});

describe("smsHref", () => {
  it("builds an sms: link with an encoded body", async () => {
    const m = await loadModule();
    const body = "on my way, ETA ~10:42 AM";
    expect(m.smsHref({ to: "+15551234567", body })).toBe(
      `sms:+15551234567?&body=${encodeURIComponent(body)}`
    );
  });
});

describe("sendSms", () => {
  it("posts { to, body, threadKey } to {VITE_MESSAGING_URL}/send", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ externalId: "msg-1" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const m = await loadModule("http://localhost:4020");
    const res = await m.sendSms({
      to: "+15551234567",
      body: "hi",
      threadKey: "+15551234567",
    });
    expect(res).toEqual({ sent: true, via: "messaging" });
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:4020/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: "+15551234567",
        body: "hi",
        threadKey: "+15551234567",
      }),
    });
  });

  it("reroutes every text to VITE_DEMO_PHONE when set", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const m = await loadModule("http://localhost:4020", "+15550100100");
    await m.sendSms({ to: "+15551234567", body: "hi", threadKey: "+15551234567" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      to: "+15550100100",
      body: "hi",
      threadKey: "+15550100100",
    });
  });

  it("resolves via:none without fetching when VITE_MESSAGING_URL is unset", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const m = await loadModule("");
    expect(
      await m.sendSms({ to: "+15551234567", body: "hi", threadKey: "+15551234567" })
    ).toEqual({ sent: false, via: "none" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves via:none when fetch rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("service down");
      })
    );
    const m = await loadModule("http://localhost:4020");
    expect(
      await m.sendSms({ to: "+15551234567", body: "hi", threadKey: "+15551234567" })
    ).toEqual({ sent: false, via: "none" });
  });

  it("resolves via:none on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500 }))
    );
    const m = await loadModule("http://localhost:4020");
    expect(
      await m.sendSms({ to: "+15551234567", body: "hi", threadKey: "+15551234567" })
    ).toEqual({ sent: false, via: "none" });
  });
});
