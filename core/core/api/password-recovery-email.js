'use strict';
const { exactHttpsOrigin } = require('./invitation-email');

function passwordRecoveryMessage({ token, publicOrigin, confirmation = false }) {
  if (publicOrigin !== exactHttpsOrigin(publicOrigin) || (!confirmation && (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)))) {
    throw new Error('password_recovery_email_invalid');
  }
  const subject = confirmation ? 'Your Dispatch password was reset' : 'Reset your Dispatch password';
  const intro = confirmation
    ? 'Your Dispatch password has been changed. All existing sessions have been signed out.'
    : 'We received a request to reset your Dispatch password.';
  const guidance = confirmation
    ? 'If you did not make this change, reset your password immediately and contact your Dispatch administrator.'
    : 'This link can be used once and expires in 30 minutes. If you did not request a reset, you can ignore this email. Your password has not changed.';
  // Fragments are not sent in HTTP requests or Referer headers. The app sends
  // this secret only in the reset POST body, never to a third-party widget.
  const url = confirmation ? `${publicOrigin}/#/forgot-password` : `${publicOrigin}/#/reset-password/${token}`;
  const label = confirmation ? 'Secure your account' : 'Reset password';
  return {
    subject,
    text: [subject, '', intro, '', label + ':', url, '', guidance,
      '', 'Dispatch will never ask you to send your password by email.'].join('\n'),
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${subject}</title></head>
<body style="margin:0;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;color:#101820">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fff;border:1px solid #dfe4e8;border-radius:12px"><tr><td style="padding:32px 24px">
<p style="margin:0 0 28px;font-size:32px;font-weight:700;letter-spacing:-1px">Dispatch</p>
<h1 style="font-size:28px;line-height:1.2">${subject}</h1>
<p style="font-size:16px;line-height:1.6">${intro}</p>
<p style="margin:28px 0"><a href="${url}" style="display:block;padding:16px 20px;background:#1455f5;color:#fff;text-align:center;font-size:16px;font-weight:700;text-decoration:none;border-radius:8px">${label}</a></p>
<p style="font-size:14px;line-height:1.6;color:#46515e">${guidance}</p>
<p style="margin-top:28px;padding-top:20px;border-top:1px solid #dfe4e8;font-size:13px;line-height:1.6;color:#506170">Dispatch will never ask you to send your password by email.</p>
</td></tr></table></td></tr></table></body></html>`,
  };
}
module.exports = { passwordRecoveryMessage };
