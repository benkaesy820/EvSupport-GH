import { config, isProduction } from "./config.js";
import { db } from "./db.js";
import { systemSettings } from "./schema.js";
import { eq } from "drizzle-orm";

type Email = {
  to: string;
  subject: string;
  text: string;
};

function appUrl() {
  return (config.FRONTEND_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

async function optionalEmailEnabled() {
  const [setting] = await db.select().from(systemSettings).where(eq(systemSettings.key, "emailNotificationsEnabled")).limit(1);
  return setting?.value !== false;
}

export async function sendEmail(email: Email) {
  if (config.NODE_ENV === "test") {
    return { delivered: false, skipped: true };
  }
  if (!config.BREVO_API_KEY || !config.EMAIL_FROM) {
    if (!isProduction) console.log(`[email:dev] to=${email.to} subject=${email.subject}\n${email.text}`);
    return { delivered: false, skipped: true };
  }

  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": config.BREVO_API_KEY,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      sender: { email: config.EMAIL_FROM },
      to: [{ email: email.to }],
      subject: email.subject,
      textContent: email.text,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Email provider failed: ${response.status} ${body.slice(0, 500)}`);
  }

  return { delivered: true, skipped: false };
}

export async function sendTwoFactorCode(to: string, code: string) {
  return sendEmail({
    to,
    subject: "Your evComm verification code",
    text: `Your verification code is ${code}. It expires in 10 minutes.`,
  });
}

export async function sendPasswordReset(to: string, token: string) {
  return sendEmail({
    to,
    subject: "Reset your evComm password",
    text: `Use this link to reset your password: ${appUrl()}/reset-password?token=${encodeURIComponent(token)}\nThis link expires in 1 hour.`,
  });
}

export async function sendNewAccountEmail(to: string) {
  return sendEmail({
    to,
    subject: "Your evComm account is ready",
    text: `Your evComm account has been created. Sign in at ${appUrl()}.`,
  });
}

export async function sendCustomerInvite(to: string, token: string) {
  return sendEmail({
    to,
    subject: "Complete your evComm account",
    text: `Set your password: ${appUrl()}/set-password?token=${encodeURIComponent(token)}\nYour account must be approved before you can sign in.`,
  });
}

export async function sendSecurityAlert(to: string, message: string) {
  return sendEmail({
    to,
    subject: "evComm security alert",
    text: message,
  });
}

export async function sendChatResolved(to: string, chatId: string) {
  if (!(await optionalEmailEnabled())) return { delivered: false, skipped: true };
  return sendEmail({
    to,
    subject: "Your support chat was resolved",
    text: `Your support chat was marked resolved. If your issue is fully resolved, please rate your experience: ${appUrl()}/chats/${encodeURIComponent(chatId)}`,
  });
}

export async function sendReportStatusChanged(to: string, status: string, reportId: string) {
  if (!(await optionalEmailEnabled())) return { delivered: false, skipped: true };
  return sendEmail({
    to,
    subject: `Your report is now ${status}`,
    text: `An admin updated your report status to ${status}. View it: ${appUrl()}/reports/${encodeURIComponent(reportId)}`,
  });
}

export async function sendCustomerApproved(to: string) {
  if (!(await optionalEmailEnabled())) return { delivered: false, skipped: true };
  return sendEmail({
    to,
    subject: "Your evComm account is approved",
    text: `Your evComm account has been approved. Sign in at ${appUrl()} to start using support.`,
  });
}
