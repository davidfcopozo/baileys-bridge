import { makeWASocket, useMultiFileAuthState } from '@whiskeysockets/baileys';
import qrcode from 'qrcode';
import express from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 10000;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;

let sock;
let qrCodeSVG = null;

/* ---------- core connection ---------- */
async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  /* pairing code (only if no session yet) */
  if (!state.creds.registered && sock.requestPairingCode) {
    const code = await sock.requestPairingCode('34656565656'); // <-- YOUR NUMBER
    console.log('Pairing code:', code);
  }

  /* QR or connection status */
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrCodeSVG = await qrcode.toString(qr, { type: 'svg' });
    } else {
      qrCodeSVG = null;
    }
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== 401;
      if (shouldReconnect) setTimeout(connect, 3000);
    }
  });

  /* forward every incoming message to n8n */
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0];
    if (m.key.fromMe) return;

    const payload = {
      id: m.key.id,
      from: m.key.remoteJid,
      text: m.message?.conversation || m.message?.extendedTextMessage?.text || '',
      ts: m.messageTimestamp,
    };

    if (N8N_WEBHOOK_URL) {
      fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => {});
    }
  });
}

/* ---------- HTTP routes ---------- */

app.get('/', (_req, res) => {
  if (qrCodeSVG) {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(qrCodeSVG);
  } else {
    res.send('Baileys bridge is connected ✔');
  }
});

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

app.delete('/reset', async (_req, res) => {
  try {
    await fs.rm(path.resolve('./auth'), { recursive: true, force: true });
    console.log('Session wiped.');
    res.json({ ok: true, msg: 'Session deleted – restart container to pair again.' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ---------- start ---------- */
connect();
app.listen(PORT, () => console.log(`Baileys bridge listening on :${PORT}`));
