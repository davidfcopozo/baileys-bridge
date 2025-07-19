import { makeWASocket, useMultiFileAuthState } from '@whiskeysockets/baileys';
import qrcode from 'qrcode';
import express from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 10000;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;

let sock;
let qrCodeSVG = null;

(async () => {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,         // we’ll show it via HTTP
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      // convert QR buffer → SVG string
      qrCodeSVG = await qrcode.toString(qr, { type: 'svg' });
    }
    if (connection === 'open') {
      qrCodeSVG = null;               // hide QR once connected
    }
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== 401;
      if (shouldReconnect) startSock(); // auto-reconnect (optional)
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0];
    if (m.key.fromMe) return;
    const payload = { id: m.key.id, from: m.key.remoteJid, text: m.message?.conversation || '', ts: m.messageTimestamp };
    if (N8N_WEBHOOK_URL) {
      await fetch(N8N_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    }
  });
})();

// show QR code in browser
app.get('/', (_req, res) => {
  if (qrCodeSVG) {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(qrCodeSVG);
  } else {
    res.send('Baileys bridge is connected ✔');
  }
});

// existing /send endpoint stays the same
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

app.listen(PORT, () => console.log(`Baileys bridge listening on :${PORT}`));
