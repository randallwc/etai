import { useEffect, useState } from "react";
import MapView from "./MapView.jsx";
import { fmtWindow } from "./Board.jsx";
import { geocode, route } from "../api/lookup.js";
import { etaMessage, sendSms, smsHref } from "../api/notify.js";
import { etaClock, etaLabel, formatMiles } from "../lib/eta.js";
import { currentPosition } from "../lib/location.js";

const geoCache = new Map();

async function geocodeCached(address) {
  if (!address) return null;
  if (!geoCache.has(address)) {
    geoCache.set(address, await geocode(address).catch(() => null));
  }
  return geoCache.get(address);
}

async function contractorPosition(homeBaseAddress) {
  return (await currentPosition()) ?? (await geocodeCached(homeBaseAddress));
}

export default function JobDetail({ job, customer, contractor, onAction }) {
  const [pos, setPos] = useState(null);
  const [dest, setDest] = useState();
  const [routeInfo, setRouteInfo] = useState();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    let live = true;
    geocodeCached(job.address).then((g) => live && setDest(g));
    return () => {
      live = false;
    };
  }, [job.address]);

  useEffect(() => {
    if (dest === undefined) return;
    if (!dest) {
      setRouteInfo(null);
      return;
    }
    let live = true;
    contractorPosition(contractor.homeBaseAddress)
      .then((p) => {
        if (!live) return null;
        setPos(p);
        return p ? route(p, dest) : null;
      })
      .then((r) => live && setRouteInfo(r));
    return () => {
      live = false;
    };
  }, [dest, contractor.homeBaseAddress]);

  async function onMyWay() {
    if (!customer) return;
    setBusy(true);
    setNotice(null);
    const p = await contractorPosition(contractor.homeBaseAddress);
    if (p) setPos(p);
    const r = p && dest ? await route(p, dest) : null;
    if (!r) {
      setNotice({ error: "Couldn't get a driving route to that address." });
      setBusy(false);
      return;
    }
    setRouteInfo(r);
    const body = etaMessage({
      contractor,
      customer,
      job,
      milesText: formatMiles(r.meters),
      etaText: etaClock(r.minutes),
    });
    const res = await sendSms({
      to: customer.phone,
      body,
      threadKey: customer.phone,
    });
    setNotice({ body, via: res.via });
    onAction(job.id, "depart");
    setBusy(false);
  }

  const done = job.status === "done" || job.status === "canceled";

  return (
    <div className="job-detail">
      <header className="jd-head">
        <div>
          <h1>{customer?.name ?? "Customer"}</h1>
          <div className="jd-sub">
            {customer?.phone && (
              <a href={`tel:${customer.phone}`}>{customer.phone}</a>
            )}
            {customer?.phone && " · "}
            {job.address}
          </div>
          <div className="jd-desc">{job.description}</div>
          <div className="jd-window">{fmtWindow(job.window)}</div>
          {customer?.notes && (
            <div className="jd-window">Notes: {customer.notes}</div>
          )}
        </div>
        <span className={`chip st-${job.status}`}>
          {job.status.replace("_", " ")}
        </span>
      </header>

      <div className="map-slot">
        <MapView
          customer={dest ? { ...dest, label: job.address } : { label: job.address }}
          contractor={pos}
        />
      </div>

      <div className="eta-readout">
        <div className="eta-big">
          {routeInfo ? formatMiles(routeInfo.meters) : "—"}
        </div>
        <div className="eta-sub">
          {routeInfo === undefined && "Locating…"}
          {routeInfo === null && "Route unavailable"}
          {routeInfo &&
            `${etaLabel(routeInfo.minutes)} · ETA ${etaClock(routeInfo.minutes)}`}
        </div>
      </div>

      {done ? (
        <div className="jd-done">This job is {job.status}.</div>
      ) : (
        <div className="jd-actions">
          <button
            className="btn-primary"
            onClick={onMyWay}
            disabled={busy || !customer || dest === undefined}
          >
            {busy
              ? "Sending…"
              : job.status === "en_route"
                ? "Resend ETA"
                : "On my way"}
          </button>
          <button
            className="btn-secondary"
            onClick={() => onAction(job.id, "resolve")}
          >
            Mark resolved
          </button>
        </div>
      )}

      {notice?.error && <div className="notice error">{notice.error}</div>}
      {notice?.body && (
        <div className="notice">
          <div className="notice-label">
            {notice.via === "none"
              ? "Couldn't send — no messaging service"
              : "Text sent to customer"}
          </div>
          {notice.body}
          {notice.via === "none" && (
            <div>
              <a href={smsHref({ to: customer?.phone, body: notice.body })}>
                Send via Messages app
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
