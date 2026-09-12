import { useEffect, useState } from "react";
import { AGENTS } from "./agents.js";
import { fetchCoworkers } from "./api/ambiguous.js";
import { loadBoard, saveBoard, transition } from "./lib/jobs.js";
import Board from "./components/Board.jsx";
import JobDetail from "./components/JobDetail.jsx";
import CallScreen from "./components/CallScreen.jsx";

const RESOLVED = new Set(["done", "canceled"]);

export default function App() {
  const [agents, setAgents] = useState(AGENTS);
  const [board, setBoard] = useState(loadBoard);
  const [selectedId, setSelectedId] = useState(null);
  const [callAgent, setCallAgent] = useState(null);

  useEffect(() => {
    fetchCoworkers()
      .then((list) => list?.length && setAgents(list))
      .catch(() => {});
  }, []);

  function updateJob(jobId, action) {
    setBoard((b) => {
      const next = transition(b, jobId, action);
      saveBoard(next);
      return next;
    });
  }

  const job =
    board.jobs.find((j) => j.id === selectedId) ??
    board.jobs.find((j) => !RESOLVED.has(j.status));
  const customer = job
    ? board.customers.find((c) => c.id === job.customerId)
    : null;

  return (
    <div className="app console">
      <Board
        agents={agents}
        board={board}
        selectedId={job?.id}
        onSelectJob={setSelectedId}
        onCallAgent={setCallAgent}
      />
      <main className="pane">
        {job ? (
          <JobDetail
            key={job.id}
            job={job}
            customer={customer}
            contractor={board.contractor}
            onAction={updateJob}
          />
        ) : (
          <div className="pane-empty">No jobs on the board.</div>
        )}
      </main>
      {callAgent && (
        <CallScreen
          agent={callAgent}
          agents={agents}
          onSwitch={setCallAgent}
          onExit={() => setCallAgent(null)}
        />
      )}
    </div>
  );
}
