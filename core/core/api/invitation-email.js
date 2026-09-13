'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CLOUDFLARE_API_ORIGIN = 'https://api.cloudflare.com';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ACCOUNT_ID_RE = /^[a-f0-9]{32}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{40,128}$/;
const INVITATION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function fail() {
  throw Object.assign(new Error('invitation_email_config_invalid'), {
    code: 'invitation_email_config_invalid',
  });
}

function exactHttpsOrigin(value) {
  if (typeof value !== 'string') fail();
  let selected;
  try { selected = new URL(value); } catch { return fail(); }
  if (selected.protocol !== 'https:' || selected.origin !== value
      || selected.pathname !== '/' || selected.username || selected.password || selected.search || selected.hash) fail();
  return selected.origin;
}

function readPrivateApiToken(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file
      || /[\0\r\n]/.test(file)) fail();
  const parent = path.dirname(file);
  let parentInfo;
  let before;
  try {
    parentInfo = fs.lstatSync(parent);
    before = fs.lstatSync(file);
  } catch { return fail(); }
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || parentInfo.uid !== process.geteuid()
      || (parentInfo.mode & 0o7777) !== 0o700 || fs.realpathSync(parent) !== parent
      || !before.isFile() || before.isSymbolicLink() || before.uid !== process.geteuid()
      || before.nlink !== 1 || (before.mode & 0o7777) !== 0o600 || before.size < 40 || before.size > 256
      || fs.realpathSync(file) !== file) fail();

  let descriptor;
  let value;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.uid !== process.geteuid() || opened.nlink !== 1
        || (opened.mode & 0o7777) !== 0o600 || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size !== before.size) fail();
    value = fs.readFileSync(descriptor, 'utf8').replace(/\r?\n$/, '');
    const after = fs.fstatSync(descriptor);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
        || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) fail();
  } catch (error) {
    if (error?.code === 'invitation_email_config_invalid') throw error;
    return fail();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  if (!TOKEN_RE.test(value)) fail();
  return value;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function ownerInvitationMessage({ invitationUrl, expiresAt }) {
  const expiry = new Intl.DateTimeFormat('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    timeZone: 'UTC', timeZoneName: 'short',
  }).format(new Date(expiresAt));
  const subject = "You're invited to Dispatch";
  const intro = 'Get started with Dispatch to set up and manage your DSP.';
  const guidance = 'Accept your invitation, then create an account or sign in. You’ll enter your DSP details during setup.';
  const expiration = `This one-time invitation expires ${expiry}.`;
  const unexpected = 'Didn’t expect this invitation? You can safely ignore this email.';
  const security = 'Dispatch will never ask you to send provider credentials or passwords by email.';
  const text = [subject, '', 'DSP OWNER INVITATION', '', intro, '', guidance, '',
    'Accept invitation:', invitationUrl, '', expiration, '', unexpected, security].join('\n');
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escapeHtml(subject)}</title>
    <style>@media only screen and (max-width:480px){.email-outer{padding:16px 12px!important}.email-content{padding:28px 24px!important}.email-heading{font-size:28px!important}}</style>
  </head>
  <body style="margin:0;padding:0;background:#f4f6f8;color:#101820;font-family:Arial,Helvetica,sans-serif">
    <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">Accept your DSP owner invitation. You’ll enter your DSP details during setup.</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f4f6f8">
      <tr><td class="email-outer" align="center" style="padding:32px 16px">
        <!--[if mso]><table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0"><tr><td><![endif]-->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;background:#fff;border:1px solid #dfe4e8;border-radius:12px">
          <tr><td class="email-content" style="padding:40px">
            <p style="margin:0 0 28px;font-size:36px;line-height:1.2;font-weight:700;letter-spacing:-1px">Dispatch</p>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="height:2px;background:#1455f5;font-size:0;line-height:0">&nbsp;</td></tr></table>
            <p style="margin:36px 0 16px;font-size:14px;line-height:1.5;font-weight:700;letter-spacing:.04em;color:#506170">DSP OWNER INVITATION</p>
            <h1 class="email-heading" style="margin:0 0 24px;font-size:32px;line-height:1.2;letter-spacing:-.6px">You’re invited to Dispatch</h1>
            <p style="margin:0 0 20px;font-size:20px;line-height:1.5">${escapeHtml(intro)}</p>
            <p style="margin:0 0 32px;font-size:16px;line-height:1.6;color:#46515e">${escapeHtml(guidance)}</p>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td align="center" bgcolor="#1455f5" style="border-radius:8px;mso-padding-alt:18px 24px">
              <a href="${escapeHtml(invitationUrl)}" style="display:block;padding:18px 24px;color:#fff;font-size:18px;line-height:24px;font-weight:700;text-decoration:none;border-radius:8px">Accept invitation</a>
            </td></tr></table>
            <p style="margin:24px 0 32px;font-size:13px;line-height:1.6;color:#506170">${escapeHtml(expiration)}</p>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="border-top:1px solid #dfe4e8;padding-top:24px">
              <p style="margin:0 0 12px;font-size:13px;line-height:1.6;color:#506170">${escapeHtml(unexpected)}</p>
              <p style="margin:0;font-size:13px;line-height:1.6;color:#506170">${escapeHtml(security)}</p>
            </td></tr></table>
          </td></tr>
        </table>
        <!--[if mso]></td></tr></table><![endif]-->
      </td></tr>
    </table>
  </body>
</html>`;
  return Object.freeze({ subject, text, html, invitationUrl });
}

function teamInvitationMessage({ organizationName, roleName, invitationUrl, expiresAt }) {
  const date = new Date(expiresAt);
  const expiryDate = new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  }).format(date);
  const expiryTime = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short',
  }).format(date);
  const subject = "You're invited to Dispatch";
  const guidance = 'Create an account or sign in to join.';
  const expiration = `Expires ${expiryDate} · ${expiryTime}`;
  const unexpected = 'Not expecting this? You can ignore this email.';
  const text = [subject, '', 'TEAM INVITATION', '', `DSP: ${organizationName}`, `Your role: ${roleName}`,
    '', 'Accept invitation:', invitationUrl, '', guidance, '', expiration, '', unexpected].join('\n');
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escapeHtml(subject)}</title>
    <style>@media only screen and (max-width:480px){.team-outer{padding:24px 12px!important}.team-content{padding:28px 20px!important}.team-heading{font-size:32px!important}.team-details{padding:24px 20px!important}.team-name{font-size:28px!important}.team-role-label,.team-role-value{display:block!important;width:auto!important}.team-role-value{padding-top:8px!important}}</style>
  </head>
  <body style="margin:0;padding:0;background:#f4f6f8;color:#101820;font-family:Arial,Helvetica,sans-serif">
    <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">Your team invitation is here. ${escapeHtml(guidance)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f4f6f8;table-layout:fixed">
      <tr><td class="team-outer" align="center" style="padding:32px 16px">
        <!--[if mso]><table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0"><tr><td><![endif]-->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;table-layout:fixed">
          <tr><td style="padding:0 0 28px">
            <p style="margin:0 0 10px;font-size:32px;line-height:1.2;font-weight:700;letter-spacing:-1px">Dispatch</p>
            <table role="presentation" width="32" cellspacing="0" cellpadding="0" border="0"><tr><td style="height:3px;background:#1455f5;font-size:0;line-height:0">&nbsp;</td></tr></table>
          </td></tr>
          <tr><td>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#fff;border:1px solid #dfe4e8;border-radius:12px;table-layout:fixed">
              <tr><td class="team-content" align="center" style="padding:40px">
                <p style="margin:0 0 20px;color:#1455f5;font-size:14px;line-height:1.5;font-weight:700;letter-spacing:.06em">TEAM INVITATION</p>
                <h1 class="team-heading" style="margin:0 0 32px;font-size:40px;line-height:1.2;letter-spacing:-1px">You’re invited<span style="color:#1455f5">.</span></h1>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#001733;border-radius:8px;table-layout:fixed">
                  <tr><td class="team-details" align="center" bgcolor="#001733" style="padding:32px 24px;border-radius:8px;color:#fff">
                    <p style="margin:0 0 12px;color:#9bc9ff;font-size:16px;line-height:1.5;font-weight:700">DSP</p>
                    <p class="team-name" style="margin:0 0 28px;color:#fff;font-size:34px;line-height:1.2;font-weight:700;overflow-wrap:anywhere;word-wrap:break-word">${escapeHtml(organizationName)}</p>
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-top:1px dashed #9bc9ff;table-layout:fixed">
                      <tr><td class="team-role-label" width="38%" align="left" valign="top" style="padding-top:24px;color:#c6d3e3;font-size:13px;line-height:1.5">YOUR ROLE</td><td class="team-role-value" align="left" valign="top" style="padding-top:24px;color:#fff;font-size:18px;line-height:1.5;overflow-wrap:anywhere;word-wrap:break-word">${escapeHtml(roleName)}</td></tr>
                    </table>
                  </td></tr>
                </table>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td height="28" style="height:28px;font-size:0;line-height:0">&nbsp;</td></tr><tr><td align="center" bgcolor="#1455f5" style="border-radius:8px;mso-padding-alt:18px 20px">
                  <a href="${escapeHtml(invitationUrl)}" style="display:block;padding:18px 20px;color:#fff;font-size:18px;line-height:24px;font-weight:700;text-decoration:none;border-radius:8px">Accept invitation</a>
                </td></tr></table>
                <p style="margin:20px 0 28px;color:#647080;font-size:14px;line-height:1.6">${escapeHtml(guidance)}</p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td align="center" style="border-top:1px solid #dfe4e8;padding-top:24px">
                  <p style="margin:0 0 16px;color:#647080;font-size:13px;line-height:1.6">${escapeHtml(expiration)}</p>
                  <p style="margin:0;color:#647080;font-size:13px;line-height:1.6">${escapeHtml(unexpected)}</p>
                </td></tr></table>
              </td></tr>
            </table>
          </td></tr>
        </table>
        <!--[if mso]></td></tr></table><![endif]-->
      </td></tr>
    </table>
  </body>
</html>`;
  return Object.freeze({ subject, text, html, invitationUrl });
}

function invitationMessage({ kind, recipient, organizationName, roleName, expiresAt, token, publicOrigin }) {
  const owner = kind === 'organization_owner';
  if (typeof recipient !== 'string' || !EMAIL_RE.test(recipient) || recipient.length > 254
      || (!owner && (typeof organizationName !== 'string' || organizationName.length < 1 || organizationName.length > 120
        || typeof roleName !== 'string' || roleName.length < 1 || roleName.length > 64))
      || typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt))
      || typeof token !== 'string' || !INVITATION_TOKEN_RE.test(token)) fail();
  const origin = exactHttpsOrigin(publicOrigin);
  const invitationUrl = `${origin}/#/invitation/${token}`;
  if (owner) return ownerInvitationMessage({ invitationUrl, expiresAt });
  if (kind === 'organization_member') return teamInvitationMessage({ organizationName, roleName, invitationUrl, expiresAt });
  const expiry = new Date(expiresAt).toUTCString();
  const text = [
    "You're invited to Dispatch",
    '',
    `You have been invited to join ${organizationName} as ${roleName}.`,
    '',
    'Accept your invitation:',
    invitationUrl,
    '',
    `This one-time invitation expires ${expiry}.`,
    'If you were not expecting this invitation, you can safely ignore this email.',
    'Dispatch will never ask you to send provider credentials or passwords by email.',
  ].join('\n');
  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#f4f6f8;color:#17212b;font-family:Arial,sans-serif">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f6f8;padding:32px 16px">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fff;border:1px solid #dfe4e8;border-radius:12px;padding:32px">
          <tr><td>
            <p style="margin:0 0 20px;font-size:14px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#506170">Dispatch</p>
            <h1 style="margin:0 0 16px;font-size:28px;line-height:1.2">You're invited</h1>
            <p style="margin:0 0 24px;font-size:16px;line-height:1.6">You have been invited to join <strong>${escapeHtml(organizationName)}</strong> as <strong>${escapeHtml(roleName)}</strong>.</p>
            <p style="margin:0 0 28px"><a href="${escapeHtml(invitationUrl)}" style="display:inline-block;background:#174ea6;color:#fff;text-decoration:none;font-weight:700;padding:13px 20px;border-radius:8px">Accept invitation</a></p>
            <p style="margin:0 0 8px;font-size:14px;line-height:1.5;color:#506170">This one-time invitation expires ${escapeHtml(expiry)}.</p>
            <p style="margin:0 0 8px;font-size:14px;line-height:1.5;color:#506170">If you were not expecting this invitation, you can safely ignore this email.</p>
            <p style="margin:0;font-size:14px;line-height:1.5;color:#506170">Dispatch will never ask you to send provider credentials or passwords by email.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
  return Object.freeze({ subject: "You're invited to Dispatch", text, html, invitationUrl });
}

class CloudflareInvitationDelivery {
  constructor({ accountId, apiToken, publicOrigin, senderAddress, fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
    if (typeof accountId !== 'string' || !ACCOUNT_ID_RE.test(accountId)
        || typeof apiToken !== 'string' || !TOKEN_RE.test(apiToken)
        || typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) fail();
    this.accountId = accountId;
    this.apiToken = apiToken;
    this.publicOrigin = exactHttpsOrigin(publicOrigin);
    const address = senderAddress ?? `invites@${new URL(this.publicOrigin).hostname}`;
    if (typeof address !== 'string' || address.length > 254 || !EMAIL_RE.test(address)) fail();
    this.from = Object.freeze({ address, name: 'Dispatch' });
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async send(invitation) {
    const message = invitationMessage({
      kind: invitation?.kind,
      recipient: invitation?.email,
      organizationName: invitation?.organizationName,
      roleName: invitation?.roleName,
      expiresAt: invitation?.expiresAt,
      token: invitation?.token,
      publicOrigin: this.publicOrigin,
    });
    return this.deliver(invitation.email, message);
  }

  sendPasswordReset(reset) {
    return this.deliver(reset.email, require('./password-recovery-email').passwordRecoveryMessage({
      token: reset.token, publicOrigin: this.publicOrigin,
    }));
  }

  sendPasswordResetConfirmation(reset) {
    return this.deliver(reset.email, require('./password-recovery-email').passwordRecoveryMessage({
      publicOrigin: this.publicOrigin, confirmation: true,
    }));
  }

  async deliver(recipient, message) {
    if (typeof recipient !== 'string' || !EMAIL_RE.test(recipient) || recipient.length > 254) fail();
    const payload = {
      to: recipient,
      from: this.from,
      subject: message.subject,
      html: message.html,
      text: message.text,
    };
    let response;
    try {
      response = await this.fetch(
        `${CLOUDFLARE_API_ORIGIN}/client/v4/accounts/${this.accountId}/email/sending/send`,
        {
          method: 'POST',
          redirect: 'error',
          headers: {
            Authorization: `Bearer ${this.apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch {
      return Object.freeze({ status: 'unknown' });
    }

    let body;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok) {
      return Object.freeze({ status: response.status >= 400 && response.status < 500 ? 'failed' : 'unknown' });
    }
    if (body?.success !== true || !body.result || typeof body.result !== 'object') {
      return Object.freeze({ status: 'failed' });
    }
    const normalized = recipient.toLowerCase();
    const recipients = key => Array.isArray(body.result[key])
      ? body.result[key].filter(value => typeof value === 'string').map(value => value.toLowerCase()) : [];
    if (recipients('delivered').includes(normalized) || recipients('queued').includes(normalized)) {
      return Object.freeze({ status: 'accepted' });
    }
    if (recipients('permanent_bounces').includes(normalized)
        || recipients('suppressed_recipients').includes(normalized)) {
      return Object.freeze({ status: 'failed' });
    }
    return Object.freeze({ status: 'unknown' });
  }
}

function invitationDeliveryFromEnvironment({ environment = process.env, paths, publicOrigin, fetchImpl } = {}) {
  const accountId = environment?.DISPATCH_EMAIL_ACCOUNT_ID;
  if (accountId === undefined) return null;
  if (!paths || typeof paths.secretsRoot !== 'string') fail();
  const apiToken = readPrivateApiToken(path.join(paths.secretsRoot, 'email', 'cloudflare-api-token'));
  return new CloudflareInvitationDelivery({ accountId, apiToken, publicOrigin,
    senderAddress: environment.DISPATCH_EMAIL_FROM_ADDRESS, fetchImpl });
}

module.exports = {
  CLOUDFLARE_API_ORIGIN,
  exactHttpsOrigin,
  readPrivateApiToken,
  invitationMessage,
  CloudflareInvitationDelivery,
  invitationDeliveryFromEnvironment,
};
