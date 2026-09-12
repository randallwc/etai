import { useEffect, useState } from "react";
import { AGENTS } from "./agents.js";
import { loadBoard, saveBoard, transition } from "./lib/jobs.js";
import { fetchBoard } from "./api/bus.js";
import Board from "./components/Board.jsx";
import JobDetail from "./components/JobDetail.jsx";
import CallScreen from "./components/CallScreen.jsx";

const RESOLVED = new Set(["done", "canceled"]);

const asList = (v) => (Array.isArray(v) ? v : Object.values(v ?? {}));

function mergeList(local, incoming) {
  const byId = new Map(asList(incoming).map((x) => [x.id, x]));
  const known = new Set(local.map((x) => x.id));
  return [
    ...local.map((x) => byId.get(x.id) ?? x),
    ...[...byId.values()].filter((x) => !known.has(x.id)),
  ];
}

function mergeBoard(board, remote) {
  return {
    ...board,
    jobs: mergeList(board.jobs, remote.jobs),
    customers: mergeList(board.customers, remote.customers),
  };
}

export default function App() {
  const agents = AGENTS;
  const [board, setBoard] = useState(loadBoard);
  const [selectedId, setSelectedId] = useState(null);
  const [callAgent, setCallAgent] = useState(null);

  const syncCalendar = useCallback(() => {
    fetchCalendarJobs()
      .then((r) => {
        if (!r) return;
        setBoard((b) => {
          const next = mergeCalendarJobs(b, r.events, r.contacts);
          saveBoard(next);
          return next;
        });
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    syncCalendar();
  }, [syncCalendar, callAgent]);

  useEffect(() => {
    let alive = true;
    async function sync() {
      const remote = await fetchBoard();
      if (!remote || !alive) return;
      setBoard((b) => {
        const next = mergeBoard(b, remote);
        saveBoard(next);
        return next;
      });
    }
    sync();
    const timer = setInterval(sync, 15000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
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
