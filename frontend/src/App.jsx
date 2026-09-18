/**
 * App shell: one persona, one call screen. Minimum because a
 * single-agent MVP needs no roster module or routing layer.
 */
import CallScreen from "./components/CallScreen.jsx";

const AGENT = {
  id: "etai",
  name: "etAI",
  role: "Dispatch assistant",
  theme: "#405ef2",
  initials: "AI",
  greeting:
    "Hey, it's etAI. I can move a job, squeeze something new in, or check where things stand. What do you need?",
  skills: ["rescheduling", "booking", "status updates"],
  voice: { pitch: 1.05, rate: 1.0 },
};

export default function App() {
  return (
    <div className="app">
      <CallScreen agent={AGENT} />
    </div>
  );
}
