import { google } from "googleapis";
import { config } from "../config";

const oauth2Client = new google.auth.OAuth2(
  config.google.clientId,
  config.google.clientSecret,
  config.google.redirectUri
);

oauth2Client.setCredentials({
  refresh_token: config.google.refreshToken,
});

const gmail = google.gmail({ version: "v1", auth: oauth2Client });

export interface SendEmailOptions {
  to: string | string[];
  cc?: string | string[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
}

export async function sendEmail(options: SendEmailOptions): Promise<string> {
  const toAddresses = Array.isArray(options.to) ? options.to.join(", ") : options.to;
  const ccAddresses = options.cc
    ? Array.isArray(options.cc)
      ? options.cc.join(", ")
      : options.cc
    : "";

  const headers = [
    `From: "${config.agentName}" <${config.agentEmail}>`,
    `To: ${toAddresses}`,
    `Subject: ${options.subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset="UTF-8"`,
  ];

  if (ccAddresses) {
    headers.push(`Cc: ${ccAddresses}`);
  }

  if (options.inReplyTo) {
    headers.push(`In-Reply-To: ${options.inReplyTo}`);
  }

  if (options.references && options.references.length > 0) {
    headers.push(`References: ${options.references.join(" ")}`);
  }

  const email = [...headers, "", options.text].join("\r\n");

  const encodedEmail = Buffer.from(email)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const response = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw: encodedEmail,
    },
  });

  console.log(`[EmailSender] Sent email to ${toAddresses}: ${response.data.id}`);
  return response.data.id || "";
}
