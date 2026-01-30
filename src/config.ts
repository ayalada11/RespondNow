import dotenv from "dotenv";
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || "3000"),
  agentEmail: process.env.AGENT_EMAIL || "assistant@yourdomain.com",
  agentName: process.env.AGENT_NAME || "RespondNow",

  geminiApiKey: process.env.GEMINI_API_KEY || "",

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    redirectUri:
      process.env.GOOGLE_REDIRECT_URI ||
      (process.env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/auth/google/callback`
        : "http://localhost:3000/auth/google/callback"),
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN || "",
  },

  smtp: {
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: parseInt(process.env.SMTP_PORT || "587"),
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
  },

  webhookSecret: process.env.WEBHOOK_SECRET || "",

  followUp: {
    delayHours: parseInt(process.env.FOLLOWUP_DELAY_HOURS || "48"),
    maxFollowUps: parseInt(process.env.MAX_FOLLOWUPS || "3"),
  },

  availability: {
    workStartHour: parseInt(process.env.WORK_START_HOUR || "9"),
    workEndHour: parseInt(process.env.WORK_END_HOUR || "17"),
    timezone: process.env.TIMEZONE || "America/New_York",
    meetingDurationMinutes: parseInt(
      process.env.MEETING_DURATION_MINUTES || "30"
    ),
  },
};
