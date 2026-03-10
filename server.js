require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public")));

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_FROM_NUMBER;

if (!accountSid || !authToken || !fromNumber) {
  console.error("ERROR: Missing Twilio credentials in .env file!");
  process.exit(1);
}

const client = twilio(accountSid, authToken);

app.get("/config", function(req, res) {
  res.json({ fromNumber: fromNumber });
});

app.post("/send", async function(req, res) {
  const to = req.body.to;
  const body = req.body.body;
  if (!to || !body) {
    return res.status(400).json({ success: false, error: "Missing to or body" });
  }
  console.log("[SEND] To: " + to + "  Body: " + body);
  try {
    const message = await client.messages.create({
      from: fromNumber,
      to: to,
      body: body
    });
    console.log("[SEND] OK SID=" + message.sid + " Status=" + message.status);
    res.json({ success: true, sid: message.sid, status: message.status });
  } catch (err) {
    console.error("[SEND] ERROR " + err.code + ": " + err.message);
    res.status(400).json({ success: false, error: err.message, code: err.code });
  }
});

app.get("/receive", async function(req, res) {
  const recipientFilter = req.query.to;
  console.log("[RECEIVE] Fetching inbox - filter: " + (recipientFilter || "all"));
  try {
    const messages = await client.messages.list({
      to: fromNumber,
      limit: 50
    });
    const filtered = messages
      .filter(function(m) {
        return m.direction === "inbound" && (!recipientFilter || m.from === recipientFilter);
      })
      .map(function(m) {
        return {
          sid: m.sid,
          body: m.body,
          from: m.from,
          to: m.to,
          direction: m.direction,
          status: m.status,
          dateSent: m.dateSent,
          dateCreated: m.dateCreated
        };
      });
    console.log("[RECEIVE] OK Total=" + messages.length + " Inbound=" + filtered.length);
    res.json({ success: true, messages: filtered });
  } catch (err) {
    console.error("[RECEIVE] ERROR " + err.code + ": " + err.message);
    res.status(400).json({ success: false, error: err.message, code: err.code });
  }
});

app.get("/status/:sid", async function(req, res) {
  const sid = req.params.sid;
  console.log("[STATUS] Checking: " + sid);
  try {
    const message = await client.messages(sid).fetch();
    console.log("[STATUS] " + sid + " => " + message.status);
    res.json({
      success: true,
      sid: message.sid,
      status: message.status,
      errorCode: message.errorCode,
      errorMessage: message.errorMessage
    });
  } catch (err) {
    console.error("[STATUS] ERROR " + err.code + ": " + err.message);
    res.status(400).json({ success: false, error: err.message, code: err.code });
  }
});

app.get("/health", function(req, res) {
  res.json({ status: "ok", from: fromNumber, time: new Date().toISOString() });
});

app.listen(PORT, function() {
  console.log("========================================");
  console.log("  Twilio SMS Messenger");
  console.log("========================================");
  console.log("  Server : http://localhost:" + PORT);
  console.log("  From   : " + fromNumber);
  console.log("  Open http://localhost:" + PORT + " in browser");
  console.log("========================================");
});
