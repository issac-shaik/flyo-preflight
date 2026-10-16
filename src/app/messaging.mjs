// Traveller messaging. Default: in-browser WhatsApp simulator (messages live on the booking thread).
// Optional: Twilio WhatsApp (sandbox works) for a real phone. Every message is mirrored to the thread
// so the agent dashboard always shows the conversation.
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { config } from '../shared/env.mjs';
import { touch } from './store.mjs';

export const messagingMode = () =>
  config.messaging.mode === 'twilio' && config.messaging.twilioSid && config.messaging.twilioToken ? 'twilio' : 'simulator';

const e164 = (contact) => {
  const digits = String(contact?.phone || '').replace(/\D/g, '');
  if (!digits) return null;
  return digits.length === 10 ? `+91${digits}` : `+${digits}`;
};

/** Outbound message to the booking's traveller contact. */
export async function sendToTraveller(booking, { text, media = [] }) {
  const msg = { id: randomUUID(), dir: 'out', text, media, at: new Date().toISOString(), channel: messagingMode(), delivery: 'sent' };
  touch(booking, (b) => b.thread.push(msg));
  if (messagingMode() !== 'twilio') return msg;

  const to = e164(booking.contact);
  if (!to) { msg.delivery = 'no phone number'; touch(booking); return msg; }
  try {
    // Twilio sends one media item per message; send text first, then each attachment.
    const sends = [{ Body: text }, ...media.filter((m) => /^https:\/\//.test(m.url)).map((m) => ({ Body: m.name || '', MediaUrl: m.url }))];
    for (const s of sends) {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.messaging.twilioSid}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.messaging.twilioSid}:${config.messaging.twilioToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ From: config.messaging.twilioFrom, To: `whatsapp:${to}`, ...s }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Twilio ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    msg.delivery = 'delivered to Twilio';
  } catch (err) {
    msg.delivery = `failed: ${err.message}`;
  }
  touch(booking);
  return msg;
}

/** Verify X-Twilio-Signature (HMAC-SHA1 of full URL + sorted POST params, keyed by auth token). */
export function verifyTwilioSignature(url, params, signature) {
  if (!config.messaging.twilioToken || !signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const expected = createHmac('sha1', config.messaging.twilioToken).update(data).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Download inbound Twilio media (requires basic auth). */
export async function fetchTwilioMedia(url) {
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${Buffer.from(`${config.messaging.twilioSid}:${config.messaging.twilioToken}`).toString('base64')}` },
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Media download failed: ${res.status}`);
  return { data: Buffer.from(await res.arrayBuffer()), mime: (res.headers.get('content-type') || 'application/octet-stream').split(';')[0] };
}
