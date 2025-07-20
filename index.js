import express from 'express';
import { makeWASocket, DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Environment variables
const N8N_BASE_URL = process.env.N8N_BASE_URL || 'https://n8n-vwjn.onrender.com';
const N8N_WEBHOOK_PATH = process.env.N8N_WEBHOOK_PATH || 'f5b0365d-ee2e-4901-8b8b-7f9ab737c06f';
const BAILEYS_BASE_URL = process.env.BAILEYS_BASE_URL || 'https://baileys-bridge.onrender.com';

// Construct full webhook URL
const N8N_WEBHOOK_URL = `${N8N_BASE_URL}/webhook/${N8N_WEBHOOK_PATH}`;

app.use(express.json());

let sock;
let qrCode = '';
let connectionStatus = 'disconnected';

// Ensure auth directory exists
const authDir = path.join(__dirname, 'auth');
if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
}

// Create a proper logger that Baileys expects
const logger = {
    level: 'silent',
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    child: () => ({
        level: 'silent',
        trace: () => {},
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        fatal: () => {}
    })
};

// Helper function to clear authentication state
async function clearAuthState() {
    try {
        if (fs.existsSync(authDir)) {
            const files = await fs.promises.readdir(authDir);
            for (const file of files) {
                await fs.promises.unlink(path.join(authDir, file));
            }
            console.log('🧹 Authentication state cleared');
        }
    } catch (error) {
        console.error('❌ Error clearing auth state:', error);
    }
}

async function connectToWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        
        sock = makeWASocket({
            auth: state,
            logger: logger,
            printQRInTerminal: false, // Don't spam terminal
            browser: ['Baileys Bridge', 'Chrome', '4.0.0'],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 10000,
            generateHighQualityLinkPreview: true,
            syncFullHistory: false,
            markOnlineOnConnect: true,
            qrTimeout: 60000, // 60 seconds for QR timeout
            retryRequestDelayMs: 250
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr, isOnline, isNewLogin } = update;
            
            if (qr) {
                qrCode = qr;
                connectionStatus = 'qr_ready';
                console.log('📱 QR Code generated - Please scan with WhatsApp');
                console.log('⏰ QR Code expires in 60 seconds');
                
                // Set QR timeout
                setTimeout(() => {
                    if (connectionStatus === 'qr_ready') {
                        console.log('⏰ QR Code expired, generating new one...');
                        qrCode = '';
                    }
                }, 60000);
            }

            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error instanceof Boom) 
                    ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                    : true;
                
                const reason = lastDisconnect?.error?.output?.statusCode;
                console.log('❌ Connection closed due to:', lastDisconnect?.error);
                
                // Handle QR timeout specifically
                if (lastDisconnect?.error?.message?.includes('QR refs attempts ended')) {
                    console.log('⏰ QR Code attempts ended, restarting connection...');
                    connectionStatus = 'disconnected';
                    qrCode = '';
                    setTimeout(() => connectToWhatsApp(), 3000);
                    return;
                }
                
                // Handle specific disconnect reasons
                if (reason === DisconnectReason.badSession) {
                    console.log('🔄 Bad session, clearing auth and restarting...');
                    connectionStatus = 'disconnected';
                    clearAuthState().then(() => {
                        setTimeout(() => connectToWhatsApp(), 3000);
                    });
                } else if (reason === DisconnectReason.connectionClosed) {
                    console.log('🔄 Connection closed, reconnecting...');
                    connectionStatus = 'disconnected';
                    setTimeout(() => connectToWhatsApp(), 2000);
                } else if (reason === DisconnectReason.connectionLost) {
                    console.log('🔄 Connection lost, reconnecting...');
                    connectionStatus = 'disconnected';
                    setTimeout(() => connectToWhatsApp(), 2000);
                } else if (reason === DisconnectReason.connectionReplaced) {
                    console.log('⚠️  Connection replaced by another session');
                    connectionStatus = 'disconnected';
                } else if (reason === DisconnectReason.loggedOut) {
                    console.log('🚪 Logged out, clearing auth state...');
                    connectionStatus = 'disconnected';
                    clearAuthState().then(() => {
                        console.log('✅ Auth state cleared after logout');
                    });
                } else if (reason === DisconnectReason.restartRequired) {
                    console.log('🔄 Restart required, restarting...');
                    connectionStatus = 'disconnected';
                    setTimeout(() => connectToWhatsApp(), 3000);
                } else if (shouldReconnect) {
                    console.log('🔄 Attempting to reconnect...');
                    connectionStatus = 'disconnected';
                    setTimeout(() => connectToWhatsApp(), 5000);
                }
            } else if (connection === 'open') {
                console.log('✅ WhatsApp connected successfully!');
                connectionStatus = 'connected';
                qrCode = '';
                
                if (isNewLogin) {
                    console.log('🎉 New login detected!');
                }
            } else if (connection === 'connecting') {
                console.log('🔄 Connecting to WhatsApp...');
                connectionStatus = 'connecting';
            }
        });
    } catch (error) {
        console.error('❌ Error in connectToWhatsApp:', error);
        connectionStatus = 'error';
        setTimeout(() => connectToWhatsApp(), 10000);
    }

    // Handle incoming messages
    sock.ev.on('messages.upsert', async (m) => {
        const messages = m.messages;
        
        for (const message of messages) {
            if (message.key.fromMe) continue; // Skip own messages
            
            // Extract contact info
            const contact = message.pushName || message.key.remoteJid?.split('@')[0] || 'Unknown';
            const phoneNumber = message.key.remoteJid?.includes('@s.whatsapp.net') 
                ? message.key.remoteJid.split('@')[0] 
                : message.key.remoteJid;

            const messageData = {
                // Basic message info
                id: message.key.id,
                from: message.key.remoteJid,
                fromName: contact,
                phoneNumber: phoneNumber,
                timestamp: message.messageTimestamp,
                
                // Message content
                body: message.message?.conversation || 
                      message.message?.extendedTextMessage?.text || 
                      message.message?.imageMessage?.caption || 
                      message.message?.videoMessage?.caption || '',
                
                // Message metadata
                messageType: getMessageType(message),
                isGroup: message.key.remoteJid?.endsWith('@g.us') || false,
                
                // Additional context for n8n processing
                rawMessage: {
                    key: message.key,
                    messageTimestamp: message.messageTimestamp,
                    pushName: message.pushName
                },
                
                // Webhook metadata
                webhookSource: 'baileys-bridge',
                processedAt: new Date().toISOString()
            };

            // Send to n8n webhook
            try {
                console.log('Sending message to n8n:', {
                    from: messageData.fromName,
                    phone: messageData.phoneNumber,
                    body: messageData.body.substring(0, 50) + (messageData.body.length > 50 ? '...' : ''),
                    type: messageData.messageType
                });

                const response = await axios.post(N8N_WEBHOOK_URL, messageData, {
                    headers: { 
                        'Content-Type': 'application/json',
                        'User-Agent': 'Baileys-Bridge/1.0'
                    },
                    timeout: 10000 // 10 second timeout
                });
                
                console.log('✅ Message sent to n8n successfully');
                
            } catch (error) {
                console.error('❌ Error sending to n8n:', {
                    message: error.message,
                    status: error.response?.status,
                    data: error.response?.data
                });
                
                // Optional: Store failed messages for retry
                // You could implement a retry mechanism here
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
    if (message.message?.locationMessage) return 'location';
    if (message.message?.contactMessage) return 'contact';
    return 'unknown';
}

// Routes
app.get('/', (req, res) => {
    res.json({
        status: connectionStatus,
        message: 'WhatsApp Baileys Bridge Server - n8n Integration',
        n8nWebhook: N8N_WEBHOOK_URL,
        endpoints: {
            qr: '/qr',
            status: '/status',
            send: '/send',
            health: '/health',
            restart: '/restart',
            clearAuth: '/clear-auth'
        }
    });
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        connection: connectionStatus,
        n8nWebhook: N8N_WEBHOOK_URL,
        timestamp: new Date().toISOString()
    });
});

app.get('/status', (req, res) => {
    res.json({ 
        status: connectionStatus,
        hasQR: !!qrCode,
        n8nWebhook: N8N_WEBHOOK_URL
    });
});

app.get('/qr', (req, res) => {
    if (qrCode) {
        res.json({ 
            qr: qrCode, 
            status: 'qr_ready',
            message: 'Scan this QR code with WhatsApp within 60 seconds',
            instructions: [
                '1. Open WhatsApp on your phone',
                '2. Go to Settings > Linked Devices',
                '3. Tap "Link a Device"',
                '4. Scan this QR code'
            ]
        });
    } else {
        res.json({ 
            message: connectionStatus === 'connected' 
                ? 'Already connected to WhatsApp' 
                : connectionStatus === 'connecting'
                ? 'Currently connecting to WhatsApp...'
                : 'QR code not available. Try restarting the connection.',
            status: connectionStatus 
        });
    }
});

// Send message endpoint (can be triggered from n8n)
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
            case 'image':
                // You can extend this for image messages
                return res.status(400).json({ error: 'Image messages not implemented yet' });
            default:
                return res.status(400).json({ error: 'Unsupported message type' });
        }
        
        console.log('✅ Message sent via API:', { to: jid, message: message.substring(0, 50) + '...' });
        
        res.json({ 
            success: true, 
            messageId: result.key.id,
            to: jid,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('❌ Send message error:', error);
        res.status(500).json({ 
            error: 'Failed to send message',
            details: error.message 
        });
    }
});

// Clear auth and restart endpoint
app.post('/clear-auth', async (req, res) => {
    try {
        console.log('🧹 Clearing authentication state...');
        
        // Close existing connection
        if (sock) {
            sock.end();
        }
        
        // Clear auth state
        await clearAuthState();
        
        // Wait a moment then restart
        setTimeout(() => {
            connectToWhatsApp();
        }, 3000);
        
        res.json({ 
            message: 'Authentication cleared. Restarting connection...',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ Error clearing auth:', error);
        res.status(500).json({ 
            error: 'Failed to clear authentication',
            details: error.message 
        });
    }
});

// Restart connection endpoint
app.post('/restart', async (req, res) => {
    try {
        console.log('🔄 Restarting WhatsApp connection...');
        if (sock) {
            sock.end();
        }
        setTimeout(() => {
            connectToWhatsApp();
        }, 2000);
        
        res.json({ 
            message: 'Restarting connection...',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Test n8n connection endpoint
app.get('/test-n8n', async (req, res) => {
    try {
        const testData = {
            test: true,
            message: 'Test connection from Baileys Bridge',
            timestamp: new Date().toISOString(),
            source: 'baileys-bridge-test'
        };
        
        const response = await axios.post(N8N_WEBHOOK_URL, testData, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 5000
        });
        
        res.json({
            success: true,
            message: 'n8n webhook connection successful',
            webhookUrl: N8N_WEBHOOK_URL,
            response: response.status
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Failed to connect to n8n webhook',
            webhookUrl: N8N_WEBHOOK_URL,
            details: error.message
        });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📡 n8n Base URL: ${N8N_BASE_URL}`);
    console.log(`🔗 n8n Webhook Path: ${N8N_WEBHOOK_PATH}`);
    console.log(`📨 Full n8n Webhook URL: ${N8N_WEBHOOK_URL}`);
    console.log(`🌐 Baileys Bridge URL: ${BAILEYS_BASE_URL}`);
    console.log('');
    console.log('Environment Variables:');
    console.log(`  PORT: ${PORT}`);
    console.log(`  N8N_BASE_URL: ${N8N_BASE_URL}`);
    console.log(`  N8N_WEBHOOK_PATH: ${N8N_WEBHOOK_PATH}`);
    console.log(`  BAILEYS_BASE_URL: ${BAILEYS_BASE_URL}`);
    
    // Test n8n connection on startup
    setTimeout(async () => {
        try {
            await axios.get(`http://localhost:${PORT}/test-n8n`);
        } catch (error) {
            console.log('⚠️  Could not test n8n connection on startup');
        }
    }, 5000);
    
    // Initialize WhatsApp connection
    connectToWhatsApp();
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('🛑 Shutting down gracefully...');
    if (sock) {
        sock.end();
    }
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('🛑 Received SIGTERM, shutting down...');
    if (sock) {
        sock.end();
    }
    process.exit(0);
});
