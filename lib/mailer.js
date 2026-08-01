'use strict';

/**
 * Outbound email for the daily report — Resend only, and deliberately so.
 *
 * Resend's API is a single HTTPS POST with a bearer token, which Node 18+ can
 * do with built-in `fetch`. That keeps this project's dependency list at
 * exactly one entry (express). SMTP would mean nodemailer.
 *
 * Nothing here is allowed to break the queue: every failure returns a result
 * object instead of throwing, and the caller just logs it.
 */

const config = require('./queueConfig');

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const TIMEOUT_MS = 20000;

function isConfigured() {
  const { email } = config.get();
  return Boolean(email.enabled && email.token && email.from && email.to);
}

/**
 * @returns {Promise<{ok:boolean, skipped?:string, id?:string, error?:string}>}
 */
async function send({ subject, text, html }) {
  const { email } = config.get();

  if (!email.enabled) return { ok: false, skipped: 'email delivery is turned off' };
  if (!email.token) return { ok: false, skipped: 'no API token configured' };
  if (!email.from || !email.to) return { ok: false, skipped: 'from/to address missing' };
  if (email.provider !== 'resend') {
    return { ok: false, skipped: `unsupported provider "${email.provider}"` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${email.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: email.from,
        to: [email.to],
        subject,
        text,
        ...(html ? { html } : {}),
      }),
      signal: controller.signal,
    });

    const body = await res.text();
    if (!res.ok) {
      return { ok: false, error: `Resend responded ${res.status}: ${body.slice(0, 300)}` };
    }
    let id;
    try {
      id = JSON.parse(body).id;
    } catch {
      /* a 2xx without a parseable body still counts as sent */
    }
    return { ok: true, id };
  } catch (err) {
    const reason = err.name === 'AbortError' ? `timed out after ${TIMEOUT_MS}ms` : err.message;
    return { ok: false, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { send, isConfigured, RESEND_ENDPOINT };
