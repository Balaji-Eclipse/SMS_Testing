if (process.env.NODE_ENV !== "production") { require("dotenv").config(); }

// ── SSL fix for corporate networks (dev only)
if (process.env.NODE_ENV !== "production") {
  process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
  //console.warn("⚠️  TLS verification bypassed (dev mode)");
}
if (process.env.NODE_ENV === "production" && process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
  console.error("FATAL: TLS verification must not be disabled in production."); process.exit(1);
}

const express = require("express");
const twilio  = require("twilio");
const path    = require("path");
const fs      = require("fs");
const crypto  = require("crypto");
const app     = express();
const PORT    = process.env.PORT || 3000;
const HOST    = "0.0.0.0";

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));
// Favicon handler (prevent 404 in console)
app.get("/favicon.ico", (req, res) => {
  const ico = Buffer.from("AAABAAEAEBAAAAEAIABoBAAAFgAAACgAAAAQAAAAIAAAAAEAIAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA///////////////////////////////////////////////////////////////////////////////////////////////////////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", "base64");
  res.type("image/x-icon").send(ico);
});

app.use(express.static(path.join(__dirname, "public")));

// ── Security headers
app.use((_, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

// ── CORS Protection (CRITICAL FIX #3)
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:3000").split(",");
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ── Credentials
const accountSid   = process.env.TWILIO_ACCOUNT_SID;
const authToken    = process.env.TWILIO_AUTH_TOKEN;
const fromNumber   = process.env.TWILIO_FROM_NUMBER;
const whatsappFrom = process.env.TWILIO_WHATSAPP_FROM;

if (!accountSid || !authToken || !fromNumber) {
  console.error("ERROR: Missing Twilio credentials in .env"); process.exit(1);
}
const client = twilio(accountSid, authToken);

// ── Persistent data
const DATA_DIR   = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const SCHED_FILE    = path.join(DATA_DIR, "scheduled.json");
const CONTACTS_FILE = path.join(DATA_DIR, "contacts.json");

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
}
function writeJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8"); }
  catch (e) { console.error("[FS]", e.message); }
}

// ── Contacts
let serverContacts = readJSON(CONTACTS_FILE, {});
function saveContacts() { writeJSON(CONTACTS_FILE, serverContacts); }

// ── Scheduled messages — restored from disk
let scheduled = [];
readJSON(SCHED_FILE, []).forEach(j => {
  const delay = new Date(j.sendAt) - Date.now();
  if (j.status !== "pending" || delay <= 0) {
    if (j.status === "pending") j.status = "expired";
    scheduled.push(j); return;
  }
  j.timerId = setTimeout(async () => {
    try {
      const m = await client.messages.create({ from: fromNumber, to: j.to, body: j.body });
      j.status = "sent"; j.sid = m.sid;
    } catch (e) { j.status = "failed"; j.error = e.message; }
    saveScheduled();
  }, delay);
  scheduled.push(j);
  console.log("[SCHED] Restored id=" + j.id + " delay=" + Math.round(delay / 1000) + "s");
});
function saveScheduled() {
  writeJSON(SCHED_FILE, scheduled.map(({ timerId: _, ...j }) => j));
}

// ── In-memory rate limiter
const rlMap = new Map();
function rateLimit(max, winMs) {
  return (req, res, next) => {
    const k = req.ip || "anon", now = Date.now();
    const e = rlMap.get(k) || { n: 0, t: now + winMs };
    if (now > e.t) { e.n = 0; e.t = now + winMs; }
    if (++e.n > max) {
      rlMap.set(k, e);
      return res.status(429).json({ success: false, error: "Too many requests — slow down" });
    }
    rlMap.set(k, e); next();
  };
}
setInterval(() => {
  const now = Date.now();
  rlMap.forEach((v, k) => { if (v.t < now) rlMap.delete(k); });
}, 60_000);

// ── Input Sanitization (CRITICAL FIX #5)
const PHONE_REGEX = /^\+?[1-9]\d{1,14}$/; // E.164 format

function sanitizePhone(num) {
  if (typeof num !== "string") throw new Error("Phone must be string");
  const clean = num.trim();
  if (!PHONE_REGEX.test(clean)) throw new Error("Invalid phone number (must be E.164 format, e.g., +1234567890)");
  return clean;
}

function sanitizeText(text) {
  if (typeof text !== "string") throw new Error("Message must be string");
  const clean = text.trim();
  if (clean.length > 160 * 255) throw new Error("Message too long (max 40,800 chars)");
  if (clean.length === 0) throw new Error("Message cannot be empty");
  return clean;
}

function sanitizeName(name) {
  if (typeof name !== "string") throw new Error("Name must be string");
  const clean = name.trim();
  if (clean.length > 100) throw new Error("Name too long (max 100 chars)");
  if (clean.length === 0) throw new Error("Name cannot be empty");
  return clean.replace(/[<>]/g, ""); // Remove potential HTML
}

// ── Input validators
const isPhone = v => typeof v === "string" && /^\+?[\d\s\-(). ]{7,20}$/.test(v.trim());
const isBody  = v => typeof v === "string" && v.trim().length > 0 && v.length <= 1600;

// ── SSE clients
const sseClients = new Set();
function broadcastSSE(data) {
  const p = `data: ${JSON.stringify(data)}\n\n`;
  for (const r of sseClients) {
    try { r.write(p); } catch (_) { sseClients.delete(r); }
  }
}

// ── Keep-alive (Render free tier)
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_URL) {
  const https = require("https");
  setInterval(() => https.get(RENDER_URL + "/health", () => {}).on("error", () => {}), 14 * 60 * 1000);
}

// ── Message field picker
function pick(m) {
  return {
    sid: m.sid, body: m.body, from: m.from, to: m.to, status: m.status,
    direction: m.direction, numSegments: m.numSegments, price: m.price, priceUnit: m.priceUnit,
    dateCreated: m.dateCreated, dateSent: m.dateSent, dateUpdated: m.dateUpdated,
    errorCode: m.errorCode, errorMessage: m.errorMessage
  };
}

// ════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════

// CONFIG
app.get("/config", (_, res) => res.json({
  fromNumber, whatsappEnabled: !!whatsappFrom, whatsappFrom: whatsappFrom || null
}));

// CONTACTS
app.get("/contacts", (_, res) => res.json({ success: true, contacts: serverContacts }));

app.post("/contacts", (req, res) => {
  try {
    const { number, name } = req.body;
    
    // Sanitize inputs
    const cleanNumber = sanitizePhone(number);
    const cleanName = sanitizeName(name || cleanNumber);
    
    serverContacts[cleanNumber] = {
      name: cleanName,
      number: cleanNumber,
      updatedAt: new Date().toISOString()
    };
    saveContacts();
    res.json({ success: true, contact: serverContacts[cleanNumber] });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.delete("/contacts/:number", (req, res) => {
  delete serverContacts[decodeURIComponent(req.params.number)];
  saveContacts();
  res.json({ success: true });
});

// SSE — with keepalive pings
app.get("/events", (req, res) => {
  res.set({
    "Content-Type":  "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection":    "keep-alive",
    "X-Accel-Buffering": "no"          // nginx fix
  });
  res.flushHeaders();
  res.write("retry: 10000\n\n");
  const ka = setInterval(() => {
    try { res.write(": ping\n\n"); } catch (_) { sseClients.delete(res); clearInterval(ka); }
  }, 25_000);
  sseClients.add(res);
  req.on("close", () => { sseClients.delete(res); clearInterval(ka); });
});

// ── Webhook Signature Verification (CRITICAL FIX #1)
function validateTwilioSignature(req, res, next) {
  // Skip verification in dev mode (can be disabled with env var)
  if (process.env.SKIP_WEBHOOK_VERIFICATION === "true") {
   // console.warn("⚠️  Webhook signature verification disabled (dev only)");
    return next();
  }
  
  const token = authToken;
  const url = `https://${req.hostname}${req.originalUrl}`;
  const signature = req.headers["x-twilio-signature"];
  
  if (!signature) {
    return res.status(403).json({ error: "Missing signature" });
  }
  
  // Build the data string in the order Twilio uses
  const data = url + Object.keys(req.body).sort().reduce((s, k) => s + k + req.body[k], "");
  
  // Compute HMAC-SHA1
  const hmac = crypto.createHmac("sha1", token).update(data).digest("base64");
  
  if (hmac !== signature) {
    console.warn(`[SECURITY] Invalid webhook signature from ${req.ip}`);
    return res.status(403).json({ error: "Invalid signature" });
  }
  
  next();
}

// INCOMING WEBHOOK
app.post("/incoming", validateTwilioSignature, (req, res) => {
  try {
    const from = req.body.From || req.body.from;
    const to   = req.body.To   || req.body.to;
    const body = req.body.Body || req.body.body || "";
    const sid  = req.body.MessageSid || req.body.messageSid || null;
    
    // Sanitize inputs
    const cleanFrom = sanitizePhone(from);
    const cleanTo = sanitizePhone(to);
    const cleanBody = sanitizeText(body);
    
    if (!serverContacts[cleanFrom]) {
      serverContacts[cleanFrom] = { name: cleanFrom, number: cleanFrom, updatedAt: new Date().toISOString() };
      saveContacts();
    }
    broadcastSSE({ type: "incoming", from: cleanFrom, to: cleanTo, body: cleanBody, sid, timestamp: new Date().toISOString() });
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
  } catch (e) {
    console.error("[INCOMING ERROR]", e.message);
    res.status(400).json({ error: e.message });
  }
});

// SEND SMS
app.post("/send", rateLimit(30, 60_000), async (req, res) => {
  try {
    const { to, body, channel = "sms" } = req.body;
    
    // Sanitize inputs
    const cleanTo = sanitizePhone(to);
    const cleanBody = sanitizeText(body);
    
    console.log("[SEND] To:", cleanTo, "Ch:", channel, "Body:", cleanBody.substring(0, 60));
    let from = fromNumber, dest = cleanTo;
    if (channel === "whatsapp") {
      if (!whatsappFrom) return res.status(400).json({ success: false, error: "WhatsApp not configured" });
      from = `whatsapp:${whatsappFrom}`;
      dest = `whatsapp:${cleanTo.replace(/^whatsapp:/, "")}`;
    }
    const msg = await client.messages.create({ from, to: dest, body: cleanBody });
    console.log("[SEND] OK SID=" + msg.sid);
    res.json({ success: true, sid: msg.sid, status: msg.status, channel });
  } catch (err) {
    console.error("[SEND] ERR", err.code, err.message);
    res.status(400).json({ success: false, error: err.message, code: err.code });
  }
});

// BROADCAST — parallel (FIX: was sequential)
app.post("/broadcast", rateLimit(3, 60_000), async (req, res) => {
  try {
    const { recipients, body } = req.body;
    if (!Array.isArray(recipients) || !recipients.length)
      return res.status(400).json({ success: false, error: "No recipients provided" });
    if (recipients.length > 50)
      return res.status(400).json({ success: false, error: "Max 50 recipients per broadcast" });
    
    // Sanitize message body
    const cleanBody = sanitizeText(body);

    const results = await Promise.allSettled(
      recipients.map(async to => {
        try {
          const cleanTo = sanitizePhone(to);
          const msg = await client.messages.create({ from: fromNumber, to: cleanTo, body: cleanBody });
          return { to: cleanTo, success: true, sid: msg.sid };
        } catch (err) {
          return { to, success: false, error: err.message };
        }
      })
    );
    const final = results.map(r => r.status === "fulfilled" ? r.value : { success: false, error: r.reason?.message });
    const sent  = final.filter(r => r.success).length;
    console.log(`[BROADCAST] ${sent}/${final.length} sent`);
    res.json({ success: true, results: final, sent, failed: final.length - sent });
  } catch (err) {
    console.error("[BROADCAST] ERR", err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// HISTORY
app.get("/history", async (req, res) => {
  const { to: contact, limit = 200 } = req.query;
  if (!contact) return res.status(400).json({ success: false, error: "Missing to" });
  const lim = Math.min(parseInt(limit) || 200, 500);
  try {
    const [out, inb] = await Promise.all([
      client.messages.list({ from: fromNumber, to: contact, limit: lim }),
      client.messages.list({ to: fromNumber, from: contact, limit: lim })
    ]);
    const all = [
      ...out.map(m => ({ ...pick(m), direction: "outbound" })),
      ...inb.map(m => ({ ...pick(m), direction: "inbound" }))
    ].sort((a, b) => new Date(a.dateCreated) - new Date(b.dateCreated));
    res.json({ success: true, messages: all, total: all.length });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// MESSAGE STATUS
app.get("/status/:sid", async (req, res) => {
  try {
    const m = await client.messages(req.params.sid).fetch();
    res.json({
      success: true, sid: m.sid, status: m.status,
      errorCode: m.errorCode, price: m.price,
      numSegments: m.numSegments, dateCreated: m.dateCreated, dateSent: m.dateSent
    });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

// REDACT
app.post("/redact/:sid", async (req, res) => {
  try {
    await client.messages(req.params.sid).update({ body: "" });
    res.json({ success: true });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

// ⚠️ SPECIFIC DELETE ROUTES BEFORE /:sid — express matches top-to-bottom
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
      try { await client.messages(m.sid).remove(); deleted++; } catch (_) { failed++; }
    }));
    res.json({ success: true, deleted, failed });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

app.delete("/messages/clearall", async (req, res) => {
  console.log("[CLEAR ALL]");
  try {
    const [out, inb] = await Promise.all([
      client.messages.list({ from: fromNumber, limit: 1000 }),
      client.messages.list({ to: fromNumber, limit: 1000 })
    ]);
    const seen = new Set();
    const all = [...out, ...inb].filter(m => {
      if (seen.has(m.sid)) return false; seen.add(m.sid); return true;
    });
    let deleted = 0, failed = 0;
    await Promise.allSettled(all.map(async m => {
      try { await client.messages(m.sid).remove(); deleted++; } catch (_) { failed++; }
    }));
    res.json({ success: true, deleted, failed, total: all.length });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

app.delete("/messages/:sid", async (req, res) => {
  console.log("[DELETE] SID:", req.params.sid);
  try {
    await client.messages(req.params.sid).remove();
    res.json({ success: true });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

// SCHEDULE
app.post("/schedule", rateLimit(20, 60_000), (req, res) => {
  const { to, body, sendAt } = req.body;
  if (!isPhone(to))  return res.status(400).json({ success: false, error: "Invalid number" });
  if (!isBody(body)) return res.status(400).json({ success: false, error: "Invalid body" });
  const delay = new Date(sendAt) - Date.now();
  if (delay < 1000)  return res.status(400).json({ success: false, error: "Must be in the future" });
  const id = "sch_" + Date.now();
  const job = { id, to, body, sendAt, status: "pending", sid: null, createdAt: new Date().toISOString() };
  job.timerId = setTimeout(async () => {
    try {
      const m = await client.messages.create({ from: fromNumber, to, body });
      job.status = "sent"; job.sid = m.sid;
    } catch (e) { job.status = "failed"; job.error = e.message; }
    saveScheduled();
  }, delay);
  scheduled.push(job);
  saveScheduled();
  console.log("[SCHED] id=" + id + " delay=" + Math.round(delay / 1000) + "s");
  res.json({ success: true, id, sendAt, to });
});

app.get("/schedule", (_, res) => res.json({
  success: true,
  scheduled: scheduled.map(({ id, to, body, sendAt, status, sid, createdAt }) =>
    ({ id, to, body, sendAt, status, sid, createdAt }))
}));

app.delete("/schedule/:id", (req, res) => {
  const idx = scheduled.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, error: "Not found" });
  const job = scheduled[idx];
  if (job.status !== "pending") return res.status(400).json({ success: false, error: "Already " + job.status });
  clearTimeout(job.timerId);
  scheduled.splice(idx, 1);
  saveScheduled();
  res.json({ success: true });
});

// STATS
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
    res.json({
      success: true, total: all.length, sent: out.length, received: inb.length,
      totalCostUSD: totalCost.toFixed(4), totalSegments: totalSegs, statuses
    });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

// DASHBOARD
app.get("/dashboard", async (_, res) => {
  try {
    const [account, numbers] = await Promise.all([
      client.api.accounts(accountSid).fetch(),
      client.incomingPhoneNumbers.list({ limit: 20 })
    ]);
    res.json({
      success: true,
      account: { name: account.friendlyName, status: account.status, type: account.type },
      numbers: numbers.map(n => ({
        number: n.phoneNumber, friendly: n.friendlyName,
        sms: n.capabilities.sms, voice: n.capabilities.voice, mms: n.capabilities.mms
      }))
    });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

// HEALTH
app.get("/health", (_, res) => res.json({
  status: "ok", from: fromNumber, time: new Date().toISOString(),
  scheduled: scheduled.filter(s => s.status === "pending").length,
  sseClients: sseClients.size,
  contacts: Object.keys(serverContacts).length
}));

// Global error handler
app.use((err, req, res, _next) => {
  console.error("[ERROR]", err.message);
  res.status(500).json({ success: false, error: "Internal server error" });
});

app.listen(PORT, HOST, () => {
  console.log("════════════════════════════════════════════════════");
  console.log("  virtual SMS v2.1 — Improved Edition");
  console.log("  Listening  : " + HOST + ":" + PORT);
  console.log("  From       : " + fromNumber);
  console.log("  Contacts   : " + Object.keys(serverContacts).length + " saved");
  console.log("  Scheduled  : " + scheduled.filter(s => s.status === "pending").length + " pending");
  if (RENDER_URL) console.log("  Public URL : " + RENDER_URL);
  console.log("════════════════════════════════════════════════════");
});