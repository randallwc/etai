/**
 * The frontend's only Ambiguous call: POST the finished call transcript
 * as a workspace document. Minimum because it is the single boundary
 * file the repo rules require and it holds one function.
 */
const BASE = import.meta.env.DEV ? "/api" : "https://app.ambiguous.ai/api";
const KEY = import.meta.env.VITE_AMBIGUOUS_API_KEY;

const enabled = Boolean(KEY);

/**
 * Store the finished call transcript as a workspace document so coworkers
 * can read and validate it. Never throws - check `ok` on the result.
 */
export async function sendConversation({ agentId, transcript, endedAt }) {
  if (!enabled) return { ok: true, mocked: true };
  try {
    const res = await fetch(`${BASE}/documents`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "doc",
        title: `Call transcript - ${endedAt}`,
        content: `Call with coworker ${agentId}\nEnded ${endedAt}\n\n${transcript}`,
      }),
    });
    const doc = await res.json();
    if (!res.ok) throw new Error(`Ambiguous /documents -> ${res.status}`);
    return { ok: true, docId: doc.id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
