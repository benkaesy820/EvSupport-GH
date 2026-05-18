import { config, isProduction } from "./config.js";

type Email = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export async function sendEmail(email: Email) {
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
      htmlContent: email.html ?? `<p>${escapeHtml(email.text).replaceAll("\n", "<br>")}</p>`,
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
  const baseUrl = config.FRONTEND_URL ?? "http://localhost:3000";
  const resetUrl = `${baseUrl.replace(/\/$/, "")}/reset-password?token=${encodeURIComponent(token)}`;
  return sendEmail({
    to,
    subject: "Reset your evComm password",
    text: `Use this link to reset your password: ${resetUrl}\nThis link expires in 1 hour.`,
  });
}

export async function sendNewAccountEmail(to: string, password: string) {
  return sendEmail({
    to,
    subject: "Your evComm account is ready",
    text: `Your evComm account has been created.\nTemporary password: ${password}\nSign in and change it as soon as possible.`,
  });
}

export async function sendSecurityAlert(to: string, message: string) {
  return sendEmail({
    to,
    subject: "evComm security alert",
    text: message,
  });
}
