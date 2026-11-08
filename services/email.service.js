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

async function sendRegistrationConfirmationEmail({
  to,
  userName,
  organizationName,
  role = 'ADMIN',
  confirmUrl,
  loginUrl,
  expiresInHours = 24,
}) {
  const mailTransporter = getTransporter();
  const from = env.MAIL_FROM || 'PortallOps <denverimousines@gmail.com>';

  const subject = 'Confirm Your PortalOps Account - Action Required';
  const ctaUrl =
    confirmUrl ||
    (env.FRONTEND_URL || env.APP_URL || 'http://localhost:5173').replace(/\/+$/, '') + '/confirm-email';
  const loginLink =
    loginUrl || (env.FRONTEND_URL || env.APP_URL || 'http://localhost:5173').replace(/\/+$/, '') + '/login';

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Confirm Your PortalOps Account</title>
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
      max-width: 580px;
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
      font-size: 21px;
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
    .notice-box {
      background-color: #f0fdf4;
      border: 1px solid #bbf7d0;
      border-radius: 6px;
      padding: 14px 18px;
      margin: 20px 0;
      font-size: 13.5px;
      color: #166534;
      line-height: 1.5;
    }
    .details-card {
      background-color: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      padding: 16px 20px;
      margin: 24px 0;
    }
    .details-row {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid #edf2f7;
      font-size: 13px;
    }
    .details-row:last-child {
      border-bottom: none;
      padding-bottom: 0;
    }
    .details-label {
      color: #64748b;
      font-weight: 500;
    }
    .details-value {
      color: #0f172a;
      font-weight: 600;
      font-family: monospace;
    }
    .btn-container {
      margin: 28px 0;
      text-align: center;
    }
    .btn {
      display: inline-block;
      background-color: #005459;
      color: #ffffff !important;
      text-decoration: none;
      font-size: 14px;
      font-weight: 600;
      padding: 13px 32px;
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
    .security-note {
      font-size: 12px;
      color: #64748b;
      border-left: 3px solid #005459;
      padding-left: 12px;
      margin-top: 24px;
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
      <h1>Confirm Your Email Address</h1>
      <p>Hello ${userName || 'Operator'},</p>
      <p>Thank you for registering on <strong>PortalOps</strong>. Before you can access your workspace and the onboarding screen, you must confirm your email address.</p>

      <div class="notice-box">
        Please click the button below to confirm your email. Once confirmed, you will be directed straight to your workspace onboarding.
      </div>

      <div class="btn-container">
        <a href="${ctaUrl}" class="btn" target="_blank">Confirm Email &amp; Launch Onboarding</a>
      </div>

    

    

      <div class="security-note">
        <strong>Security Notice:</strong> If you did not create a PortalOps account, please ignore this email. No workspace will be provisioned without confirmation.
      </div>
    </div>
    <div class="footer">
      PortalOps Security & Infrastructure Team • Automated Verification<br>
      Please do not reply directly to this email.
    </div>
  </div>
</body>
</html>
  `.trim();

  const text = `
Hello ${userName || 'Operator'},

Thank you for registering on PortalOps. Before you can access your workspace and the onboarding screen, you must confirm your email address.

Please click or open the link below to confirm your email:
${ctaUrl}

This confirmation link expires in ${expiresInHours} hours.

Account Details:
- Registered Email: ${to}
- Workspace / Team: ${organizationName || 'Default Workspace'}
- Authority Role: ${role || 'ADMIN'}

If you did not create this account, please ignore this email.

— PortalOps Security & Infrastructure Team
  `.trim();

  try {
    const info = await mailTransporter.sendMail({
      from,
      to,
      subject,
      text,
      html,
    });
    logger.info({ to, messageId: info.messageId }, 'Registration confirmation email sent successfully');
    return { success: true, messageId: info.messageId };
  } catch (err) {
    logger.error({ err, to }, 'Failed to send registration confirmation email');
    throw err;
  }
}

async function sendTeamInvitationEmail({
  to,
  memberName,
  inviterName,
  organizationName,
  role = 'DEPLOYER',
  roleTitle,
  inviteUrl,
  temporaryPassword,
  expiresInDays = 7,
}) {
  const mailTransporter = getTransporter();
  const from = env.MAIL_FROM || 'PortallOps <denverimousines@gmail.com>';
  const org = organizationName || 'PortalOps Workspace';
  const inviter = inviterName || 'A team administrator';
  const roleDisplay = (role || 'DEPLOYER').toUpperCase();
  const titleDisplay = roleTitle || (roleDisplay === 'ADMIN' ? 'Platform Admin' : roleDisplay === 'VIEWER' ? 'Telemetry Observer' : 'Platform Deployer');

  const subject = `You've been invited to join ${org} on PortalOps`;
  const acceptLink =
    inviteUrl ||
    `${(env.FRONTEND_URL || env.APP_URL || 'http://localhost:5173').replace(/\/+$/, '')}/accept-invite?email=${encodeURIComponent(to)}&org=${encodeURIComponent(org)}`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>You're Invited to Join PortalOps</title>
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
      max-width: 580px;
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
      font-size: 21px;
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
    .invite-banner {
      background-color: #e2f0fd;
      border: 1px solid #beddf7;
      border-radius: 6px;
      padding: 14px 18px;
      margin: 20px 0;
      font-size: 13.5px;
      color: #005459;
      line-height: 1.5;
    }
    .details-card {
      background-color: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      padding: 16px 20px;
      margin: 24px 0;
    }
    .details-row {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid #edf2f7;
      font-size: 13px;
    }
    .details-row:last-child {
      border-bottom: none;
      padding-bottom: 0;
    }
    .details-label {
      color: #64748b;
      font-weight: 500;
    }
    .details-value {
      color: #0f172a;
      font-weight: 600;
      text-align: right;
    }
    .role-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-family: monospace;
      font-weight: 700;
      background-color: #005459;
      color: #ffffff;
    }
    .btn-container {
      margin: 32px 0;
      text-align: center;
    }
    .btn {
      display: inline-block;
      background-color: #005459;
      color: #ffffff !important;
      text-decoration: none;
      font-size: 14px;
      font-weight: 600;
      padding: 12px 28px;
      border-radius: 6px;
      letter-spacing: -0.01em;
      box-shadow: 0 2px 8px rgba(0, 84, 89, 0.25);
    }
    .raw-link {
      word-break: break-all;
      color: #005459;
      font-size: 12px;
      font-family: monospace;
      background-color: #f1f5f9;
      padding: 10px 14px;
      border-radius: 4px;
      border: 1px solid #e2e8f0;
      display: block;
      margin-top: 12px;
    }
    .footer {
      background-color: #f8fafc;
      padding: 20px 32px;
      border-top: 1px solid #e2e8f0;
      font-size: 11px;
      color: #94a3b8;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <div class="logo-badge">
        <span>⚡</span>
        <span>PORTALOPS CONTROL PLANE</span>
      </div>
      <div class="tagline">Enterprise Release Orchestration & Continuous Delivery</div>
    </div>
    <div class="content">
      <h1>You're invited to collaborate!</h1>
      <p>Hello${memberName ? ` <strong>${memberName}</strong>` : ''},</p>
      
      <div class="invite-banner">
        <strong>${inviter}</strong> has invited you to join the <strong>${org}</strong> workspace on PortalOps.
      </div>

      <div class="details-card">
        <div class="details-row">
          <span class="details-label">Workspace</span>
          <span class="details-value">${org}</span>
        </div>
        <div class="details-row">
          <span class="details-label">Assigned Role</span>
          <span class="details-value"><span class="role-badge">${roleDisplay}</span></span>
        </div>
        <div class="details-row">
          <span class="details-label">Title / Team</span>
          <span class="details-value">${titleDisplay}</span>
        </div>
        <div class="details-row">
          <span class="details-label">Invited By</span>
          <span class="details-value">${inviter}</span>
        </div>
      </div>

      <p>Accept this invitation to activate your access, configure your credentials, and start collaborating on deployments:</p>

      <div class="btn-container">
        <a href="${acceptLink}" class="btn" target="_blank" rel="noopener">Accept Invitation & Join Team</a>
      </div>

      <p style="font-size: 12px; color: #64748b; margin-top: 24px;">
        If the button doesn't work, copy and paste this link into your browser:
      </p>
      <span class="raw-link">${acceptLink}</span>

      <p style="font-size: 12px; color: #64748b; margin-top: 20px;">
        This invitation will expire in ${expiresInDays} days. If you weren't expecting this invitation, you can safely ignore this email.
      </p>
    </div>
    <div class="footer">
      This is an automated team notification sent from PortalOps Control Plane. Please do not reply directly to this email.<br>
      PortalOps Release Infrastructure &bull; Secure Multi-Target Delivery System
    </div>
  </div>
</body>
</html>
  `.trim();

  const text = `
Hello${memberName ? ` ${memberName}` : ''},

${inviter} has invited you to join the ${org} team on PortalOps.

Invitation Details:
- Workspace: ${org}
- Permission Role: ${roleDisplay}
- Job Title / Team: ${titleDisplay}
- Invited By: ${inviter}

Please accept your invitation by clicking the link below:
${acceptLink}

This invitation link expires in ${expiresInDays} days.

— PortalOps Security & Infrastructure Team
  `.trim();

  try {
    const info = await mailTransporter.sendMail({
      from,
      to,
      subject,
      text,
      html,
    });
    logger.info({ to, messageId: info.messageId }, 'Team invitation email sent successfully');
    return { success: true, messageId: info.messageId };
  } catch (err) {
    logger.error({ err, to }, 'Failed to send team invitation email');
    throw err;
  }
}

/**
 * Sends a deployment outcome alert (Success or Failure) to subscribed engineers.
 */
async function sendDeploymentStatusEmail({
  to,
  userName,
  projectName,
  targetName,
  serverHost,
  status,
  branch,
  commitSha,
  commitMessage,
  error,
  durationSec,
  deployUrl,
}) {
  const mailTransporter = getTransporter();
  const from = env.MAIL_FROM || 'PortalOps <denverimousines@gmail.com>';
  const isSuccess = status === 'SUCCESS';

  const subject = isSuccess
    ? `[PortalOps] Deployment Succeeded: ${projectName} (${branch})`
    : `[PortalOps Alert] Deployment Failed: ${projectName} (${branch})`;

  const badgeColor = isSuccess ? '#137333' : '#c5221f';
  const badgeBg = isSuccess ? '#e6f4ea' : '#fce8e6';
  const badgeBorder = isSuccess ? '#b7e1cd' : '#fad2cf';
  const statusTitle = isSuccess ? '✓ DEPLOYMENT SUCCEEDED' : '✕ DEPLOYMENT FAILED';

  const shortSha = commitSha ? commitSha.slice(0, 8) : 'HEAD';
  const appUrl = (env.FRONTEND_URL || env.APP_URL || 'http://localhost:5173').replace(/\/+$/, '');
  const finalDeployUrl = deployUrl || `${appUrl}/deployments`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
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
      max-width: 580px;
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
    .status-banner {
      display: inline-block;
      padding: 6px 14px;
      border-radius: 6px;
      font-family: monospace;
      font-size: 12px;
      font-weight: 700;
      background-color: ${badgeBg};
      color: ${badgeColor};
      border: 1px solid ${badgeBorder};
      margin-bottom: 20px;
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
      margin: 14px 0;
    }
    .details-card {
      background-color: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      padding: 16px 20px;
      margin: 20px 0;
    }
    .details-row {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      font-size: 13px;
      border-bottom: 1px solid #edf2f7;
    }
    .details-row:last-child {
      border-bottom: none;
    }
    .details-label {
      color: #64748b;
      font-weight: 500;
    }
    .details-value {
      color: #0f172a;
      font-weight: 600;
      font-family: monospace;
      text-align: right;
    }
    .error-box {
      background-color: #fef2f2;
      border: 1px solid #fee2e2;
      border-radius: 6px;
      padding: 12px 16px;
      color: #991b1b;
      font-family: monospace;
      font-size: 12px;
      margin: 16px 0;
      word-break: break-all;
    }
    .btn-container {
      margin: 28px 0;
      text-align: center;
    }
    .btn {
      display: inline-block;
      background-color: #005459;
      color: #ffffff !important;
      text-decoration: none;
      padding: 12px 28px;
      border-radius: 6px;
      font-weight: 600;
      font-size: 13px;
    }
    .footer {
      background-color: #f8fafc;
      padding: 20px 32px;
      border-top: 1px solid #e2e8e5;
      font-size: 11px;
      color: #94a3b8;
      text-align: center;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <div class="logo-badge">
        <span>⚡</span>
        <span>PORTALOPS CONTROL PLANE</span>
      </div>
      <div class="tagline">Enterprise Release Orchestration & Continuous Delivery</div>
    </div>
    <div class="content">
      <div class="status-banner">${statusTitle}</div>
      <h1>${isSuccess ? 'Production Release Succeeded' : 'Release Pipeline Incident'}</h1>
      <p>Hello${userName ? ` <strong>${userName}</strong>` : ''},</p>
      <p>
        The deployment pipeline for <strong>${projectName}</strong> on branch <strong>${branch}</strong>
        ${isSuccess ? 'has successfully finished and passed all verification stages.' : 'has encountered a failure and halted.'}
      </p>

      <div class="details-card">
        <div class="details-row">
          <span class="details-label">Project</span>
          <span class="details-value">${projectName}</span>
        </div>
        <div class="details-row">
          <span class="details-label">Target Server</span>
          <span class="details-value">${targetName}${serverHost ? ` (${serverHost})` : ''}</span>
        </div>
        <div class="details-row">
          <span class="details-label">Branch & Commit</span>
          <span class="details-value">${branch} @ ${shortSha}</span>
        </div>
        ${commitMessage ? `
        <div class="details-row">
          <span class="details-label">Commit Message</span>
          <span class="details-value" style="font-family: inherit;">${commitMessage}</span>
        </div>` : ''}
        ${durationSec ? `
        <div class="details-row">
          <span class="details-label">Elapsed Time</span>
          <span class="details-value">${durationSec} seconds</span>
        </div>` : ''}
      </div>

      ${error ? `
      <div class="error-box">
        <strong>Failure Reason:</strong><br>${error}
      </div>` : ''}

      <div class="btn-container">
        <a href="${finalDeployUrl}" class="btn" target="_blank" rel="noopener">Inspect Deployment Logs</a>
      </div>
    </div>
    <div class="footer">
      You are receiving this automated alert because you opted in to deployment notifications in your PortalOps Profile preferences.<br>
      PortalOps Release Infrastructure &bull; Secure Multi-Target Delivery System
    </div>
  </div>
</body>
</html>
  `.trim();

  const text = `
PortalOps ${statusTitle}
Project: ${projectName}
Target: ${targetName} (${serverHost || 'Target'})
Branch: ${branch} @ ${shortSha}
${commitMessage ? `Commit Message: ${commitMessage}\n` : ''}${durationSec ? `Duration: ${durationSec}s\n` : ''}${error ? `Error: ${error}\n` : ''}
View logs at: ${finalDeployUrl}
  `.trim();

  try {
    const info = await mailTransporter.sendMail({
      from,
      to,
      subject,
      text,
      html,
    });
    logger.info({ to, messageId: info.messageId, status, projectName }, 'Deployment status email sent');
    return { success: true, messageId: info.messageId };
  } catch (err) {
    logger.error({ err, to, projectName }, 'Failed to send deployment status email');
    throw err;
  }
}

/**
 * Sends an email notification to workspace members when a new colleague joins the organization.
 */
async function sendColleagueJoinedEmail({
  to,
  userName,
  newMemberName,
  newMemberEmail,
  newMemberRole,
  newMemberTitle,
  organizationName,
  teamUrl,
}) {
  const mailTransporter = getTransporter();
  const from = env.MAIL_FROM || 'PortalOps <denverimousines@gmail.com>';
  const subject = `[PortalOps] New Colleague Joined: ${newMemberName || newMemberEmail} (${organizationName})`;

  const appUrl = (env.FRONTEND_URL || env.APP_URL || 'http://localhost:5173').replace(/\/+$/, '');
  const finalTeamUrl = teamUrl || `${appUrl}/users`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
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
      max-width: 580px;
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
    .badge {
      display: inline-block;
      padding: 5px 12px;
      border-radius: 5px;
      font-family: monospace;
      font-size: 11px;
      font-weight: 700;
      background-color: #e2f0fd;
      color: #005459;
      border: 1px solid #beddf7;
      margin-bottom: 20px;
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
      margin: 14px 0;
    }
    .details-card {
      background-color: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      padding: 16px 20px;
      margin: 20px 0;
    }
    .details-row {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      font-size: 13px;
      border-bottom: 1px solid #edf2f7;
    }
    .details-row:last-child {
      border-bottom: none;
    }
    .details-label {
      color: #64748b;
      font-weight: 500;
    }
    .details-value {
      color: #0f172a;
      font-weight: 600;
      font-family: monospace;
      text-align: right;
    }
    .btn-container {
      margin: 28px 0;
      text-align: center;
    }
    .btn {
      display: inline-block;
      background-color: #005459;
      color: #ffffff !important;
      text-decoration: none;
      padding: 12px 28px;
      border-radius: 6px;
      font-weight: 600;
      font-size: 13px;
    }
    .footer {
      background-color: #f8fafc;
      padding: 20px 32px;
      border-top: 1px solid #e2e8e5;
      font-size: 11px;
      color: #94a3b8;
      text-align: center;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <div class="logo-badge">
        <span>⚡</span>
        <span>PORTALOPS CONTROL PLANE</span>
      </div>
      <div class="tagline">Enterprise Release Orchestration & Continuous Delivery</div>
    </div>
    <div class="content">
      <div class="badge">👥 NEW TEAM MEMBER</div>
      <h1>A new engineer joined your workspace</h1>
      <p>Hello${userName ? ` <strong>${userName}</strong>` : ''},</p>
      <p>
        <strong>${newMemberName || newMemberEmail}</strong> has completed their onboarding and joined <strong>${organizationName}</strong>.
      </p>

      <div class="details-card">
        <div class="details-row">
          <span class="details-label">Full Name</span>
          <span class="details-value">${newMemberName || 'N/A'}</span>
        </div>
        <div class="details-row">
          <span class="details-label">Email Address</span>
          <span class="details-value">${newMemberEmail}</span>
        </div>
        <div class="details-row">
          <span class="details-label">Assigned Role</span>
          <span class="details-value">${newMemberRole}</span>
        </div>
        ${newMemberTitle ? `
        <div class="details-row">
          <span class="details-label">Job Title / Team</span>
          <span class="details-value">${newMemberTitle}</span>
        </div>` : ''}
      </div>

      <div class="btn-container">
        <a href="${finalTeamUrl}" class="btn" target="_blank" rel="noopener">View Workspace Team & IAM</a>
      </div>
    </div>
    <div class="footer">
      You are receiving this automated alert because you opted in to team activity notifications in your PortalOps Profile preferences.<br>
      PortalOps Release Infrastructure &bull; Secure Multi-Target Delivery System
    </div>
  </div>
</body>
</html>
  `.trim();

  const text = `
PortalOps: New Team Member Joined
${newMemberName || newMemberEmail} has joined ${organizationName} as ${newMemberRole}.
Role: ${newMemberRole}
Title: ${newMemberTitle || 'Team Member'}
View team at: ${finalTeamUrl}
  `.trim();

  try {
    const info = await mailTransporter.sendMail({
      from,
      to,
      subject,
      text,
      html,
    });
    logger.info({ to, messageId: info.messageId, newMemberEmail }, 'Colleague joined email sent');
    return { success: true, messageId: info.messageId };
  } catch (err) {
    logger.error({ err, to, newMemberEmail }, 'Failed to send colleague joined email');
    throw err;
  }
}

module.exports = {
  getTransporter,
  sendPasswordResetEmail,
  sendRegistrationConfirmationEmail,
  sendTeamInvitationEmail,
  sendDeploymentStatusEmail,
  sendColleagueJoinedEmail,
};

