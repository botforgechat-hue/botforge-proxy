const express = require('express');
const cors = require('cors');

// Node 18+ has fetch built in; fall back to node-fetch on older runtimes.
const fetch = globalThis.fetch
  ? globalThis.fetch.bind(globalThis)
  : (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ── Settings (Railway variables) ───────────────────────────
// The API key must come from the environment. Never put it in this file:
// this repo has been public.
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_URL   = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages';
const MODEL           = process.env.CHAT_MODEL || 'claude-haiku-4-5-20251001';
const MAX_TOKENS      = 500;
// Widgets are embedded on client sites, so any origin is allowed unless you list them,
// e.g. ALLOWED_ORIGINS=https://botforgechat.co.uk,https://clientsite.co.uk
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

// Spending guards: stop strangers using this as a free AI endpoint on your bill.
const DAILY_REQUEST_CAP = Number(process.env.DAILY_REQUEST_CAP || 1000); // all visitors combined
const PER_IP_PER_MINUTE = Number(process.env.PER_IP_PER_MINUTE || 12);
const PER_IP_PER_DAY    = Number(process.env.PER_IP_PER_DAY || 150);
const MAX_MESSAGES      = 40;      // turns of conversation kept
const MAX_CHARS         = 24000;   // total characters across all messages
const MAX_SYSTEM_CHARS  = 12000;   // the bot's instructions/knowledge from the widget

const app = express();
app.set('trust proxy', 1); // Railway sits in front, so take the visitor's IP from it
app.use(cors(ALLOWED_ORIGINS.length ? { origin: ALLOWED_ORIGINS } : {}));
app.use(express.json({ limit: '100kb' }));

// ── Rate limiting (in memory; resets on restart, which is fine for a guard) ──
let day = new Date().toISOString().slice(0, 10);
let dailyCount = 0;
const perIp = new Map(); // ip -> { minute, minuteCount, dayCount }

function allow(ip) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) { day = today; dailyCount = 0; perIp.clear(); }
  if (dailyCount >= DAILY_REQUEST_CAP) return 'daily';
  const minute = Math.floor(Date.now() / 60000);
  const rec = perIp.get(ip) || { minute, minuteCount: 0, dayCount: 0 };
  if (rec.minute !== minute) { rec.minute = minute; rec.minuteCount = 0; }
  if (rec.minuteCount >= PER_IP_PER_MINUTE || rec.dayCount >= PER_IP_PER_DAY) return 'ip';
  rec.minuteCount++; rec.dayCount++; dailyCount++;
  perIp.set(ip, rec);
  return null;
}

function textLength(content) {
  if (typeof content === 'string') return content.length;
  return JSON.stringify(content || '').length;
}

function validate(body) {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return 'messages must be a non-empty array';
  if (messages.length > MAX_MESSAGES) return `too many messages (max ${MAX_MESSAGES})`;
  for (const m of messages) {
    if (!m || !['user', 'assistant'].includes(m.role)) return 'each message needs role user or assistant';
  }
  if (messages.reduce((n, m) => n + textLength(m.content), 0) > MAX_CHARS) return 'conversation too long';
  if (body.system !== undefined && typeof body.system !== 'string') return 'system must be text';
  if ((body.system || '').length > MAX_SYSTEM_CHARS) return 'system prompt too long';
  return null;
}

function cleanMarkdown(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')  // remove bold **text**
    .replace(/\*(.*?)\*/g, '$1')       // remove italic *text*
    .replace(/#{1,6}\s/g, '')          // remove headings #
    .replace(/---/g, '')               // remove dividers
    .replace(/`(.*?)`/g, '$1')         // remove inline code
    .trim();
}

app.post('/chat', async (req, res) => {
  if (!ANTHROPIC_KEY) {
    return res.status(503).json({ error: 'Chat is not configured yet. Please try again later.' });
  }
  const invalid = validate(req.body || {});
  if (invalid) return res.status(400).json({ error: invalid });
  const limited = allow(req.ip);
  if (limited) {
    console.warn(`Rate limited (${limited})`);
    return res.status(429).json({ error: 'Too many messages right now. Please try again in a minute.' });
  }

  try {
    const response = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: (req.body.system || 'You are a helpful assistant.') + ' Never use markdown formatting, asterisks, or hashtags in your responses. Write in plain conversational text only.',
        messages: req.body.messages
      }),
      signal: AbortSignal.timeout(30000)
    });
    const data = await response.json();
    if (!response.ok) {
      // Log the real reason, but don't hand Anthropic's error details to the public.
      console.error('Anthropic error', response.status, data && data.error && data.error.type);
      return res.status(502).json({ error: 'The assistant is unavailable right now. Please try again shortly.' });
    }
    if (data.content && data.content[0] && data.content[0].text) {
      data.content[0].text = cleanMarkdown(data.content[0].text);
    }
    res.json(data);
  } catch (err) {
    console.error('Error:', err.message);
    res.status(502).json({ error: 'The assistant is unavailable right now. Please try again shortly.' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', configured: Boolean(ANTHROPIC_KEY) }));

if (require.main === module) {
  if (!ANTHROPIC_KEY) console.warn('ANTHROPIC_API_KEY is not set: /chat will return 503 until it is.');
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`BotForge proxy running on port ${PORT}`));
}

module.exports = app;
