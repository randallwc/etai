const MIN_PAD = 0.01;

function isCoord(n) {
  return typeof n === "number" && Number.isFinite(n);
}

export default function MapView({ customer, contractor }) {
  if (!customer || !isCoord(customer.lat) || !isCoord(customer.lon)) {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          minHeight: 160,
          display: "grid",
          placeItems: "center",
          borderRadius: 12,
          border: "1px solid var(--line)",
          background: "var(--surface-2)",
          color: "var(--ink-dim)",
          fontSize: "0.85rem",
        }}
      >
        {customer?.label || "No location"}
      </div>
    );
  }

  const points = [customer];
  if (contractor && isCoord(contractor.lat) && isCoord(contractor.lon)) {
    points.push(contractor);
  }
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  const latPad = Math.max((Math.max(...lats) - Math.min(...lats)) * 0.3, MIN_PAD);
  const lonPad = Math.max((Math.max(...lons) - Math.min(...lons)) * 0.3, MIN_PAD);
  const bbox = [
    Math.min(...lons) - lonPad,
    Math.min(...lats) - latPad,
    Math.max(...lons) + lonPad,
    Math.max(...lats) + latPad,
  ].join(",");
  const src = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${customer.lat},${customer.lon}`;

  return (
    <iframe
      title={customer.label ? `Map of ${customer.label}` : "Job location map"}
      src={src}
      loading="lazy"
      style={{
        width: "100%",
        height: "100%",
        minHeight: 160,
        display: "block",
        border: "1px solid var(--line)",
        borderRadius: 12,
        background: "var(--surface-2)",
      }}
    />
  );
}
