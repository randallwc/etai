const { resolveDayRef } = require("./calendar.js");

const ORDINALS = {
  first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4,
};

function fmtTime(iso, tz) {
  return new Date(iso).toLocaleTimeString("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtDay(iso, tz) {
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "numeric",
    day: "numeric",
  });
}

function nextDay(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

function parseChoice(body, slots, tz) {
  const s = body.trim().toLowerCase();
  const digit = s.match(/^(\d{1,2})\b/);
  if (digit && +digit[1] <= slots.length) return +digit[1];
  const ord = s.match(new RegExp(`^(${Object.keys(ORDINALS).join("|")})\\b`));
  if (ord) return ORDINALS[ord[1]];
  const at = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (at) {
    const hour = (+at[1] % 12) + (at[3] === "pm" ? 12 : 0);
    const minute = +(at[2] ?? 0);
    const idx = slots.findIndex((sl) => {
      const p = new Date(sl.start).toLocaleTimeString("en-US", {
        timeZone: tz, hour12: false, hour: "2-digit", minute: "2-digit",
      });
      const [h, m] = p.split(":").map(Number);
      return h % 24 === hour && m === minute;
    });
    if (idx >= 0) return idx + 1;
  }
  if (/^(yes|yeah|sure|sounds good|ok|okay)\b/.test(s)) return slots.length === 1 ? 1 : null;
  return null;
}

function optionsText(slots, dateLabel) {
  const list = slots.map((s, i) => `${i + 1}) ${s.label}`).join("  ");
  return `I have these open ${dateLabel}: ${list}. Reply with a number.`;
}

/**
 * The agent loop: normalized inbound message -> intent -> calendar tools ->
 * reply via notify(). Contractor-originated changes confirm to the
 * contractor; client-originated changes always notify the contractor too.
 * Tool calls are logged as AgentActions; failures become a plain-language
 * reply, never a throw at the user.
 */
function createLoop({ calendar, ai, store, notify, createTask, upsertContact, contractorPhone, tz = "America/Los_Angeles", now = () => new Date() }) {
  const isContractor = (from) => contractorPhone && from === contractorPhone;

  async function reply(to, body) {
    await notify({ to, body, threadKey: to });
  }

  async function tellContractor(body) {
    if (contractorPhone) await notify({ to: contractorPhone, body, threadKey: contractorPhone });
  }

  async function record(tool, args, fn) {
    try {
      const result = await fn();
      store.logAction({ tool, args, result });
      return result;
    } catch (e) {
      store.logAction({ tool, args, error: e.message });
      throw e;
    }
  }

  async function crmSync(phone) {
    if (!upsertContact) return;
    const c = store.data.customers[phone];
    if (!c || c.ambiguousCrmId) return;
    const contact = await record(
      "crm_upsert_contact",
      { name: c.name ?? null, phone },
      () => upsertContact({ name: c.name ?? null, phone })
    ).catch(() => null);
    if (contact?.id) store.upsertCustomer(phone, { ambiguousCrmId: contact.id });
  }

  function labeledSlots(slots) {
    return slots.map((s) => ({ ...s, label: fmtTime(s.start, tz) }));
  }

  async function digest() {
    const today = resolveDayRef("today", tz, now());
    const events = await calendar.listDay({ date: today });
    return events.length
      ? `Today's route: ${events.map((e) => `${fmtTime(e.start, tz)} ${e.title}`).join("; ")}.`
      : "Nothing on the calendar today.";
  }

  async function clientUpdate(phone) {
    const nowMs = now().getTime();
    let sent = 0;
    for (const p of phone ? [phone] : Object.keys(store.data.customers)) {
      const job = store.jobForPhone(p);
      if (!job || job.status !== "confirmed" || new Date(job.window.end).getTime() <= nowMs) continue;
      await record("client_update", { phone: p, jobId: job.id }, () =>
        reply(p, `You have ${job.description} ${fmtDay(job.window.start, tz)} at ${fmtTime(job.window.start, tz)}. Reply with a new day or time to move it.`)
      );
      sent++;
    }
    return { sent };
  }

  async function propose(msg, intent, mode, jobId, say) {
    const duration = intent.durationMinutes ?? 60;
    let date = resolveDayRef(intent.dayRef, tz, now());
    let slots = await record("get_availability", { date, durationMinutes: duration }, () =>
      calendar.proposeSlots({ date, durationMinutes: duration, count: 3, timePref: intent.timePref })
    );
    if (!slots.length) {
      date = nextDay(date);
      slots = await record("get_availability", { date, durationMinutes: duration }, () =>
        calendar.proposeSlots({ date, durationMinutes: duration, count: 3, timePref: intent.timePref })
      );
    }
    if (!slots.length) {
      return say("Those days are fully booked. Want me to look further out?");
    }
    store.setThread(msg.threadKey, {
      pendingProposal: {
        mode,
        jobId: jobId ?? null,
        slots: slots.map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() })),
        description: intent.description ?? msg.body,
        customerPhone: msg.from,
        createdAt: now().toISOString(),
      },
    });
    await say(optionsText(labeledSlots(slots), fmtDay(slots[0].start, tz)));
  }

  async function proposalReply(msg, thread, say) {
    const p = thread.pendingProposal;
    if (/never ?mind|nvm|forget it|cancel/i.test(msg.body)) {
      store.setThread(msg.threadKey, { pendingProposal: null });
      return say("No problem — nothing changed.");
    }
    const n = parseChoice(msg.body, p.slots, tz);
    if (!n || n > p.slots.length) {
      const list = p.slots.map((s, i) => `${i + 1}) ${fmtTime(s.start, tz)}`).join("  ");
      return say(`Sorry, which one — ${list}? Reply with a number.`);
    }
    const slot = p.slots[n - 1];
    const customer = store.upsertCustomer(p.customerPhone, {});
    await crmSync(p.customerPhone);
    if (p.mode === "reschedule" && p.jobId) {
      const job = store.data.jobs[p.jobId];
      await record("reschedule_job", { jobId: p.jobId, slot }, () =>
        calendar.updateEvent({ eventId: job.ambiguousEventId, start: slot.start, end: slot.end })
      );
      job.window = slot;
      store.save();
      store.setThread(msg.threadKey, { pendingProposal: null });
      await say(`Done — moved to ${fmtDay(slot.start, tz)} at ${fmtTime(slot.start, tz)}.`);
      if (!isContractor(msg.from)) {
        await tellContractor(`${p.description} moved to ${fmtDay(slot.start, tz)} ${fmtTime(slot.start, tz)} by the client.`);
      }
      return;
    }
    const custName = store.data.customers[p.customerPhone]?.name;
    const ev = await record("book_job", { slot, description: p.description }, () =>
      calendar.createEvent({
        title: `${p.description} — ${custName ?? p.customerPhone}`,
        start: slot.start,
        end: slot.end,
        description: `${p.description}\nClient: ${custName ?? "unknown"} ${p.customerPhone}`,
      })
    );
    store.addJob({
      customerId: customer.id,
      contractorId: "contractor",
      ambiguousEventId: ev.id,
      status: "confirmed",
      window: slot,
      description: p.description,
      source: msg.channel === "voice" ? "call" : "message",
    });
    store.setThread(msg.threadKey, { pendingProposal: null });
    await say(`Locked in — ${p.description} ${fmtDay(slot.start, tz)} at ${fmtTime(slot.start, tz)}. We'll see you then.`);
    if (!isContractor(msg.from)) {
      await tellContractor(`New booking: ${p.description} ${fmtDay(slot.start, tz)} ${fmtTime(slot.start, tz)} for ${custName ?? p.customerPhone}.`);
    }
  }

  async function runningLate(msg, intent, say) {
    const mins = intent.delayMinutes ?? 15;
    const job = store.nextJob(now().getTime());
    if (!job?.ambiguousEventId) {
      return say("I don't see an active job to shift — which visit is this about?");
    }
    const start = new Date(new Date(job.window.start).getTime() + mins * 60000).toISOString();
    const end = new Date(new Date(job.window.end).getTime() + mins * 60000).toISOString();
    await record("report_delay", { jobId: job.id, mins }, () =>
      calendar.updateEvent({ eventId: job.ambiguousEventId, start, end })
    );
    job.window = { start, end };
    job.eta = start;
    store.save();
    const cust = Object.values(store.data.customers).find((c) => c.id === job.customerId);
    if (cust) {
      await notify({
        to: cust.phone,
        body: `Running about ${mins} min late — new ETA ${fmtTime(start, tz)}. Sorry for the wait!`,
        threadKey: cust.phone,
      });
    }
    await say(`Updated — shifted ${job.description} by ${mins} min and let them know.`);
  }

  async function cancel(msg, say) {
    const job = isContractor(msg.from) ? store.nextJob(now().getTime()) : store.jobForPhone(msg.from);
    if (!job?.ambiguousEventId) {
      return say("I don't see a booking to cancel.");
    }
    await record("cancel_job", { jobId: job.id }, () =>
      calendar.cancelEvent({ eventId: job.ambiguousEventId })
    );
    job.status = "canceled";
    store.save();
    const label = `${job.description} ${fmtDay(job.window.start, tz)}`;
    if (isContractor(msg.from)) {
      const cust = Object.values(store.data.customers).find((c) => c.id === job.customerId);
      if (cust) {
        await notify({ to: cust.phone, body: `Sorry — ${label} needs to be canceled. Reply here and I'll find you a new time.`, threadKey: cust.phone });
      }
      return say(`Canceled ${label} and told them.`);
    }
    await say(`Canceled ${label}. If you want to rebook, just say so.`);
    await tellContractor(`Client canceled ${label} — that slot is free.`);
  }

  async function handle(msg) {
    const thread = store.thread(msg.threadKey) ?? { threadKey: msg.threadKey };
    const out = {};
    const say = async (body) => {
      if (msg.channel === "voice") out.reply = body;
      else await reply(msg.from, body);
    };
    try {
      if (thread.pendingProposal) await proposalReply(msg, thread, say);
      else {
        const intent = await ai.classify(msg.body);
        store.setThread(msg.threadKey, { lastIntent: intent.intent });
        switch (intent.intent) {
          case "book":
            store.upsertCustomer(msg.from, intent.name ? { name: intent.name } : {});
            await crmSync(msg.from);
            await propose(msg, intent, "book", null, say);
            break;
          case "reschedule": {
            const job = store.jobForPhone(msg.from);
            if (!job?.ambiguousEventId) await say("I don't see a booking to move — want me to set one up?");
            else await propose(msg, intent, "reschedule", job.id, say);
            break;
          }
          case "day_summary":
            await say(await digest());
            break;
          case "running_late":
            await runningLate(msg, intent, say);
            break;
          case "cancel":
            await cancel(msg, say);
            break;
          default:
            if (isContractor(msg.from) && createTask) {
              const task = await record("create_task", { title: msg.body }, () => createTask(msg.body));
              await say(`Logged as a task: "${task?.title ?? msg.body}".`);
            } else {
              await say("I can help you book, move, or cancel a visit — what do you need?");
            }
        }
      }
    } catch (e) {
      console.error(`agent loop failed for ${msg.externalId}: ${e.message}`);
      await say("Sorry — I couldn't reach the calendar just now. Try again in a minute.");
    }
    return out.reply;
  }

  return { handle, digest, clientUpdate, parseChoice };
}

module.exports = { createLoop, parseChoice, fmtTime, fmtDay };
