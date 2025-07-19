const express = require('express');
const { makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;

app.use(express.json());

let sock;
let qrCode = '';
let connectionStatus = 'disconnected';

// Ensure auth directory exists
const authDir = path.join(__dirname, 'auth');
if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: {
            level: 'silent',
            child: () => ({ level: 'silent' })
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrCode = qr;
            connectionStatus = 'qr_ready';
            console.log('QR Code generated');
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom) 
                ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                : true;
            
            console.log('Connection closed due to:', lastDisconnect?.error);
            connectionStatus = 'disconnected';
            
            if (shouldReconnect) {
                console.log('Reconnecting...');
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('WhatsApp connected successfully');
            connectionStatus = 'connected';
            qrCode = '';
        }
    });

    // Handle incoming messages
    sock.ev.on('messages.upsert', async (m) => {
        const messages = m.messages;
        
        for (const message of messages) {
            if (message.key.fromMe) continue; // Skip own messages
            
            const messageData = {
                id: message.key.id,
                from: message.key.remoteJid,
                fromName: message.pushName || 'Unknown',
                timestamp: message.messageTimestamp,
                body: message.message?.conversation || 
                      message.message?.extendedTextMessage?.text || 
                      message.message?.imageMessage?.caption || 
                      message.message?.videoMessage?.caption || '',
                messageType: getMessageType(message),
                isGroup: message.key.remoteJid.endsWith('@g.us')
            };

            // Send to n8n webhook
            if (N8N_WEBHOOK_URL) {
                try {
                    await axios.post(N8N_WEBHOOK_URL, messageData, {
                        headers: { 'Content-Type': 'application/json' }
                    });
                    console.log('Message sent to n8n:', messageData.body);
                } catch (error) {
                    console.error('Error sending to n8n:', error.message);
                }
            }
        }
    });
}

function getMessageType(message) {
    if (message.message?.conversation) return 'text';
    if (message.message?.extendedTextMessage) return 'text';
    if (message.message?.imageMessage) return 'image';
    if (message.message?.videoMessage) return 'video';
    if (message.message?.audioMessage) return 'audio';
    if (message.message?.documentMessage) return 'document';
    if (message.message?.stickerMessage) return 'sticker';
    return 'unknown';
}

// Routes
app.get('/', (req, res) => {
    res.json({
        status: connectionStatus,
        message: 'WhatsApp Baileys Bridge Server',
        endpoints: {
            qr: '/qr',
            status: '/status',
            send: '/send',
            health: '/health'
        }
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', connection: connectionStatus });
});

app.get('/status', (req, res) => {
    res.json({ 
        status: connectionStatus,
        hasQR: !!qrCode 
    });
});

app.get('/qr', (req, res) => {
    if (qrCode) {
        res.json({ qr: qrCode, status: 'qr_ready' });
    } else {
        res.json({ 
            message: connectionStatus === 'connected' 
                ? 'Already connected' 
                : 'QR not available',
            status: connectionStatus 
        });
    }
});

// Send message endpoint
app.post('/send', async (req, res) => {
    try {
        const { to, message, type = 'text' } = req.body;
        
        if (!sock || connectionStatus !== 'connected') {
            return res.status(400).json({ 
                error: 'WhatsApp not connected',
                status: connectionStatus 
            });
        }
        
        if (!to || !message) {
            return res.status(400).json({ 
                error: 'Missing required fields: to, message' 
            });
        }

        // Format phone number
        const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
        
        let result;
        switch (type) {
            case 'text':
                result = await sock.sendMessage(jid, { text: message });
                break;
            default:
                return res.status(400).json({ error: 'Unsupported message type' });
        }
        
        res.json({ 
            success: true, 
            messageId: result.key.id,
            to: jid 
        });
        
    } catch (error) {
        console.error('Send message error:', error);
        res.status(500).json({ 
            error: 'Failed to send message',
            details: error.message 
        });
    }
});

// Restart connection endpoint
app.post('/restart', async (req, res) => {
    try {
        if (sock) {
            sock.end();
        }
        setTimeout(() => {
            connectToWhatsApp();
        }, 2000);
        
        res.json({ message: 'Restarting connection...' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`N8N Webhook URL: ${N8N_WEBHOOK_URL || 'Not set'}`);
    
    // Initialize WhatsApp connection
    connectToWhatsApp();
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down gracefully...');
    if (sock) {
        sock.end();
    }
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down...');
    if (sock) {
        sock.end();
    }
    process.exit(0);
});
