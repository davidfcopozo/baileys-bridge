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
const PHONE_NUMBER = process.env.PHONE_NUMBER;
let sock;
let qrCodeSVG = null;

/* ---------- core connection ---------- */
async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    /* 1. show QR or pairing code */
    if (qr) {
      qrCodeSVG = await qrcode.toString(qr, { type: 'svg' });
      console.log('QR ready');
    } else {
      qrCodeSVG = null;
    }

    /* 2. when socket is finally open we may request pairing code */
   if (connection === 'open') {
  console.log('Socket open ✅');
  if (!state.creds.registered && sock.requestPairingCode) {
    sock.requestPairingCode('34656565656')
      .then(code => console.log('Pairing code:', code))
      .catch(err => console.log('Pairing code failed:', err.message));
  }
}

    /* 3. auto-reconnect on non-logout errors */
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== 401;
      if (shouldReconnect) {
        console.log('Reconnecting in 3 s…');
        setTimeout(connect, 3000);
      }
    }
  });

  /* 4. forward inbound messages to n8n */
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
connect();
app.listen(PORT, () => console.log(`Baileys bridge listening on :${PORT}`));
