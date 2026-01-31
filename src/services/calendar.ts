import { google, calendar_v3 } from "googleapis";
import { config } from "../config";
import {
  addMinutes,
  startOfDay,
  endOfDay,
  addDays,
  setHours,
  setMinutes,
  isAfter,
  isBefore,
  format,
} from "date-fns";
import { utcToZonedTime, zonedTimeToUtc } from "date-fns-tz";

const oauth2Client = new google.auth.OAuth2(
  config.google.clientId,
  config.google.clientSecret,
  config.google.redirectUri
);

oauth2Client.setCredentials({
  refresh_token: config.google.refreshToken,
});

const calendar = google.calendar({ version: "v3", auth: oauth2Client });

export interface TimeSlot {
  start: Date;
  end: Date;
}

export interface AvailabilityOptions {
  daysAhead?: number;
  durationMinutes?: number;
}

/**
 * Get free/busy data from Google Calendar and return available slots.
 */
export async function getAvailableSlots(
  options: AvailabilityOptions = {}
): Promise<TimeSlot[]> {
  const {
    daysAhead = 5,
    durationMinutes = config.availability.meetingDurationMinutes,
  } = options;
  const tz = config.availability.timezone;

  const now = new Date();
  const timeMin = now.toISOString();
  const timeMax = addDays(now, daysAhead).toISOString();

  const freeBusy = await calendar.freebusy.query({
    requestBody: {
      timeMin,
      timeMax,
      timeZone: tz,
      items: [{ id: "primary" }],
    },
  });

  const busySlots =
    freeBusy.data.calendars?.primary?.busy?.map((b) => ({
      start: new Date(b.start!),
      end: new Date(b.end!),
    })) || [];

  const availableSlots: TimeSlot[] = [];

  for (let d = 0; d < daysAhead; d++) {
    const day = addDays(now, d);
    const dayStart = zonedTimeToUtc(
      setMinutes(
        setHours(startOfDay(utcToZonedTime(day, tz)), config.availability.workStartHour),
        0
      ),
      tz
    );
    const dayEnd = zonedTimeToUtc(
      setMinutes(
        setHours(startOfDay(utcToZonedTime(day, tz)), config.availability.workEndHour),
        0
      ),
      tz
    );

    // Skip weekends (0 = Sunday, 6 = Saturday)
    const zonedDay = utcToZonedTime(day, tz);
    if (zonedDay.getDay() === 0 || zonedDay.getDay() === 6) continue;

    let cursor = isAfter(now, dayStart) ? now : dayStart;
    // Snap cursor to next slot boundary
    const mins = cursor.getMinutes();
    const remainder = mins % durationMinutes;
    if (remainder > 0) {
      cursor = addMinutes(cursor, durationMinutes - remainder);
    }

    while (isBefore(addMinutes(cursor, durationMinutes), dayEnd) || addMinutes(cursor, durationMinutes).getTime() === dayEnd.getTime()) {
      const slotEnd = addMinutes(cursor, durationMinutes);

      const isConflict = busySlots.some(
        (busy) => isBefore(cursor, busy.end) && isAfter(slotEnd, busy.start)
      );

      if (!isConflict) {
        availableSlots.push({ start: new Date(cursor), end: slotEnd });
      }

      cursor = slotEnd;
    }
  }

  return availableSlots;
}

/**
 * Format available slots as a human-readable string.
 */
export function formatAvailability(slots: TimeSlot[], maxSlots = 8): string {
  const tz = config.availability.timezone;
  const display = slots.slice(0, maxSlots);

  if (display.length === 0) {
    return "I don't have any available slots in the next few days. I'll follow up when something opens up.";
  }

  const lines = display.map((slot, i) => {
    const zonedStart = utcToZonedTime(slot.start, tz);
    const zonedEnd = utcToZonedTime(slot.end, tz);
    return `  ${i + 1}. ${format(zonedStart, "EEEE, MMM d")} at ${format(zonedStart, "h:mm a")} - ${format(zonedEnd, "h:mm a")} (${tz})`;
  });

  return `Here are some available times:\n\n${lines.join("\n")}\n\nJust reply with the number or suggest another time that works for you.`;
}

/**
 * Book a meeting on Google Calendar and return the event.
 */
export async function bookMeeting(
  slot: TimeSlot,
  attendeeEmail: string,
  subject: string
): Promise<calendar_v3.Schema$Event> {
  const event = await calendar.events.insert({
    calendarId: "primary",
    requestBody: {
      summary: subject,
      start: {
        dateTime: slot.start.toISOString(),
        timeZone: config.availability.timezone,
      },
      end: {
        dateTime: slot.end.toISOString(),
        timeZone: config.availability.timezone,
      },
      attendees: [
        { email: attendeeEmail },
        { email: config.agentEmail, optional: true },
      ],
      reminders: {
        useDefault: true,
      },
      conferenceData: {
        createRequest: {
          requestId: `respondnow-${Date.now()}`,
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
    },
    conferenceDataVersion: 1,
    sendUpdates: "all",
  });

  console.log(`[Calendar] Booked meeting: ${event.data.id}`);
  return event.data;
}

/**
 * Generate Google OAuth2 authorization URL for initial setup.
 */
export function getAuthUrl(): string {
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: [
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.modify",
    ],
    prompt: "consent",
  });
}

/**
 * Exchange auth code for tokens (used during initial setup).
 */
export async function exchangeCode(
  code: string
): Promise<{ refreshToken: string }> {
  const clientId = process.env.GOOGLE_CLIENT_ID || "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
  const redirectUri = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/auth/google/callback`;
  
  console.log("[Auth] Exchanging code:", code.substring(0, 20) + "...");
  
  const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  
  const { tokens } = await client.getToken(code);
  return { refreshToken: tokens.refresh_token || "" };
}
