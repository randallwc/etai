const { randomUUID } = require("node:crypto");
const { resolveDayRef, partsInTz } = require("./calendar.js");
const { fmtTime, fmtDay } = require("./loop.js");
const { channelPrompt } = require("./prompts.js");
const { extractJson } = require("./ai.js");

const MAX_STEPS = 8;
const CHANNELS = new Set(["sms", "imessage"]);

function loadBuiltInAgent() {
  try {
    return require("@copilotkit/runtime/v2").BuiltInAgent;
  } catch {
    return null;
  }
}

function pickModel(env) {
  if (env.COPILOT_MODEL) return env.COPILOT_MODEL;
  if (env.OPENAI_API_KEY) return "openai/gpt-4.1-mini";
  if (env.ANTHROPIC_API_KEY) return "anthropic/claude-sonnet-4.5";
  if (env.GOOGLE_API_KEY) return "google/gemini-2.5-flash";
  return null;
}

function basePrompt(tz) {
  return [
    "You are etAI, the dispatcher for a one-person trade business. You answer",
    "texts like a human dispatcher: plain, short, one or two sentences.",
    "No markdown, no emoji.",
    "You have tools for the contractor's real calendar. Never invent times or",
    "bookings: check get_availability before offering slots, and call book_job",
    'only after the texter picks one. Offer at most three options as "1) <time>',
    '2) <time> 3) <time>" in the contractor timezone; when they answer with a',
    "number or a time, match it against the options you last offered.",
    "When a client books, moves, or cancels, the tool already texts the",
    "contractor a heads-up; when the contractor changes a client visit the tool",
    "texts the client. Use send_text only for messages no tool sends.",
    'The contractor texting "running 20 late" -> report_delay. A client asking',
    "where the contractor is -> answer from their active job window or say the",
    "contractor will text them an ETA.",
    "Anything else from the contractor that is not scheduling -> create_task.",
    "If a request is ambiguous, ask one short clarifying question instead of",
    "guessing. Keep every reply under 300 characters.",
    `All times are ${tz}.`,
  ].join("\n");
}

function factoryPrompt(tools, convo) {
  const names = Object.keys(tools)
    .map((n) => `${n}${JSON.stringify(tools[n].params ?? {})}`)
    .join(", ");
  return [
    "You will see a conversation between a texter and the agent (you).",
    "Respond with exactly one JSON object and no other text:",
    '{"tool":"<name>","args":{...}} to call a tool, or {"say":"<text>"} to answer.',
    `Tools: ${names}`,
    "Dates may be today, tomorrow, a weekday name, or YYYY-MM-DD. Tool",
    "results are appended to the conversation; call another tool or say.",
    "",
    ...convo,
  ].join("\n");
}

function collectRun(stream) {
  const acc = { reply: "", toolCalls: [], error: null };
  const openCalls = new Map();
  const onEvent = (ev) => {
    if (!ev || typeof ev !== "object") return;
    if (ev.type === "TEXT_MESSAGE_CONTENT" && typeof ev.delta === "string") {
      acc.reply += ev.delta;
    } else if (ev.type === "TOOL_CALL_START") {
      openCalls.set(ev.toolCallId, { tool: ev.toolCallName, argsRaw: "" });
    } else if (ev.type === "TOOL_CALL_ARGS") {
      const c = openCalls.get(ev.toolCallId);
      if (c) c.argsRaw += ev.delta ?? "";
    } else if (ev.type === "TOOL_CALL_END") {
      const c = openCalls.get(ev.toolCallId);
      if (!c) return;
      let args = {};
      try {
        args = JSON.parse(c.argsRaw || "{}");
      } catch {}
      acc.toolCalls.push({ tool: c.tool, args });
    } else if (ev.type === "RUN_ERROR") {
      acc.error = new Error(ev.message ?? "run error");
    }
  };
  return new Promise((resolve) => {
    if (stream && typeof stream.subscribe === "function") {
      stream.subscribe({
        next: onEvent,
        error: (e) => {
          acc.error = e;
          resolve(acc);
        },
        complete: () => resolve(acc),
      });
    } else if (stream && stream[Symbol.asyncIterator]) {
      (async () => {
        try {
          for await (const e of stream) onEvent(e);
        } catch (e) {
          acc.error = e;
        }
        resolve(acc);
      })();
    } else {
      resolve(acc);
    }
  });
}

/**
 * The CopilotKit agent path for sms and imessage. createCopilot returns
 * {enabled, handles, handle}. Each inbound becomes one BuiltInAgent run:
 * classic mode (native tool calling) when COPILOT_MODEL or a provider key
 * exists, else factory mode driven by Ambiguous assistant/chat. Replies are
 * texted via notify; failures degrade to a plain-language text, never a
 * throw at the sender.
 */
function createCopilot({
  env = process.env,
  calendar,
  store,
  notify,
  chat,
  createTask,
  upsertContact,
  contractorPhone,
  tz = "America/Los_Angeles",
  now = () => new Date(),
  AgentCtor,
} = {}) {
  const Ctor = AgentCtor ?? loadBuiltInAgent();
  const model = pickModel(env);
  const enabled =
    env.COPILOT_AGENT !== "off" &&
    Boolean(Ctor) &&
    Boolean(model || (chat && env.COPILOT_AGENT === "on"));
  const chains = new Map();
  const isContractor = (from) => contractorPhone && from === contractorPhone;

  async function record(tool, args, fn) {
    try {
      const result = await fn();
      store.logAction({ tool, args, result });
      return result;
    } catch (e) {
      store.logAction({ tool, args, error: e.message });
      return { error: e.message };
    }
  }

  function crmSync(phone) {
    if (!upsertContact) return;
    const c = store.data.customers[phone];
    if (!c || c.ambiguousCrmId) return;
    record("crm_upsert_contact", { name: c.name ?? null, phone }, () =>
      upsertContact({ name: c.name ?? null, phone })
    ).then((contact) => {
      if (contact?.id) store.upsertCustomer(phone, { ambiguousCrmId: contact.id });
    });
  }

  function buildTools(msg) {
    const mine = () =>
      isContractor(msg.from)
        ? store.upcomingJobs(now().getTime())
        : store.jobsForPhone(msg.from);

    function resolveJob(ref) {
      const jobs = mine();
      if (!ref) {
        return (
          (isContractor(msg.from)
            ? store.nextJob(now().getTime())
            : store.jobForPhone(msg.from)) ?? jobs[0] ?? null
        );
      }
      const r = String(ref).toLowerCase();
      const hit =
        jobs.find((j) => j.id === ref) ??
        jobs.find((j) => (j.description ?? "").toLowerCase().includes(r));
      if (hit) return hit;
      const t = r.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/);
      if (!t) return null;
      const hour = (+t[1] % 12) + (t[3] === "pm" ? 12 : 0);
      const minute = +(t[2] ?? 0);
      return (
        jobs.find((j) => {
          const p = new Date(j.window.start).toLocaleTimeString("en-US", {
            timeZone: tz, hour12: false, hour: "2-digit", minute: "2-digit",
          });
          const [h, m] = p.split(":").map(Number);
          return h % 24 === hour && m === minute;
        }) ?? null
      );
    }

    function fmtSlot(s) {
      return `${fmtDay(s.start, tz)} ${fmtTime(s.start, tz)}`;
    }

    const tools = {
      get_schedule: {
        params: { date: "day ref" },
        description: "List the contractor's calendar events for a day.",
        parameters: {
          type: "object",
          required: ["date"],
          properties: { date: { type: "string" } },
        },
        handler: async ({ date }) => {
          const d = resolveDayRef(date, tz, now());
          const events = await record("get_schedule", { date: d }, () =>
            calendar.listDay({ date: d })
          );
          if (events?.error) return events;
          return {
            date: d,
            events: events.map((e) => ({
              title: e.title, start: e.start, end: e.end, status: e.status,
            })),
          };
        },
      },
      get_availability: {
        params: { date: "day ref", durationMinutes: "int?", timePref: "morning|afternoon|evening|HH:MM?" },
        description: "Open slots inside working hours for a day.",
        parameters: {
          type: "object",
          required: ["date"],
          properties: {
            date: { type: "string" },
            durationMinutes: { type: "integer" },
            timePref: { type: "string" },
          },
        },
        handler: async ({ date, durationMinutes, timePref }) => {
          const d = resolveDayRef(date, tz, now());
          const slots = await record(
            "get_availability",
            { date: d, durationMinutes, timePref },
            () =>
              calendar.proposeSlots({
                date: d,
                durationMinutes: durationMinutes ?? 60,
                count: 3,
                timePref,
              })
          );
          if (slots?.error) return slots;
          return {
            date: d,
            slots: slots.map((s) => ({
              start: s.start.toISOString(),
              end: s.end.toISOString(),
              label: fmtSlot(s),
            })),
          };
        },
      },
      book_job: {
        params: { start: "iso", end: "iso", description: "what the job is" },
        description: "Create the calendar event and the job record once the texter picked a slot.",
        parameters: {
          type: "object",
          required: ["start", "end", "description"],
          properties: {
            start: { type: "string" },
            end: { type: "string" },
            description: { type: "string" },
          },
        },
        handler: async ({ start, end, description }) => {
          const slot = {
            start: new Date(start).toISOString(),
            end: new Date(end).toISOString(),
          };
          const clash = Object.values(store.data.jobs).some(
            (j) =>
              (j.status === "confirmed" || j.status === "en_route") &&
              new Date(j.window.start) < new Date(slot.end) &&
              new Date(j.window.end) > new Date(slot.start)
          );
          if (clash) return { error: "that window conflicts with a booked job" };
          const customer = store.upsertCustomer(msg.from, {});
          crmSync(msg.from);
          const ev = await record("book_job", { slot, description }, () =>
            calendar.createEvent({
              title: `${description} - ${customer.name ?? msg.from}`,
              start: slot.start,
              end: slot.end,
              description: `${description}\nClient: ${customer.name ?? "unknown"} ${msg.from}`,
            })
          );
          if (ev?.error) return ev;
          const job = store.addJob({
            customerId: customer.id,
            contractorId: "contractor",
            ambiguousEventId: ev.id,
            status: "confirmed",
            window: slot,
            description,
            source: msg.channel === "voice" ? "call" : "message",
          });
          if (!isContractor(msg.from) && contractorPhone) {
            await notify({
              to: contractorPhone,
              body: `New booking: ${description} ${fmtSlot(slot)} for ${customer.name ?? msg.from}.`,
            }).catch(() => {});
          }
          return { booked: true, jobId: job.id, when: fmtSlot(slot) };
        },
      },
      reschedule_job: {
        params: { jobRef: "id|desc|time?", start: "iso", end: "iso" },
        description: "Move an existing booking to a new window.",
        parameters: {
          type: "object",
          required: ["start", "end"],
          properties: {
            jobRef: { type: "string" },
            start: { type: "string" },
            end: { type: "string" },
          },
        },
        handler: async ({ jobRef, start, end }) => {
          const job = resolveJob(jobRef);
          if (!job?.ambiguousEventId) return { error: "no booking found to move" };
          const slot = {
            start: new Date(start).toISOString(),
            end: new Date(end).toISOString(),
          };
          const r = await record("reschedule_job", { jobId: job.id, slot }, () =>
            calendar.updateEvent({
              eventId: job.ambiguousEventId,
              start: slot.start,
              end: slot.end,
            })
          );
          if (r?.error) return r;
          job.window = slot;
          store.save();
          if (!isContractor(msg.from) && contractorPhone) {
            await notify({
              to: contractorPhone,
              body: `${job.description} moved to ${fmtSlot(slot)} by the client.`,
            }).catch(() => {});
          }
          return { moved: true, when: fmtSlot(slot) };
        },
      },
      cancel_job: {
        params: { jobRef: "id|desc|time?" },
        description: "Cancel an existing booking and free the slot.",
        parameters: {
          type: "object",
          properties: { jobRef: { type: "string" } },
        },
        handler: async ({ jobRef }) => {
          const job = resolveJob(jobRef);
          if (!job?.ambiguousEventId) return { error: "no booking found to cancel" };
          const r = await record("cancel_job", { jobId: job.id }, () =>
            calendar.cancelEvent({ eventId: job.ambiguousEventId })
          );
          if (r?.error) return r;
          job.status = "canceled";
          store.save();
          const label = `${job.description} ${fmtSlot(job.window)}`;
          if (isContractor(msg.from)) {
            const cust = Object.values(store.data.customers).find(
              (c) => c.id === job.customerId
            );
            if (cust) {
              await notify({
                to: cust.phone,
                body: `Sorry - ${label} needs to be canceled. Reply here and I will find you a new time.`,
              }).catch(() => {});
            }
          } else if (contractorPhone) {
            await notify({
              to: contractorPhone,
              body: `Client canceled ${label} - that slot is free.`,
            }).catch(() => {});
          }
          return { canceled: true, label };
        },
      },
      report_delay: {
        params: { minutes: "int" },
        description: "Shift the next job by N minutes and text the client the new ETA. Contractor only.",
        parameters: {
          type: "object",
          required: ["minutes"],
          properties: { minutes: { type: "integer" } },
        },
        handler: async ({ minutes }) => {
          if (!isContractor(msg.from)) {
            if (contractorPhone) {
              await notify({
                to: contractorPhone,
                body: `Client ${msg.from} is running late.`,
              }).catch(() => {});
            }
            return { relayed: true };
          }
          const mins = Math.max(1, Math.round(Number(minutes) || 15));
          const job = store.nextJob(now().getTime());
          if (!job?.ambiguousEventId) return { error: "no active job to shift" };
          const slot = {
            start: new Date(new Date(job.window.start).getTime() + mins * 60000).toISOString(),
            end: new Date(new Date(job.window.end).getTime() + mins * 60000).toISOString(),
          };
          const r = await record("report_delay", { jobId: job.id, mins }, () =>
            calendar.updateEvent({ eventId: job.ambiguousEventId, ...slot })
          );
          if (r?.error) return r;
          job.window = slot;
          job.eta = slot.start;
          store.save();
          const cust = Object.values(store.data.customers).find(
            (c) => c.id === job.customerId
          );
          if (cust) {
            await notify({
              to: cust.phone,
              body: `Running about ${mins} min late - new ETA ${fmtTime(slot.start, tz)}. Sorry for the wait!`,
            }).catch(() => {});
          }
          return { shifted: true, eta: fmtTime(slot.start, tz) };
        },
      },
      send_text: {
        params: { to: "e164|contractor", body: "text" },
        description: "Text a party directly. For messages the other tools do not already send.",
        parameters: {
          type: "object",
          required: ["to", "body"],
          properties: { to: { type: "string" }, body: { type: "string" } },
        },
        handler: async ({ to, body }) => {
          const target = to === "contractor" ? contractorPhone : to;
          if (!target) return { error: "no such recipient" };
          return record("send_text", { to: target, body }, () =>
            notify({ to: target, body })
          );
        },
      },
      create_task: {
        params: { title: "task title" },
        description: "Log a non-scheduling request as an Ambiguous task.",
        parameters: {
          type: "object",
          required: ["title"],
          properties: { title: { type: "string" } },
        },
        handler: async ({ title }) =>
          createTask
            ? record("create_task", { title }, () => createTask(title))
            : { error: "tasks unavailable" },
      },
    };
    return tools;
  }

  function contextFor(msg) {
    const cust = store.data.customers[msg.from];
    const jobs = isContractor(msg.from)
      ? store.upcomingJobs(now().getTime())
      : store.jobsForPhone(msg.from);
    const p = partsInTz(tz, now());
    return [
      { description: "Channel", value: channelPrompt(msg.channel) },
      {
        description: "Texter",
        value: isContractor(msg.from)
          ? `The contractor (${msg.from}). They own the calendar; tool side-effects still notify clients.`
          : `A client at ${msg.from}${cust?.name ? ` named ${cust.name}` : ""}. They manage their own visits.`,
      },
      {
        description: "Active jobs for this texter",
        value:
          jobs
            .map((j) => `${j.id} "${j.description}" ${fmtDay(j.window.start, tz)} ${fmtTime(j.window.start, tz)}`)
            .join("; ") || "none",
      },
      {
        description: "Today",
        value: `${p.weekday} ${resolveDayRef("today", tz, now())}`,
      },
    ];
  }

  async function* factoryStream(input, tools) {
    const handlers = Object.fromEntries(
      Object.entries(tools).map(([n, t]) => [n, t.handler])
    );
    const convo = input.messages.map(
      (m) => `${m.role === "assistant" ? "agent" : "texter"}: ${m.content}`
    );
    for (let step = 0; step < MAX_STEPS; step++) {
      const res = await chat(factoryPrompt(handlers, convo));
      const text = res?.response ?? "";
      const parsed = extractJson(text);
      if (parsed?.tool && handlers[parsed.tool]) {
        const toolCallId = `tc-${randomUUID().slice(0, 8)}`;
        const args = parsed.args ?? {};
        yield { type: "TOOL_CALL_START", toolCallId, toolCallName: parsed.tool };
        yield { type: "TOOL_CALL_ARGS", toolCallId, delta: JSON.stringify(args) };
        yield { type: "TOOL_CALL_END", toolCallId };
        const result = await handlers[parsed.tool](args);
        yield {
          type: "TOOL_CALL_RESULT",
          messageId: `tm-${toolCallId}`,
          toolCallId,
          content: JSON.stringify(result),
        };
        convo.push(`agent: ${text}`);
        convo.push(`tool ${parsed.tool} result: ${JSON.stringify(result)}`);
        continue;
      }
      const say = typeof parsed?.say === "string" && parsed.say ? parsed.say : text;
      const messageId = `m-${randomUUID().slice(0, 8)}`;
      yield { type: "TEXT_MESSAGE_START", messageId, role: "assistant" };
      yield { type: "TEXT_MESSAGE_CONTENT", messageId, delta: say };
      yield { type: "TEXT_MESSAGE_END", messageId };
      return;
    }
    const messageId = `m-${randomUUID().slice(0, 8)}`;
    yield { type: "TEXT_MESSAGE_START", messageId, role: "assistant" };
    yield {
      type: "TEXT_MESSAGE_CONTENT",
      messageId,
      delta: "Sorry - that one got away from me. Say it once more?",
    };
    yield { type: "TEXT_MESSAGE_END", messageId };
  }

  async function turn(msg) {
    store.pushHistory(msg.threadKey, "them", msg.body);
    const tools = buildTools(msg);
    const messages = (store.thread(msg.threadKey)?.history ?? []).map(
      (h, i) => ({
        id: `h-${i}`,
        role: h.role === "them" ? "user" : "assistant",
        content: h.body,
      })
    );
    const input = {
      threadId: msg.threadKey,
      runId: `run-${randomUUID()}`,
      messages,
      context: contextFor(msg),
      tools: Object.entries(tools).map(([name, t]) => ({
        name,
        description: t.description,
        parameters: t.parameters,
      })),
    };
    const config = model
      ? {
          model,
          prompt: basePrompt(tz),
          maxSteps: MAX_STEPS,
          tools: Object.entries(tools).map(([name, t]) => ({
            name,
            description: t.description,
            parameters: t.parameters,
            execute: (args) => t.handler(args),
          })),
        }
      : {
          type: "custom",
          factory: (ctx) => factoryStream(ctx.input, tools),
        };
    const agent = new Ctor(config);
    const timeoutMs = Number(env.COPILOT_RUN_TIMEOUT_MS ?? 90000);
    let acc;
    let timer;
    try {
      acc = await Promise.race([
        collectRun(agent.run(input)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("copilot run timeout")), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch (e) {
      agent.abortRun?.();
      acc = { reply: "", toolCalls: [], error: e };
    } finally {
      clearTimeout(timer);
    }
    if (acc.error) {
      store.logAction({
        tool: "copilot_run",
        args: { externalId: msg.externalId },
        error: acc.error.message,
      });
    }
    let reply = acc.reply.trim();
    if (!reply) {
      reply = "Sorry - I could not get to that just now. Try again in a minute.";
    }
    store.pushHistory(msg.threadKey, "etai", reply);
    if (msg.channel === "voice") return reply;
    await notify({ to: msg.from, body: reply });
    return reply;
  }

  function handle(msg) {
    const run = (chains.get(msg.threadKey) ?? Promise.resolve()).then(() =>
      turn(msg)
    );
    chains.set(
      msg.threadKey,
      run.catch(() => {})
    );
    return run;
  }

  return {
    enabled,
    handles: (channel) => enabled && CHANNELS.has(channel),
    handle,
  };
}

module.exports = { createCopilot, collectRun };
