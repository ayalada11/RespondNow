import db from "../db";
import { sendEmail } from "../services/emailSender";
import { getAvailableSlots, formatAvailability } from "../services/calendar";
import { config } from "../config";
import { addHours } from "date-fns";

interface FollowUpRow {
  id: string;
  conversation_id: string;
  lead_email: string;
  owner_email: string;
  thread_id: string;
  subject: string;
  attempt: number;
  max_attempts: number;
  next_follow_up_at: string;
  status: string;
}

/**
 * Process pending follow-ups that are due.
 * Run this on a cron schedule (e.g., every hour).
 *
 *   crontab: 0 * * * * cd /path/to/respond-now && npm run follow-up:process
 *
 * Or call processFollowUps() from your own scheduler.
 */
export async function processFollowUps(): Promise<number> {
  const now = new Date().toISOString();

  const dueFollowUps = db
    .prepare(
      `SELECT * FROM follow_ups
       WHERE status = 'pending' AND next_follow_up_at <= ?
       ORDER BY next_follow_up_at ASC`
    )
    .all(now) as FollowUpRow[];

  console.log(`[FollowUp] Found ${dueFollowUps.length} due follow-ups`);

  let processed = 0;

  for (const followUp of dueFollowUps) {
    try {
      // Check if conversation was booked or declined in the meantime
      const conversation = db
        .prepare("SELECT * FROM conversations WHERE id = ?")
        .get(followUp.conversation_id) as any;

      if (
        !conversation ||
        conversation.status === "booked" ||
        conversation.status === "declined"
      ) {
        db.prepare(
          `UPDATE follow_ups SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`
        ).run(followUp.id);
        continue;
      }

      const newAttempt = followUp.attempt + 1;

      if (newAttempt > followUp.max_attempts) {
        // Max follow-ups reached
        db.prepare(
          `UPDATE follow_ups SET status = 'exhausted', updated_at = datetime('now') WHERE id = ?`
        ).run(followUp.id);

        // Notify the owner
        await sendEmail({
          to: followUp.owner_email,
          subject: `Follow-up complete: ${followUp.subject}`,
          text: `Hi,\n\nI've sent ${followUp.max_attempts} follow-ups to ${followUp.lead_email} regarding "${followUp.subject}" but haven't received a response.\n\nYou may want to reach out directly or try a different approach.\n\nBest,\n${config.agentName}`,
        });

        db.prepare(
          `UPDATE conversations SET status = 'stale', updated_at = datetime('now') WHERE id = ?`
        ).run(followUp.conversation_id);

        continue;
      }

      // Send follow-up email
      const slots = await getAvailableSlots();
      const availabilityText = formatAvailability(slots);

      const followUpMessages = [
        `Just wanted to follow up on scheduling a meeting with ${followUp.owner_email}. Are any of these times still working for you?\n\n${availabilityText}`,
        `Checking in one more time about finding a time to meet. Here's updated availability:\n\n${availabilityText}\n\nWould any of these work for you?`,
        `This is my last follow-up about scheduling this meeting. If you're still interested, here are some available times:\n\n${availabilityText}\n\nNo worries if the timing isn't right — just let me know either way!`,
      ];

      const messageIndex = Math.min(newAttempt - 1, followUpMessages.length - 1);

      await sendEmail({
        to: followUp.lead_email,
        cc: followUp.owner_email,
        subject: `Re: ${followUp.subject}`,
        text: `Hi,\n\n${followUpMessages[messageIndex]}\n\nBest,\n${config.agentName}`,
      });

      // Update follow-up record
      const nextFollowUpAt = addHours(
        new Date(),
        config.followUp.delayHours
      ).toISOString();

      db.prepare(
        `UPDATE follow_ups
         SET attempt = ?, next_follow_up_at = ?, updated_at = datetime('now')
         WHERE id = ?`
      ).run(newAttempt, nextFollowUpAt, followUp.id);

      console.log(
        `[FollowUp] Sent follow-up ${newAttempt}/${followUp.max_attempts} to ${followUp.lead_email}`
      );
      processed++;
    } catch (err) {
      console.error(`[FollowUp] Error processing follow-up ${followUp.id}:`, err);
    }
  }

  return processed;
}

// Run directly if called as a script
if (require.main === module) {
  processFollowUps()
    .then((count) => {
      console.log(`[FollowUp] Processed ${count} follow-ups`);
      process.exit(0);
    })
    .catch((err) => {
      console.error("[FollowUp] Fatal error:", err);
      process.exit(1);
    });
}
