/**
 * Job packet: on booking, create the paperwork a real dispatch needs -
 * a public intake form for the customer, a work-order doc, a Sign draft
 * of the work authorization (agents may prepare, humans send), a CRM
 * deal, and a linked follow-up task. Every step is non-fatal: failures
 * land in packet.errors and the booking still completes.
 */
const INTAKE_FIELDS = [
  { id: "gate_code", type: "short_text", label: "Gate or entry code" },
  {
    id: "pets",
    type: "select",
    label: "Any pets we should know about?",
    options: ["No pets", "Yes - dog", "Yes - cat", "Yes - other"],
  },
  { id: "photos", type: "file_upload", label: "Photos of the problem area" },
  { id: "notes", type: "long_text", label: "Anything else we should know" },
];

function workOrderMarkdown({ description, customer, location, when }) {
  return [
    `# Work order - ${description}`,
    "",
    `- Customer: ${customer.name ?? "unknown"} (${customer.phone})`,
    location ? `- Where: ${location}` : null,
    `- When: ${when}`,
    `- Job: ${description}`,
    "",
    "## Work authorization",
    "",
    "Customer authorizes the work described above. Signature on the attached Sign document.",
  ]
    .filter(Boolean)
    .join("\n");
}

async function createJobPacket({ ambi, job, customer, location, when, now = () => new Date() }) {
  const packet = { createdAt: now().toISOString(), errors: [] };
  const custName = customer.name ?? customer.phone;
  const step = async (name, fn) => {
    try {
      return await fn();
    } catch (e) {
      packet.errors.push({ step: name, error: e.message });
      return null;
    }
  };

  const [form, doc, deal] = await Promise.all([
    step("form", () =>
      ambi.createForm({
        title: `Intake - ${job.description} - ${custName}`,
        description: "A few details before your upcoming visit.",
        fields: INTAKE_FIELDS,
      })
    ),
    step("work_order", () =>
      ambi.createDocument({
        title: `Work order - ${job.description} - ${custName}`,
        content: workOrderMarkdown({ description: job.description, customer, location, when }),
      })
    ),
    step("deal", () =>
      customer.ambiguousCrmId
        ? ambi.createDeal({ title: `${job.description} - ${custName}`, contactId: customer.ambiguousCrmId })
        : null
    ),
  ]);

  if (form) {
    packet.formId = form.id;
    packet.formUrl = form.public_url;
  }
  if (doc) packet.documentId = doc.id;
  if (deal) packet.dealId = deal.id;

  const [sign, task, activity] = await Promise.all([
    step("sign_draft", () =>
      doc
        ? ambi.createSignDraft({
            title: `Work authorization - ${job.description} - ${custName}`,
            sourceDocId: doc.id,
            signer: customer.email ? { email: customer.email, name: custName } : null,
          })
        : null
    ),
    step("task", () =>
      ambi.createTask({
        title: `Prep for ${job.description} - review intake, send work auth`,
        contact_id: customer.ambiguousCrmId ?? undefined,
        deal_id: deal?.id ?? undefined,
        due_date: job.window?.start?.slice(0, 10),
      })
    ),
    step("activity", () =>
      customer.ambiguousCrmId
        ? ambi.logActivity({
            contactId: customer.ambiguousCrmId,
            dealId: deal?.id,
            subject: `Booked: ${job.description}`,
            body: `${when}${location ? ` at ${location}` : ""} - booked via etAI.`,
          })
        : null
    ),
  ]);

  if (sign) {
    packet.signDocumentId = sign.id;
    packet.signStatus = sign.status;
  }
  if (task) packet.taskId = task.id;
  return packet;
}

module.exports = { createJobPacket, INTAKE_FIELDS, workOrderMarkdown };
