const RESOLVED = new Set(["done", "canceled"]);

const dayKey = (d) => {
  const date = new Date(d);
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${m}-${day}`;
};

const fmtDay = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
};

export function fmtWindow(w) {
  if (!w?.start) return "";
  const day = new Date(w.start).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const fmt = (d) =>
    new Date(d).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  const span = w.end ? `${fmt(w.start)}–${fmt(w.end)}` : fmt(w.start);
  return `${day} · ${span}`;
}

function JobRow({ job, customer, selected, onSelect }) {
  return (
    <button className={`job-row ${selected ? "sel" : ""}`} onClick={onSelect}>
      <span className="row-main">
        <span className="row-top">
          <span className="row-name">{customer?.name ?? "Unknown"}</span>
          <span className={`chip st-${job.status}`}>
            {job.status.replace("_", " ")}
          </span>
        </span>
        <span className="row-sub">{job.description}</span>
        <span className="row-sub">{fmtWindow(job.window)}</span>
      </span>
    </button>
  );
}

export default function Board({
  agents,
  board,
  selectedId,
  onSelectJob,
  onCallAgent,
}) {
  const customersById = Object.fromEntries(
    board.customers.map((c) => [c.id, c])
  );
  const sorted = [...board.jobs].sort(
    (a, b) => new Date(a.window?.start ?? 0) - new Date(b.window?.start ?? 0)
  );
  const active = sorted.filter((j) => !RESOLVED.has(j.status));
  const resolved = sorted.filter((j) => RESOLVED.has(j.status));

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const groups = new Map();
  for (const job of active) {
    const key = dayKey(job.window.start);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(job);
  }
  const sections = [...groups.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  );
  for (const [, jobs] of sections)
    jobs.sort((a, b) => (b.status === "en_route") - (a.status === "en_route"));

  const label = (key) =>
    key === dayKey(new Date())
      ? "Customers today"
      : key === dayKey(tomorrow)
        ? "Customers tomorrow"
        : `Customers · ${fmtDay(key)}`;

  const row = (j) => (
    <JobRow
      key={j.id}
      job={j}
      customer={customersById[j.customerId]}
      selected={j.id === selectedId}
      onSelect={() => onSelectJob(j.id)}
    />
  );

  return (
    <aside className="side">
      <img className="side-logo" src="/etai-wordmark.svg" alt="etAI" />
      <div className="side-label">Agents</div>
      {agents.map((a) => (
        <button key={a.id} className="agent-row" onClick={() => onCallAgent(a)}>
          <span className="avatar" style={{ background: a.theme }}>
            {a.initials}
          </span>
          <span className="row-main">
            <span className="row-name">{a.name}</span>
            <span className="row-sub">{a.role}</span>
          </span>
        </button>
      ))}

      {sections.map(([key, jobs]) => (
        <div key={key}>
          <div className="side-label">{label(key)}</div>
          {jobs.map(row)}
        </div>
      ))}
      {resolved.length > 0 && (
        <details className="resolved">
          <summary>Resolved · {resolved.length}</summary>
          {resolved.map(row)}
        </details>
      )}
    </aside>
  );
}
