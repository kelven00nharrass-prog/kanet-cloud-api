/**
 * ==============================================================================
 * KA-NET CLOUD WHATSAPP ENGINE (POWERED BY BAILEYS)
 * ==============================================================================
 * - Motor WhatsApp ultra-leve para rodar 24h na Nuvem (Render).
 * - Tabela de preços e lógica igual ao bot local (Ka-Net System 2.0.js)
 * - Suporta: Menu, Comprar, Comprovativo M-Pesa/e-Mola, Comandos Admin
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

const AUTH_DIR = path.join(__dirname, '..', 'auth_info_baileys');
if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
}

// ══════════════════════════════════════════════════
// CONFIGURAÇÕES (iguais ao bot local)
// ══════════════════════════════════════════════════
const NOME_SISTEMA  = 'Ka-Net System';
const MPESA_NUM     = '856268811';
const MPESA_NOME    = 'Kelven Junior Anabela Nharrava';
const EMOLA_NUM     = '864882152';
const EMOLA_NOME    = 'Catia Anabela Nharrava';
const MASTERS       = ['856116039', '850401416'];

// Tabela 24h (preço MT → MB) — extraída do bot_config.js
const TABELA_24H = {
  10:  { mb: 350,   nome: '350MB 24h'  },
  14:  { mb: 550,   nome: '550MB 24h'  },
  17:  { mb: 696,   nome: '696MB 24h'  },
  19:  { mb: 800,   nome: '800MB 24h'  },
  23:  { mb: 1024,  nome: '1GB 24h'    },
  28:  { mb: 1229,  nome: '1.2GB 24h'  },
  30:  { mb: 1331,  nome: '1.3GB 24h'  },
  37:  { mb: 1638,  nome: '1.6GB 24h'  },
  46:  { mb: 2048,  nome: '2GB 24h'    },
  69:  { mb: 3072,  nome: '3GB 24h'    },
  92:  { mb: 4096,  nome: '4GB 24h'    },
  115: { mb: 5120,  nome: '5GB 24h'    },
  138: { mb: 6144,  nome: '6GB 24h'    },
  161: { mb: 7168,  nome: '7GB 24h'    },
  184: { mb: 8192,  nome: '8GB 24h'    },
  207: { mb: 9216,  nome: '9GB 24h'    },
  230: { mb: 10240, nome: '10GB 24h'   },
};

// Tabela Semanal
const TABELA_SEMANAL = {
  47:  { mb: 1741,  nome: '1.7GB 7 Dias' },
  80:  { mb: 2970,  nome: '2.9GB 7 Dias' },
  90:  { mb: 3482,  nome: '3.4GB 7 Dias' },
  140: { mb: 5427,  nome: '5.3GB 7 Dias' },
  190: { mb: 7373,  nome: '7.2GB 7 Dias' },
  290: { mb: 10957, nome: '10.7GB 7 Dias'},
  380: { mb: 14438, nome: '14.1GB 7 Dias'},
  470: { mb: 18022, nome: '17.6GB 7 Dias'},
};

// Regex para extrair comprovativo M-Pesa
const MPESA_REGEX = /([A-Z0-9.]+)\s+Confirmado[\s.]+Recebeu\s+([\d.,]+)\s*MT\s+de\s+(\d{9})/i;
// Regex para e-Mola
const EMOLA_REGEX = /(TX[0-9A-Z.]+).*?([\d.,]+)\s*MT.*?(\d{9})/is;

// Estado temporário por sessão (aguardar número após comprovativo)
const pendingPayments = new Map(); // jid -> { txn_id, valor, remetente, metodo, aguardando_numero }

// ══════════════════════════════════════════════════
// FUNÇÕES UTILITÁRIAS
// ══════════════════════════════════════════════════
function gerarMenu() {
  const linhas24h = Object.entries(TABELA_24H)
    .map(([preco, p]) => `  • *${p.nome}* 👉 *${preco} MT*`)
    .join('\n');
  const linhasSemanal = Object.entries(TABELA_SEMANAL)
    .slice(0, 4)
    .map(([preco, p]) => `  • *${p.nome}* 👉 *${preco} MT*`)
    .join('\n');

  return `╔══════════════════════════╗
   ⚡ *${NOME_SISTEMA}* ⚡
╚══════════════════════════╝

👋 Bem-vindo ao sistema automático de Megas!

📋 *PACOTES DIÁRIOS (24H):*
${linhas24h}

📋 *PACOTES SEMANAIS (7 Dias):*
${linhasSemanal}

💳 *COMO COMPRAR:*
1️⃣ Pague via *M-Pesa* para *${MPESA_NUM}* (${MPESA_NOME})
   ou *e-Mola* para *${EMOLA_NUM}* (${EMOLA_NOME})
2️⃣ Envie aqui o *comprovativo* de pagamento
3️⃣ Envie o *número de destino* dos dados

🤖 _Sistema 100% automático — ativo 24h na Nuvem!_`;
}

function buscarPacotePorValor(valor) {
  const v = Math.round(parseFloat(String(valor).replace(',', '.')));
  if (TABELA_24H[v])     return { ...TABELA_24H[v],     preco: v, tipo: '24hrs'   };
  if (TABELA_SEMANAL[v]) return { ...TABELA_SEMANAL[v], preco: v, tipo: 'semanal' };
  // Tolerância ±1 MT
  for (const delta of [1, -1]) {
    if (TABELA_24H[v+delta])     return { ...TABELA_24H[v+delta],     preco: v+delta, tipo: '24hrs'   };
    if (TABELA_SEMANAL[v+delta]) return { ...TABELA_SEMANAL[v+delta], preco: v+delta, tipo: 'semanal' };
  }
  return null;
}

function isMaster(numero) {
  return MASTERS.includes(String(numero).replace(/\D/g, ''));
}

// ══════════════════════════════════════════════════
// MOTOR PRINCIPAL
// ══════════════════════════════════════════════════
async function startWhatsApp(orderCallback) {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    console.log(`📡 [BAILEYS] Iniciando Ka-Net WhatsApp Cloud v${version.join('.')}...`);

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
          console.error('Erro ao gerar QR:', e);
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
        console.log(`✅ [BAILEYS] WhatsApp Conectado! Logado como: ${connectedUser}`);
      }
    });

    // ── OUVINTE DE MENSAGENS ──────────────────────────────────
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

          const senderNumber = jid.replace('@s.whatsapp.net', '').replace('@g.us', '');
          const cleanText = text.trim().toLowerCase();

          if (!text.trim()) continue;

          console.log(`📩 [CLOUD BOT] De: ${senderNumber} | ${text.substring(0, 60)}`);

          const reply = async (resposta) => {
            await sock.sendMessage(jid, { text: resposta });
          };

          // ── 1. AGUARDANDO NÚMERO DE DESTINO APÓS COMPROVATIVO ──
          if (pendingPayments.has(jid)) {
            const pay = pendingPayments.get(jid);
            if (pay.aguardando_numero) {
              const numDestino = text.trim().replace(/\D/g, '');
              if (numDestino.length >= 9) {
                pendingPayments.delete(jid);
                const pacote = buscarPacotePorValor(pay.valor);
                if (!pacote) {
                  await reply(`⚠️ Não encontrei um pacote para *${pay.valor} MT*.\n\nDigite *Menu* para ver os pacotes disponíveis.`);
                  continue;
                }

                const orderId = 'WA-' + pay.txn_id + '-' + Date.now();
                await reply(
                  `✅ *Pedido Confirmado!*\n\n` +
                  `📦 Pacote: *${pacote.nome}*\n` +
                  `📱 Número: *${numDestino}*\n` +
                  `💳 Pagamento: *${pay.valor} MT* via ${pay.metodo === 'emola' ? 'e-Mola' : 'M-Pesa'}\n` +
                  `🆔 Ref: ${pay.txn_id}\n\n` +
                  `⏳ A activar o pacote automaticamente...`
                );

                if (orderCallback) {
                  orderCallback({
                    orderId,
                    numero: numDestino,
                    quantidade: pacote.mb,
                    modo: pacote.tipo,
                    jid,
                    sender: senderNumber,
                    txn_id: pay.txn_id,
                    valor: pay.valor
                  });
                }
                continue;
              } else {
                await reply(`⚠️ Número inválido. Envie o número de destino com 9 dígitos (ex: *84XXXXXXX*).`);
                continue;
              }
            }
          }

          // ── 2. COMPROVATIVO M-PESA ──────────────────────────────
          const mpesaMatch = text.match(MPESA_REGEX);
          if (mpesaMatch) {
            const txn_id   = mpesaMatch[1];
            const valor    = mpesaMatch[2];
            const remetente = mpesaMatch[3];
            const pacote   = buscarPacotePorValor(valor);

            console.log(`💳 [CLOUD BOT] Comprovativo M-Pesa: ${txn_id} - ${valor} MT de ${remetente}`);

            if (!pacote) {
              await reply(
                `⚠️ *Comprovativo recebido!*\n\n` +
                `Transação: *${txn_id}*\n` +
                `Valor: *${valor} MT*\n\n` +
                `Mas este valor não corresponde a nenhum pacote.\n` +
                `Digite *Menu* para ver os preços disponíveis.`
              );
              continue;
            }

            pendingPayments.set(jid, {
              txn_id, valor, remetente,
              metodo: 'mpesa',
              aguardando_numero: true
            });

            await reply(
              `✅ *Comprovativo M-Pesa verificado!*\n\n` +
              `🆔 Transação: *${txn_id}*\n` +
              `💰 Valor: *${valor} MT*\n` +
              `📦 Pacote: *${pacote.nome}* (${pacote.mb} MB)\n\n` +
              `📱 *Envie agora o número de destino dos dados:*\n_(ex: 84XXXXXXX ou 85XXXXXXX)_`
            );
            continue;
          }

          // ── 3. COMPROVATIVO E-MOLA ──────────────────────────────
          const emolaMatch = text.match(EMOLA_REGEX);
          if (emolaMatch) {
            const txn_id    = emolaMatch[1];
            const valor     = emolaMatch[2];
            const remetente = emolaMatch[3];
            const pacote    = buscarPacotePorValor(valor);

            console.log(`💳 [CLOUD BOT] Comprovativo e-Mola: ${txn_id} - ${valor} MT`);

            if (!pacote) {
              await reply(
                `⚠️ *Comprovativo e-Mola recebido!*\n\nValor *${valor} MT* não corresponde a nenhum pacote.\nDigite *Menu* para ver os preços.`
              );
              continue;
            }

            pendingPayments.set(jid, {
              txn_id, valor, remetente,
              metodo: 'emola',
              aguardando_numero: true
            });

            await reply(
              `✅ *Comprovativo e-Mola verificado!*\n\n` +
              `🆔 Transação: *${txn_id}*\n` +
              `💰 Valor: *${valor} MT*\n` +
              `📦 Pacote: *${pacote.nome}*\n\n` +
              `📱 *Envie agora o número de destino dos dados:*`
            );
            continue;
          }

          // ── 4. MENU ─────────────────────────────────────────────
          const menuWords = ['menu','oi','olá','ola','bom dia','boa tarde','boa noite','megas','preco','preço','tabela','pacotes','planos','precos','iniciar','start','ativar','comprar megas'];
          if (menuWords.some(w => cleanText === w || cleanText.startsWith(w))) {
            await reply(gerarMenu());
            continue;
          }

          // ── 5. COMO COMPRAR ─────────────────────────────────────
          if (['como comprar','como funciona','como faço','como faz','como ativar','ajuda','help'].some(w => cleanText.includes(w))) {
            await reply(
              `🛒 *COMO COMPRAR MEGAS — ${NOME_SISTEMA}*\n\n` +
              `1️⃣ Veja os preços digitando *Menu*\n` +
              `2️⃣ Pague via:\n` +
              `   💳 *M-Pesa:* ${MPESA_NUM} (${MPESA_NOME})\n` +
              `   💳 *e-Mola:* ${EMOLA_NUM} (${EMOLA_NOME})\n` +
              `3️⃣ Envie o *comprovativo* aqui no chat\n` +
              `4️⃣ Envie o *número de destino* (que vai receber os dados)\n\n` +
              `✅ O sistema activa automaticamente em segundos!`
            );
            continue;
          }

          // ── 6. PAGAMENTO / CONTAS ────────────────────────────────
          if (['pagamento','conta','contas','numero','número','mpesa','emola','e-mola','pagar'].some(w => cleanText.includes(w))) {
            await reply(
              `💳 *CONTAS DE PAGAMENTO — ${NOME_SISTEMA}*\n\n` +
              `📱 *M-Pesa:* ${MPESA_NUM}\n` +
              `   Nome: ${MPESA_NOME}\n\n` +
              `📱 *e-Mola:* ${EMOLA_NUM}\n` +
              `   Nome: ${EMOLA_NOME}\n\n` +
              `Após pagar, envie o comprovativo aqui! ✅`
            );
            continue;
          }

          // ── 7. COMANDO COMPRAR MANUAL (admin) ────────────────────
          if (cleanText.startsWith('comprar ') && isMaster(senderNumber)) {
            const parts = text.trim().split(/\s+/);
            if (parts.length >= 3) {
              const quantidade = parseInt(parts[1]);
              const numDest    = parts[2].replace(/\D/g, '');
              if (quantidade > 0 && numDest.length >= 9) {
                const orderId = 'MANUAL-' + Date.now();
                await reply(`⏳ *Pedido manual registado!*\n📦 ${quantidade} MB → 📱 ${numDest}\nRef: ${orderId}`);
                if (orderCallback) {
                  orderCallback({ orderId, numero: numDest, quantidade, modo: 'diario', jid, sender: senderNumber });
                }
                continue;
              }
            }
            await reply(`Formato: *COMPRAR [MB] [NUMERO]*\nEx: COMPRAR 1024 841234567`);
            continue;
          }

          // ── 8. STATUS (admin) ──────────────────────────────────
          if ((cleanText === 'status' || cleanText === 'estado') && isMaster(senderNumber)) {
            await reply(
              `📊 *KA-NET CLOUD STATUS*\n\n` +
              `🤖 Bot: ✅ Online 24h na Nuvem\n` +
              `📱 WhatsApp: ✅ Conectado\n` +
              `🕐 Hora: ${new Date().toLocaleString('pt-PT', { timeZone: 'Africa/Maputo' })}`
            );
            continue;
          }

          // ── 9. RESPOSTA PADRÃO ────────────────────────────────
          await reply(
            `👋 Olá! Bem-vindo ao *${NOME_SISTEMA}*!\n\n` +
            `Digite *Menu* para ver os pacotes de dados disponíveis.\n\n` +
            `Ou envie o *comprovativo M-Pesa/e-Mola* para comprar automaticamente! ✅`
          );
        }
      } catch (err) {
        console.error('❌ [BAILEYS MSG ERROR]:', err);
      }
    });

  } catch (e) {
    console.error('❌ [BAILEYS INIT ERROR]:', e);
    setTimeout(() => startWhatsApp(orderCallback), 10000);
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

module.exports = { startWhatsApp, getStatus, sendTextMessage };
