/**
 * The call UI and the whole frontend flow: mic or typed turns go to
 * POST /voice/turn, replies are spoken via speechSynthesis, and the
 * transcript is handed to Ambiguous on hangup. Minimum because the
 * service client and the speech helper are each used only here, so
 * they live here instead of in their own modules.
 */
import { useEffect, useRef, useState } from "react";
import AgentSurface from "./AgentSurface.jsx";
import { sendConversation } from "../api/ambiguous.js";

const BUS_URL = import.meta.env.VITE_BUS_URL;
const CALLER = import.meta.env.VITE_DEMO_PHONE || "+15550000001";

const DONE_RE =
  /^(yes|yeah|yep|yup|that's all|thats all|that is all|all set|done|no|nope|nothing else|i'm good|im good|perfect|great|bye)[.!]?$/i;

const SR =
  typeof window !== "undefined"
    ? window.SpeechRecognition || window.webkitSpeechRecognition
    : null;

async function voiceTurn(body) {
  try {
    const res = await fetch(`${BUS_URL}/voice/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: CALLER, body }),
    });
    return res.ok ? (await res.json()).reply ?? null : null;
  } catch {
    return null;
  }
}

const VOICE_PREFER = [
  "Google US English",
  "Microsoft Aria",
  "Microsoft Jenny",
  "Microsoft Ava",
  "Samantha",
  "Alex",
];

let speakGen = 0;

function stopSpeaking() {
  speakGen++;
  globalThis.speechSynthesis?.cancel();
}

function pickVoice(voices) {
  for (const name of VOICE_PREFER) {
    const v = voices.find((v) => v.name.includes(name));
    if (v) return v;
  }
  return (
    voices.find((v) => v.lang?.startsWith("en") && v.localService === false) ??
    voices.find((v) => v.lang?.startsWith("en")) ??
    null
  );
}

function speak(text, voice = {}, { onEnd } = {}) {
  const g = ++speakGen;
  let done = false;
  const finish = () => {
    if (done || g !== speakGen) return;
    done = true;
    clearTimeout(guard);
    onEnd?.();
  };
  const guard = setTimeout(finish, Math.min(15000, 2000 + text.length * 100));
  const synth = globalThis.speechSynthesis;
  if (!synth) {
    setTimeout(finish, Math.min(4000, 800 + text.length * 30));
    return;
  }
  const u = new globalThis.SpeechSynthesisUtterance(text);
  u.voice = pickVoice(synth.getVoices?.() ?? []);
  u.pitch = voice?.pitch ?? 1;
  u.rate = voice?.rate ?? 1;
  u.onend = u.onerror = finish;
  synth.speak(u);
}

export default function CallScreen({ agent }) {
  const [phase, setPhase] = useState("connecting");
  const [speaking, setSpeaking] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sendOk, setSendOk] = useState(null);
  const [listening, setListening] = useState(false);
  const [micError, setMicError] = useState(false);
  const payloadRef = useRef(null);
  const recRef = useRef(null);
  const submitRef = useRef(null);

  payloadRef.current = {
    agentId: agent.id,
    transcript: messages.map((m) => `${m.from}: ${m.text}`).join("\n"),
    endedAt: new Date().toISOString(),
  };

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
      stopSpeaking();
      if (payloadRef.current?.transcript) {
        sendConversation(payloadRef.current).catch(() => {});
      }
    };
  }, [agent]);

  function agentSay(text) {
    setMessages((m) => [...m, { from: "agent", text }]);
    setSpeaking(true);
    speak(text, agent.voice, { onEnd: () => setSpeaking(false) });
  }

  function userSay(text) {
    setMessages((m) => [...m, { from: "user", text }]);
  }

  const lastAgentMsg = [...messages].reverse().find((m) => m.from === "agent");

  async function submitUserText(text) {
    text = text.trim();
    if (!text || phase !== "live") return;
    userSay(text);

    if (lastAgentMsg?.text.includes("Is that all") && DONE_RE.test(text)) {
      agentSay("Perfect - passing everything to Ambiguous to confirm. Bye!");
      setTimeout(handleEnd, 1400);
      return;
    }

    setSpeaking(true);
    const reply = await voiceTurn(text);
    setSpeaking(false);
    setTimeout(
      () => agentSay(reply || "Sorry - I can't reach the service right now. Try again in a bit."),
      500
    );
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
      if (recRef.current !== rec) return;
      try {
        rec.start();
      } catch {
        recRef.current = null;
        setListening(false);
      }
    };
    recRef.current = rec;
    rec.start();
    setListening(true);
  }

  useEffect(
    () => () => {
      recRef.current?.stop();
      stopSpeaking();
    },
    []
  );

  async function handleEnd() {
    stopMic();
    stopSpeaking();
    setPhase("sending");
    const res = await sendConversation(payloadRef.current);
    payloadRef.current = null;
    setSendOk(res.ok !== false);
    setPhase("done");
  }

  function handleRedial() {
    stopMic();
    stopSpeaking();
    setMessages([]);
    setSendOk(null);
    setPhase("connecting");
    setTimeout(() => {
      setPhase("live");
      agentSay(agent.greeting);
    }, 800);
  }

  return (
    <div className="ft-call" style={{ "--agent-color": agent.theme }}>
      <AgentSurface agent={agent} speaking={speaking} />

      <div className="ft-top">
        <div className="ft-top-right">
          <div className="ft-status">
            {phase === "connecting" && `Calling ${agent.name}…`}
            {phase === "live" && agent.name}
            {phase === "sending" && "Sending to Ambiguous…"}
            {phase === "done" &&
              (sendOk ? "Sent to Ambiguous.ai" : "Handoff failed")}
          </div>
        </div>
      </div>

      <div className="ft-bottom">
        {phase === "live" && lastAgentMsg && (
          <div className="caption">
            <span className="caption-name">{agent.name}</span>
            {lastAgentMsg.text}
          </div>
        )}

        {phase === "live" && (
          <form className="composer" onSubmit={handleSend}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Say something…"
            />
          </form>
        )}

        {phase === "done" && (
          <div className="call-summary">
            <div className="call-summary-head">
              {sendOk
                ? `Conversation sent to ${agent.name} via Ambiguous`
                : "Couldn't reach Ambiguous - transcript not sent"}
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
