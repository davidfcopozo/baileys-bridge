import makeWASocket, { useMultiFileAuthState } from '@whiskeysockets/baileys';
import express from 'express';
import bodyParser from 'body-parser';
const app = express();
app.use(bodyParser.json());

let sock;
(async () => {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  sock = makeWASocket({ auth: state, printQRInTerminal: true });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('messages.upsert', m => {
    if (m.messages[0].key.fromMe) return;
    fetch(process.env.N8N_WEBHOOK_URL, {
      method: 'POST',
      body: JSON.stringify(m),
      headers: { 'Content-Type': 'application/json' }
    });
  });
})();

app.post('/send', async (req, res) => {
  const { jid, text } = req.body;
  await sock.sendMessage(jid, { text });
  res.json({ ok: true });
});

app.listen(3000, () => console.log('Baileys bridge on :3000'));
