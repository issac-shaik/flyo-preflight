// Minimal .env loader (no dependency). Existing process.env values win.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv(path.join(ROOT, '.env'));

const env = (key, fallback = '') => {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
};
const num = (key, fallback) => {
  const n = Number(env(key, ''));
  return Number.isFinite(n) && env(key, '') !== '' ? n : fallback;
};

export const config = {
  flyo: {
    baseUrl: env('FLYO_BASE_URL', 'http://127.0.0.1:4010').replace(/\/+$/, ''),
    apiKey: env('FLYO_API_KEY', 'flyo_test_demo_key'),
    webhookSecret: env('FLYO_WEBHOOK_SECRET', 'change-me-webhook-secret'),
  },
  app: {
    host: env('APP_HOST', '127.0.0.1'),
    port: num('APP_PORT', 3000),
    publicUrl: env('APP_PUBLIC_URL', `http://127.0.0.1:${num('APP_PORT', 3000)}`).replace(/\/+$/, ''),
    pollIntervalMs: num('POLL_INTERVAL_MS', 15000),
    dataDir: path.join(ROOT, 'data'),
  },
  mock: {
    host: env('MOCK_HOST', '127.0.0.1'),
    port: num('MOCK_PORT', 4010),
    apiKey: env('MOCK_FLYO_API_KEY', 'flyo_test_demo_key'),
    quotaUnits: num('MOCK_QUOTA_UNITS', 50),
    fastForward: env('MOCK_FAST_FORWARD', '1') === '1',
    duplicateFinalWebhook: env('MOCK_DUPLICATE_FINAL_WEBHOOK', '1') === '1',
  },
  llm: {
    provider: env('LLM_PROVIDER', '').toLowerCase(),
    apiKey: env('LLM_API_KEY', ''),
    model: env('LLM_MODEL', ''),
  },
  messaging: {
    mode: env('MESSAGING', 'simulator'),
    twilioSid: env('TWILIO_ACCOUNT_SID', ''),
    twilioToken: env('TWILIO_AUTH_TOKEN', ''),
    twilioFrom: env('TWILIO_WHATSAPP_FROM', 'whatsapp:+14155238886'),
  },
};

export const llmEnabled = () => Boolean(config.llm.provider && config.llm.apiKey);
