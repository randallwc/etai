MESSAGING PERF PASS -- decision log
====================================

Owner: messaging / phone team.

This is the decision log for the hardening shipped in commit 3985453
("Bound messaging waits"). The run/config reference stays in
docs/messaging.md; this file exists because that doc describes what the
service does, while this one records what was slow and why the fixes
look the way they do. Read messaging.md first; come here when a choice
looks odd.

WHAT WAS WRONG
--------------

Every outbound fetch was unbounded. Subscriber fanout, both transport
sends, and all five mail-poller calls could hang forever. The real cost
was not the hang itself but what it held: the inflight dedup slot, so a
provider's retry of the same message was swallowed as a duplicate until
the first attempt unblocked, and the webhook ack, so BlueBubbles saw us
as slow whenever any single subscriber was.

The mail poller ran on a bare setInterval. A poll slower than
MAIL_POLL_SECONDS stacked the next poll on top of it, so a degraded
inbox produced compounding concurrent inbox scans plus duplicate
mark-read PATCHes.

Non-gateway mail was re-normalized on every poll. The skipped set only
suppressed the log line; fromMail still ran on the same unread items
every five seconds for the life of the process.

Request bodies had no cap. A large POST buffered into memory without
limit, and malformed JSON fell out of readBody as a 500, which tells
providers to retry what can never succeed.

WHAT CHANGED
------------

One env var, FETCH_TIMEOUT_MS, bounds every outbound fetch via
AbortSignal.timeout -- 8s for fanout and poll calls, 15s for transport
sends, which ride slower upstream APIs. Tests set it to 80ms, which is
also why it exists as config rather than a constant.

pollOnce short-circuits when a poll is already running. The interval
still fires on schedule; an overlapped tick just returns 0.

Skipped mail ids are checked before fromMail runs, so a non-gateway
item costs one map lookup per poll instead of a re-parse. The set is
capped at 5000, oldest evicted.

Bodies over 1 MiB are rejected with 413 while the rest of the upload
drains; malformed JSON is a 400.

TRIED AND REJECTED
------------------

Ack the webhook after the first successful fanout instead of waiting
for all subscribers. Rejected for now: Promise.all plus the timeout
already bounds the worst case, and the not-accepted response is the
signal that feeds provider retries and the undelivered queue. Revisit
if subscriber count grows past a handful.

Mark skipped non-gateway mail read so the inbox query stops returning
it. Rejected at first so a human still saw it as unread in the workspace
inbox, then implemented: an ignored non-gateway mail was refetched and
re-logged on every poll forever, and the mail remains visible in the
mailbox either way. The in-memory skipped set still guards the
mark-read-failure case.

A ring buffer for the recent-messages log. Rejected: shift() on a
200-entry array is noise, not a bottleneck.

Dropping the per-event ambimail payload log. Rejected for the hackathon;
it is the only visibility into what the push webhook actually sends.
If volume makes it hot, gate it behind a DEBUG flag.

KNOWN CEILING
-------------

The webhook ack still awaits fanout. At the current scale (a handful of
subscribers, FETCH_TIMEOUT_MS bound) that is fine. If inbound rate or
subscriber count grows, the upgrade path is: mark deduped, ack
immediately, and let the undelivered queue own delivery confirmation.
That trades a weaker provider-facing signal for ack latency.

In-memory state (seen, skipped, recent) dies on restart -- deliberate
for the demo. The undelivered queue is the exception: it persists to
UNDELIVERED_FILE so a restart cannot drop buffered inbound. A durable
store for the rest is the upgrade path if redelivery-after-crash ever
matters.
