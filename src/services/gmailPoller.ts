import { google } from "googleapis";
import { config } from "../config";
import { handleInboundEmail } from "./agent";
import { ParsedEmail } from "./emailParser";
import db from "../db";

const oauth2Client = new google.auth.OAuth2(
  config.google.clientId,
  config.google.clientSecret,
  config.google.redirectUri
);

oauth2Client.setCredentials({
  refresh_token: config.google.refreshToken,
});

const gmail = google.gmail({ version: "v1", auth: oauth2Client });

// Domains/patterns to ignore (automated emails)
const IGNORED_DOMAINS = [
  "notify.railway.app",
  "news.railway.app",
  "noreply@",
  "no-reply@",
  "notifications@",
  "mailer-daemon@",
  "postmaster@",
  "github.com",
  "gitlab.com",
  "linkedin.com",
  "facebookmail.com",
  "amazonses.com",
  "sendgrid.net",
  "mailchimp.com",
  "slack.com",
  "calendar-notification@google.com",
];

function shouldIgnoreEmail(email: string): boolean {
  const lower = email.toLowerCase();
  return IGNORED_DOMAINS.some(
    (pattern) => lower.includes(pattern)
  );
}

/**
 * Poll Gmail inbox for new emails where the agent is CC'd.
 * Only processes emails where:
 * - Agent is in CC (not just TO)
 * - Sender is a real person (not automated)
 * - There are other recipients (a real conversation)
 */
export async function pollGmailInbox(): Promise<number> {
  const agentEmail = config.agentEmail.toLowerCase();

  try {
    // Search for unread emails where the agent is in CC only
    const response = await gmail.users.messages.list({
      userId: "me",
      q: `is:unread cc:${agentEmail}`,
      maxResults: 10,
    });

    const messages = response.data.messages || [];

    if (messages.length === 0) {
      return 0;
    }

    let processed = 0;

    for (const msg of messages) {
      if (!msg.id) continue;

      // Skip if already processed
      const existing = db
        .prepare("SELECT 1 FROM processed_emails WHERE gmail_message_id = ?")
        .get(msg.id);

      if (existing) {
        // Mark as read even if already processed
        await markAsRead(msg.id);
        continue;
      }

      try {
        // Fetch full message
        const full = await gmail.users.messages.get({
          userId: "me",
          id: msg.id,
          format: "full",
        });

        const email = parseGmailMessage(full.data);

        if (!email) {
          console.log(`[Gmail] Could not parse message ${msg.id}, skipping`);
          await markAsProcessedAndRead(msg.id);
          continue;
        }

        // Skip emails sent BY the agent (our own replies)
        if (email.from.toLowerCase() === agentEmail) {
          console.log(`[Gmail] Skipping own reply: ${msg.id}`);
          await markAsProcessedAndRead(msg.id);
          continue;
        }

        // Skip automated emails
        if (shouldIgnoreEmail(email.from)) {
          console.log(`[Gmail] Skipping automated email from: ${email.from}`);
          await markAsProcessedAndRead(msg.id);
          continue;
        }

        // Skip if agent is not actually in CC
        const ccEmails = email.cc.map((e) => e.toLowerCase());
        if (!ccEmails.includes(agentEmail)) {
          console.log(`[Gmail] Agent not in CC, skipping: ${msg.id}`);
          await markAsProcessedAndRead(msg.id);
          continue;
        }

        // Skip if no other recipients (just sent to agent)
        const otherRecipients = [...email.to, ...email.cc].filter(
          (e) => e.toLowerCase() !== agentEmail
        );
        if (otherRecipients.length === 0) {
          console.log(`[Gmail] No other recipients, skipping: ${msg.id}`);
          await markAsProcessedAndRead(msg.id);
          continue;
        }

        console.log(
          `[Gmail] Processing email from ${email.from} | Subject: ${email.subject}`
        );

        // Process through the agent
        await handleInboundEmail(email);

        // Mark as processed and read
        await markAsProcessedAndRead(msg.id);

        processed++;
      } catch (err) {
        console.error(`[Gmail] Error processing message ${msg.id}:`, err);
      }
    }

    return processed;
  } catch (err) {
    console.error("[Gmail] Error polling inbox:", err);
    return 0;
  }
}

async function markAsProcessedAndRead(messageId: string): Promise<void> {
  db.prepare(
    "INSERT OR IGNORE INTO processed_emails (gmail_message_id) VALUES (?)"
  ).run(messageId);
  await markAsRead(messageId);
}

async function markAsRead(messageId: string): Promise<void> {
  try {
    await gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: {
        removeLabelIds: ["UNREAD"],
      },
    });
  } catch (err) {
    console.error(`[Gmail] Error marking message ${messageId} as read:`, err);
  }
}

function parseGmailMessage(message: any): ParsedEmail | null {
  const headers = message.payload?.headers || [];

  const getHeader = (name: string): string => {
    const h = headers.find(
      (h: any) => h.name.toLowerCase() === name.toLowerCase()
    );
    return h?.value || "";
  };

  const from = extractEmail(getHeader("From"));
  const toRaw = getHeader("To");
  const ccRaw = getHeader("Cc");
  const subject = getHeader("Subject");
  const messageId = getHeader("Message-ID") || message.id || "";
  const inReplyTo = getHeader("In-Reply-To") || undefined;
  const referencesRaw = getHeader("References");
  const dateStr = getHeader("Date");

  const to = toRaw ? extractEmails(toRaw) : [];
  const cc = ccRaw ? extractEmails(ccRaw) : [];
  const references = referencesRaw
    ? referencesRaw.split(/\s+/).filter(Boolean)
    : [];

  // Use Gmail thread ID as our thread ID for consistency
  const threadId =
    message.threadId || references[0] || inReplyTo || messageId;

  // Extract body text
  const textBody = extractBody(message.payload, "text/plain");
  const htmlBody = extractBody(message.payload, "text/html");

  if (!from) return null;

  return {
    messageId,
    from,
    to,
    cc,
    subject,
    textBody,
    htmlBody,
    inReplyTo,
    references,
    threadId,
    date: dateStr ? new Date(dateStr) : new Date(),
  };
}

function extractBody(payload: any, mimeType: string): string {
  if (!payload) return "";

  // Direct body
  if (payload.mimeType === mimeType && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }

  // Multipart — recurse into parts
  if (payload.parts) {
    for (const part of payload.parts) {
      const result = extractBody(part, mimeType);
      if (result) return result;
    }
  }

  return "";
}

function extractEmail(str: string): string {
  const match = str.match(/<([^>]+)>/);
  return match ? match[1].toLowerCase() : str.trim().toLowerCase();
}

function extractEmails(str: string): string[] {
  return str
    .split(",")
    .map((s) => extractEmail(s.trim()))
    .filter(Boolean);
}
