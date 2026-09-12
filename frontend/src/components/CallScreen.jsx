import { useEffect, useRef, useState } from "react";
import AgentSurface from "./AgentSurface.jsx";
import {
  fetchDaySummary,
  createTask,
  handleRequest,
  sendConversation,
} from "../api/ambiguous.js";
import { isDoneSignal, offlineReply } from "../lib/parseRequest.js";

const SR =
  typeof window !== "undefined"
    ? window.SpeechRecognition || window.webkitSpeechRecognition
    : null;

export default function CallScreen({ agent, agents, onSwitch }) {
  const videoRef = useRef(null);
  const pipRef = useRef(null);
  const [cameraError, setCameraError] = useState(false);
  const [phase, setPhase] = useState("connecting");
  const [speaking, setSpeaking] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [awaitingTask, setAwaitingTask] = useState(false);
  const [pipPos, setPipPos] = useState(null);
  const [sendOk, setSendOk] = useState(null);
  const [listening, setListening] = useState(false);
  const [micError, setMicError] = useState(false);
  const dragRef = useRef(null);
  const payloadRef = useRef(null);
  const recRef = useRef(null);
  const submitRef = useRef(null);

  payloadRef.current = {
    agentId: agent.id,
    transcript: messages.map((m) => `${m.from}: ${m.text}`).join("\n"),
    endedAt: new Date().toISOString(),
  };

  useEffect(() => {
    let stream;
    navigator.mediaDevices
      ?.getUserMedia({ video: true, audio: true })
      .then((s) => {
        stream = s;
        if (videoRef.current) videoRef.current.srcObject = s;
      })
      .catch(() => setCameraError(true));
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      setPhase("live");
      agentSay(agent.greeting);
    }, 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent]);

  useEffect(() => {
    return () => {
      if (payloadRef.current?.transcript) {
        sendConversation(payloadRef.current).catch(() => {});
      }
    };
  }, [agent]);

  function agentSay(text) {
    setSpeaking(true);
    setMessages((m) => [...m, { from: "agent", text }]);
    setTimeout(() => setSpeaking(false), Math.min(4000, 800 + text.length * 30));
  }

  function userSay(text) {
    setMessages((m) => [...m, { from: "user", text }]);
  }

  function chooseSummary() {
    userSay("Give me my day summary.");
    fetchDaySummary()
      .then((text) => agentSay(text || "Your calendar is clear today."))
      .catch(() => agentSay("Your calendar is clear today."));
  }

  function chooseTask() {
    userSay("I want to add a new task.");
    setAwaitingTask(true);
    setTimeout(() => agentSay("Sure — tell me what you need to get done."), 700);
  }

  const lastAgentMsg = [...messages].reverse().find((m) => m.from === "agent");

  async function submitUserText(text) {
    text = text.trim();
    if (!text || phase !== "live") return;
    userSay(text);

    if (lastAgentMsg?.text.includes("Is that all") && isDoneSignal(text)) {
      agentSay("Perfect — passing everything to Ambiguous to confirm. Bye!");
      setTimeout(handleEnd, 1400);
      return;
    }

    if (awaitingTask) {
      setAwaitingTask(false);
      createTask(text).catch(() => {});
      setTimeout(
        () => agentSay("Done — it's in Ambiguous. Is that all?"),
        700
      );
      return;
    }

    setSpeaking(true);
    const reply = await handleRequest(text).catch(() => null);
    setSpeaking(false);
    setTimeout(() => agentSay(reply || offlineReply(text)), 500);
  }

  submitRef.current = submitUserText;

  function handleSend(e) {
    e.preventDefault();
    const text = input.trim();
    setInput("");
    submitUserText(text);
  }

  function stopMic() {
    const rec = recRef.current;
    recRef.current = null;
    setListening(false);
    rec?.stop();
  }

  function toggleMic() {
    if (listening) {
      stopMic();
      return;
    }
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) submitRef.current?.(r[0].transcript);
        else interim += r[0].transcript;
      }
      setInput(interim);
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setMicError(true);
      }
      stopMic();
    };
    rec.onend = () => {
      if (recRef.current === rec) {
        recRef.current = null;
        setListening(false);
      }
    };
    recRef.current = rec;
    rec.start();
    setListening(true);
  }

  useEffect(() => () => recRef.current?.stop(), []);

  async function handleEnd() {
    stopMic();
    setPhase("sending");
    const res = await sendConversation(payloadRef.current);
    payloadRef.current = null;
    setSendOk(res.ok !== false);
    setPhase("done");
  }

  function handleRedial() {
    stopMic();
    setMessages([]);
    setAwaitingTask(false);
    setSendOk(null);
    setPhase("connecting");
    setTimeout(() => {
      setPhase("live");
      agentSay(agent.greeting);
    }, 800);
  }

  function onPipDown(e) {
    const rect = pipRef.current.getBoundingClientRect();
    dragRef.current = {
      dx: e.clientX - rect.left,
      dy: e.clientY - rect.top,
      w: rect.width,
      h: rect.height,
    };
    pipRef.current.setPointerCapture(e.pointerId);
  }

  function onPipMove(e) {
    if (!dragRef.current) return;
    const { dx, dy, w, h } = dragRef.current;
    const x = Math.min(Math.max(e.clientX - dx, 8), window.innerWidth - w - 8);
    const y = Math.min(Math.max(e.clientY - dy, 8), window.innerHeight - h - 8);
    setPipPos({ x, y });
  }

  function onPipUp() {
    dragRef.current = null;
  }

  return (
    <div className="ft-call" style={{ "--agent-color": agent.theme }}>
      <AgentSurface agent={agent} speaking={speaking} />

      <div
        ref={pipRef}
        className="pip"
        style={pipPos ? { left: pipPos.x, top: pipPos.y } : undefined}
        onPointerDown={onPipDown}
        onPointerMove={onPipMove}
        onPointerUp={onPipUp}
      >
        {cameraError ? (
          <div className="pip-off">No camera</div>
        ) : (
          <video ref={videoRef} autoPlay playsInline muted />
        )}
      </div>

      <div className="ft-top">
        <div className="agent-switcher">
          {agents.map((a) => (
            <button
              key={a.id}
              className={`switch-dot ${a.id === agent.id ? "on" : ""}`}
              style={{ background: a.theme }}
              title={a.name}
              onClick={() => onSwitch(a)}
            >
              {a.initials}
            </button>
          ))}
        </div>
        <div className="ft-status">
          {phase === "connecting" && `Calling ${agent.name}…`}
          {phase === "live" && agent.name}
          {phase === "sending" && "Sending to Ambiguous…"}
          {phase === "done" &&
            (sendOk ? "Sent to Ambiguous.ai" : "Handoff failed")}
        </div>
      </div>

      <div className="ft-bottom">
        {phase === "live" && lastAgentMsg && (
          <div className="caption">
            <span className="caption-name">{agent.name}</span>
            {lastAgentMsg.text}
          </div>
        )}

        {phase === "live" && !awaitingTask && (
          <div className="choices">
            <button onClick={chooseSummary}>Day summary</button>
            <button onClick={chooseTask}>New task</button>
          </div>
        )}

        {phase === "live" && (
          <form className="composer" onSubmit={handleSend}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                awaitingTask ? "Describe the task…" : `Say something…`
              }
            />
          </form>
        )}

        {phase === "done" && (
          <div className="call-summary">
            <div className="call-summary-head">
              {sendOk
                ? `Conversation sent to ${agent.name} via Ambiguous`
                : "Couldn't reach Ambiguous — transcript not sent"}
            </div>
            {messages.length ? (
              messages.map((m, i) => (
                <div key={i} className="summary-line">
                  <span className="summary-who">
                    {m.from === "agent" ? agent.name : "You"}
                  </span>
                  {m.text}
                </div>
              ))
            ) : (
              <div className="summary-line">No conversation recorded.</div>
            )}
          </div>
        )}

        <div className="ft-controls">
          {phase === "done" ? (
            <button className="ctrl-btn" onClick={handleRedial}>
              Call again
            </button>
          ) : (
            <>
              {SR && (
                <button
                  className={`ctrl-btn mic ${listening ? "on" : ""}`}
                  onClick={toggleMic}
                  disabled={phase !== "live" || micError}
                >
                  {micError ? "No mic" : listening ? "Mic on" : "Mic"}
                </button>
              )}
              <button
                className="ctrl-btn end"
                onClick={handleEnd}
                disabled={phase !== "live"}
              >
                End
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
