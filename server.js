require("dotenv").config();
const express = require("express");
const twilio  = require("twilio");
const path    = require("path");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public")));

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken  = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_FROM_NUMBER;

if (!accountSid || !authToken || !fromNumber) {
  console.error("ERROR: Missing Twilio credentials in .env");
  process.exit(1);
}

const client = twilio(accountSid, authToken);

// ── Scheduled messages store (in-memory) ─────────────────────────────────────
const scheduled = []; // { id, to, body, sendAt, status, timerId }

// ── GET /config ───────────────────────────────────────────────────────────────
app.get("/config", (req, res) => {
  res.json({ fromNumber });
});

// ── POST /send ────────────────────────────────────────────────────────────────
app.post("/send", async (req, res) => {
  const { to, body } = req.body;
  if (!to || !body) return res.status(400).json({ success: false, error: "Missing to or body" });
  console.log("[SEND] To:", to, "Body:", body.substring(0, 60));
  try {
    const msg = await client.messages.create({ from: fromNumber, to, body });
    console.log("[SEND] OK SID=" + msg.sid);
    res.json({ success: true, sid: msg.sid, status: msg.status });
  } catch (err) {
    console.error("[SEND] ERR", err.code, err.message);
    res.status(400).json({ success: false, error: err.message, code: err.code });
  }
});

// ── GET /receive?to=+1xxx&limit=100 ──────────────────────────────────────────
app.get("/receive", async (req, res) => {
  const { to: filterFrom, limit = 100 } = req.query;
  try {
    const msgs = await client.messages.list({ to: fromNumber, limit: parseInt(limit) });
    const result = msgs
      .filter(m => m.direction === "inbound" && (!filterFrom || m.from === filterFrom))
      .map(m => ({
        sid: m.sid, body: m.body, from: m.from, to: m.to,
        direction: m.direction, status: m.status,
        numSegments: m.numSegments, price: m.price, priceUnit: m.priceUnit,
        dateSent: m.dateSent, dateCreated: m.dateCreated, dateUpdated: m.dateUpdated
      }));
    res.json({ success: true, messages: result, total: result.length });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message, code: err.code });
  }
});

// ── GET /history?to=+1xxx&limit=100  (both inbound + outbound for a number) ──
app.get("/history", async (req, res) => {
  const { to: contact, limit = 100 } = req.query;
  if (!contact) return res.status(400).json({ success: false, error: "Missing to param" });
  try {
    const [outbound, inbound] = await Promise.all([
      client.messages.list({ from: fromNumber, to: contact, limit: parseInt(limit) }),
      client.messages.list({ to: fromNumber, from: contact, limit: parseInt(limit) })
    ]);
    const all = [
      ...outbound.map(m => ({ ...pick(m), direction: "outbound" })),
      ...inbound.map(m => ({ ...pick(m), direction: "inbound" }))
    ].sort((a, b) => new Date(a.dateCreated) - new Date(b.dateCreated));
    res.json({ success: true, messages: all, total: all.length });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message, code: err.code });
  }
});

function pick(m) {
  return {
    sid: m.sid, body: m.body, from: m.from, to: m.to,
    status: m.status, numSegments: m.numSegments,
    price: m.price, priceUnit: m.priceUnit,
    dateSent: m.dateSent, dateCreated: m.dateCreated,
    errorCode: m.errorCode, errorMessage: m.errorMessage
  };
}

// ── GET /status/:sid ──────────────────────────────────────────────────────────
app.get("/status/:sid", async (req, res) => {
  try {
    const m = await client.messages(req.params.sid).fetch();
    res.json({
      success: true, sid: m.sid, status: m.status,
      errorCode: m.errorCode, errorMessage: m.errorMessage,
      price: m.price, priceUnit: m.priceUnit, numSegments: m.numSegments
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message, code: err.code });
  }
});

// ── DELETE /messages/:sid  (permanently delete from Twilio logs) ──────────────
app.delete("/messages/:sid", async (req, res) => {
  const { sid } = req.params;
  console.log("[DELETE] Deleting SID:", sid);
  try {
    await client.messages(sid).remove();
    console.log("[DELETE] Deleted:", sid);
    res.json({ success: true, sid });
  } catch (err) {
    console.error("[DELETE] ERR", err.code, err.message);
    res.status(400).json({ success: false, error: err.message, code: err.code });
  }
});

// ── POST /redact/:sid  (clear message body but keep log record) ───────────────
app.post("/redact/:sid", async (req, res) => {
  const { sid } = req.params;
  console.log("[REDACT] Redacting SID:", sid);
  try {
    await client.messages(sid).update({ body: "" });
    console.log("[REDACT] Redacted:", sid);
    res.json({ success: true, sid });
  } catch (err) {
    console.error("[REDACT] ERR", err.code, err.message);
    res.status(400).json({ success: false, error: err.message, code: err.code });
  }
});

// ── POST /schedule  { to, body, sendAt (ISO string) } ─────────────────────────
app.post("/schedule", (req, res) => {
  const { to, body, sendAt } = req.body;
  if (!to || !body || !sendAt) return res.status(400).json({ success: false, error: "Missing to/body/sendAt" });
  const delay = new Date(sendAt) - Date.now();
  if (delay < 1000) return res.status(400).json({ success: false, error: "sendAt must be in the future" });

  const id = "sch_" + Date.now();
  const job = { id, to, body, sendAt, status: "pending", sid: null };

  const timerId = setTimeout(async () => {
    console.log("[SCHED] Firing scheduled message id=" + id + " to=" + to);
    try {
      const msg = await client.messages.create({ from: fromNumber, to, body });
      job.status = "sent";
      job.sid    = msg.sid;
      console.log("[SCHED] Sent SID=" + msg.sid);
    } catch (err) {
      job.status = "failed";
      job.error  = err.message;
      console.error("[SCHED] FAILED:", err.message);
    }
  }, delay);

  job.timerId = timerId;
  scheduled.push(job);
  console.log("[SCHED] Queued id=" + id + " delay=" + Math.round(delay/1000) + "s");
  res.json({ success: true, id, sendAt, to });
});

// ── GET /schedule  (list all scheduled) ──────────────────────────────────────
app.get("/schedule", (req, res) => {
  const list = scheduled.map(({ id, to, body, sendAt, status, sid }) => ({ id, to, body, sendAt, status, sid }));
  res.json({ success: true, scheduled: list });
});

// ── DELETE /schedule/:id  (cancel a scheduled message) ───────────────────────
app.delete("/schedule/:id", (req, res) => {
  const idx = scheduled.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, error: "Not found" });
  const job = scheduled[idx];
  if (job.status !== "pending") return res.status(400).json({ success: false, error: "Already " + job.status });
  clearTimeout(job.timerId);
  scheduled.splice(idx, 1);
  console.log("[SCHED] Cancelled:", req.params.id);
  res.json({ success: true, id: req.params.id });
});

// ── GET /stats?to=+1xxx  (cost + segment summary) ────────────────────────────
app.get("/stats", async (req, res) => {
  const { to: contact } = req.query;
  try {
    const params = contact
      ? [client.messages.list({ from: fromNumber, to: contact, limit: 200 }),
         client.messages.list({ to: fromNumber, from: contact, limit: 200 })]
      : [client.messages.list({ from: fromNumber, limit: 200 }),
         client.messages.list({ to: fromNumber, limit: 200 })];

    const [outbound, inbound] = await Promise.all(params);
    const all = [...outbound, ...inbound];

    let totalCost = 0, totalSegs = 0;
    const statuses = {};
    all.forEach(m => {
      if (m.price) totalCost += Math.abs(parseFloat(m.price));
      if (m.numSegments) totalSegs += parseInt(m.numSegments);
      statuses[m.status] = (statuses[m.status] || 0) + 1;
    });

    res.json({
      success: true,
      total: all.length,
      sent: outbound.length,
      received: inbound.length,
      totalCostUSD: totalCost.toFixed(4),
      totalSegments: totalSegs,
      statuses
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message, code: err.code });
  }
});

// ── GET /health ───────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", from: fromNumber, time: new Date().toISOString(), scheduledCount: scheduled.filter(s => s.status === "pending").length });
});

app.listen(PORT, () => {
  console.log("═══════════════════════════════════════");
  console.log("  NOVA SMS  →  http://localhost:" + PORT);
  console.log("  From: " + fromNumber);
  console.log("═══════════════════════════════════════");
  console.log("  Endpoints:");
  console.log("  GET  /config");
  console.log("  POST /send");
  console.log("  GET  /receive");
  console.log("  GET  /history?to=+1xxx");
  console.log("  GET  /status/:sid");
  console.log("  DELETE /messages/:sid   ← delete from Twilio logs");
  console.log("  POST /redact/:sid       ← clear message body");
  console.log("  POST /schedule          ← schedule future send");
  console.log("  GET  /schedule          ← list scheduled");
  console.log("  DELETE /schedule/:id    ← cancel scheduled");
  console.log("  GET  /stats             ← cost + usage stats");
  console.log("═══════════════════════════════════════");
});
