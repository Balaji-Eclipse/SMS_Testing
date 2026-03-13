if (process.env.NODE_ENV !== "production") { require("dotenv").config(); }
const express = require("express");
const twilio  = require("twilio");
const path    = require("path");
const app     = express();
const PORT    = process.env.PORT || 3000;
const HOST    = "0.0.0.0";
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public")));

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken  = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_FROM_NUMBER;
const whatsappFrom = process.env.TWILIO_WHATSAPP_FROM; // optional
if (!accountSid || !authToken || !fromNumber) {
  console.error("ERROR: Missing Twilio credentials!"); process.exit(1);
}
const client = twilio(accountSid, authToken);
const scheduled = [];

// Server-Sent Events (SSE) clients for real-time inbound updates
const sseClients = new Set();
function broadcastSSE(data){
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for(const res of sseClients){
    try{res.write(payload);}catch(_){sseClients.delete(res);}    
  }
}

// Keep-alive for Render free tier
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_URL) {
  const https = require("https");
  setInterval(() => https.get(RENDER_URL + "/health", ()=>{}).on("error", ()=>{}), 14*60*1000);
}

function pick(m) {
  return { sid: m.sid, body: m.body, from: m.from, to: m.to, status: m.status,
    direction: m.direction, numSegments: m.numSegments, price: m.price, priceUnit: m.priceUnit,
    dateCreated: m.dateCreated, dateSent: m.dateSent, dateUpdated: m.dateUpdated,
    errorCode: m.errorCode, errorMessage: m.errorMessage };
}

// ── CONFIG ────────────────────────────────────────────────────────────────────
app.get("/config", (req, res) => res.json({
  fromNumber,
  whatsappEnabled: !!whatsappFrom,
  whatsappFrom: whatsappFrom || null,
}));

// ── REAL-TIME INBOUND (Server-Sent Events) ───────────────────────────────────
app.get("/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  res.write("retry: 10000\n\n");
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

// ── TWILIO INCOMING WEBHOOK (called by Twilio when a new message arrives) ───
app.post("/incoming", (req, res) => {
  const from = req.body.From || req.body.from;
  const to = req.body.To || req.body.to;
  const body = req.body.Body || req.body.body || "";
  const sid = req.body.MessageSid || req.body.messageSid || null;
  if (!from || !to) return res.status(400).send("Missing From/To");

  // Broadcast to all connected clients
  broadcastSSE({
    type: "incoming",
    from,
    to,
    body,
    sid,
    timestamp: new Date().toISOString(),
  });

  // Twilio expects a 200 response (can return empty TwiML)
  res.send("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>");
});

// ── SEND SMS ──────────────────────────────────────────────────────────────────
app.post("/send", async (req, res) => {
  const { to, body, channel = "sms" } = req.body;
  if (!to || !body) return res.status(400).json({ success: false, error: "Missing to or body" });
  console.log("[SEND] To:", to, "Channel:", channel, "Body:", body.substring(0, 60));

  let from = fromNumber;
  let dest = to;
  if (channel === "whatsapp") {
    if (!whatsappFrom) return res.status(400).json({ success: false, error: "WhatsApp not configured on server" });
    from = `whatsapp:${whatsappFrom}`;
    dest = `whatsapp:${to.replace(/^whatsapp:/, "")}`;
  }

  try {
    const msg = await client.messages.create({ from, to: dest, body });
    console.log("[SEND] OK SID=" + msg.sid);
    res.json({ success: true, sid: msg.sid, status: msg.status, channel });
  } catch (err) {
    console.error("[SEND] ERR", err.code, err.message);
    res.status(400).json({ success: false, error: err.message, code: err.code });
  }
});

// ── HISTORY (sorted ascending — fixes order mismatch) ─────────────────────────
app.get("/history", async (req, res) => {
  const { to: contact, limit = 200 } = req.query;
  if (!contact) return res.status(400).json({ success: false, error: "Missing to" });
  try {
    const [out, inb] = await Promise.all([
      client.messages.list({ from: fromNumber, to: contact, limit: parseInt(limit) }),
      client.messages.list({ to: fromNumber, from: contact, limit: parseInt(limit) })
    ]);
    const all = [
      ...out.map(m => ({ ...pick(m), direction: "outbound" })),
      ...inb.map(m => ({ ...pick(m), direction: "inbound" }))
    ].sort((a, b) => new Date(a.dateCreated) - new Date(b.dateCreated));
    res.json({ success: true, messages: all, total: all.length });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

// ── MESSAGE STATUS ─────────────────────────────────────────────────────────────
app.get("/status/:sid", async (req, res) => {
  try {
    const m = await client.messages(req.params.sid).fetch();
    res.json({ success: true, sid: m.sid, status: m.status, errorCode: m.errorCode,
      price: m.price, numSegments: m.numSegments, dateCreated: m.dateCreated, dateSent: m.dateSent });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

// ── DELETE ONE MESSAGE ─────────────────────────────────────────────────────────
app.delete("/messages/:sid", async (req, res) => {
  console.log("[DELETE] SID:", req.params.sid);
  try { await client.messages(req.params.sid).remove(); res.json({ success: true }); }
  catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

// ── REDACT MESSAGE BODY ────────────────────────────────────────────────────────
app.post("/redact/:sid", async (req, res) => {
  try { await client.messages(req.params.sid).update({ body: "" }); res.json({ success: true }); }
  catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

// ── CLEAR ALL FOR ONE CONTACT ─────────────────────────────────────────────────
app.delete("/messages/contact/:number", async (req, res) => {
  const contact = decodeURIComponent(req.params.number);
  console.log("[CLEAR CONTACT]", contact);
  try {
    const [out, inb] = await Promise.all([
      client.messages.list({ from: fromNumber, to: contact, limit: 1000 }),
      client.messages.list({ to: fromNumber, from: contact, limit: 1000 })
    ]);
    let deleted = 0, failed = 0;
    await Promise.allSettled([...out, ...inb].map(async m => {
      try { await client.messages(m.sid).remove(); deleted++; }
      catch (e) { failed++; }
    }));
    res.json({ success: true, deleted, failed });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

// ── CLEAR ALL MESSAGES (entire account) ──────────────────────────────────────
app.delete("/messages/clearall", async (req, res) => {
  console.log("[CLEAR ALL]");
  try {
    const [out, inb] = await Promise.all([
      client.messages.list({ from: fromNumber, limit: 1000 }),
      client.messages.list({ to: fromNumber, limit: 1000 })
    ]);
    const seen = new Set();
    const all = [...out, ...inb].filter(m => { if (seen.has(m.sid)) return false; seen.add(m.sid); return true; });
    let deleted = 0, failed = 0;
    await Promise.allSettled(all.map(async m => {
      try { await client.messages(m.sid).remove(); deleted++; }
      catch (e) { failed++; }
    }));
    res.json({ success: true, deleted, failed, total: all.length });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

// ── SCHEDULE ──────────────────────────────────────────────────────────────────
app.post("/schedule", (req, res) => {
  const { to, body, sendAt } = req.body;
  if (!to || !body || !sendAt) return res.status(400).json({ success: false, error: "Missing fields" });
  const delay = new Date(sendAt) - Date.now();
  if (delay < 1000) return res.status(400).json({ success: false, error: "Must be in the future" });
  const id = "sch_" + Date.now();
  const job = { id, to, body, sendAt, status: "pending", sid: null };
  job.timerId = setTimeout(async () => {
    try { const msg = await client.messages.create({ from: fromNumber, to, body }); job.status = "sent"; job.sid = msg.sid; }
    catch (err) { job.status = "failed"; job.error = err.message; }
  }, delay);
  scheduled.push(job);
  console.log("[SCHED] id=" + id + " delay=" + Math.round(delay/1000) + "s");
  res.json({ success: true, id, sendAt, to });
});

app.get("/schedule", (req, res) => res.json({
  success: true,
  scheduled: scheduled.map(({ id, to, body, sendAt, status, sid }) => ({ id, to, body, sendAt, status, sid }))
}));

app.delete("/schedule/:id", (req, res) => {
  const idx = scheduled.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, error: "Not found" });
  const job = scheduled[idx];
  if (job.status !== "pending") return res.status(400).json({ success: false, error: "Already " + job.status });
  clearTimeout(job.timerId); scheduled.splice(idx, 1);
  res.json({ success: true });
});

// ── STATS ─────────────────────────────────────────────────────────────────────
app.get("/stats", async (req, res) => {
  const { to: contact } = req.query;
  try {
    const [out, inb] = await Promise.all(contact
      ? [client.messages.list({ from: fromNumber, to: contact, limit: 500 }),
         client.messages.list({ to: fromNumber, from: contact, limit: 500 })]
      : [client.messages.list({ from: fromNumber, limit: 500 }),
         client.messages.list({ to: fromNumber, limit: 500 })]);
    const all = [...out, ...inb];
    let totalCost = 0, totalSegs = 0; const statuses = {};
    all.forEach(m => {
      if (m.price) totalCost += Math.abs(parseFloat(m.price));
      if (m.numSegments) totalSegs += parseInt(m.numSegments);
      statuses[m.status] = (statuses[m.status] || 0) + 1;
    });
    res.json({ success: true, total: all.length, sent: out.length, received: inb.length,
      totalCostUSD: totalCost.toFixed(4), totalSegments: totalSegs, statuses });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

// ── ACCOUNT DASHBOARD ─────────────────────────────────────────────────────────
app.get("/dashboard", async (req, res) => {
  try {
    const [account, numbers] = await Promise.all([
      client.api.accounts(accountSid).fetch(),
      client.incomingPhoneNumbers.list({ limit: 20 })
    ]);
    res.json({ success: true,
      account: { name: account.friendlyName, status: account.status, type: account.type },
      numbers: numbers.map(n => ({ number: n.phoneNumber, friendly: n.friendlyName,
        sms: n.capabilities.sms, voice: n.capabilities.voice, mms: n.capabilities.mms }))
    });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({
  status: "ok", from: fromNumber, time: new Date().toISOString(),
  scheduled: scheduled.filter(s => s.status === "pending").length
}));

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log("═══════════════════════════════════════════════════");
  console.log("  SMS Master  ·  Advanced Edition");
  console.log("  Listening : " + HOST + ":" + PORT);
  console.log("  From      : " + fromNumber);
  if (RENDER_URL) console.log("  Public    : " + RENDER_URL);
  console.log("═══════════════════════════════════════════════════");
});
