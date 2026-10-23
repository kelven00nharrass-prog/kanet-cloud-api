/**
 * ==============================================================================
 * KA-NET CLOUD WHATSAPP ENGINE — FORNECIMENTO (SESSÃO SECUNDÁRIA BAILEYS)
 * ==============================================================================
 * Atendimento dedicado e exclusivo para venda de megas/dados no atacado (Fornecimento),
 * parceiros e grandes revendedores.
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

let sock = null;
let currentQrBase64 = null;
let connectionStatus = 'connecting';
let connectedUser = null;
let orderDispatchCallback = null;
let firestoreDbInstance = null;
let isConnecting = false;
let reconnectAttempts = 0;

const AUTH_DIR = path.join(__dirname, 'auth_info_baileys_fornecimento');
if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
}

// Configurações
const BOT_CONFIG_PATH = path.join(__dirname, 'bot_config.js');
let DYN_CFG = {};
try {
    if (fs.existsSync(BOT_CONFIG_PATH)) {
        DYN_CFG = require(BOT_CONFIG_PATH);
    }
} catch (e) {
    console.warn('⚠️ [FORNECIMENTO] Erro ao carregar bot_config.js:', e.message);
}

const recentLogs = [];
function addLog(msg) {
    const entry = `[${new Date().toLocaleTimeString('pt-PT', { timeZone: 'Africa/Maputo' })}] ${msg}`;
    console.log(entry);
    recentLogs.unshift(entry);
    if (recentLogs.length > 50) recentLogs.pop();
}

// Backup para Firestore se disponível
let backupDebounceTimer = null;
function backupAuthToFirestore(db) {
    if (!db || !fs.existsSync(AUTH_DIR)) return;
    if (backupDebounceTimer) clearTimeout(backupDebounceTimer);
    backupDebounceTimer = setTimeout(async () => {
        try {
            const files = fs.readdirSync(AUTH_DIR);
            let batch = db.batch();
            let count = 0;
            for (const file of files) {
                const filePath = path.join(AUTH_DIR, file);
                if (fs.statSync(filePath).isFile()) {
                    const content = fs.readFileSync(filePath, 'utf8');
                    batch.set(db.collection('whatsapp_fornecimento_auth').doc(encodeURIComponent(file)), {
                        content,
                        updatedAt: new Date().toISOString()
                    });
                    count++;
                }
            }
            if (count > 0) {
                await batch.commit();
                console.log(`☁️ [FORNECIMENTO FIRESTORE] Backup de ${count} ficheiros de autenticação concluído.`);
            }
        } catch (e) {
            console.warn('⚠️ [FORNECIMENTO FIRESTORE] Falha no backup:', e.message);
        }
    }, 5000);
}

async function restoreAuthFromFirestore(db) {
    if (!db) return;
    try {
        const snap = await db.collection('whatsapp_fornecimento_auth').get();
        if (!snap.empty) {
            console.log(`☁️ [FORNECIMENTO FIRESTORE] Restaurando ${snap.docs.length} ficheiros de sessão...`);
            for (const doc of snap.docs) {
                const fileName = decodeURIComponent(doc.id);
                const filePath = path.join(AUTH_DIR, fileName);
                fs.writeFileSync(filePath, doc.data().content, 'utf8');
            }
        }
    } catch (e) {
        console.warn('⚠️ [FORNECIMENTO FIRESTORE] Falha ao restaurar sessão:', e.message);
    }
}

function getMenuFornecimento() {
    const mpesaNum = DYN_CFG.MPESA_NUMBER || '856268811';
    const mpesaName = DYN_CFG.MPESA_NAME || 'Kelven Junior Anabela Nharrava';
    const emolaNum = DYN_CFG.EMOLA_NUMBER || '864882152';
    const emolaName = DYN_CFG.EMOLA_NAME || 'Catia Anabela Nharrava';

    return `📦 *KA-NET — ATENDIMENTO DE FORNECIMENTO (ATACADO)* 📦\n` +
           `_Linha exclusiva para fornecedores e revendedores de dados em grande escala._\n\n` +
           `💎 *TABELA DE FORNECIMENTO:* \n` +
           `▫️ *10 GB* ➔ *190 MT*\n` +
           `▫️ *20 GB* ➔ *380 MT*\n` +
           `▫️ *30 GB* ➔ *570 MT*\n` +
           `▫️ *40 GB* ➔ *760 MT*\n` +
           `▫️ *50 GB* ➔ *925 MT*\n` +
           `▫️ *60 GB* ➔ *1110 MT*\n` +
           `▫️ *70 GB* ➔ *1295 MT*\n` +
           `▫️ *80 GB* ➔ *1480 MT*\n\n` +
           `💳 *FORMAS DE PAGAMENTO:* \n` +
           `▫️ *M-Pesa:* \`${mpesaNum}\` (${mpesaName})\n` +
           `▫️ *e-Mola:* \`${emolaNum}\` (${emolaName})\n\n` +
           `📩 *COMO COMPRAR:* \n` +
           `Transfira o valor pretendido e *envie o SMS comprovativo para este WhatsApp*. O sistema valida e processa a entrega automaticamente!`;
}

async function startWhatsApp(orderCallback, db = null) {
    if (db) firestoreDbInstance = db;
    if (orderCallback) orderDispatchCallback = orderCallback;

    if (isConnecting) {
        console.log('🔄 [FORNECIMENTO] Inicialização já em andamento. Ignorando chamada concorrente.');
        return;
    }
    isConnecting = true;

    try {
        if (firestoreDbInstance) {
            await restoreAuthFromFirestore(firestoreDbInstance);
        }

        if (sock) {
            try {
                sock.ev.removeAllListeners();
                sock.ws?.close();
                sock.end?.(undefined);
            } catch (e) {}
            sock = null;
        }

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const { version } = await fetchLatestBaileysVersion();

        console.log(`🚀 [FORNECIMENTO] Iniciando Baileys WhatsApp Fornecimento v${version.join('.')}...`);

        sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            auth: state,
            browser: ['Ka-Net Fornecimento', 'Chrome', '1.0.0'],
            syncFullHistory: false,
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: false,
            getMessage: async () => ({ conversation: '' })
        });

        sock.ev.on('creds.update', async () => {
            await saveCreds();
            if (firestoreDbInstance) {
                backupAuthToFirestore(firestoreDbInstance);
            }
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                connectionStatus = 'qr_ready';
                reconnectAttempts = 0;
                try {
                    currentQrBase64 = await QRCode.toDataURL(qr);
                    console.log('⚡ [FORNECIMENTO] Novo QR Code gerado.');
                } catch (e) {
                    console.warn('⚠️ [FORNECIMENTO] Erro ao converter QR Code:', e.message);
                }
            }

            if (connection === 'close') {
                isConnecting = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const errMsg = lastDisconnect?.error?.message || 'sem mensagem';
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                connectionStatus = 'disconnected';
                currentQrBase64 = null;

                addLog(`⚠️ [FORNECIMENTO DESCONECTADO] Código: ${statusCode} | Motivo: ${errMsg}`);

                if (shouldReconnect) {
                    const delay = Math.min(3000 * Math.pow(2, Math.min(reconnectAttempts, 4)), 30000);
                    reconnectAttempts++;
                    setTimeout(() => startWhatsApp(orderDispatchCallback, firestoreDbInstance), delay);
                } else {
                    addLog('🔒 [FORNECIMENTO] Sessão encerrada (Logout). Limpando dados locais.');
                    connectedUser = null;
                }
            } else if (connection === 'open') {
                isConnecting = false;
                connectionStatus = 'connected';
                currentQrBase64 = null;
                reconnectAttempts = 0;
                connectedUser = sock?.user?.id?.split(':')[0] || sock?.user?.id || 'Conectado';
                addLog(`✅ WhatsApp Fornecimento CONECTADO com SUCESSO! Número: ${connectedUser}`);
                if (firestoreDbInstance) {
                    backupAuthToFirestore(firestoreDbInstance);
                }
            }
        });

        // Receptor de Mensagens
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            for (const msg of messages) {
                if (!msg.message || msg.key.fromMe) continue;

                const senderJid = msg.key.remoteJid;
                const text = (msg.message.conversation ||
                              msg.message.extendedTextMessage?.text ||
                              msg.message.imageMessage?.caption || '').trim();

                if (!text) continue;

                const textLower = text.toLowerCase();

                // Comandos de Ajuda / Menu de Fornecimento
                if (['menu', '#menu', 'fornecimento', '#fornecimento', 'tabela', 'precos', 'preços', 'ola', 'olá', 'bom dia', 'boa tarde', 'boa noite', 'ajuda'].some(k => textLower === k || textLower.startsWith(k + ' '))) {
                    await sock.sendMessage(senderJid, { text: getMenuFornecimento() }, { quoted: msg });
                    continue;
                }

                // Deteção de Comprovativo M-Pesa / e-Mola para Fornecimento
                const mpesaMatch = text.match(/([A-Z0-9]{10,12})\s*Confirmado\.?\s*(?:Voce\s+transferiu|Transferiste)\s*([\d,.]+)\s*MT/i) ||
                                   text.match(/Confirmado\.\s*([\d,.]+)\s*MT\s*transferido\s*para.*(?:Ref|TxId|Transaccao)[:\s]*([A-Z0-9]+)/i);

                if (mpesaMatch) {
                    const valorStr = (mpesaMatch[1].match(/^\d/) ? mpesaMatch[1] : mpesaMatch[2]).replace(',', '.');
                    const txnId = mpesaMatch[1].match(/^\d/) ? mpesaMatch[2] : mpesaMatch[1];
                    const valor = parseFloat(valorStr);

                    addLog(`📥 [FORNECIMENTO COMPROVATIVO] Txn: ${txnId} | Valor: ${valor} MT de ${senderJid}`);

                    // Notificar entrega se corresponder a pacote de fornecimento
                    await sock.sendMessage(senderJid, {
                        text: `✅ *COMPROVATIVO DE FORNECIMENTO DETETADO!* \n\n` +
                              `📋 *Transação:* \`${txnId}\`\n` +
                              `💰 *Valor:* \`${valor} MT\`\n` +
                              `⏳ *Estado:* O seu pedido de megas no atacado está a ser processado pela central Ka-Net!`
                    }, { quoted: msg });

                    if (orderDispatchCallback) {
                        orderDispatchCallback({
                            type: 'fornecimento',
                            txnId,
                            valor,
                            senderJid,
                            raw: text
                        });
                    }
                }
            }
        });

    } catch (err) {
        isConnecting = false;
        connectionStatus = 'error';
        addLog(`❌ [FORNECIMENTO ERRO]: ${err.message}`);
        console.error('❌ [FORNECIMENTO EXCEPTION]:', err);
    }
}

function getStatus() {
    return {
        session: 'fornecimento',
        status: connectionStatus,
        user: connectedUser,
        hasQr: !!currentQrBase64,
        qrImage: currentQrBase64
    };
}

async function sendTextMessage(jid, text, options = {}) {
    if (sock && connectionStatus === 'connected') {
        const payload = typeof text === 'string' ? { text } : { ...text };
        if (options && options.mentions && Array.isArray(options.mentions)) {
            payload.mentions = options.mentions;
        }
        return await sock.sendMessage(jid, payload);
    }
    throw new Error('WhatsApp Fornecimento não está conectado');
}

async function resetSession(db = null) {
    console.log('🔄 [FORNECIMENTO] Reset total da sessão solicitado.');
    try {
        if (sock) {
            try {
                sock.ev.removeAllListeners();
                sock.ws?.close();
                sock.end?.(undefined);
            } catch (e) {}
            sock = null;
        }
        if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            fs.mkdirSync(AUTH_DIR, { recursive: true });
        }
        if (db) {
            try {
                const snap = await db.collection('whatsapp_fornecimento_auth').get();
                const batch = db.batch();
                snap.docs.forEach(doc => batch.delete(doc.ref));
                await batch.commit();
            } catch (e) {}
        }
        currentQrBase64 = null;
        connectionStatus = 'disconnected';
        connectedUser = null;
        setTimeout(() => startWhatsApp(orderDispatchCallback, db), 1500);
        return { success: true, message: 'Sessão de Fornecimento reiniciada com sucesso' };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

module.exports = {
    startWhatsApp,
    getStatus,
    resetSession,
    sendTextMessage,
    getRecentLogs: () => recentLogs
};
