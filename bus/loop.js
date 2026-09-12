const { resolveDayRef } = require("./calendar.js");
const { extractFields } = require("./ai.js");

const PROPOSAL_TTL_MS = 30 * 60000;

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

function orList(items) {
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")}${items.length > 2 ? "," : ""} or ${items.at(-1)}`;
}

const WHEN_ONLY_RE =
  /^[\s,.]*(today|tomorrow|tonight|next week|morning|afternoon|evening|noon|midnight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|at|on|the|a|an|around|about|for|please|\d{1,2}(:\d{2})?\s*(am|pm)?|\d{1,2}:\d{2}|[.,'!?-])+[\s,.!?]*$/i;

function missingBook(b) {
  const m = [];
  if (b.mode === "book" && !b.description) m.push("what");
  if (!b.dayRef && !b.timePref) m.push("when");
  return m;
}

function askFor(b) {
  const q = [];
  if (!b.description) q.push("what's the job");
  if (!b.dayRef && !b.timePref) q.push("what day or time works");
  if (!b.location) q.push("the address");
  const last = q.pop();
  return `Sure - ${q.length ? `${q.join(", ")}, and ${last}` : last}?`;
}

function optionsText(slots, dateLabel, description) {
  const what = description ? `${description} - ` : "";
  return `${what}I have ${orList(slots.map((s, i) => `${i + 1}) ${s.label}`))} open ${dateLabel}. Which works?`;
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
      if (args.jobId) e.jobId = args.jobId;
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

  async function learnName(phone, name) {
    if (!name || isContractor(phone)) return;
    store.upsertCustomer(phone, { name });
    crmSync(phone);
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
    const description =
      intent.description ??
      (jobId ? store.data.jobs[jobId]?.description : null) ??
      msg.body;
    store.setThread(msg.threadKey, {
      pendingProposal: {
        mode,
        jobId: jobId ?? null,
        slots: slots.map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() })),
        description,
        location: intent.location ?? null,
        customerPhone: msg.from,
        createdAt: now().toISOString(),
      },
    });
    await say(optionsText(labeledSlots(slots), fmtDay(slots[0].start, tz), description));
  }

  async function proposalReply(msg, thread, say) {
    const p = thread.pendingProposal;
    if (/never ?mind|nvm|forget it|cancel/i.test(msg.body)) {
      store.setThread(msg.threadKey, { pendingProposal: null });
      return say("No problem, nothing changed.");
    }
    let n = parseChoice(msg.body, p.slots, tz);
    if (!n || n > p.slots.length) {
      const retry = await ai.classify(msg.body, { channel: msg.channel });
      await learnName(msg.from, retry.name);
      if (retry.slotChoice && retry.slotChoice <= p.slots.length) {
        n = retry.slotChoice;
      } else if (
        (retry.intent === "book" || retry.intent === "reschedule") &&
        (retry.dayRef || retry.timePref)
      ) {
        return propose(msg, retry, p.mode, p.jobId, say);
      } else {
        const times = orList(p.slots.map((s) => fmtTime(s.start, tz)));
        return say(`Sorry, which one - ${times}?`);
      }
    }
    const slot = p.slots[n - 1];
    const durMin = Math.round((new Date(slot.end) - new Date(slot.start)) / 60000);
    const slotDate = new Date(slot.start).toLocaleDateString("en-CA", { timeZone: tz });
    const clash = Object.values(store.data.jobs).some(
      (j) =>
        j.status === "confirmed" &&
        j.id !== p.jobId &&
        new Date(j.window.start) < new Date(slot.end) &&
        new Date(j.window.end) > new Date(slot.start)
    );
    const open =
      !clash &&
      (await record("get_availability", { date: slotDate, durationMinutes: durMin, recheck: true }, () =>
        calendar.proposeSlots({ date: slotDate, durationMinutes: durMin, count: 10 })
      )).some((s) => s.start.toISOString() === slot.start);
    if (!open) {
      await say("That time was just taken -");
      return propose(msg, { dayRef: slotDate, durationMinutes: durMin, description: p.description, location: p.location }, p.mode, p.jobId, say);
    }
    const customer = store.upsertCustomer(p.customerPhone, {});
    if (p.mode === "reschedule" && p.jobId) {
      const job = store.data.jobs[p.jobId];
      await record("reschedule_job", { jobId: p.jobId, slot }, () =>
        calendar.updateEvent({ eventId: job.ambiguousEventId, start: slot.start, end: slot.end })
      );
      job.window = slot;
      store.save();
      store.setThread(msg.threadKey, { pendingProposal: null });
      await Promise.all([
        say(`Done - moved to ${fmtDay(slot.start, tz)} at ${fmtTime(slot.start, tz)}.`),
        !isContractor(msg.from) &&
          tellContractor(`Client moved ${p.description} to ${fmtDay(slot.start, tz)} at ${fmtTime(slot.start, tz)}.`),
      ]);
      return;
    }
    const dupe = (await record("check_calendar", { date: slotDate }, () =>
      calendar.listDay({ date: slotDate })
    )).find((e) => e.status !== "canceled" && similarDesc(e.title, p.description));
    if (dupe) {
      store.setThread(msg.threadKey, { pendingProposal: null });
      return say(`Already on the calendar: ${dupe.title} ${fmtDay(dupe.start, tz)} at ${fmtTime(dupe.start, tz)}. Reply "move it" to change it.`);
    }
    const custName = store.data.customers[p.customerPhone]?.name;
    const ev = await record("book_job", { slot, description: p.description }, () =>
      calendar.createEvent({
        title: `${p.description} - ${custName ?? p.customerPhone}`,
        start: slot.start,
        end: slot.end,
        location: p.location,
        description: `${p.description}\nClient: ${custName ?? "unknown"} ${p.customerPhone}${p.location ? `\nWhere: ${p.location}` : ""}`,
      })
    ).catch((e) => {
      if (e.code === "conflict") return null;
      throw e;
    });
    if (!ev) {
      await say("That time was just taken —");
      return propose(msg, { dayRef: slotDate, durationMinutes: durMin, description: p.description }, p.mode, p.jobId, say);
    }
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
    await Promise.all([
      say(`Locked in: ${p.description} ${fmtDay(slot.start, tz)} at ${fmtTime(slot.start, tz)}. See you then.`),
      !isContractor(msg.from) &&
        tellContractor(`New booking: ${p.description} ${fmtDay(slot.start, tz)} at ${fmtTime(slot.start, tz)} for ${custName ?? p.customerPhone}.`),
    ]);
  }

  async function runningLate(msg, intent, say) {
    const mins = intent.delayMinutes ?? 15;
    const job = store.nextJob(now().getTime());
    if (!job?.ambiguousEventId) {
      return say("I don't see an active job. Which visit is this about?");
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
    await Promise.all([
      cust &&
        notify({
          to: cust.phone,
          body: `Running about ${mins} min late - new ETA ${fmtTime(start, tz)}. Sorry for the wait.`,
          threadKey: cust.phone,
        }),
      say(`Updated - shifted ${job.description} by ${mins} min and let them know.`),
    ]);
  }

  const DESC_STOP = new Set([
    "the", "and", "for", "with", "need", "visit", "appointment", "job", "work",
    "repair", "fix", "come", "book", "booking", "please", "want", "have", "some",
    "today", "tomorrow", "tonight", "morning", "afternoon", "evening", "next",
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  ]);

  function similarDesc(a, b) {
    const toks = (s) =>
      new Set(
        (s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
          .map((w) => w.replace(/s$/, ""))
          .filter((w) => w.length >= 4 && !DESC_STOP.has(w))
      );
    const wa = toks(a);
    if (!wa.size) return false;
    return [...toks(b)].some((w) => wa.has(w));
  }

  function matchJobRef(jobs, ref) {
    const r = ref.toLowerCase();
    return (
      jobs.find((j) => j.id === ref) ??
      jobs.find((j) => (j.description ?? "").toLowerCase().includes(r)) ??
      jobs.find((j) => {
        const m = r.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/);
        if (!m) return false;
        const hour = (+m[1] % 12) + (m[3] === "pm" ? 12 : 0);
        const minute = +(m[2] ?? 0);
        const p = new Date(j.window.start).toLocaleTimeString("en-US", {
          timeZone: tz, hour12: false, hour: "2-digit", minute: "2-digit",
        });
        const [h, min] = p.split(":").map(Number);
        return h % 24 === hour && min === minute;
      }) ??
      null
    );
  }

  function jobForIntent(msg, intent) {
    if (!intent.jobRef) {
      return { job: isContractor(msg.from) ? store.nextJob(now().getTime()) : store.jobForPhone(msg.from), ambiguous: false };
    }
    const jobs = isContractor(msg.from) ? store.upcomingJobs(now().getTime()) : store.jobsForPhone(msg.from);
    const job = matchJobRef(jobs, intent.jobRef);
    return { job, ambiguous: jobs.length > 0 && !job };
  }

  async function cancel(msg, intent, say) {
    const { job, ambiguous } = jobForIntent(msg, intent ?? {});
    if (ambiguous) {
      return say("You have a few bookings - which one should I cancel?");
    }
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
      await Promise.all([
        cust &&
          notify({ to: cust.phone, body: `Sorry, ${label} needs to be canceled. Reply here and I'll find you a new time.`, threadKey: cust.phone }),
        say(`Canceled ${label} and told them.`),
      ]);
      return;
    }
    await Promise.all([
      say(`Canceled ${label}. If you want to rebook, just say so.`),
      tellContractor(`Client canceled ${label} - that slot is free.`),
    ]);
  }

  async function bookReply(msg, thread, say) {
    const b = thread.pendingBook;
    if (/never ?mind|nvm|forget it|cancel/i.test(msg.body)) {
      store.setThread(msg.threadKey, { pendingBook: null });
      return say("No problem - nothing changed.");
    }
    const intent = await ai.classify(msg.body);
    const fields = extractFields(msg.body);
    await learnName(msg.from, intent.name ?? fields.name);
    for (const k of ["description", "dayRef", "timePref", "durationMinutes", "location"]) {
      if (!b[k]) b[k] = intent[k] ?? fields[k] ?? null;
    }
    if (b.mode === "book" && !WHEN_ONLY_RE.test(msg.body)) {
      if (!b.location) b.location = msg.body;
      else if (!b.description) b.description = msg.body;
    }
    if (missingBook(b).length) {
      store.setThread(msg.threadKey, { pendingBook: b });
      return say(askFor(b));
    }
    store.setThread(msg.threadKey, { pendingBook: null });
    return propose(msg, b, b.mode, b.jobId, say);
  }

  function gatherBook(msg, intent, mode, jobId) {
    return {
      mode,
      jobId: jobId ?? null,
      description: intent.description ?? (mode === "book" && !/^(book|schedule|set up|make|add)\b/i.test(msg.body.trim()) ? msg.body : null),
      dayRef: intent.dayRef ?? null,
      timePref: intent.timePref ?? null,
      durationMinutes: intent.durationMinutes ?? null,
      location: intent.location ?? null,
      customerPhone: msg.from,
      createdAt: now().toISOString(),
    };
  }

  async function handle(msg) {
    const thread = store.thread(msg.threadKey) ?? { threadKey: msg.threadKey };
    store.pushHistory(msg.threadKey, "them", msg.body);
    const out = {};
    const say = async (body) => {
      store.pushHistory(msg.threadKey, "etai", body);
      if (msg.channel === "voice") out.reply = body;
      else await reply(msg.from, body);
    };
    try {
      if (thread.pendingProposal) {
        const p = thread.pendingProposal;
        const stale =
          p.slots.every((s) => new Date(s.start) <= now()) ||
          now() - new Date(p.createdAt ?? 0) > PROPOSAL_TTL_MS;
        if (stale && !parseChoice(msg.body, p.slots, tz)) {
          store.setThread(msg.threadKey, { pendingProposal: null });
          thread.pendingProposal = null;
        }
      }
      if (thread.pendingBook && now() - new Date(thread.pendingBook.createdAt ?? 0) > PROPOSAL_TTL_MS) {
        store.setThread(msg.threadKey, { pendingBook: null });
        thread.pendingBook = null;
      }
      if (thread.pendingProposal) await proposalReply(msg, thread, say);
      else if (thread.pendingBook) await bookReply(msg, thread, say);
      else {
        if (thread.pendingClarify) store.setThread(msg.threadKey, { pendingClarify: null });
        const intent = await ai.classify(msg.body, {
          channel: msg.channel,
          role: isContractor(msg.from) ? "contractor" : "client",
          customer: store.data.customers[msg.from] ?? null,
          jobs: isContractor(msg.from) ? store.upcomingJobs(now().getTime()) : store.jobsForPhone(msg.from),
          pending: thread.pendingClarify ? { mode: "clarify", slots: [], question: thread.pendingClarify.question } : null,
          history: thread.history ?? [],
        });
        store.setThread(msg.threadKey, { lastIntent: intent.intent });
        const learnedName = intent.name ?? extractFields(msg.body).name;
        await learnName(msg.from, learnedName);
        switch (intent.intent) {
          case "book": {
            store.upsertCustomer(msg.from, learnedName ? { name: learnedName } : {});
            if (!learnedName) crmSync(msg.from).catch(() => {});
            const existing = store.jobForPhone(msg.from);
            const book = gatherBook(msg, intent, "book");
            if (!isContractor(msg.from) && existing && similarDesc(existing.description, book.description ?? msg.body)) {
              if (thread.pendingDedup) {
                store.setThread(msg.threadKey, { pendingDedup: null });
              } else {
                store.setThread(msg.threadKey, {
                  pendingDedup: { jobId: existing.id, at: now().toISOString() },
                });
                store.logAction({ tool: "dedupe_warn", args: { jobId: existing.id, phone: msg.from } });
                await say(`You already have ${existing.description} ${fmtDay(existing.window.start, tz)} at ${fmtTime(existing.window.start, tz)} - reply "move it" to reschedule, or ask again to book a second visit.`);
                break;
              }
            }
            if (thread.pendingDedup) store.setThread(msg.threadKey, { pendingDedup: null });
            if (missingBook(book).length) {
              store.setThread(msg.threadKey, { pendingBook: book });
              await say(askFor(book));
            } else {
              await propose(msg, book, "book", null, say);
            }
            break;
          }
          case "reschedule": {
            const { job, ambiguous } = jobForIntent(msg, intent);
            if (ambiguous) await say("Which visit should I move - reply with the job name or its day.");
            else if (!job?.ambiguousEventId) await say("I don't see a booking to move - want me to set one up?");
            else await propose(msg, intent, "reschedule", job.id, say);
            break;
          }
          case "day_summary":
            if (isContractor(msg.from)) await say(await digest());
            else {
              const job = store.jobForPhone(msg.from);
              await say(job
                ? `You have ${job.description} ${fmtDay(job.window.start, tz)} at ${fmtTime(job.window.start, tz)}.`
                : "Nothing booked for you right now - want me to set something up?");
            }
            break;
          case "running_late":
            if (!isContractor(msg.from)) {
              await say("No problem - I've let them know you're running behind.");
              await tellContractor(`Client ${msg.from} is running late.`);
              break;
            }
            await runningLate(msg, intent, say);
            break;
          case "cancel":
            await cancel(msg, intent, say);
            break;
          case "clarify": {
            const q = intent.question ?? intent.say ?? "Which visit do you mean?";
            store.setThread(msg.threadKey, { pendingClarify: { question: q, at: now().toISOString() } });
            store.logAction({ tool: "clarify", args: { question: q } });
            await say(q);
            break;
          }
          case "eta": {
            const job = store.jobForPhone(msg.from);
            if (job?.eta) await say(`Latest ETA ${fmtTime(job.eta, tz)} - see you soon.`);
            else if (job) await say("The contractor will text you an ETA shortly.");
            else await say("I don't see an active job for you right now.");
            break;
          }
          default:
            if (/^(ok|okay|thanks|thank you|thx|ty|got it|great|perfect|sounds good|yep|yeah|yup|cool|nice)\b/.test(msg.body.trim().toLowerCase())) {
              await say("Got it, thanks!");
            } else if (/^(bye|goodbye|that's all|thats all|all set|nothing else|nope|i'm good|im good)\b/i.test(msg.body.trim())) {
              await say("Talk soon!");
            } else if (isContractor(msg.from) && createTask) {
              record("create_task", { title: msg.body }, () => createTask(msg.body)).catch(() => {});
              await say(`Logged as a task: "${msg.body}".`);
            } else {
              await say(intent.say ?? "I can book, move, or cancel a visit - what do you need?");
            }
        }
      }
    } catch (e) {
      console.error(`agent loop failed for ${msg.externalId}: ${e.message}`);
      const boss = isContractor(msg.from);
      if (e?.code === "not_found") {
        const job = e.jobId
          ? store.data.jobs[e.jobId]
          : boss ? store.nextJob(now().getTime()) : store.jobForPhone(msg.from);
        if (job?.ambiguousEventId) {
          job.ambiguousEventId = null;
          store.save();
        }
        await say(boss
          ? `That booking isn't on the calendar anymore - cleared the link on my end. (${e.message})`
          : "That booking isn't on the calendar anymore - I cleared it on my end. Reply to set a new time.");
      } else if (e?.code === "auth") {
        await say(boss
          ? `My calendar connection needs a new key - ${e.message}.`
          : "My calendar connection needs a new key - tell the contractor.");
      } else {
        await say("Sorry - I couldn't reach the calendar just now. Try again in a minute.").catch(() => {});
      }
    }
    return out.reply;
  }

  return { handle, digest, clientUpdate, parseChoice };
}

module.exports = { createLoop, parseChoice, fmtTime, fmtDay };
