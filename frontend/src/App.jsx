import { useEffect, useState } from "react";
import { AGENTS } from "./agents.js";
import { fetchCoworkers } from "./api/ambiguous.js";
import CallScreen from "./components/CallScreen.jsx";

export default function App() {
  const [agents, setAgents] = useState(AGENTS);
  const [agent, setAgent] = useState(AGENTS[0]);

  useEffect(() => {
    fetchCoworkers()
      .then((list) => {
        if (list?.length) {
          setAgents(list);
          setAgent(list[0]);
        }
      })
      .catch(() => {});
  }, []);

  return <CallScreen agent={agent} agents={agents} onSwitch={setAgent} />;
}
