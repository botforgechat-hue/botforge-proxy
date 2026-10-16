// Run: npm test   (uses a fake Anthropic server; no real key or calls)
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

let fake, proxy, base, upstreamCalls = 0, lastUpstream;

before(async () => {
  fake = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      upstreamCalls++; lastUpstream = { headers: req.headers, body: JSON.parse(body) };
      res.setHeader('Content-Type', 'application/json');
      if (lastUpstream.body.messages[0].content === 'fail') {
        res.statusCode = 401; return res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'secret detail' } }));
      }
      res.end(JSON.stringify({ content: [{ type: 'text', text: '**Hello** there' }] }));
    });
  }).listen(0);
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.PER_IP_PER_MINUTE = '5';
  const app = require('../server.js');
  proxy = app.listen(0);
  base = `http://127.0.0.1:${proxy.address().port}`;
});
after(() => { fake.close(); proxy.close(); });

const chat = body => fetch(`${base}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('normal chat works and keeps the same response shape', async () => {
  const r = await chat({ system: 'You are the salon bot.', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).content[0].text, 'Hello there');
  assert.equal(lastUpstream.headers['x-api-key'], 'test-key');
  assert.equal(lastUpstream.body.max_tokens, 500);
  assert.match(lastUpstream.body.system, /^You are the salon bot\./);
});

test('bad input is rejected without calling Anthropic', async () => {
  const before = upstreamCalls;
  for (const body of [{}, { messages: [] }, { messages: [{ role: 'system', content: 'x' }] },
                      { messages: [{ role: 'user', content: 'x'.repeat(30000) }] },
                      { system: 'x'.repeat(20000), messages: [{ role: 'user', content: 'hi' }] }]) {
    assert.equal((await chat(body)).status, 400);
  }
  assert.equal(upstreamCalls, before);
});

test('upstream errors are not leaked to the public', async () => {
  const r = await chat({ messages: [{ role: 'user', content: 'fail' }] });
  assert.equal(r.status, 502);
  assert.doesNotMatch(JSON.stringify(await r.json()), /secret detail|authentication/);
});

test('per-IP rate limit kicks in', async () => {
  let limited = 0;
  for (let i = 0; i < 8; i++) if ((await chat({ messages: [{ role: 'user', content: 'hi' }] })).status === 429) limited++;
  assert.ok(limited > 0);
});

test('health reports configured', async () => {
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), { status: 'ok', configured: true });
});
