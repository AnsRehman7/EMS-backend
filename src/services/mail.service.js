const nodemailer = require("nodemailer");
const { env } = require("../config/env");
const ApiError = require("../utils/apiError");

const isConfigured = Boolean(env.smtpHost && env.mailFromAddress);

let transporter = null;

const getTransporter = () => {
  if (!isConfigured) return null;
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    auth: env.smtpUser ? { pass: env.smtpPassword, user: env.smtpUser } : undefined,
    host: env.smtpHost,
    port: env.smtpPort,
    // Port 465 is implicit TLS; 587 upgrades with STARTTLS.
    secure: env.smtpSecure || env.smtpPort === 465,
  });

  return transporter;
};

const sendMail = async ({ html, subject, text, to }) => {
  const activeTransporter = getTransporter();

  if (!activeTransporter) {
    if (env.nodeEnv === "production") {
      throw new ApiError(503, "Email delivery is not configured. Contact your workspace administrator.");
    }
    console.warn(`[mail] SMTP is not configured. Would have sent "${subject}" to ${to}:\n${text}`);
    return { delivered: false };
  }

  await activeTransporter.sendMail({
    from: `"${env.mailFromName}" <${env.mailFromAddress}>`,
    html,
    subject,
    text,
    to,
  });

  return { delivered: true };
};

const escapeHtml = (value = "") =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const sendSignInCodeEmail = async ({ code, expiresMinutes, name, to }) => {
  const greeting = name ? `Hi ${escapeHtml(name.split(" ")[0])},` : "Hi,";
  const subject = `${code} is your StaffFlow sign-in code`;
  const text = [
    `${name ? `Hi ${name.split(" ")[0]},` : "Hi,"}`,
    "",
    `Your StaffFlow sign-in code is ${code}.`,
    `It expires in ${expiresMinutes} minutes and can be used once.`,
    "",
    "If you did not try to sign in, you can ignore this email and your account stays secure.",
  ].join("\n");

  const html = `
    <div style="background:#f7f8f5;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
      <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
        <div style="padding:24px 28px;border-bottom:1px solid #e2e8f0;">
          <span style="display:inline-block;background:#047857;color:#ffffff;font-weight:700;font-size:13px;padding:8px 10px;border-radius:8px;">SF</span>
          <span style="margin-left:10px;font-weight:700;color:#020617;font-size:15px;vertical-align:middle;">StaffFlow</span>
        </div>
        <div style="padding:28px;">
          <p style="margin:0 0 18px;color:#334155;font-size:15px;line-height:24px;">${greeting}</p>
          <p style="margin:0 0 20px;color:#334155;font-size:15px;line-height:24px;">Use this code to sign in to your workspace.</p>
          <div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:10px;padding:20px;text-align:center;">
            <div style="font-size:34px;font-weight:800;letter-spacing:10px;color:#065f46;font-family:'SFMono-Regular',Menlo,Consolas,monospace;">${escapeHtml(code)}</div>
          </div>
          <p style="margin:20px 0 0;color:#64748b;font-size:13px;line-height:21px;">
            This code expires in ${expiresMinutes} minutes and can only be used once.
          </p>
          <p style="margin:14px 0 0;color:#64748b;font-size:13px;line-height:21px;">
            If you did not try to sign in, ignore this email. Your account stays secure.
          </p>
        </div>
      </div>
    </div>
  `;

  return sendMail({ html, subject, text, to });
};

module.exports = {
  isMailConfigured: isConfigured,
  sendMail,
  sendSignInCodeEmail,
};
