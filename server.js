const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(cors());
app.use(express.json());

const ANTHROPIC_KEY = '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';

app.post('/chat', async (req, res) => {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system: req.body.system || 'You are a helpful assistant.',
        messages: req.body.messages || []
      })
    });
    const data = await response.json();
    console.log('Status:', response.status);
    res.json(data);
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`BotForge proxy running on port ${PORT}`));
