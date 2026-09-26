const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const pino = require('pino');

let makeWASocket, useMultiFileAuthState, DisconnectReason;
try {
    const baileys = require('@whiskeysockets/baileys');
    makeWASocket = baileys.default || baileys.makeWASocket;
    useMultiFileAuthState = baileys.useMultiFileAuthState;
    DisconnectReason = baileys.DisconnectReason;
} catch (e) {
    console.error('⚠️ [WhatsApp Service] Could not load @whiskeysockets/baileys:', e.message);
}

class WhatsAppService {
    constructor() {
        this.sock = null;
        this.io = null;
        this.status = 'disconnected'; // 'disconnected' | 'connecting' | 'waiting_qr' | 'connected'
        this.qrCodeRaw = null;
        this.qrCodeDataUrl = null;
        this.user = null;
        this.authDir = path.join(__dirname, 'data', 'whatsapp_auth');
        this.reconnectAttempts = 0;
        this.maxReconnectDelay = 30000;
        this.isInitializing = false;
        this.isExplicitLogout = false;
        this.logger = pino({ level: 'silent' });
    }

    init(ioInstance) {
        if (ioInstance) {
            this.io = ioInstance;
        }

        if (!makeWASocket) {
            console.warn('⚠️ [WhatsApp Service] Baileys library not available. WhatsApp integration is disabled.');
            this.status = 'unavailable';
            return;
        }

        // Ensure auth directory exists
        if (!fs.existsSync(this.authDir)) {
            try {
                fs.mkdirSync(this.authDir, { recursive: true });
            } catch (err) {
                console.error('❌ [WhatsApp Service] Failed to create auth folder:', err);
            }
        }

        this.connect();
    }

    broadcastStatus() {
        const payload = this.getStatus();
        if (this.io) {
            this.io.emit('whatsapp:status', payload);
        }
    }

    getStatus() {
        return {
            connected: this.status === 'connected',
            status: this.status,
            qr: this.qrCodeDataUrl,
            user: this.user,
            authDirExists: fs.existsSync(this.authDir)
        };
    }

    async connect() {
        if (this.isInitializing) return;
        this.isInitializing = true;
        this.isExplicitLogout = false;

        try {
            this.status = 'connecting';
            this.broadcastStatus();
            console.log('🔄 [WhatsApp Service] Initializing WhatsApp multi-device connection...');

            const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

            this.sock = makeWASocket({
                auth: state,
                logger: this.logger,
                printQRInTerminal: false,
                browser: ['Krishan POS', 'Chrome', '1.0.0'],
                syncFullHistory: false,
                generateHighQualityLinkPreview: true,
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 25000
            });

            this.sock.ev.on('creds.update', saveCreds);

            this.sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    this.qrCodeRaw = qr;
                    try {
                        this.qrCodeDataUrl = await QRCode.toDataURL(qr, {
                            margin: 2,
                            width: 320,
                            color: {
                                dark: '#064e3b',
                                light: '#ffffff'
                            }
                        });
                    } catch (qrErr) {
                        console.error('❌ [WhatsApp Service] Error generating QR data URL:', qrErr);
                    }
                    this.status = 'waiting_qr';
                    this.user = null;
                    console.log('📲 [WhatsApp Service] New QR Code generated. Scan with WhatsApp on phone to link POS.');
                    this.broadcastStatus();
                }

                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const isLoggedOut = statusCode === DisconnectReason.loggedOut || this.isExplicitLogout;

                    console.log(`🔌 [WhatsApp Service] Connection closed. Reason code: ${statusCode}. Logged out: ${isLoggedOut}`);

                    this.status = 'disconnected';
                    this.qrCodeRaw = null;
                    this.qrCodeDataUrl = null;
                    this.user = null;
                    this.broadcastStatus();

                    if (isLoggedOut) {
                        console.log('🚪 [WhatsApp Service] Session terminated/logged out. Clearing session files...');
                        this.cleanAuthDir();
                        // Generate fresh QR code after short pause
                        setTimeout(() => {
                            this.isInitializing = false;
                            this.connect();
                        }, 2000);
                    } else {
                        // Reconnect with backoff
                        this.reconnectAttempts++;
                        const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), this.maxReconnectDelay);
                        console.log(`⏳ [WhatsApp Service] Reconnecting in ${Math.round(delay / 1000)}s (Attempt #${this.reconnectAttempts})...`);
                        setTimeout(() => {
                            this.isInitializing = false;
                            this.connect();
                        }, delay);
                    }
                } else if (connection === 'open') {
                    this.reconnectAttempts = 0;
                    this.status = 'connected';
                    this.qrCodeRaw = null;
                    this.qrCodeDataUrl = null;

                    const id = this.sock.user?.id || '';
                    const rawPhone = id.split(':')[0] || id.split('@')[0];
                    const name = this.sock.user?.name || this.sock.user?.notify || 'Krishan POS Shop';

                    this.user = {
                        id,
                        phone: rawPhone,
                        name
                    };

                    console.log(`✅ [WhatsApp Service] Connected successfully to WhatsApp! Account: +${rawPhone} (${name})`);
                    this.broadcastStatus();
                }
            });

            this.sock.ev.on('messages.upsert', () => {
                // Incoming message hooks if needed in the future
            });

        } catch (err) {
            console.error('❌ [WhatsApp Service] Initialization error:', err);
            this.status = 'disconnected';
            this.broadcastStatus();
            setTimeout(() => {
                this.isInitializing = false;
                this.connect();
            }, 5000);
        } finally {
            this.isInitializing = false;
        }
    }

    cleanAuthDir() {
        try {
            if (fs.existsSync(this.authDir)) {
                fs.rmSync(this.authDir, { recursive: true, force: true });
                fs.mkdirSync(this.authDir, { recursive: true });
            }
        } catch (err) {
            console.error('⚠️ [WhatsApp Service] Could not remove auth dir:', err.message);
        }
    }

    formatPhone(phone) {
        if (!phone) return null;
        let digits = String(phone).replace(/[^0-9]/g, '');
        if (!digits) return null;

        if (digits.startsWith('0') && digits.length === 10) {
            digits = '94' + digits.substring(1);
        } else if (digits.length === 9) {
            digits = '94' + digits;
        } else if (digits.startsWith('94') && digits.length >= 11) {
            // Already standard format
        } else if (digits.length < 9) {
            return null;
        }
        return digits;
    }

    async sendMessage(phone, messageText) {
        if (this.status !== 'connected' || !this.sock) {
            return {
                success: false,
                notConnected: true,
                message: 'WhatsApp is not connected to POS. Please scan QR code in POS WhatsApp Manager.'
            };
        }

        const cleanPhone = this.formatPhone(phone);
        if (!cleanPhone) {
            return {
                success: false,
                message: 'Invalid customer phone number. Must be at least 9 or 10 digits (e.g. 07x xxxxxxx).'
            };
        }

        const jid = `${cleanPhone}@s.whatsapp.net`;

        try {
            // Check if phone number is registered on WhatsApp
            let verifiedJid = jid;
            try {
                const results = await this.sock.onWhatsApp(jid);
                if (results && results.length > 0 && results[0].exists) {
                    verifiedJid = results[0].jid || jid;
                } else {
                    return {
                        success: false,
                        notOnWhatsApp: true,
                        phone: cleanPhone,
                        message: `Customer phone number (+${cleanPhone}) is not registered on WhatsApp.`
                    };
                }
            } catch (checkErr) {
                // If onWhatsApp verification fails or timeouts, still attempt sending
                console.warn('⚠️ [WhatsApp Service] Number lookup warning, attempting direct send:', checkErr.message);
            }

            console.log(`📤 [WhatsApp Service] Sending 1-Shot WhatsApp message to +${cleanPhone}...`);

            const sentResult = await this.sock.sendMessage(verifiedJid, {
                text: messageText
            });

            console.log(`✅ [WhatsApp Service] Message successfully sent to +${cleanPhone} (MsgID: ${sentResult?.key?.id})`);

            return {
                success: true,
                messageId: sentResult?.key?.id,
                phone: cleanPhone,
                status: 'sent'
            };
        } catch (sendErr) {
            console.error(`❌ [WhatsApp Service] Error sending WhatsApp message to +${cleanPhone}:`, sendErr);
            return {
                success: false,
                error: sendErr.message,
                message: `Failed to deliver WhatsApp message: ${sendErr.message}`
            };
        }
    }

    async restart() {
        console.log('🔄 [WhatsApp Service] Restarting WhatsApp connection requested...');
        if (this.sock) {
            try {
                this.sock.end(new Error('Manual Restart'));
            } catch (e) {}
        }
        this.isInitializing = false;
        await this.connect();
        return this.getStatus();
    }

    async logout() {
        console.log('🚪 [WhatsApp Service] Manual logout requested...');
        this.isExplicitLogout = true;
        if (this.sock) {
            try {
                await this.sock.logout();
            } catch (e) {
                try {
                    this.sock.end(new Error('Explicit Logout'));
                } catch (err) {}
            }
        }
        this.cleanAuthDir();
        this.status = 'disconnected';
        this.user = null;
        this.qrCodeRaw = null;
        this.qrCodeDataUrl = null;
        this.broadcastStatus();

        setTimeout(() => {
            this.isInitializing = false;
            this.connect();
        }, 1500);

        return { success: true, message: 'Logged out successfully. Generating new QR code...' };
    }
}

const whatsappService = new WhatsAppService();
module.exports = { whatsappService };
