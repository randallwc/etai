export default function AgentSurface({ agent, speaking }) {
  return (
    <div
      className={`agent-surface ${speaking ? "speaking" : ""}`}
      style={{ "--agent-color": agent.theme }}
    >
      <div className="orb-core">{agent.initials}</div>
      <div className="agent-surface-label">
        <strong>{agent.name}</strong>
        <span>{agent.role}</span>
      </div>
    </div>
  );
}
