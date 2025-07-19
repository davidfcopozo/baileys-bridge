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

// ---------- helper to start/re-start ----------
async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  // pairing code (only once, if no session yet)
  if (!state.creds.registered && sock.requestPairingCode) {
    const code = await sock.requestPairingCode('34656565656'); // <-- your Spanish number
    console.log('Pairing code:', code);
  }

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrCodeSVG = await qrcode.toString(qr, { type: 'svg' });
    } else {
      qrCodeSVG = null;
    }
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== 401;
      if (shouldReconnect) setTimeout(connect, 3000); // auto-reconnect
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0];
    if (m.key.fromMe) return;
    const payload = { id: m.key.id, from: m.key.remoteJid, text: m.message?.conversation || '', ts: m.messageTimestamp };
    if (N8N_WEBHOOK_URL) {
      fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => {});
    }
  });
}

// kick it off
connect();
