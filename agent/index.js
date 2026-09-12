const http = require("node:http");
const { join } = require("node:path");
const { parseIntent, resolveDate, toLocalDate } = require("./intent");
const { createCalendar } = require("./calendar");
const store = require("./store");

const WORK_START = 9;
const WORK_END = 17;
const JOB_MINUTES = 60;

function normEvent(e) {
  return {
    id: e.id,
    title: e.title ?? "job",
    start: e.start ?? e.start_at,
    end: e.end ?? e.end_at,
    status: e.status ?? "confirmed",
  };
}

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtDay(dateStr) {
  return new Date(`${dateStr}T12:00:00`).toLocaleDateString("en-US", {
    weekday: "long",
  });
}

function openWindows(busy, date, partOfDay) {
  const dayStart = new Date(`${date}T${String(WORK_START).padStart(2, "0")}:00:00`);
  const dayEnd = new Date(`${date}T${WORK_END}:00:00`);
  const start = partOfDay === "afternoon" ? new Date(`${date}T13:00:00`) : dayStart;
  const end = partOfDay === "morning" ? new Date(`${date}T12:00:00`) : dayEnd;
  const sorted = [...busy]
    .map((b) => ({ start: new Date(b.start ?? b.start_at), end: new Date(b.end ?? b.end_at) }))
    .sort((a, b) => a.start - b.start);
  const gaps = [];
  let cursor = start;
  for (const slot of sorted) {
    if (slot.start > cursor) gaps.push({ start: cursor, end: slot.start });
    if (slot.end > cursor) cursor = slot.end;
  }
  if (cursor < end) gaps.push({ start: cursor, end });
  return gaps.filter(
    (g) => g.end - g.start >= JOB_MINUTES * 60000 && g.end <= end && g.start >= start,
  );
}

function createAgentServer(env = process.env) {
  store.useFile(env.AGENT_STATE_FILE ?? join(__dirname, ".state.json"));
  const ambi = createCalendar(env);
  const messagingUrl = env.MESSAGING_URL?.replace(/\/$/, "");
  const contractorPhone = env.CONTRACT_PHONE ?? env.CONTRACTOR_PHONE;
  const sentLog = [];

  async function sendReply(to, body, threadKey) {
    if (!messagingUrl) {
      sentLog.push({ to, body });
      console.log(`[agent reply] -> ${to}: ${body}`);
      return;
    }
    await fetch(`${messagingUrl}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to, body, threadKey }),
    }).catch((e) => console.error(`send failed: ${e.message}`));
  }

  async function daySummary(date) {
    const events = (await ambi.listEvents(`${date}T00:00:00`, `${date}T23:59:59`)).map(normEvent);
    if (!events.length) return "Nothing on the calendar today.";
    const lines = events
      .sort((a, b) => new Date(a.start) - new Date(b.start))
      .map((e) => `${fmtTime(e.start)}-${fmtTime(e.end)} ${e.title}`);
    return `Today: ${lines.join("; ")}`;
  }

  function nextEvent(events) {
    const now = Date.now();
    return events
      .map(normEvent)
      .filter((e) => new Date(e.end).getTime() > now)
      .sort((a, b) => new Date(a.start) - new Date(b.start))[0];
  }

  async function notifyClient(eventId, body) {
    const job = store.jobByEventId(eventId);
    const client = job && store.customerById(job.customerId);
    if (client) await sendReply(client.phone, body, client.phone);
  }

  async function handle(msg) {
    if (!store.dedup(msg.externalId)) return;
    const intent = parseIntent(msg.body);
    const customer = store.customerByPhone(msg.from);
    const reply = (body) => sendReply(msg.from, body, msg.threadKey);

    if (intent.type === "day") {
      return reply(await daySummary(toLocalDate(new Date())));
    }

    if (intent.type === "late") {
      const events = await ambi.listEvents(
        `${toLocalDate(new Date())}T00:00:00`,
        `${toLocalDate(new Date())}T23:59:59`,
      );
      const ev = nextEvent(events);
      if (!ev) return reply("No upcoming job today to shift.");
      const start = new Date(new Date(ev.start).getTime() + intent.minutes * 60000);
      const end = new Date(new Date(ev.end).getTime() + intent.minutes * 60000);
      try {
        const updated = await ambi.updateEvent(ev.id, { start: start.toISOString(), end: end.toISOString() });
        store.logAction("reschedule_job", { eventId: ev.id, minutes: intent.minutes }, updated);
      } catch (e) {
        store.logAction("reschedule_job", { eventId: ev.id, minutes: intent.minutes }, null, e);
        return reply("Couldn't reach the calendar -- try again in a minute.");
      }
      await notifyClient(
        ev.id,
        `Heads up: running ${intent.minutes} min late -- new ETA ${fmtTime(start.toISOString())}.`,
      );
      return reply(
        `Shifted "${ev.title}" to ${fmtTime(start.toISOString())}. Client notified.`,
      );
    }

    if (intent.type === "cancel") {
      const events = await ambi.listEvents(
        `${toLocalDate(new Date())}T00:00:00`,
        `${toLocalDate(new Date())}T23:59:59`,
      );
      const ev = nextEvent(events);
      if (!ev) return reply("No upcoming job today to cancel.");
      try {
        const canceled = await ambi.cancelEvent(ev.id);
        store.logAction("cancel_job", { eventId: ev.id }, canceled);
      } catch (e) {
        store.logAction("cancel_job", { eventId: ev.id }, null, e);
        return reply("Couldn't reach the calendar -- try again in a minute.");
      }
      await notifyClient(
        ev.id,
        `"${ev.title}" was canceled. Reply here to rebook.`,
      );
      return reply(`Canceled "${ev.title}" and told the client.`);
    }

    if (intent.type === "book") {
      const date = resolveDate(intent);
      const busy = await ambi.availability(`${date}T00:00:00`, `${date}T23:59:59`);
      const windows = openWindows(busy, date, intent.partOfDay);
      if (!windows.length) {
        return reply(`No open time ${fmtDay(date)}. Another day?`);
      }
      const slot = {
        start: windows[0].start.toISOString(),
        end: new Date(windows[0].start.getTime() + JOB_MINUTES * 60000).toISOString(),
      };
      store.setPending(msg.threadKey, { slot, customerId: customer.id, summary: msg.body });
      store.logAction("get_availability", { date }, windows);
      return reply(
        `I can do ${fmtDay(date)} ${fmtTime(slot.start)}-${fmtTime(slot.end)}. Confirm?`,
      );
    }

    if (intent.type === "confirm") {
      const pending = store.pending(msg.threadKey);
      if (!pending) return reply("Nothing to confirm -- tell me what you need.");
      let created;
      try {
        created = await ambi.createEvent({
          title: pending.summary.slice(0, 60),
          start: pending.slot.start,
          end: pending.slot.end,
          description: `booked via text from ${msg.from}`,
        });
        store.logAction("book_job", { slot: pending.slot, customer: customer.id }, created);
      } catch (e) {
        store.logAction("book_job", { slot: pending.slot, customer: customer.id }, null, e);
        return reply("Couldn't reach the calendar -- try again in a minute.");
      }
      store.addJob({
        customerId: customer.id,
        ambiguousEventId: created?.id ?? null,
        status: "confirmed",
        window: pending.slot,
        address: "",
        description: pending.summary,
        source: "message",
        eta: null,
      });
      store.clearPending(msg.threadKey);
      if (contractorPhone && msg.from !== contractorPhone) {
        await sendReply(
          contractorPhone,
          `New booking: ${fmtDay(toLocalDate(new Date(pending.slot.start)))} ${fmtTime(pending.slot.start)} -- ${pending.summary.slice(0, 40)}`,
          contractorPhone,
        );
      }
      return reply(
        `Booked ${fmtDay(toLocalDate(new Date(pending.slot.start)))} at ${fmtTime(pending.slot.start)}. See you then.`,
      );
    }

    if (intent.type === "decline") {
      store.clearPending(msg.threadKey);
      return reply("No problem -- what day works better?");
    }

    return reply(
      "I can book jobs, give your day, or mark you late/cancel. Try \"what's my day\" or \"book Thursday afternoon\".",
    );
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {});
        } catch (e) {
          reject(e);
        }
      });
      req.on("error", reject);
    });
  }

  function replyJson(res, status, payload) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload ?? {}));
  }

  const server = http.createServer((req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    (async () => {
      if (req.method === "GET" && path === "/healthz") {
        return replyJson(res, 200, {
          ok: true,
          stub: ambi.stub,
          messaging: Boolean(messagingUrl),
        });
      }
      if (req.method === "POST" && path === "/internal/digest") {
        const date = toLocalDate(new Date());
        if (contractorPhone) await sendReply(contractorPhone, await daySummary(date), contractorPhone);
        return replyJson(res, 200, { sent: Boolean(contractorPhone) });
      }
      if (req.method === "POST" && path === "/webhooks/inbound") {
        const body = await readBody(req);
        if (!body.externalId || !body.from || !body.body) {
          return replyJson(res, 400, { error: { code: "invalid", message: "externalId, from, body required" } });
        }
        replyJson(res, 202, { accepted: true });
        return handle(body).catch((e) => console.error(`inbound failed: ${e.message}`));
      }
      return replyJson(res, 404, { error: { code: "invalid", message: "not found" } });
    })().catch((e) => {
      console.error(e);
      replyJson(res, 500, { error: { code: "upstream", message: "internal error" } });
    });
  });

  async function subscribe() {
    if (!messagingUrl || !env.PUBLIC_URL) return;
    const url = `${env.PUBLIC_URL.replace(/\/$/, "")}/webhooks/inbound`;
    await fetch(`${messagingUrl}/subscriptions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    }).catch((e) => console.error(`subscribe failed: ${e.message}`));
  }

  return { server, subscribe, sentLog };
}

if (require.main === module) {
  require("../shared/env.js").loadEnv();
  const port = Number(process.env.PORT ?? 4030);
  const { server, subscribe } = createAgentServer();
  server.listen(port, async () => {
    console.log(`agent listening on :${port}`);
    await subscribe();
  });
}

module.exports = { createAgentServer, openWindows, normEvent };
