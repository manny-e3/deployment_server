const nodemailer = require('nodemailer');
const { env } = require('../utils/env');
const { logger } = require('../utils/logger');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const port = Number(env.SMTP_PORT) || 587;
  // Gmail & standard SMTP: port 587 uses STARTTLS (secure: false), port 465 uses SSL direct (secure: true)
  const isSecure = port === 465 || (env.SMTP_SECURE && port !== 587);

  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST || 'smtp.gmail.com',
    port,
    secure: isSecure,
    auth: {
      user: env.SMTP_USER,
      pass: env.SMTP_PASSWORD,
    },
    tls: {
      rejectUnauthorized: env.NODE_ENV === 'production',
    },
  });

  return transporter;
}

async function sendPasswordResetEmail({ to, userName, resetUrl, expiresInMinutes = 60 }) {
  const mailTransporter = getTransporter();
  const from = env.MAIL_FROM || 'PortallOps <denverimousines@gmail.com>';

  const subject = 'Reset Your PortalOps Password';

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset Your Password</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      background-color: #f4f6f5;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: #101d26;
      -webkit-font-smoothing: antialiased;
    }
    .wrapper {
      max-width: 560px;
      margin: 40px auto;
      background-color: #ffffff;
      border: 1px solid #e2e8e5;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.04);
    }
    .header {
      background-color: #0d1219;
      padding: 24px 32px;
      border-bottom: 2px solid #005459;
    }
    .logo-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: #ffffff;
      font-size: 16px;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .tagline {
      font-size: 11px;
      color: #94a3b8;
      font-family: monospace;
      margin-top: 4px;
    }
    .content {
      padding: 32px;
    }
    h1 {
      margin-top: 0;
      font-size: 20px;
      font-weight: 700;
      color: #0f172a;
      letter-spacing: -0.02em;
    }
    p {
      font-size: 14px;
      line-height: 1.6;
      color: #475569;
      margin: 16px 0;
    }
    .btn-container {
      margin: 28px 0;
      text-align: center;
    }
    .btn {
      display: inline-block;
      background-color: #0f172a;
      color: #ffffff !important;
      text-decoration: none;
      font-size: 14px;
      font-weight: 600;
      padding: 12px 28px;
      border-radius: 6px;
      letter-spacing: -0.01em;
      transition: background-color 0.2s;
    }
    .url-fallback {
      background-color: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      padding: 12px 16px;
      font-family: monospace;
      font-size: 12px;
      word-break: break-all;
      color: #334155;
      margin-top: 20px;
    }
    .footer {
      background-color: #f8fafc;
      padding: 20px 32px;
      border-top: 1px solid #e2e8f0;
      font-size: 12px;
      color: #64748b;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <div class="logo-badge">
        <span>PortalOps Control Plane</span>
      </div>
      <div class="tagline">Zero-Downtime Deployment Automation</div>
    </div>
    <div class="content">
      <h1>Reset Your Password</h1>
      <p>Hello ${userName || 'Operator'},</p>
      <p>We received a request to reset the password for your PortalOps account associated with <strong>${to}</strong>.</p>
      <div class="btn-container">
        <a href="${resetUrl}" class="btn" target="_blank">Reset Password</a>
      </div>
      <p style="font-size: 13px; color: #64748b;">
        This reset link is valid for <strong>${expiresInMinutes} minutes</strong>. If you did not make this request, you can safely disregard this email—your account remains secure.
      </p>
      <div class="url-fallback">
        If the button above does not work, copy and paste this link into your browser:<br>
        <a href="${resetUrl}" style="color: #0284c7; text-decoration: underline;">${resetUrl}</a>
      </div>
    </div>
    <div class="footer">
      PortalOps Security Team • Automated Notification<br>
      Please do not reply directly to this email.
    </div>
  </div>
</body>
</html>
  `;

  const text = `
Hello ${userName || 'Operator'},

We received a request to reset your PortalOps account password.

Click or paste the link below in your browser to choose a new password:
${resetUrl}

This link is valid for ${expiresInMinutes} minutes.

If you did not request a password reset, please ignore this email. Your password will not change.

— PortalOps Security Team
  `.trim();

  try {
    const info = await mailTransporter.sendMail({
      from,
      to,
      subject,
      text,
      html,
    });
    logger.info({ to, messageId: info.messageId }, 'Password reset email sent successfully');
    return { success: true, messageId: info.messageId };
  } catch (err) {
    logger.error({ err, to }, 'Failed to send password reset email');
    throw err;
  }
}

module.exports = {
  getTransporter,
  sendPasswordResetEmail,
};

