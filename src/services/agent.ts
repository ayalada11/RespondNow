import OpenAI from "openai";
import { config } from "../config";
import { ParsedEmail } from "./emailParser";
import {
  getAvailableSlots,
  formatAvailability,
  bookMeeting,
  TimeSlot,
} from "./calendar";
import { sendEmail } from "./emailSender";
import db from "../db";
import { v4 as uuidv4 } from "uuid";
import { addHours, parseISO } from "date-fns";

const openai = new OpenAI({ apiKey: config.openaiApiKey });

export type Intent =
  | "request_meeting"
  | "share_availability"
  | "confirm_slot"
  | "decline"
  | "general_reply"
  | "unknown";

interface AgentDecision {
  intent: Intent;
  selectedSlotIndex?: number;
  suggestedTime?: string;
  reply: string;
}

/**
 * Main agent: processes an inbound email where the agent was CC'd.
 *
 * Flow:
 * 1. Detect who CC'd the agent (the "owner") vs. who the lead is
 * 2. Classify intent of the email
 * 3. Take action (share availability, book meeting, queue follow-up)
 * 4. Reply to the thread
 */
export async function handleInboundEmail(email: ParsedEmail): Promise<void> {
  const agentEmail = config.agentEmail.toLowerCase();

  // Determine who is the owner (the person who CC'd the agent) vs the lead
  const allRecipients = [...email.to, ...email.cc].map((e) => e.toLowerCase());
  const isAgentCCd = allRecipients.includes(agentEmail);

  if (!isAgentCCd) {
    console.log("[Agent] Agent not CC'd, ignoring email.");
    return;
  }

  const senderEmail = email.from.toLowerCase();
  const otherRecipients = allRecipients.filter((e) => e !== agentEmail);

  // Look up or create conversation
  let conversation = db
    .prepare("SELECT * FROM conversations WHERE thread_id = ?")
    .get(email.threadId) as any;

  if (!conversation) {
    // First time seeing this thread — sender is the owner, others are leads
    const conversationId = uuidv4();
    const leadEmail =
      otherRecipients.find((e) => e !== senderEmail) || senderEmail;
    db.prepare(
      `INSERT INTO conversations (id, thread_id, from_email, to_email, subject, owner_email, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`
    ).run(
      conversationId,
      email.threadId,
      senderEmail,
      leadEmail,
      email.subject,
      senderEmail
    );
    conversation = {
      id: conversationId,
      thread_id: email.threadId,
      from_email: senderEmail,
      to_email: leadEmail,
      subject: email.subject,
      owner_email: senderEmail,
    };

    // Owner CC'd the agent — share availability with the lead
    await handleShareAvailability(email, conversation);
    return;
  }

  // Existing conversation — this is a reply
  const isFromOwner = senderEmail === conversation.owner_email;
  const isFromLead = senderEmail === conversation.to_email;

  if (isFromLead) {
    // Lead replied — classify intent and respond
    const decision = await classifyAndDecide(email, conversation);
    await executeDecision(decision, email, conversation);
  } else if (isFromOwner) {
    // Owner sent another message — could be asking to follow up or share availability again
    await handleOwnerMessage(email, conversation);
  }
}

async function handleShareAvailability(
  email: ParsedEmail,
  conversation: any
): Promise<void> {
  const slots = await getAvailableSlots();
  const availabilityText = formatAvailability(slots);

  const replyText = `Hi there,

Thanks for connecting! I'm helping ${conversation.owner_email} coordinate scheduling.

${availabilityText}

Looking forward to finding a time that works!

Best,
${config.agentName}`;

  await sendEmail({
    to: conversation.to_email,
    cc: conversation.owner_email,
    subject: `Re: ${email.subject}`,
    text: replyText,
    inReplyTo: email.messageId,
    references: [...email.references, email.messageId],
  });

  // Queue follow-ups for the lead
  queueFollowUp(conversation);
}

async function classifyAndDecide(
  email: ParsedEmail,
  conversation: any
): Promise<AgentDecision> {
  const slots = await getAvailableSlots();
  const slotsDescription = slots
    .slice(0, 8)
    .map(
      (s, i) => `${i + 1}. ${s.start.toISOString()} - ${s.end.toISOString()}`
    )
    .join("\n");

  const prompt = `You are an email scheduling assistant. Analyze this email reply and determine the intent.

Context:
- Owner (your client): ${conversation.owner_email}
- Lead (the person replying): ${email.from}
- Subject: ${email.subject}
- This is a reply in a meeting scheduling thread.

Available time slots:
${slotsDescription}

The lead's email:
---
${email.textBody}
---

Classify the intent as one of:
- "confirm_slot": The lead is selecting or confirming a specific time slot. Extract which slot number (1-8) or parse the suggested time.
- "request_meeting": The lead is asking to schedule/meet but hasn't picked a time yet.
- "decline": The lead is declining or not interested.
- "share_availability": The lead is asking for availability or different times.
- "general_reply": Any other response.

Respond in JSON format:
{
  "intent": "<intent>",
  "selectedSlotIndex": <number or null>,
  "suggestedTime": "<ISO datetime string if they suggested a specific time, else null>",
  "reply": "<a helpful, concise reply email body to send back>"
}`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    temperature: 0.3,
  });

  const result = JSON.parse(response.choices[0].message.content || "{}");

  return {
    intent: result.intent || "unknown",
    selectedSlotIndex: result.selectedSlotIndex,
    suggestedTime: result.suggestedTime,
    reply: result.reply || "Thanks for your response! Let me check on this.",
  };
}

async function executeDecision(
  decision: AgentDecision,
  email: ParsedEmail,
  conversation: any
): Promise<void> {
  switch (decision.intent) {
    case "confirm_slot": {
      const slots = await getAvailableSlots();
      let selectedSlot: TimeSlot | undefined;

      if (
        decision.selectedSlotIndex &&
        decision.selectedSlotIndex >= 1 &&
        decision.selectedSlotIndex <= slots.length
      ) {
        selectedSlot = slots[decision.selectedSlotIndex - 1];
      } else if (decision.suggestedTime) {
        // Find the closest matching slot
        const suggested = parseISO(decision.suggestedTime);
        selectedSlot = slots.find(
          (s) => Math.abs(s.start.getTime() - suggested.getTime()) < 3600000
        );
      }

      if (selectedSlot) {
        const event = await bookMeeting(
          selectedSlot,
          email.from,
          `Meeting: ${conversation.subject}`
        );

        // Save booked meeting
        db.prepare(
          `INSERT INTO booked_meetings (id, conversation_id, owner_email, attendee_email, start_time, end_time, calendar_event_id, subject)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          uuidv4(),
          conversation.id,
          conversation.owner_email,
          email.from,
          selectedSlot.start.toISOString(),
          selectedSlot.end.toISOString(),
          event.id || "",
          conversation.subject
        );

        // Cancel pending follow-ups
        db.prepare(
          `UPDATE follow_ups SET status = 'cancelled', updated_at = datetime('now')
           WHERE conversation_id = ? AND status = 'pending'`
        ).run(conversation.id);

        // Update conversation status
        db.prepare(
          `UPDATE conversations SET status = 'booked', updated_at = datetime('now') WHERE id = ?`
        ).run(conversation.id);

        const meetLink = event.hangoutLink || "";
        const replyText = `Great, the meeting is booked!

${decision.reply}${meetLink ? `\n\nGoogle Meet link: ${meetLink}` : ""}

A calendar invite has been sent to everyone. See you then!

Best,
${config.agentName}`;

        await sendEmail({
          to: email.from,
          cc: conversation.owner_email,
          subject: `Re: ${email.subject}`,
          text: replyText,
          inReplyTo: email.messageId,
          references: [...email.references, email.messageId],
        });
      } else {
        // Couldn't match a slot — share availability again
        await handleShareAvailability(email, conversation);
      }
      break;
    }

    case "request_meeting":
    case "share_availability":
      await handleShareAvailability(email, conversation);
      break;

    case "decline":
      db.prepare(
        `UPDATE follow_ups SET status = 'cancelled', updated_at = datetime('now')
         WHERE conversation_id = ? AND status = 'pending'`
      ).run(conversation.id);

      db.prepare(
        `UPDATE conversations SET status = 'declined', updated_at = datetime('now') WHERE id = ?`
      ).run(conversation.id);

      await sendEmail({
        to: conversation.owner_email,
        subject: `Re: ${email.subject}`,
        text: `Hi,\n\n${email.from} has declined the meeting request.\n\n${decision.reply}\n\nBest,\n${config.agentName}`,
        inReplyTo: email.messageId,
        references: [...email.references, email.messageId],
      });
      break;

    case "general_reply":
    default:
      await sendEmail({
        to: email.from,
        cc: conversation.owner_email,
        subject: `Re: ${email.subject}`,
        text: `${decision.reply}\n\nBest,\n${config.agentName}`,
        inReplyTo: email.messageId,
        references: [...email.references, email.messageId],
      });
      break;
  }
}

async function handleOwnerMessage(
  email: ParsedEmail,
  conversation: any
): Promise<void> {
  // Owner replied in the thread — re-share availability or acknowledge
  const slots = await getAvailableSlots();
  const availabilityText = formatAvailability(slots);

  await sendEmail({
    to: conversation.to_email,
    cc: conversation.owner_email,
    subject: `Re: ${email.subject}`,
    text: `Hi!\n\nJust circling back on scheduling. Here's the latest availability:\n\n${availabilityText}\n\nBest,\n${config.agentName}`,
    inReplyTo: email.messageId,
    references: [...email.references, email.messageId],
  });
}

function queueFollowUp(conversation: any): void {
  const existing = db
    .prepare(
      "SELECT * FROM follow_ups WHERE conversation_id = ? AND status = 'pending'"
    )
    .get(conversation.id);

  if (existing) return; // Already queued

  const nextFollowUpAt = addHours(
    new Date(),
    config.followUp.delayHours
  ).toISOString();

  db.prepare(
    `INSERT INTO follow_ups (id, conversation_id, lead_email, owner_email, thread_id, subject, attempt, max_attempts, next_follow_up_at, status)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 'pending')`
  ).run(
    uuidv4(),
    conversation.id,
    conversation.to_email,
    conversation.owner_email,
    conversation.thread_id,
    conversation.subject,
    config.followUp.maxFollowUps,
    nextFollowUpAt
  );

  console.log(
    `[Agent] Queued follow-up for ${conversation.to_email} at ${nextFollowUpAt}`
  );
}
