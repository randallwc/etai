const RESOLVED = new Set(["done", "canceled"]);

export function fmtWindow(w) {
  if (!w?.start) return "";
  const fmt = (d) =>
    new Date(d).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  return w.end ? `${fmt(w.start)}–${fmt(w.end)}` : fmt(w.start);
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

      <div className="side-label">Customers</div>
      {active.map(row)}
      {resolved.length > 0 && (
        <details className="resolved">
          <summary>Resolved · {resolved.length}</summary>
          {resolved.map(row)}
        </details>
      )}
    </aside>
  );
}
