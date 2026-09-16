/**
 * ==============================================================================
 * KA-NET CLOUD WHATSAPP ENGINE (POWERED BY BAILEYS)
 * ==============================================================================
 * - Motor WhatsApp ultra-leve (~30MB RAM) para rodar 24h na Nuvem (Render).
 * - Sem Chromium / Puppeteer.
 * - QR Code servido via Web em /qr para fácil escaneamento no celular.
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

let sock = null;
let currentQrBase64 = null;
let connectionStatus = 'connecting'; // 'connecting', 'qr_ready', 'connected', 'disconnected'
let connectedUser = null;

const AUTH_DIR = path.join(__dirname, '..', 'auth_info_baileys');
if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
}

async function startWhatsApp(orderCallback) {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const { version } = await fetchLatestBaileysVersion();

        console.log(`📡 [BAILEYS] Iniciando WhatsApp Cloud v${version.join('.')}...`);

        sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: true,
            auth: state,
            browser: ['Ka-Net Cloud', 'Chrome', '2.0.0']
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                connectionStatus = 'qr_ready';
                try {
                    currentQrBase64 = await QRCode.toDataURL(qr);
                    console.log('📱 [BAILEYS] Novo QR Code gerado! Aceda a /qr para escanear.');
                } catch (e) {
                    console.error('Erro ao gerar QR Code imagem:', e);
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                connectionStatus = 'disconnected';
                currentQrBase64 = null;
                console.log(`🔌 [BAILEYS] Conexão fechada (${statusCode}). Reconectar: ${shouldReconnect}`);
                if (shouldReconnect) {
                    setTimeout(() => startWhatsApp(orderCallback), 5000);
                }
            } else if (connection === 'open') {
                connectionStatus = 'connected';
                currentQrBase64 = null;
                connectedUser = sock.user?.id || 'KaNet Cloud Bot';
                console.log(`✅ [BAILEYS] WhatsApp Conectado com SUCESSO! Logado como: ${connectedUser}`);
            }
        });

        // Ouvinte de mensagens recebidas
        sock.ev.on('messages.upsert', async (m) => {
            try {
                if (m.type !== 'notify') return;
                for (const msg of m.messages) {
                    if (msg.key.fromMe) continue;
                    const jid = msg.key.remoteJid;
                    if (!jid) continue;

                    const text = msg.message?.conversation || 
                                 msg.message?.extendedTextMessage?.text || 
                                 msg.message?.imageMessage?.caption || '';

                    if (!text) continue;
                    const cleanText = text.trim().toLowerCase();
                    const senderNumber = jid.replace('@s.whatsapp.net', '').replace('@g.us', '');

                    console.log(`📩 [WHATSAPP MSG] De: ${senderNumber} | Texto: ${text.substring(0, 50)}`);

                    // 1. Menu Principal
                    if (['menu', 'oi', 'ola', 'olá', 'bom dia', 'boa tarde', 'boa noite', 'megas', 'preco', 'preço', 'tabela'].includes(cleanText)) {
                        const menuMsg = 
`╔═══════════════════════╗
   ⚡ *KA-NET MEGAS 24H* ⚡
╚═══════════════════════╝

👋 Olá! Bem-vindo ao sistema automático de Megas da Vodacom.

📋 *TABELA DE MEGAS DIÁRIOS (24H):*
• 500 MB  👉 *25 MT*
• 1.024 MB (1GB) 👉 *45 MT*
• 2.048 MB (2GB) 👉 *85 MT*
• 3.072 MB (3GB) 👉 *120 MT*
• 5.120 MB (5GB) 👉 *190 MT*

💳 *COMO COMPRAR:*
Envie o valor via M-Pesa para a conta do serviço e envie aqui o comprovativo ou digite:
👉 *COMPRAR [MEGAS] [NUMERO]*
Exemplo: *COMPRAR 1024 841234567*

🤖 _Atendimento 100% automático 24h na Nuvem!_`;
                        await sock.sendMessage(jid, { text: menuMsg });
                        continue;
                    }

                    // 2. Comando Comprar Manual
                    if (cleanText.startsWith('comprar ')) {
                        const parts = text.split(/\s+/);
                        if (parts.length >= 3) {
                            const quantidade = parseInt(parts[1]);
                            const numeroDestino = parts[2].replace(/\D/g, '');

                            if (quantidade > 0 && numeroDestino.length >= 9) {
                                const orderId = `WHATSAPP-${Date.now()}`;
                                await sock.sendMessage(jid, { 
                                    text: `⏳ *Pedido Registado!*\n\n📦 Quantidade: *${quantidade} MB*\n📱 Número: *${numeroDestino}*\n\nA enviar pedido para o celular de envio...` 
                                });

                                if (orderCallback) {
                                    orderCallback({
                                        orderId,
                                        numero: numeroDestino,
                                        quantidade,
                                        modo: 'diario',
                                        jid,
                                        sender: senderNumber
                                    });
                                }
                            }
                        }
                    }
                }
            } catch (err) {
                console.error('❌ [BAILEYS MSG ERROR]:', err);
            }
        });

    } catch (e) {
        console.error('❌ [BAILEYS INIT ERROR]:', e);
    }
}

function getStatus() {
    return {
        status: connectionStatus,
        user: connectedUser,
        hasQr: !!currentQrBase64,
        qrImage: currentQrBase64
    };
}

async function sendTextMessage(jid, text) {
    if (sock && connectionStatus === 'connected') {
        return await sock.sendMessage(jid, { text });
    }
    return false;
}

module.exports = {
    startWhatsApp,
    getStatus,
    sendTextMessage
};
