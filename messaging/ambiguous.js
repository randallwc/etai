const DEFAULT_BASE = "https://app.ambiguous.ai";

function createAmbiguous(env = process.env) {
  const base = (env.AMBIGUOUS_BASE_URL ?? DEFAULT_BASE).replace(/\/$/, "");
  const key = env.AMBIG_API ?? env.AMBIGUOUS_API_KEY;
  const enabled = Boolean(key);

  async function api(path, options = {}) {
    const res = await fetch(`${base}/api${path}`, {
      ...options,
      signal: AbortSignal.timeout(60_000),
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "API-Version": "1",
        ...(options.headers ?? {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const code =
        res.status === 404
          ? "not_found"
          : res.status === 401 || res.status === 403
            ? "auth"
            : "upstream";
      throw Object.assign(new Error(`Ambiguous ${path} -> ${res.status}`), {
        status: res.status,
        code,
      });
    }
    return data;
  }

  async function findContact(phone) {
    const res = await api(`/crm/contacts?q=${encodeURIComponent(phone)}`);
    const digits = phone.replace(/\D/g, "");
    return (
      (res.data ?? []).find(
        (c) => (c.phone ?? "").replace(/\D/g, "") === digits
      ) ?? null
    );
  }

  return {
    enabled,
    api,
    async users() {
      return (await api("/users")).data ?? [];
    },
    async calendars() {
      return (await api("/calendars")).data ?? [];
    },
    async events(startIso, endIso) {
      return (await api(`/calendars/events?start=${startIso}&end=${endIso}`))
        .data ?? [];
    },
    async busySlots(userId, startIso, endIso) {
      const res = await api(
        `/calendars/availability?user_ids=${userId}&start=${startIso}&end=${endIso}`
      );
      return res?.availability?.[userId] ?? [];
    },
    async createEvent(calendarId, body) {
      const data = await api(`/calendars/${calendarId}/events`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return data.event ?? data;
    },
    async updateEvent(eventId, patch) {
      const data = await api(`/calendars/events/${eventId}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      return data.event ?? data;
    },
    async deleteEvent(eventId) {
      await api(`/calendars/events/${eventId}`, { method: "DELETE" });
    },
    findContact,
    async upsertContact({ name, phone }) {
      const existing = await findContact(phone);
      if (existing) {
        if (name && name !== existing.name) {
          const data = await api(`/crm/contacts/${existing.id}`, {
            method: "PATCH",
            body: JSON.stringify({ name }),
          });
          return data.contact ?? data;
        }
        return existing;
      }
      const data = await api("/crm/contacts", {
        method: "POST",
        body: JSON.stringify({ type: "person", name: name ?? phone, phone }),
      });
      return data.contact ?? data;
    },
    async createTask(task) {
      const body = typeof task === "string" ? { title: task } : task;
      const data = await api("/tasks", {
        method: "POST",
        body: JSON.stringify(body),
      });
      return data.task ?? data;
    },
    async createDocument({ title, content }) {
      const data = await api("/documents", {
        method: "POST",
        body: JSON.stringify({ type: "doc", title, content }),
      });
      return data.document ?? data;
    },
    async createForm({ title, description, fields }) {
      const data = await api("/forms", {
        method: "POST",
        body: JSON.stringify({ title, description, fields, is_published: true }),
      });
      const form = data.form ?? data;
      if (form.workspace_slug && form.slug) {
        form.public_url = `https://app.ambiguous.ai/f/${form.workspace_slug}/${form.slug}`;
      }
      return form;
    },
    async createDeal({ title, contactId }) {
      const data = await api("/crm/deals", {
        method: "POST",
        body: JSON.stringify({ title, contact_id: contactId, primary_contact_id: contactId }),
      });
      return data.deal ?? data;
    },
    async logActivity({ contactId, dealId, subject, body }) {
      const data = await api("/crm/activities", {
        method: "POST",
        body: JSON.stringify({
          type: "note",
          contact_id: contactId,
          deal_id: dealId ?? undefined,
          subject,
          body,
        }),
      });
      return data.activity ?? data;
    },
    async createSignDraft({ title, sourceDocId, signer }) {
      const { document } = await api("/sign", {
        method: "POST",
        body: JSON.stringify({ title, source_type: "doc", source_doc_id: sourceDocId }),
      });
      if (signer?.email) {
        const { signer: s } = await api(`/sign/${document.id}/signers`, {
          method: "POST",
          body: JSON.stringify({ email: signer.email, name: signer.name ?? signer.email }),
        });
        await api(`/sign/${document.id}/fields`, {
          method: "POST",
          body: JSON.stringify({
            signer_id: s.id,
            type: "signature",
            page: 1,
            x: 0.08,
            y: 0.85,
            w: 0.4,
            h: 0.06,
            required: true,
          }),
        });
        const prepared = await api(`/sign/${document.id}/prepare-send`, { method: "POST" });
        return prepared.document ?? document;
      }
      return document;
    },
    async assistantChat(message) {
      return api("/assistant/chat", {
        method: "POST",
        body: JSON.stringify({ message, context: { audience: "agent" } }),
      });
    },
  };
}

module.exports = { createAmbiguous };
