const { fmtTime } = require("./loop.js");

/**
 * Reminds the contractor before each confirmed job so they head to the next
 * site on time. Texts once per job inside the lead window and offers the
 * "running N late" hook, which the loop already handles.
 */
function startReminders({ store, notify, contractorPhone, tz = "America/Los_Angeles", leadMinutes = 30, intervalMs = 60000, now = () => new Date() }) {
  async function tick() {
    if (!contractorPhone) return;
    const t = now().getTime();
    for (const job of Object.values(store.data.jobs)) {
      if (job.status !== "confirmed" || job.remindedAt) continue;
      const start = new Date(job.window.start).getTime();
      const untilStart = start - t;
      if (untilStart <= leadMinutes * 60000 && untilStart > -15 * 60000) {
        await notify({
          to: contractorPhone,
          body: `Next up: ${job.description} at ${fmtTime(job.window.start, tz)}. Reply "running N late" and I'll update them.`,
          threadKey: contractorPhone,
        });
        job.remindedAt = now().toISOString();
        store.save();
      }
    }
  }

  const timer = setInterval(() => tick().catch((e) => console.error(`reminder tick: ${e.message}`)), intervalMs);
  timer.unref?.();
  return { tick, stop: () => clearInterval(timer) };
}

module.exports = { startReminders };
