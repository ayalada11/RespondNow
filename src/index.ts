import express from "express";
import { config } from "./config";
import {
  parseRawEmail,
  parseWebhookPayload,
} from "./services/emailParser";
import { handleInboundEmail } from "./services/agent";
import { getAuthUrl, exchangeCode } from "./services/calendar";
import { processFollowUps } from "./jobs/processFollowUps";
import { pollGmailInbox } from "./services/gmailPoller";

const app = express();

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", agent: config.agentEmail });
});

/**
 * Inbound email webhook — receives emails from SendGrid/Mailgun/Postmark
 * when someone CC's the agent.
 *
 * POST /webhook/inbound
 */
app.post("/webhook/inbound", async (req, res) => {
  try {
    let email;

    // If raw MIME email is provided
    if (req.body.email && typeof req.body.email === "string") {
      email = await parseRawEmail(req.body.email);
    } else {
      // Structured JSON payload
      email = parseWebhookPayload(req.body);
    }

    console.log(
      `[Webhook] Inbound email from ${email.from} | Subject: ${email.subject}`
    );

    // Process asynchronously so we respond to the webhook quickly
    handleInboundEmail(email).catch((err) =>
      console.error("[Webhook] Error handling email:", err)
    );

    res.status(200).json({ received: true });
  } catch (err) {
    console.error("[Webhook] Parse error:", err);
    res.status(400).json({ error: "Failed to parse inbound email" });
  }
});

/**
 * Manually trigger follow-up processing.
 * Can also be triggered via cron: npm run follow-up:process
 *
 * POST /api/follow-ups/process
 */
app.post("/api/follow-ups/process", async (_req, res) => {
  try {
    const count = await processFollowUps();
    res.json({ processed: count });
  } catch (err) {
    console.error("[API] Follow-up processing error:", err);
    res.status(500).json({ error: "Follow-up processing failed" });
  }
});

/**
 * Get conversation status.
 *
 * GET /api/conversations/:threadId
 */
app.get("/api/conversations/:threadId", (req, res) => {
  const { default: db } = require("./db");
  const conversation = db
    .prepare("SELECT * FROM conversations WHERE thread_id = ?")
    .get(req.params.threadId);

  if (!conversation) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  const followUps = db
    .prepare("SELECT * FROM follow_ups WHERE conversation_id = ?")
    .all(conversation.id);

  const meetings = db
    .prepare("SELECT * FROM booked_meetings WHERE conversation_id = ?")
    .all(conversation.id);

  res.json({ conversation, followUps, meetings });
});

/**
 * Google OAuth2 setup flow.
 * Visit /auth/google to start, callback saves the refresh token.
 */
app.get("/auth/google/callback", async (req, res) => {
  try {
    const code = req.query.code;
    
    console.log("[Auth] Callback received, code:", code);
    
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: "No authorization code received" });
    }
    
    const { refreshToken } = await exchangeCode(code);
    res.json({
      message: "Google Calendar + Gmail connected! Add this refresh token to your Railway env vars as GOOGLE_REFRESH_TOKEN, then redeploy.",
      refreshToken,
    });
  } catch (err) {
    console.error("[Auth] Google OAuth error:", err);
    res.status(500).json({ error: "OAuth failed" });
  }
});
  }
});

// Gmail inbox polling (checks every 2 minutes)
const GMAIL_POLL_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

function startGmailPoller() {
  if (!config.google.refreshToken) {
    console.log("[Gmail] No refresh token — skipping Gmail polling. Visit /auth/google to connect.");
    return;
  }

  console.log("[Gmail] Polling inbox every 2 minutes");
  setInterval(async () => {
    try {
      const count = await pollGmailInbox();
      if (count > 0) {
        console.log(`[Gmail] Processed ${count} new emails`);
      }
    } catch (err) {
      console.error("[Gmail] Polling error:", err);
    }
  }, GMAIL_POLL_INTERVAL_MS);

  // Run once on startup after a short delay
  setTimeout(async () => {
    try {
      const count = await pollGmailInbox();
      console.log(`[Gmail] Startup inbox check: ${count} emails processed`);
    } catch (err) {
      console.error("[Gmail] Startup polling error:", err);
    }
  }, 5_000);
}

// In-process follow-up scheduler (runs every hour)
const FOLLOW_UP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

function startFollowUpScheduler() {
  console.log("[Scheduler] Follow-up processor running every hour");
  setInterval(async () => {
    try {
      const count = await processFollowUps();
      if (count > 0) {
        console.log(`[Scheduler] Processed ${count} follow-ups`);
      }
    } catch (err) {
      console.error("[Scheduler] Follow-up processing error:", err);
    }
  }, FOLLOW_UP_INTERVAL_MS);

  setTimeout(async () => {
    try {
      const count = await processFollowUps();
      console.log(`[Scheduler] Startup follow-up check: ${count} processed`);
    } catch (err) {
      console.error("[Scheduler] Startup follow-up error:", err);
    }
  }, 10_000);
}

app.listen(config.port, () => {
  startGmailPoller();
  startFollowUpScheduler();
  console.log(`
╔══════════════════════════════════════════╗
║          RespondNow Agent Running        ║
╠══════════════════════════════════════════╣
║  Agent email: ${config.agentEmail.padEnd(26)}║
║  Port:        ${String(config.port).padEnd(26)}║
║  Gmail poll:  Every 2 min               ║
║  Follow-ups:  Every 60 min              ║
╚══════════════════════════════════════════╝

CC ${config.agentEmail} in any email thread to start booking meetings.
  `);
});

export default app;
