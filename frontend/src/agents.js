export const AGENTS = [
  {
    id: "etai",
    name: "etAI",
    role: "Dispatch assistant",
    tagline: "Moves jobs around and lands them in Ambiguous.",
    theme: "#405ef2",
    initials: "AI",
    greeting:
      "Hey, it's etAI. I can move a job, squeeze something new in, or check where things stand. What do you need?",
    summary:
      "Today: rekey on Mercer at 10, deadbolt swap in Ballard at 1, and a possible lockout around 4. Want me to shuffle any of it?",
    taskAck:
      "Done. It's in Ambiguous and headed to the right place. Anything else to move?",
    skills: ["rescheduling", "booking", "status updates"],
    voice: { pitch: 1.05, rate: 1.0 },
  },
];
