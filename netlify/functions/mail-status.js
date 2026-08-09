const { RESEND_FROM } = {};
exports.handler = async () => ({ statusCode: 200, headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ resend_key_present: !!process.env.RESEND_KEY, resend_from: process.env.RESEND_FROM || 'Revive Cafe <noreply@revive.co.nz>', gmail_fallback: !process.env.RESEND_KEY }) });
