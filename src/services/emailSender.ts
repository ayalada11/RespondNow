import nodemailer from "nodemailer";
import { config } from "../config";

const transporter = nodemailer.createTransport({
  host: config.smtp.host,
  port: config.smtp.port,
  secure: config.smtp.port === 465,
  auth: {
    user: config.smtp.user,
    pass: config.smtp.pass,
  },
});

export interface SendEmailOptions {
  to: string | string[];
  cc?: string | string[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  threadSubject?: string;
}

export async function sendEmail(options: SendEmailOptions): Promise<string> {
  const info = await transporter.sendMail({
    from: `"${config.agentName}" <${config.agentEmail}>`,
    to: Array.isArray(options.to) ? options.to.join(", ") : options.to,
    cc: options.cc
      ? Array.isArray(options.cc)
        ? options.cc.join(", ")
        : options.cc
      : undefined,
    subject: options.subject,
    text: options.text,
    html: options.html,
    inReplyTo: options.inReplyTo,
    references: options.references,
    headers: options.inReplyTo
      ? { "In-Reply-To": options.inReplyTo }
      : undefined,
  });

  console.log(`[EmailSender] Sent email to ${options.to}: ${info.messageId}`);
  return info.messageId;
}
