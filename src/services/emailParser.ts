import { simpleParser, ParsedMail } from "mailparser";

export interface ParsedEmail {
  messageId: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  textBody: string;
  htmlBody: string;
  inReplyTo?: string;
  references: string[];
  threadId: string;
  date: Date;
}

/**
 * Parse raw email (MIME) into structured data.
 * Used when receiving inbound email via webhook.
 */
export async function parseRawEmail(raw: string): Promise<ParsedEmail> {
  const parsed: ParsedMail = await simpleParser(raw);

  const from = parsed.from?.value?.[0]?.address || "";
  const to = (parsed.to
    ? Array.isArray(parsed.to)
      ? parsed.to
      : [parsed.to]
    : []
  ).flatMap((addr) => addr.value.map((v) => v.address || ""));

  const cc = (parsed.cc
    ? Array.isArray(parsed.cc)
      ? parsed.cc
      : [parsed.cc]
    : []
  ).flatMap((addr) => addr.value.map((v) => v.address || ""));

  const references = parsed.references
    ? Array.isArray(parsed.references)
      ? parsed.references
      : [parsed.references]
    : [];

  // Thread ID: use references chain or in-reply-to or message-id
  const threadId =
    references[0] || parsed.inReplyTo || parsed.messageId || "";

  return {
    messageId: parsed.messageId || "",
    from,
    to,
    cc,
    subject: parsed.subject || "",
    textBody: parsed.text || "",
    htmlBody: parsed.html || "",
    inReplyTo: parsed.inReplyTo,
    references,
    threadId,
    date: parsed.date || new Date(),
  };
}

/**
 * Parse structured JSON payload from inbound email webhooks
 * (SendGrid, Mailgun, Postmark format).
 */
export function parseWebhookPayload(body: Record<string, any>): ParsedEmail {
  // SendGrid Inbound Parse format
  if (body.envelope || body.from || body.email) {
    const envelope = body.envelope ? JSON.parse(body.envelope) : {};
    return {
      messageId: body.headers?.["Message-ID"] || body["Message-ID"] || "",
      from:
        envelope.from ||
        extractEmail(body.from) ||
        body.sender_ip ||
        "",
      to: body.to
        ? extractEmails(body.to)
        : envelope.to || [],
      cc: body.cc ? extractEmails(body.cc) : [],
      subject: body.subject || "",
      textBody: body.text || "",
      htmlBody: body.html || "",
      inReplyTo: body.headers?.["In-Reply-To"],
      references: body.headers?.["References"]
        ? body.headers["References"].split(/\s+/)
        : [],
      threadId:
        body.headers?.["References"]?.split(/\s+/)?.[0] ||
        body.headers?.["In-Reply-To"] ||
        body.headers?.["Message-ID"] ||
        "",
      date: new Date(body.headers?.Date || Date.now()),
    };
  }

  // Postmark inbound format
  if (body.FromFull || body.TextBody) {
    return {
      messageId: body.MessageID || "",
      from: body.FromFull?.Email || body.From || "",
      to: (body.ToFull || []).map((t: any) => t.Email),
      cc: (body.CcFull || []).map((c: any) => c.Email),
      subject: body.Subject || "",
      textBody: body.TextBody || "",
      htmlBody: body.HtmlBody || "",
      inReplyTo: body.Headers?.find(
        (h: any) => h.Name === "In-Reply-To"
      )?.Value,
      references:
        body.Headers?.find((h: any) => h.Name === "References")?.Value?.split(
          /\s+/
        ) || [],
      threadId:
        body.Headers?.find((h: any) => h.Name === "References")?.Value?.split(
          /\s+/
        )?.[0] ||
        body.Headers?.find((h: any) => h.Name === "In-Reply-To")?.Value ||
        body.MessageID ||
        "",
      date: new Date(body.Date || Date.now()),
    };
  }

  // Mailgun format
  return {
    messageId: body["Message-Id"] || "",
    from: body.sender || body.from || "",
    to: body.recipient ? [body.recipient] : extractEmails(body.To || ""),
    cc: body.Cc ? extractEmails(body.Cc) : [],
    subject: body.subject || body.Subject || "",
    textBody: body["body-plain"] || body["stripped-text"] || "",
    htmlBody: body["body-html"] || body["stripped-html"] || "",
    inReplyTo: body["In-Reply-To"],
    references: body.References ? body.References.split(/\s+/) : [],
    threadId:
      body.References?.split(/\s+/)?.[0] ||
      body["In-Reply-To"] ||
      body["Message-Id"] ||
      "",
    date: new Date(body.Date || Date.now()),
  };
}

function extractEmail(str: string): string {
  const match = str.match(/<([^>]+)>/);
  return match ? match[1] : str.trim();
}

function extractEmails(str: string): string[] {
  return str
    .split(",")
    .map((s) => extractEmail(s.trim()))
    .filter(Boolean);
}
