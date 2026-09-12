import { useEffect } from "react";
import { useRive, useStateMachineInput } from "@rive-app/react-canvas";

export default function AgentSurface({ agent, speaking }) {
  const { rive, RiveComponent } = useRive({
    src: "/map-pin-marker.riv",
    stateMachines: "markerpin",
    autoplay: true,
  });
  const isSelecting = useStateMachineInput(rive, "markerpin", "isSelecting");

  useEffect(() => {
    if (isSelecting) isSelecting.value = speaking;
  }, [speaking, isSelecting]);

  return (
    <div
      className={`agent-surface ${speaking ? "speaking" : ""}`}
      style={{ "--agent-color": agent.theme }}
    >
      <div className="rive-stage">
        {!rive && <div className="orb-core">{agent.initials}</div>}
        <RiveComponent />
      </div>
      <div className="agent-surface-label">
        <strong>{agent.name}</strong>
        <span>{agent.role}</span>
        {agent.skills?.length > 0 && (
          <div className="skill-chips">
            {agent.skills.map((s) => (
              <span key={s} className="skill-chip">
                {s}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
