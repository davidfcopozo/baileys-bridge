import makeWASocket, { useMultiFileAuthState } from '@whiskeysockets/baileys';
import express from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;

let sock;
(async () => {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    defaultQueryTimeoutMs: 60_000,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0];
    if (m.key.fromMe) return; // ignore own messages

    const payload = {
      id: m.key.id,
      from: m.key.remoteJid,
      text: m.message?.conversation || m.message?.extendedTextMessage?.text || '',
      ts: m.messageTimestamp,
    };

    if (N8N_WEBHOOK_URL) {
      await fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(console.error);
    }
  });
})();

app.post('/send', async (req, res) => {
  try {
    const { jid, text } = req.body;
    if (!jid || !text) return res.status(400).json({ error: 'jid & text required' });
    await sock.sendMessage(jid, { text });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (_req, res) => res.send('Baileys bridge is running'));
app.listen(PORT, () => console.log(`Baileys bridge listening on :${PORT}`));
