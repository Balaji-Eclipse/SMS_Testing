// Only load .env locally — on Render, env vars are set in the dashboard
if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const express = require("express");
const twilio  = require("twilio");
const path    = require("path");

const app  = express();

// ── CRITICAL FOR RENDER: listen on 0.0.0.0, Render injects PORT ──────────────
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public")));

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken  = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_FROM_NUMBER;

if (!accountSid || !authToken || !fromNumber) {
  console.error("ERROR: Missing Twilio credentials!");
  console.error("On Render → Dashboard → Environment → add:");
  console.error("  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER");
  process.exit(1);
}

const client = twilio(accountSid, authToken);

// ── Scheduled messages (in-memory) ───────────────────────────────────────────
const scheduled = [];

// ── Keep-alive ping (Render free tier spins down after 15 min idle) ───────────
// Render sets RENDER_EXTERNAL_URL automatically on all web services
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_URL) {
  const https = require("https");
  setInterval(() => {
    https.get(RENDER_URL + "/health", res => {
      console.log("[KEEPALIVE] /health →", res.statusCode);
    }).on("error", e => console.warn("[KEEPALIVE] fail:", e.message));
  }, 14 * 60 * 1000);
  console.log("[KEEPALIVE] Active — pinging every 14 min");
}

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

// ── GET /history?to=+1xxx&limit=100 ──────────────────────────────────────────
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
    res.json({ success: true, sid: m.sid, status: m.status,
      errorCode: m.errorCode, errorMessage: m.errorMessage,
      price: m.price, priceUnit: m.priceUnit, numSegments: m.numSegments });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message, code: err.code });
  }
});

// ── DELETE /messages/:sid ─────────────────────────────────────────────────────
app.delete("/messages/:sid", async (req, res) => {
  console.log("[DELETE] SID:", req.params.sid);
  try {
    await client.messages(req.params.sid).remove();
    res.json({ success: true, sid: req.params.sid });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message, code: err.code });
  }
});

// ── POST /redact/:sid ─────────────────────────────────────────────────────────
app.post("/redact/:sid", async (req, res) => {
  console.log("[REDACT] SID:", req.params.sid);
  try {
    await client.messages(req.params.sid).update({ body: "" });
    res.json({ success: true, sid: req.params.sid });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message, code: err.code });
  }
});

// ── POST /schedule ────────────────────────────────────────────────────────────
app.post("/schedule", (req, res) => {
  const { to, body, sendAt } = req.body;
  if (!to || !body || !sendAt) return res.status(400).json({ success: false, error: "Missing to/body/sendAt" });
  const delay = new Date(sendAt) - Date.now();
  if (delay < 1000) return res.status(400).json({ success: false, error: "sendAt must be in the future" });
  const id = "sch_" + Date.now();
  const job = { id, to, body, sendAt, status: "pending", sid: null };
  const timerId = setTimeout(async () => {
    try {
      const msg = await client.messages.create({ from: fromNumber, to, body });
      job.status = "sent"; job.sid = msg.sid;
      console.log("[SCHED] Sent SID=" + msg.sid);
    } catch (err) {
      job.status = "failed"; job.error = err.message;
      console.error("[SCHED] FAILED:", err.message);
    }
  }, delay);
  job.timerId = timerId;
  scheduled.push(job);
  console.log("[SCHED] Queued id=" + id + " in " + Math.round(delay/1000) + "s");
  res.json({ success: true, id, sendAt, to });
});

// ── GET /schedule ─────────────────────────────────────────────────────────────
app.get("/schedule", (req, res) => {
  res.json({ success: true, scheduled: scheduled.map(({ id, to, body, sendAt, status, sid }) => ({ id, to, body, sendAt, status, sid })) });
});

// ── DELETE /schedule/:id ──────────────────────────────────────────────────────
app.delete("/schedule/:id", (req, res) => {
  const idx = scheduled.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, error: "Not found" });
  const job = scheduled[idx];
  if (job.status !== "pending") return res.status(400).json({ success: false, error: "Already " + job.status });
  clearTimeout(job.timerId);
  scheduled.splice(idx, 1);
  res.json({ success: true, id: req.params.id });
});

// ── GET /stats ────────────────────────────────────────────────────────────────
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
    res.json({ success: true, total: all.length, sent: outbound.length, received: inbound.length,
      totalCostUSD: totalCost.toFixed(4), totalSegments: totalSegs, statuses });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message, code: err.code });
  }
});

// ── GET /health ───────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", from: fromNumber, time: new Date().toISOString(),
    env: process.env.NODE_ENV || "development",
    scheduledCount: scheduled.filter(s => s.status === "pending").length });
});

// ── Listen on 0.0.0.0 (REQUIRED by Render) ───────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log("═══════════════════════════════════════════════════");
  console.log("  NOVA SMS");
  console.log("  Listening: " + HOST + ":" + PORT);
  console.log("  From:      " + fromNumber);
  console.log("  Env:       " + (process.env.NODE_ENV || "development"));
  if (RENDER_URL) console.log("  Public:    " + RENDER_URL);
  console.log("═══════════════════════════════════════════════════");
});
