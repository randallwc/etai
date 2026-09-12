export const AGENTS = [
  {
    id: "nova",
    name: "Nova",
    role: "Executive Planner",
    tagline: "Sharp, upbeat, gets your day in order fast.",
    theme: "#7c5cff",
    initials: "N",
    greeting:
      "Hey, Nova here! Want a rundown of your day, or are we adding something new to the plate?",
    summary:
      "Here's your day: standup at 9:30, deep-work block until noon, lunch with Priya at 12:30, then two meetings this afternoon. You're free after 5. Anything you want moved?",
    taskAck:
      "Got it — I'll pass that to Ambiguous to find the right slot. You'll get a nudge once it's scheduled.",
    skills: ["day planning", "priorities", "scheduling"],
    voice: { pitch: 1.1, rate: 1.05 },
  },
  {
    id: "sage",
    name: "Sage",
    role: "Calm Advisor",
    tagline: "Slow, steady, and never lets a detail slip.",
    theme: "#3fae7a",
    initials: "S",
    greeting:
      "Hello, Sage speaking. Take a breath — would you like your day summary, or shall we add a new task?",
    summary:
      "Today is light. One call at 11, a review at 3, and a long open stretch in between — good time for that report. Would you like me to protect it?",
    taskAck:
      "Noted carefully. Ambiguous will weave that into your schedule and confirm shortly.",
    skills: ["reflection", "trade-offs", "detail review"],
    voice: { pitch: 0.85, rate: 0.92 },
  },
  {
    id: "wren",
    name: "Wren",
    role: "Focus Coach",
    tagline: "Direct and efficient — no fluff, just plans.",
    theme: "#3d8bff",
    initials: "W",
    greeting:
      "Wren here. Two options: day summary or new task. Which one?",
    summary:
      "Three priorities today: ship the deck by 10, gym at noon, inbox zero by 4. Everything else is noise. Need the details?",
    taskAck:
      "Captured. Ambiguous will slot it in around your existing commitments — done.",
    skills: ["time-blocking", "deadlines", "accountability"],
    voice: { pitch: 0.95, rate: 1.15 },
  },
  {
    id: "juno",
    name: "Juno",
    role: "Chaos Wrangler",
    tagline: "Warm, a little chaotic, somehow always on top of it.",
    theme: "#ff7a59",
    initials: "J",
    greeting:
      "Hiii, it's Juno! Okay okay — day summary, or are we throwing a new task into the mix?",
    summary:
      "Alright, buckle up: you've got a 9 AM check-in, a dentist thing at 1, and dinner plans at 7. The middle of the day is yours. Want me to fill it or guard it?",
    taskAck:
      "Ooh fun, adding that! Sending it over to Ambiguous now — it'll find a home in your schedule.",
    skills: ["brain dumps", "last-minute plans", "untangling chaos"],
    voice: { pitch: 1.3, rate: 1.1 },
  },
];
