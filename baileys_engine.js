/**
 * ==============================================================================
 * KA-NET CLOUD WHATSAPP ENGINE (POWERED BY BAILEYS) - 100% BOT ORIGINAL
 * ==============================================================================
 * - Estrutura idêntica de tabelas, menus, boas-vindas, formas de pagamento
 * - Suporta TODOS os comandos do painel de ajuda:
 *   • .addtabela (Modo 1: colar tabela formatada / Modo 2: individual)
 *   • .addpagamento (Atualizar M-Pesa e e-Mola)
 *   • .enviar [numero] [MB] (Envio manual instantâneo)
 *   • .comandos / !comandos / /comandos / ajuda (Painel completo)
 *   • !hoje, !vendas, !amanha, !relatorio, .leads
 *   • .manutencao, .online, /status, !status, /limpar, /tentar [ref]
 *   • !abrir, !fechar, .banir, .desbanir, .banidos, .idgrupo
 *   • !convite, !indicado, .meuplano, .estudante
 *   • Comprovativos M-Pesa e e-Mola automáticos
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const geminiAI = require('./gemini_ai');
const customerServices = require('./customer_services');

let sock = null;
let currentQrBase64 = null;
let connectionStatus = 'connecting';
let connectedUser = null;
let orderDispatchCallback = null;
let modoManutencao = false;
let botSilenciado = false;

const AUTH_DIR = path.join(__dirname, '..', 'auth_info_baileys');
if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
}

// ══════════════════════════════════════════════════
// CONFIGURAÇÕES E BANCO LOCAL
// ══════════════════════════════════════════════════
const BOT_CONFIG_PATH = path.join(__dirname, 'bot_config.js');
const LOCAL_CONFIG_PATH = path.join(__dirname, 'local_config.json');
const TRANSACOES_DB_PATH = path.join(__dirname, 'transacoes_db.json');
const SMS_PAYMENTS_DB_PATH = path.join(__dirname, 'sms_payments_db.json');
const AGUARDANDO_OPERADORA_DB_PATH = path.join(__dirname, 'aguardando_operadora_db.json');

let DYN_CFG = {};
let LOCAL_CFG = {};
const banidosSet = new Set();
const clientesLeads = new Set();
const historicoVendas = [];
const transacoesProcessadas = new Set();
const transacoesProcessadasMap = new Map(); // txn_id -> { sender, jid, status: 'locked'|'completed', valor, timestamp }
const smsPaymentsMap = new Map(); // txn_id -> { txn_id, valor, remetente, metodo, raw_sms, timestamp, usado: boolean }
const aguardandoOperadora = new Map(); // txn_id -> { txn_id, valor, metodo, metodoNome, jid, senderNumber, nomeCliente, numDestino, pacote, timestamp, timer }
const recentLogs = [];
function addLog(msg) {
    const entry = `[${new Date().toLocaleTimeString('pt-PT', { timeZone: 'Africa/Maputo' })}] ${msg}`;
    console.log(entry);
    recentLogs.unshift(entry);
    if (recentLogs.length > 50) recentLogs.pop();
}

function carregarTransacoes() {
    try {
        if (fs.existsSync(TRANSACOES_DB_PATH)) {
            const data = JSON.parse(fs.readFileSync(TRANSACOES_DB_PATH, 'utf8'));
            for (const [id, val] of Object.entries(data)) {
                transacoesProcessadasMap.set(id, val);
                transacoesProcessadas.add(id);
            }
            console.log(`🔒 [ANTI-FRAUDE] ${transacoesProcessadasMap.size} transações carregadas do banco de proteção.`);
        }
    } catch (e) {
        console.error('❌ Erro ao carregar transacoes_db.json:', e.message);
    }
}

function salvarTransacoes() {
    try {
        // Proteção de armazenamento: manter no máximo as últimas 5.000 transações
        while (transacoesProcessadasMap.size > 5000) {
            const firstKey = transacoesProcessadasMap.keys().next().value;
            transacoesProcessadasMap.delete(firstKey);
            transacoesProcessadas.delete(firstKey);
        }
        const obj = {};
        for (const [id, val] of transacoesProcessadasMap.entries()) {
            obj[id] = val;
        }
        fs.writeFileSync(TRANSACOES_DB_PATH, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) {
        console.error('❌ Erro ao salvar transacoes_db.json:', e.message);
    }
    // ── Backup Firebase: só guarda a última transação (chamada após cada nova transação) ──
    if (firestoreDbInstance) {
        const ultima = Array.from(transacoesProcessadasMap.entries()).pop();
        if (ultima) {
            const [txnId, dados] = ultima;
            firestoreDbInstance.collection('transacoes_processadas').doc(txnId).set(dados)
                .catch(e => console.warn('⚠️ [FIREBASE] Erro ao salvar transacao:', e.message));
        }
    }
}

function carregarSmsPayments() {
    try {
        if (fs.existsSync(SMS_PAYMENTS_DB_PATH)) {
            const data = JSON.parse(fs.readFileSync(SMS_PAYMENTS_DB_PATH, 'utf8'));
            for (const [id, val] of Object.entries(data)) {
                smsPaymentsMap.set(id, val);
            }
            console.log(`📥 [SMS DB] ${smsPaymentsMap.size} confirmações da operadora carregadas.`);
        }
    } catch (e) {
        console.error('❌ Erro ao carregar sms_payments_db.json:', e.message);
    }
}

function salvarSmsPayments() {
    try {
        // Proteção de armazenamento: manter no máximo os últimos 5.000 SMS
        while (smsPaymentsMap.size > 5000) {
            const firstKey = smsPaymentsMap.keys().next().value;
            smsPaymentsMap.delete(firstKey);
        }
        const obj = {};
        for (const [id, val] of smsPaymentsMap.entries()) {
            obj[id] = val;
        }
        fs.writeFileSync(SMS_PAYMENTS_DB_PATH, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) {
        console.error('❌ Erro ao salvar sms_payments_db.json:', e.message);
    }
    // ── Backup Firebase: guarda o último SMS de pagamento recebido ──
    if (firestoreDbInstance) {
        const ultima = Array.from(smsPaymentsMap.entries()).pop();
        if (ultima) {
            const [txnId, dados] = ultima;
            firestoreDbInstance.collection('sms_payments').doc(txnId).set({
                ...dados,
                txn_id: txnId,
                processedAt: dados.processedAt || new Date().toISOString()
            }).catch(e => console.warn('⚠️ [FIREBASE] Erro ao salvar sms_payment:', e.message));
        }
    }
}

function carregarConfigs() {
    try {
        if (fs.existsSync(LOCAL_CONFIG_PATH)) {
            LOCAL_CFG = JSON.parse(fs.readFileSync(LOCAL_CONFIG_PATH, 'utf8'));
        }
    } catch (e) {
        console.warn('⚠️ [CONFIG] Erro ao carregar LOCAL_CONFIG:', e.message);
    }

    try {
        if (fs.existsSync(BOT_CONFIG_PATH)) {
            delete require.cache[require.resolve(BOT_CONFIG_PATH)];
            DYN_CFG = require(BOT_CONFIG_PATH);
        }
    } catch (e) {
        console.warn('⚠️ [CONFIG] Erro ao carregar BOT_CONFIG:', e.message);
    }

    if (!DYN_CFG.TABELAS) DYN_CFG.TABELAS = { '24hrs': {}, 'semanal': {}, 'mensal': {}, 'ilimitado': {}, 'saldo': {} };
    if (!DYN_CFG.PLANOS_ESPECIAIS) DYN_CFG.PLANOS_ESPECIAIS = {};
    if (!DYN_CFG.GRUPOS_FECHADOS) DYN_CFG.GRUPOS_FECHADOS = [];
    if (!DYN_CFG.TABELAS_GRUPO) DYN_CFG.TABELAS_GRUPO = {};
    if (DYN_CFG.CUSTO_GB_MT === undefined || DYN_CFG.CUSTO_GB_MT === null) DYN_CFG.CUSTO_GB_MT = 20;
    // Restaurar modo manutenção persistido
    if (DYN_CFG.MODO_MANUTENCAO !== undefined) modoManutencao = !!DYN_CFG.MODO_MANUTENCAO;
    
    carregarTransacoes();
    carregarSmsPayments();
    carregarAguardandoOperadora();
    limparDuplicatasTabelas();
}

carregarConfigs();

function salvarBotConfig() {
    try {
        const content = '// GERADO PELO SISTEMA KA-NET CLOUD\nmodule.exports = ' + JSON.stringify(DYN_CFG, null, 4) + ';\n';
        fs.writeFileSync(BOT_CONFIG_PATH, content, 'utf8');
    } catch (e) {
        console.error('❌ Erro ao salvar bot_config.js:', e.message);
    }
    // ✅ Persistência definitiva no Firestore (sem merge: true para refletir deleções e substituições completas)
    if (firestoreDbInstance) {
        firestoreDbInstance.collection('bot_settings').doc('pricing_tables').set(DYN_CFG)
            .then(() => console.log('☁️ [FIRESTORE] Tabelas salvas na nuvem com sucesso!'))
            .catch(e => console.warn('⚠️ [FIRESTORE] Erro ao salvar tabelas no Firestore:', e.message));
    }
}

function salvarLocalConfig() {
    try {
        fs.writeFileSync(LOCAL_CONFIG_PATH, JSON.stringify(LOCAL_CFG, null, 2), 'utf8');
    } catch (e) {
        console.error('❌ Erro ao salvar local_config.json:', e.message);
    }
    // ✅ Persistência definitiva no Firestore
    if (firestoreDbInstance) {
        firestoreDbInstance.collection('bot_settings').doc('local_config').set(LOCAL_CFG, { merge: true })
            .then(() => console.log('☁️ [FIRESTORE] Config local salva na nuvem com sucesso!'))
            .catch(e => console.warn('⚠️ [FIRESTORE] Erro ao salvar local_config no Firestore:', e.message));
    }
}

function limparDuplicatasTabelas() {
    let alterado = false;
    let totalRemovidos = 0;

    // Limpar chaves que não sejam grupos válidos (@g.us) de TABELAS_GRUPO
    if (DYN_CFG.TABELAS_GRUPO) {
        for (const k of Object.keys(DYN_CFG.TABELAS_GRUPO)) {
            if (!k.endsWith('@g.us')) {
                console.log(`🧹 [TABELAS_GRUPO] Removendo chave não-grupo inválida: ${k}`);
                delete DYN_CFG.TABELAS_GRUPO[k];
                alterado = true;
            }
        }
    }

    const alvos = [];
    if (DYN_CFG.TABELAS) alvos.push(DYN_CFG.TABELAS);
    if (DYN_CFG.TABELAS_GRUPO) {
        for (const grp of Object.values(DYN_CFG.TABELAS_GRUPO)) {
            if (grp && grp.TABELAS) alvos.push(grp.TABELAS);
            else if (grp) alvos.push(grp);
        }
    }

    for (const tabelas of alvos) {
        for (const tipo of ['24hrs', 'semanal', 'mensal', 'ilimitado']) {
            const tab = tabelas[tipo];
            if (!tab || typeof tab !== 'object') continue;
            const byVolume = {};
            for (const [precoStr, pkg] of Object.entries(tab)) {
                const mb = pkg.quantidade_mb || pkg.quantidade || 0;
                if (!mb) continue;
                if (!byVolume[mb]) byVolume[mb] = [];
                byVolume[mb].push({ preco: Number(precoStr), precoStr });
            }
            for (const [mb, entries] of Object.entries(byVolume)) {
                if (entries.length > 1) {
                    entries.sort((a, b) => a.preco - b.preco);
                    // Manter o menor preço (mais vantajoso para o cliente) e remover duplicatas
                    for (let i = 1; i < entries.length; i++) {
                        delete tab[entries[i].precoStr];
                        alterado = true;
                        totalRemovidos++;
                    }
                }
            }
        }
    }
    if (totalRemovidos > 0) {
        console.log(`🧹 [DEDUP TABELAS] ${totalRemovidos} entradas duplicadas removidas com sucesso.`);
    }
    return alterado;
}

function getMasterNumbers() {
    const list = new Set(['850401416', '856116039', '856268811']);
    if (LOCAL_CFG.master_number) {
        String(LOCAL_CFG.master_number).split(/[,;]/).forEach(n => list.add(n.trim().replace(/\D/g, '')));
    }
    if (DYN_CFG.MASTER_NUMBERS && Array.isArray(DYN_CFG.MASTER_NUMBERS)) {
        DYN_CFG.MASTER_NUMBERS.forEach(n => list.add(String(n).replace(/\D/g, '')));
    }
    // Integrar números master cadastrados pelos licenciados no Portal de Licenciamento
    try {
        const { getAllLicenses } = require('./licensing/license_manager');
        const activeLicenses = getAllLicenses().filter(l => l.status === 'active');
        for (const lic of activeLicenses) {
            if (Array.isArray(lic.masterNumbers)) {
                for (const m of lic.masterNumbers) {
                    if (m && m.number) {
                        list.add(String(m.number).replace(/\D/g, ''));
                    }
                }
            }
        }
    } catch (_) {}
    return Array.from(list);
}

function isMaster(numero) {
    if (!numero) return false;
    const clean = String(numero).replace(/\D/g, '');
    const clean9 = (clean.startsWith('258') && clean.length >= 11) ? clean.substring(3) : clean;

    // Números estritos do Criador / Kelven e LID autorizado do WhatsApp
    if (clean.includes('850401416') || clean.includes('856116039') || clean.includes('856268811') ||
        clean9.includes('850401416') || clean9.includes('856116039') || clean9.includes('856268811') ||
        clean.includes('216054655656152')) { // LID verificado do Kelven
        return true;
    }

    // Verificar lista dinâmica de LIDs autorizados
    if (DYN_CFG.MASTER_LIDS && Array.isArray(DYN_CFG.MASTER_LIDS)) {
        if (DYN_CFG.MASTER_LIDS.some(l => clean.includes(String(l).replace(/\D/g, '')))) return true;
    }

    const masters = getMasterNumbers();
    return masters.some(m => {
        const mClean = String(m).replace(/\D/g, '');
        const mClean9 = (mClean.startsWith('258') && mClean.length >= 11) ? mClean.substring(3) : mClean;
        return clean.includes(mClean9) || clean9.includes(mClean9) || mClean.includes(clean9);
    });
}

function getPaymentDetails() {
    return {
        mpesa_num: LOCAL_CFG.mpesa_number || DYN_CFG.MPESA_NUMBER || '856268811',
        mpesa_name: LOCAL_CFG.mpesa_name || DYN_CFG.MPESA_NAME || 'Kelven Junior Anabela Nharrava',
        emola_num: LOCAL_CFG.emola_number || DYN_CFG.EMOLA_NUMBER || '864882152',
        emola_name: LOCAL_CFG.emola_name || DYN_CFG.EMOLA_NAME || 'Catia Anabela Nharrava'
    };
}

function getSuporteDetails() {
    let supportNum = '850401416';
    if (LOCAL_CFG.support_number) {
        supportNum = String(LOCAL_CFG.support_number).split(',')[0].trim();
    } else if (DYN_CFG.support_number || DYN_CFG.SUPPORT_NUMBER) {
        supportNum = String(DYN_CFG.support_number || DYN_CFG.SUPPORT_NUMBER).split(',')[0].trim();
    } else if (LOCAL_CFG.master_number) {
        supportNum = String(LOCAL_CFG.master_number).split(',')[0].trim();
    } else if (DYN_CFG.master_number || DYN_CFG.admin_number) {
        supportNum = String(DYN_CFG.master_number || DYN_CFG.admin_number).split(',')[0].trim();
    }
    const sysName = LOCAL_CFG.nome_sistema || DYN_CFG.NOME_SISTEMA || 'Ka-Net System';
    return { supportNum, sysName };
}

function getSaudacaoHora() {
    const hora = new Date().getUTCHours() + 2; // Maputo GMT+2
    const h = (hora >= 24) ? hora - 24 : hora;
    if (h >= 5 && h < 12) return 'Bom dia';
    if (h >= 12 && h < 18) return 'Boa tarde';
    return 'Boa noite';
}

function getGrupoNotificacoes() {
    return LOCAL_CFG.grupo_notificacoes || DYN_CFG.GRUPO_NOTIFICACOES || '120363409903708446@g.us';
}

function getGrupoErros() {
    return LOCAL_CFG.grupo_erros || DYN_CFG.GRUPO_ERROS || '120363408450329444@g.us';
}

async function enviarNotificacaoGrupo(texto) {
    try {
        const jid = getGrupoNotificacoes();
        if (sock && connectionStatus === 'connected' && jid) {
            await sock.sendMessage(jid, { text: texto });
            console.log(`🔔 [GRUPO NOTIFICAÇÕES] Mensagem enviada para ${jid}`);
            return true;
        }
    } catch (e) {
        console.warn(`⚠️ [GRUPO NOTIFICAÇÕES ERRO]: ${e.message}`);
    }
    return false;
}

async function enviarErroGrupo(texto) {
    try {
        const jid = getGrupoErros();
        if (sock && connectionStatus === 'connected' && jid) {
            await sock.sendMessage(jid, { text: texto });
            console.log(`🚨 [GRUPO ERROS] Mensagem enviada para ${jid}`);
            return true;
        }
    } catch (e) {
        console.warn(`⚠️ [GRUPO ERROS ERRO]: ${e.message}`);
    }
    return false;
}

// ══════════════════════════════════════════════════
// MOTOR DE CONCILIAÇÃO INTELIGENTE (RECONCILIATION ENGINE)
// ══════════════════════════════════════════════════
function cleanTx(s) {
    return String(s || '').trim().toUpperCase();
}

function normalizeTx(s) {
    return cleanTx(s).replace(/[^A-Z0-9]/g, '');
}

/**
 * Compara dois IDs de transação de forma robusta e inteligente (suporta com/sem pontos, prefixos e sufixos)
 */
function matchTxnId(a, b) {
    if (!a || !b) return false;
    const ca = cleanTx(a);
    const cb = cleanTx(b);
    if (ca === cb) return true;

    const na = normalizeTx(ca);
    const nb = normalizeTx(cb);
    if (na === nb) return true;

    // Se ambos são códigos padrão PP (M-Pesa / e-Mola)
    if (na.startsWith('PP') && nb.startsWith('PP')) {
        // Se ambos têm pelo menos 12 caracteres e um contém o outro
        if (Math.min(na.length, nb.length) >= 12 && (na.includes(nb) || nb.includes(na))) {
            return true;
        }
        // Se ambos têm a mesma data (primeiro bloco) e o mesmo sufixo final único (ex: B03818)
        const partsA = ca.split('.');
        const partsB = cb.split('.');
        if (partsA.length === 3 && partsB.length === 3) {
            if (partsA[0] === partsB[0] && partsA[2] === partsB[2]) return true;
        }
    } else {
        // Códigos alfanuméricos padrão (ex: DHJ4L92EBZW)
        const minL = Math.min(na.length, nb.length);
        if (minL >= 8 && (na.includes(nb) || nb.includes(na))) return true;
    }
    return false;
}

let externalPaymentFinder = null;
function setPaymentFinder(finder) {
    externalPaymentFinder = finder;
}

function findSmsPayment(txnId) {
    if (!txnId) return null;
    const cleanId = cleanTx(txnId);
    if (smsPaymentsMap.has(cleanId)) {
        return smsPaymentsMap.get(cleanId);
    }
    for (const [k, p] of smsPaymentsMap.entries()) {
        if (matchTxnId(k, cleanId) || matchTxnId(p.txn_id, cleanId)) {
            return p;
        }
    }
    return null;
}

function findItemAguardandoOperadora(incomingTxnId) {
    if (!incomingTxnId) return null;
    const cleanId = cleanTx(incomingTxnId);
    if (aguardandoOperadora.has(cleanId)) {
        return { key: cleanId, item: aguardandoOperadora.get(cleanId) };
    }
    for (const [k, item] of aguardandoOperadora.entries()) {
        if (matchTxnId(k, cleanId) || matchTxnId(item.txn_id, cleanId)) {
            return { key: k, item };
        }
    }
    return null;
}

function findPendingPayment(jid, senderNumber, rawLidClean) {
    const directKey = `${jid}:${senderNumber}`;
    if (pendingPayments.has(directKey)) {
        return { key: directKey, pay: pendingPayments.get(directKey) };
    }
    if (pendingPayments.has(jid)) {
        return { key: jid, pay: pendingPayments.get(jid) };
    }
    for (const [key, pay] of pendingPayments.entries()) {
        if (pay.jid === jid) {
            if (pay.senderNumber === senderNumber || (rawLidClean && pay.rawLidClean === rawLidClean)) {
                return { key, pay };
            }
        }
    }
    return null;
}

function salvarAguardandoOperadora() {
    try {
        const obj = {};
        const now = Date.now();
        for (const [id, val] of aguardandoOperadora.entries()) {
            const { timer, ...rest } = val;
            if (now - (val.timestamp || 0) < 600_000) {
                obj[id] = rest;
            }
        }
        fs.writeFileSync(AGUARDANDO_OPERADORA_DB_PATH, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) {
        console.warn('⚠️ [CACHE] Erro ao salvar aguardando_operadora_db.json:', e.message);
    }
}

function expirarItemAguardandoOperadora(txn_id) {
    try {
        if (aguardandoOperadora.has(txn_id)) {
            const item = aguardandoOperadora.get(txn_id);
            aguardandoOperadora.delete(txn_id);
            salvarAguardandoOperadora();
            console.log(`⏱️ [TIMER 10 MIN] Transação ${txn_id} não confirmada pela operadora em 10min. Notificando grupo.`);
            const origemMsg = (item.jid && item.jid.endsWith('@g.us')) ? 'Grupo WhatsApp' : 'Privado';
            enviarNotificacaoGrupo(
                `⏰ *COMPROVATIVO NÃO RECEBIDO DA OPERADORA (10 MIN)*\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `🔖 *Ref:* \`${txn_id}\`\n` +
                `💳 *Valor:* *${item.valor} MT* (${item.metodoNome || 'M-Pesa/e-Mola'})\n` +
                `👤 *Cliente:* *${item.nomeCliente || 'Cliente'}* (${item.senderNumber || 'N/D'})\n` +
                `🏢 *Origem:* *${origemMsg}*\n` +
                `⏳ *Status:* Tempo limite de 10 min atingido sem confirmação por SMS da operadora.`
            );
        }
    } catch (err) {
        console.error('❌ Erro no timer de 10 minutos do comprovativo:', err);
    }
}

function carregarAguardandoOperadora() {
    try {
        if (fs.existsSync(AGUARDANDO_OPERADORA_DB_PATH)) {
            const data = JSON.parse(fs.readFileSync(AGUARDANDO_OPERADORA_DB_PATH, 'utf8'));
            const now = Date.now();
            for (const [id, val] of Object.entries(data)) {
                const elapsed = now - (val.timestamp || now);
                if (elapsed < 600_000) {
                    const remaining = 600_000 - elapsed;
                    const item = { ...val, timer: null };
                    item.timer = setTimeout(() => {
                        expirarItemAguardandoOperadora(id);
                    }, remaining);
                    aguardandoOperadora.set(id, item);
                }
            }
            if (aguardandoOperadora.size > 0) {
                console.log(`⏳ [CACHE] ${aguardandoOperadora.size} comprovativos aguardando operadora restaurados com sucesso.`);
            }
        }
    } catch (e) {
        console.warn('⚠️ [CACHE] Erro ao carregar aguardando_operadora_db.json:', e.message);
    }
}

// ══════════════════════════════════════════════════
// GERADOR DINÂMICO DE TABELA (DESIGN PREMIUM E ELEGANTE)
// ══════════════════════════════════════════════════
function _fmtSize(mb) {
    if (mb >= 1024) {
        const gb = mb / 1024;
        return (gb % 1 === 0 ? gb.toFixed(0) : gb.toFixed(1)) + 'GB';
    }
    return mb + 'MB';
}

const DEFAULT_PLANOS_ESPECIAIS = {
    "76":  { nome: "♻️ 3GB+700 (Renovação)",   tipo: "renovavel",      total: 3772,  inicial: 3072, diaria: 100  },
    "120": { nome: "♻️ 5GB+700 (Renovação)",   tipo: "renovavel",      total: 5820,  inicial: 5120, diaria: 100  },
    "130": { nome: "📉 5GB Faseado (1GB/dia)",  tipo: "faseado",        total: 5120,  inicial: 1024, diaria: 1024 },
    "195": { nome: "♻️ 8GB+700 (Renovação)",   tipo: "renovavel",      total: 8892,  inicial: 8192, diaria: 100  },
    "240": { nome: "♻️ 10GB+700 (Renovação)",  tipo: "renovavel",      total: 10940, inicial: 10240, diaria: 100 },
    "255": { nome: "📉 10GB Faseado (1GB/dia)", tipo: "faseado",        total: 10240, inicial: 1024, diaria: 1024 },
    "381": { nome: "📉 15GB Faseado (1GB/dia)", tipo: "faseado",        total: 15360, inicial: 1024, diaria: 1024 },
    "510": { nome: "📉 20GB Faseado (1GB/dia)", tipo: "faseado",        total: 20480, inicial: 1024, diaria: 1024 },
    "232": { nome: "📆 10GB Faseado Mensal",    tipo: "faseado_mensal", total: 10240, inicial: 1024, diaria: 1024 },
    "461": { nome: "📆 20GB Faseado Mensal",    tipo: "faseado_mensal", total: 20480, inicial: 1024, diaria: 1024 },
    "700": { nome: "📆 30GB Faseado Mensal",    tipo: "faseado_mensal", total: 30720, inicial: 1024, diaria: 1024 }
};


// ══════════════════════════════════════════════════
// GUIA OFICIAL E INFORMAÇÕES DE TXENECO (CRÉDITO)
// ══════════════════════════════════════════════════
function gerarInfoTxenecoCompleta(senderNumber) {
    const totalCompras = customerServices.getComprasCount(senderNumber);
    const tetoMb = customerServices.calcularTetoTxeneco(totalCompras);
    const divida = customerServices.getClienteDivida(senderNumber);
    const divMb = divida ? (divida.activeDebtMb || 0) : 0;
    const dispMb = Math.max(0, tetoMb - divMb);
    const dispF = dispMb >= 1024 ? `${(dispMb / 1024).toFixed(0)}GB` : `${dispMb}MB`;
    const tetoF = tetoMb >= 1024 ? `${(tetoMb / 1024).toFixed(0)}GB` : `${tetoMb}MB`;
    const divF = divMb >= 1024 ? `${(divMb / 1024).toFixed(0)}GB` : `${divMb}MB`;

    let statusBox = '';
    if (totalCompras < 100) {
        const faltam = 100 - totalCompras;
        statusBox = `📊 *O SEU STATUS DE FIDELIDADE:*\n` +
                    `• Compras realizadas: *${totalCompras}*\n` +
                    `• Status: *Em Progresso* ⏳\n` +
                    `🎯 *Faltam apenas ${faltam} compras* para desbloquear o seu crédito de até *3 GB*!\n` +
                    `_Continue a comprar recargas na Ka-Net para liberar o benefício._\n`;
    } else if (totalCompras < 200) {
        const faltam = 200 - totalCompras;
        statusBox = `📊 *O SEU STATUS VIP DE CRÉDITO:*\n` +
                    `• Nível: *Bronze 🥉* (100+ compras)\n` +
                    `• Compras realizadas: *${totalCompras}*\n` +
                    `• Teto total de crédito: *3 GB* (${tetoF})\n` +
                    `• Limite disponível agora: *${dispF}*\n` +
                    `🆙 _Faltam ${faltam} compras para subir para 5 GB!_\n` +
                    (divida && divida.restanteMt > 0
                        ? `• Txeneco ativo: *${divF}* | Dívida pendente: *${divida.restanteMt} MT*\n`
                        : `• Situação atual: *Sem dívidas (Crédito 100% Livre!)* ✅\n`);
    } else if (totalCompras < 800) {
        const faltam = 800 - totalCompras;
        statusBox = `📊 *O SEU STATUS VIP DE CRÉDITO:*\n` +
                    `• Nível: *Prata 🥈* (200+ compras)\n` +
                    `• Compras realizadas: *${totalCompras}*\n` +
                    `• Teto total de crédito: *5 GB* (${tetoF})\n` +
                    `• Limite disponível agora: *${dispF}*\n` +
                    `👑 _Faltam ${faltam} compras para o Nível Ouro (até 10 GB)!_\n` +
                    (divida && divida.restanteMt > 0
                        ? `• Txeneco ativo: *${divF}* | Dívida pendente: *${divida.restanteMt} MT*\n`
                        : `• Situação atual: *Sem dívidas (Crédito 100% Livre!)* ✅\n`);
    } else {
        statusBox = `📊 *O SEU STATUS VIP DE CRÉDITO:*\n` +
                    `• Nível: *Ouro VIP 👑* (800+ compras)\n` +
                    `• Compras realizadas: *${totalCompras}*\n` +
                    `• Teto total de crédito: *10 GB* (Escolha livre até 10 GB!)\n` +
                    `• Limite disponível agora: *${dispF}*\n` +
                    (divida && divida.restanteMt > 0
                        ? `• Txeneco ativo: *${divF}* | Dívida pendente: *${divida.restanteMt} MT*\n`
                        : `• Situação atual: *Sem dívidas (Crédito VIP Livre!)* ✅\n`);
    }

    const { mpesa_num, mpesa_name, emola_num, emola_name } = getPaymentDetails();

    return `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n` +
           `  ⚡ *GUIA OFICIAL: TXENECO KA-NET* 📶\n` +
           `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
           `O *Txeneco* é o serviço exclusivo de *Internet a Crédito* da Ka-Net: você recebe os seus Megabytes adiantados no celular e paga depois! 🚀\n\n` +
           statusBox + `\n` +
           `━━━━━━━━━━━━━━━━━━\n` +
           `📋 *COMO FUNCIONA? (NOVOS LIMITES)*\n` +
           `1️⃣ *Escalões de Fidelidade:*
` +
           `   🥉 *A partir de 100 compras:* até *3 GB* no máximo\n` +
           `   🥈 *A partir de 200 compras:* até *5 GB* no máximo\n` +
           `   👑 *A partir de 800 compras:* Você escolhe a quantidade até *10 GB*!\n\n` +
           `2️⃣ *Faixa por pedido:*
` +
           `   Solicite a partir de *350 MB* até o teto do seu nível (3GB, 5GB ou 10GB).\n\n` +
           `3️⃣ *Qual é a taxa?*
` +
           `   Apenas *10% de taxa de serviço* sobre o valor do pacote!\n` +
           `   💡 _Exemplo transparente:_\n` +
           `   1 GB diário custa 23 MT ➔ taxa 10% = 3 MT ➔ *Total a reembolsar: 26 MT*.\n` +
           `   _Sem juros diários ou taxas abusivas!_\n\n` +
           `4️⃣ *Quando pagar?*
` +
           `   • Pague assim que recarregar o celular ou puder transferir.\n` +
           `   • ⚠️ _Regra:_ Enquanto tiver uma dívida pendente, não pode pedir novo crédito.\n` +
           `   • Pagou, o seu teto é liberado e restaurado automaticamente!\n\n` +
           `5️⃣ *Como pagar a dívida?*
` +
           `   Transfira para as nossas contas oficiais:\n` +
           `   🔴 *M-Pesa:* \`${mpesa_num}\` (${mpesa_name})\n` +
           `   🟡 *e-Mola:* \`${emola_num}\` (${emola_name})\n` +
           `   E envie aqui no WhatsApp:\n` +
           `   👉 *.pagar <comprovativo>\n\n` +
           `━━━━━━━━━━━━━━━━━━\n` +
           `📲 *COMANDOS RÁPIDOS:*\n` +
           `🔹 *.txenecar* ➔ Consultar seu nível e regras\n` +
           `🔹 *.txenecar <quantidade> <número>* ➔ Pedir crédito\n` +
           `   _Exemplos: .txenecar 1gb 841234567 | .txenecar 3gb 841234567_\n` +
           `🔹 *.pagar* ➔ Ver sua dívida atual\n` +
           `🔹 *.pagar <comprovativo>* ➔ Quitar e restaurar crédito\n` +
           `━━━━━━━━━━━━━━━━━━`;
}

// ══════════════════════════════════════════════════
// GUIA OFICIAL: CONFIGURAR NÚMERO / RECEPTOR PADRÃO
// ══════════════════════════════════════════════════
function gerarGuiaConfigurarNumero(senderNumber) {
    const lista = customerServices.obterReceptoresPorOwner(senderNumber);
    let statusBox = '';

    if (lista && lista.length > 0) {
        const receptorFixo = lista[0].targetPhone;
        const linhasPagadores = lista.map((r, i) => `   ${i + 1}. *${r.payerPhone}*`).join('\n');
        statusBox = `╭─────────────────────────────╮\n` +
                    `  📱 *SEU NÚMERO ATUALMENTE CONFIGURADO:*\n` +
                    `  🎯 *Destino Fixo:* *${receptorFixo}*\n` +
                    `  💳 *Carteiras Vinculadas:*\n${linhasPagadores}\n` +
                    `  ⚡ *Status:* Ativo e Pronto (100% Automático) ✅\n` +
                    `╰─────────────────────────────╯\n\n` +
                    `💡 _Sempre que pagar por essas contas, os Megas caem direto em *${receptorFixo}* sem você precisar enviar comprovativo!_\n`;
    } else {
        statusBox = `╭─────────────────────────────╮\n` +
                    `  📱 *STATUS:* Nenhum número configurado ainda ⏳\n` +
                    `  Configure abaixo para ativar a recarga automática!\n` +
                    `╰─────────────────────────────╯\n\n`;
    }

    return `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n` +
           `  ⚡ *CONFIGURAR NÚMERO FIXO* 📶\n` +
           `  _(Recarga Automática Sem Comprovativo)_\n` +
           `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
           `Cansado de ter que enviar o SMS de comprovativo toda vez que compra internet? 🤯\n` +
           `Com o *Receptor Padrão Ka-Net*, o sistema vincula o seu M-Pesa / e-Mola ao seu número Vodacom!\n\n` +
           statusBox +
           `━━━━━━━━━━━━━━━━━━\n` +
           `🚀 *COMO FUNCIONA?\n` +
           `1️⃣ Você configura o seu número uma única vez aqui no WhatsApp.\n` +
           `2️⃣ Quando fizer um pagamento no *M-Pesa* ou *e-Mola*, o nosso sistema identifica a transferência na hora.\n` +
           `3️⃣ Os Megabytes correspondentes ao valor pago são recarregados *imediatamente* no seu celular, *sem precisar abrir o WhatsApp nem colar comprovativo*! ⚡\n\n` +
           `━━━━━━━━━━━━━━━━━━\n` +
           `🛠️ *COMO CONFIGURAR (PASSO A PASSO):\n\n` +
           `🔹 *Caso 1: Você paga com o mesmo número deste WhatsApp:*\n` +
           `   Basta enviar o número Vodacom que deve receber os Megas:\n` +
           `   👉 *.configurar 84XXXXXXX*\n\n` +
           `🔹 *Caso 2: Voce paga por outra carteira (M-Pesa ou e-Mola):*\n` +
           `   Formato: *.configurar <numero_pagador> <numero_receptor>*\n` +
           `   O *ULTIMO numero* e sempre o receptor que recebe os Megas:\n` +
           `   👉 *.configurar 851234567 849998888*\n` +
           `   _Paga pelo 851234567, recebe no 849998888_\n\n` +
           `🔹 *Caso 3: Tem 2 ou mais carteiras pagadoras:*\n` +
           `   Os primeiros sao pagadores, o ULTIMO e o receptor:\n` +
           `   👉 *.configurar 856268811 840401416 840401414*\n` +
           `   👉 *.configurar 856268811 840401416 para 840401414*\n` +
           `   _Pagadores: 856268811 e 840401416 | Receptor: 840401414_\n\n` +
           `🔹 *Caso especial: o numero pagador e o mesmo que recebe:*\n` +
           `   Repita o numero duas vezes (pagador e receptor ao mesmo tempo):\n` +
           `   👉 *.configurar 856268811 840401416 para 840401416*\n` +
           `   _Pagadores: 856268811 e 840401416 | Receptor: 840401416_\n\n` +
           `━━━━━━━━━━━━━━━━━━\n` +
           `📋 *COMANDOS ÚTEIS:\n` +
           `▫️ *.configurar* ➔ Ver este guia e o seu status actual\n` +
           `▫️ *.meunumero* ➔ Consultar o número receptor cadastrado\n` +
           `▫️ *.desconfigurar* ➔ Desativar o envio automático\n` +
           `━━━━━━━━━━━━━━━━━━`;
}

function gerarMenuOriginal(jid = null) {
    const { supportNum, sysName } = getSuporteDetails();
    
    // Se a mensagem veio de um grupo e esse grupo tiver uma tabela customizada, exibi-la
    let _tabelas = DYN_CFG.TABELAS || {};
    let _especiais = (DYN_CFG.PLANOS_ESPECIAIS && Object.keys(DYN_CFG.PLANOS_ESPECIAIS).length > 0)
        ? { ...DEFAULT_PLANOS_ESPECIAIS, ...DYN_CFG.PLANOS_ESPECIAIS }
        : DEFAULT_PLANOS_ESPECIAIS;

    if (jid && String(jid).endsWith('@g.us') && DYN_CFG.TABELAS_GRUPO && DYN_CFG.TABELAS_GRUPO[jid]) {
        const grpCfg = DYN_CFG.TABELAS_GRUPO[jid];
        if (grpCfg.TABELAS) _tabelas = grpCfg.TABELAS;
        else _tabelas = grpCfg;
    }

    const { mpesa_num, mpesa_name, emola_num, emola_name } = getPaymentDetails();

    let out = '';
    out += `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n`;
    out += `  ✨ *${sysName.toUpperCase()} • PACOTES DE INTERNET* ✨\n`;
    out += `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n`;

    // DIÁRIOS (24H)
    if (_tabelas['24hrs'] && Object.keys(_tabelas['24hrs']).length > 0) {
        out += `⚡ *PACOTES DIÁRIOS (24H)*\n`;
        out += `╭─────────────────────────────╮\n`;
        const bestByVol = new Map();
        for (const [pStr, pkg] of Object.entries(_tabelas['24hrs'])) {
            const preco = Number(pStr);
            const mb = pkg.quantidade_mb || pkg.quantidade || 0;
            if (!mb) continue;
            if (!bestByVol.has(mb) || preco < bestByVol.get(mb).preco) {
                bestByVol.set(mb, { preco, pkg });
            }
        }
        const sorted = Array.from(bestByVol.entries()).sort((a, b) => a[0] - b[0]);
        for (const [mb, item] of sorted) {
            out += `│ 🔹 *${_fmtSize(mb).padEnd(6)}* ➔ *${item.preco} MT*\n`;
        }
        out += `╰─────────────────────────────╯\n\n`;
    }

    // SEMANAIS (7 DIAS)
    if (_tabelas['semanal'] && Object.keys(_tabelas['semanal']).length > 0) {
        out += `📅 *PACOTES SEMANAIS (7 DIAS)*\n`;
        out += `╭─────────────────────────────╮\n`;
        const bestByVol = new Map();
        for (const [pStr, pkg] of Object.entries(_tabelas['semanal'])) {
            const preco = Number(pStr);
            const mb = pkg.quantidade_mb || pkg.quantidade || 0;
            if (!mb) continue;
            if (!bestByVol.has(mb) || preco < bestByVol.get(mb).preco) {
                bestByVol.set(mb, { preco, pkg });
            }
        }
        const sorted = Array.from(bestByVol.entries()).sort((a, b) => a[0] - b[0]);
        for (const [mb, item] of sorted) {
            out += `│ 🔹 *${_fmtSize(mb).padEnd(6)}* ➔ *${item.preco} MT*\n`;
        }
        out += `╰─────────────────────────────╯\n\n`;
    }

    // MENSAIS (30 DIAS)
    if (_tabelas['mensal'] && Object.keys(_tabelas['mensal']).length > 0) {
        out += `🗓️ *PACOTES MENSAIS (30 DIAS)*\n`;
        out += `╭─────────────────────────────╮\n`;
        const bestByVol = new Map();
        for (const [pStr, pkg] of Object.entries(_tabelas['mensal'])) {
            const preco = Number(pStr);
            const mb = pkg.quantidade_mb || pkg.quantidade || 0;
            if (!mb) continue;
            if (!bestByVol.has(mb) || preco < bestByVol.get(mb).preco) {
                bestByVol.set(mb, { preco, pkg });
            }
        }
        const sorted = Array.from(bestByVol.entries()).sort((a, b) => a[0] - b[0]);
        for (const [mb, item] of sorted) {
            out += `│ 🔹 *${_fmtSize(mb).padEnd(6)}* ➔ *${item.preco} MT*\n`;
        }
        out += `╰─────────────────────────────╯\n\n`;
    }

    // PLANOS ESPECIAIS — separar renovavel/faseado de faseado_mensal
    const especiaisVip    = Object.entries(_especiais).filter(([, v]) => v.tipo !== 'faseado_mensal');
    const especiaisMensal = Object.entries(_especiais).filter(([, v]) => v.tipo === 'faseado_mensal');

    if (especiaisVip.length > 0) {
        out += `🚀 *PLANOS ESPECIAIS VIP*\n`;
        out += `╭─────────────────────────────╮\n`;
        especiaisVip.sort((a, b) => Number(a[0]) - Number(b[0]));
        for (const [preco, info] of especiaisVip) {
            out += `│ 💎 *${info.nome}* ➔ *${preco} MT*\n`;
        }
        out += `╰─────────────────────────────╯\n\n`;
    }

    if (especiaisMensal.length > 0) {
        out += `📆 *FASEADO MENSAL INTERATIVO*\n`;
        out += `╭─────────────────────────────╮\n`;
        especiaisMensal.sort((a, b) => Number(a[0]) - Number(b[0]));
        for (const [preco, info] of especiaisMensal) {
            const gbTotal = Math.round(info.total / 1024);
            out += `│ 🗓️ *${gbTotal}GB* ➔ *${preco} MT*\n`;
        }
        out += `│\n`;
        out += `│ ✅ Você define quantos GB\n`;
        out += `│    quer receber por dia.\n`;
        out += `│ 📲 Confirme por WhatsApp,\n`;
        out += `│    SMS ou Ka-Net Hub.\n`;
        out += `╰─────────────────────────────╯\n\n`;
    }

    // ILIMITADOS
    const ilimitados = _tabelas['ilimitado'] || {};
    if (Object.keys(ilimitados).length > 0) {
        const voda = [];
        const movi = [];
        for (const [p, info] of Object.entries(ilimitados)) {
            if (info.nome && info.nome.includes('Movi')) movi.push([p, info]);
            else voda.push([p, info]);
        }
        voda.sort((a, b) => Number(a[0]) - Number(b[0]));
        movi.sort((a, b) => Number(a[0]) - Number(b[0]));

        if (voda.length > 0 || movi.length > 0) {
            out += `🌐 *ILIMITADOS (30 DIAS + LIGAÇÕES)*\n`;
            out += `╭─────────────────────────────╮\n`;
            for (const [p, info] of voda) {
                const mb = info.ativacao_mb || info.quantidade_mb || info.quantidade || 0;
                out += `│ 🔴 *Voda ${Math.round(mb/1024)}GB + Min* ➔ *${p} MT*\n`;
            }
            for (const [p, info] of movi) {
                const mb = info.ativacao_mb || info.quantidade_mb || info.quantidade || 0;
                out += `│ 🟢 *Movi ${Math.round(mb/1024)}GB + Min* ➔ *${p} MT*\n`;
            }
            out += `╰─────────────────────────────╯\n\n`;
        }
    }

    out += `💳 *FORMAS DE PAGAMENTO:*\n`;
    out += `▫️ *M-Pesa:* \`${mpesa_num}\` (${mpesa_name})\n`;
    out += `▫️ *e-Mola:* \`${emola_num}\` (${emola_name})\n\n`;

    out += `⚡ *COMO ATIVAR AUTOMATICAMENTE:*\n`;
    out += `1️⃣ Pague o valor do pacote desejado.\n`;
    out += `2️⃣ Envie o comprovativo aqui.\n`;
    out += `3️⃣ Coloque o *número de destino na última linha*.\n\n`;

    out += `📞 *Precisa de ajuda ou suporte?*\n`;
    out += `Envie *Suporte* ou ligue para: *${supportNum}*\n`;
    out += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

    return out;
}

function gerarMensagemBoasVindas(nomeCliente, senderNumber = null) {
    const sd = getSaudacaoHora();
    const { supportNum, sysName } = getSuporteDetails();
    const compras = (senderNumber && customerServices && typeof customerServices.getComprasCount === 'function')
        ? customerServices.getComprasCount(senderNumber)
        : 0;
    const ehNovo = compras === 0;

    if (ehNovo) {
        return (
            `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n` +
            `  🎉 *BEM-VINDO(A) À ${sysName.toUpperCase()}!* 🇲🇿\n` +
            `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
            `Olá, *${nomeCliente}*! ${sd}! ✨\n` +
            `Somos a sua plataforma de internet rápida, económica e com ativação automática 24 horas por dia! 🚀\n\n` +
            `📌 *COMO DESEJA COMEÇAR?\n\n` +
            `1️⃣ *Menu* ➔ Ver Pacotes e Preços (Diários, Semanais e Mensais)\n` +
            `2️⃣ *Pagamento* ➔ Ver Contas M-Pesa e e-Mola\n` +
            `3️⃣ *Estudante* ➔ Tabela com Descontos Escolares\n` +
            `4️⃣ *Fidelidade* ➔ Ganhe Megas Indicando Amigos 🏆\n` +
            `5️⃣ *Suporte* ➔ Falar com Atendimento Humano 📞\n` +
            `6️⃣ *Txeneco* ➔ Internet a Crédito (Regras, Taxa e Limites) 💸\n` +
            `7️⃣ *Configurar Número* ➔ Recargas Automáticas sem Comprovativo ⚡\n\n` +
            `👉 _Basta responder com o número da opção desejada (ex: *1*, *2* ou *7*)\n\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `⚡ *COMO COMPRAR PELA PRIMEIRA VEZ (3 PASSOS):\n` +
            `1️⃣ Digite *1* para escolher o seu pacote.\n` +
            `2️⃣ Transfira o valor para a nossa conta M-Pesa ou e-Mola (opção *2*).\n` +
            `3️⃣ Cole o SMS do comprovativo aqui com o seu número Vodacom na última linha!\n` +
            `━━━━━━━━━━━━━━━━━━`
        );
    }

    return (
        `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n` +
        `  👋 *${sd.toUpperCase()}, ${nomeCliente.toUpperCase()}!* ✨\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
        `Que bom ter você de volta à *${sysName}*! 🇲🇿\n` +
        `📊 *Seu Histórico:* ${compras} compra(s) realizada(s)\n\n` +
        `📌 *COMO POSSO AJUDAR HOJE?\n\n` +
        `1️⃣ *Menu* ➔ Ver Pacotes e Preços\n` +
        `2️⃣ *Pagamento* ➔ Ver Contas M-Pesa e e-Mola\n` +
        `3️⃣ *Estudante* ➔ Tabela com Descontos Escolares\n` +
        `4️⃣ *Fidelidade* ➔ Ganhe Megas Indicando Amigos 🏆\n` +
        `5️⃣ *Suporte* ➔ Falar com Atendimento Humano 📞\n` +
        `6️⃣ *Txeneco* ➔ Internet a Crédito (Regras, Taxa e Limites) 💸\n` +
        `7️⃣ *Configurar Número* ➔ Recargas Automáticas sem Comprovativo ⚡\n\n` +
        `👉 _Responda com o número da opção (ex: *1*, *6* ou *7*)\n\n` +
        `⚡ *COMPRA RÁPIDA:\n` +
        `Já fez o pagamento? Envie o comprovativo com o seu número Vodacom para ativar em segundos!\n` +
        `━━━━━━━━━━━━━━━━━━`
    );
}

function gerarMensagemBoasVindasGrupo(groupName, participantJids) {
    const { mpesa_num, mpesa_name, emola_num, emola_name } = getPaymentDetails();
    const { supportNum, sysName } = getSuporteDetails();
    const mentions = Array.isArray(participantJids) ? participantJids : [participantJids];

    // Normalizar mentions para garantir JID completo válido no WhatsApp
    const finalMentions = mentions.map(j => {
        const str = String(j || '');
        if (str.includes('@')) return str;
        return `${str.replace(/\D/g, '')}@s.whatsapp.net`;
    }).filter(j => j.length > 5);

    const mentionsText = finalMentions.map(j => {
        const num = String(j).split('@')[0].split(':')[0].replace(/\D/g, '');
        return num ? `@${num}` : '';
    }).filter(Boolean).join(' ');

    const saudacao = getSaudacaoHora();

    return {
        text:
            `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n` +
            `  🎉 *BEM-VINDO(A) AO GRUPO!* 🇲🇿\n` +
            `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
            `Olá ${mentionsText || 'Novo Membro'}! ${saudacao}! ✨\n` +
            `Seja muito bem-vindo(a) ao *${groupName || sysName}*! 🚀\n\n` +
            `Aqui você adquire megas e gigas da Vodacom com recarga *100% automática*, rápida e aos melhores preços de Moçambique:\n\n` +
            `📌 *COMO COMPRAR O SEU PACOTE:\n` +
            `1️⃣ Digite *Menu* aqui no grupo ou no meu privado para consultar todos os pacotes e preços.\n` +
            `2️⃣ Faça a transferência para uma das contas oficiais:\n` +
            `   🔴 *M-Pesa:* \`${mpesa_num}\` (${mpesa_name})\n` +
            `   🟡 *e-Mola:* \`${emola_num}\` (${emola_name})\n` +
            `3️⃣ Cole o SMS do comprovativo aqui ou no privado com o seu *número Vodacom* (ex: 84XXXXXXX).\n\n` +
            `⚡ *Os megas entram em segundos após o envio do comprovativo!*\n\n` +
            `💡 *OUTROS COMANDOS ÚTEIS:\n` +
            `• *Menu* ➔ Ver preços\n` +
            `• *Pagamento* ➔ Ver contas bancárias\n` +
            `• *.configurar* ➔ Ativar recarga automática sem comprovativo\n` +
            `• *.txenecar* ➔ Crédito de megas para clientes fiéis\n` +
            `• *Suporte* ➔ Falar com atendimento humano (${supportNum})\n\n` +
            `Desejamos uma ótima estadia e excelente navegação! 🌐🤝`,
        mentions: finalMentions
    };
}

function gerarMensagemPagamento(nomeCliente) {
    const { mpesa_num, mpesa_name, emola_num, emola_name } = getPaymentDetails();
    return (
        `💳 *FORMAS DE PAGAMENTO*\n\n` +
        `🔴 *M-Pesa:* \`${mpesa_num}\`\n` +
        `👤 *Titular:* ${mpesa_name}\n\n` +
        `🟠 *e-Mola:* \`${emola_num}\`\n` +
        `👤 *Titular:* ${emola_name}\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📲 Envie o comprovativo com o seu número na última linha.\n` +
        `⚡ _Ativação imediata 24h!_`
    );
}

function gerarMenuEstudante() {
    const itens = (DYN_CFG.TABELAS && DYN_CFG.TABELAS['estudantes']) || {
        "10": { nome: "500MB Estudante", quantidade_mb: 500 },
        "20": { nome: "1.2GB Estudante", quantidade_mb: 1229 },
        "35": { nome: "2.5GB Estudante", quantidade_mb: 2560 },
        "50": { nome: "4GB Estudante", quantidade_mb: 4096 }
    };
    const entries = Object.entries(itens).sort((a,b) => parseInt(a[0]) - parseInt(b[0]));
    const linhas = entries.map(([preco, p]) => `│ 🎓 *${p.nome}* ➔ *${preco} MT*`).join('\n');
    const { mpesa_num, mpesa_name, emola_num, emola_name } = getPaymentDetails();

    return (
        `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n` +
        `  🎓 *TABELA ESPECIAL DE ESTUDANTES* 🎓\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
        `Pacotes promocionais e acessíveis para estudos e pesquisas:\n\n` +
        `╭─────────────────────────────╮\n` +
        `${linhas}\n` +
        `╰─────────────────────────────╯\n\n` +
        `💳 *M-Pesa:* \`${mpesa_num}\` (${mpesa_name})\n` +
        `💳 *e-Mola:* \`${emola_num}\` (${emola_name})\n\n` +
        `🚀 Envie o comprovativo com seu número na última linha para ativação instantânea!`
    );
}

function gerarMensagemSuporte(nomeCliente) {
    const { supportNum, sysName } = getSuporteDetails();
    return (
        `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n` +
        `  🆘 *CENTRAL DE SUPORTE & AJUDA* 🆘\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
        `Olá, *${nomeCliente}*! Lamentamos qualquer transtorno ou demora com o seu pedido. Estamos aqui para ajudar!\n\n` +
        `📞 *CONTACTO DIRECTO DO ADMINISTRADOR:*\n` +
        `👤 *WhatsApp / Ligação:* *${supportNum}*\n` +
        `🏢 *Central:* *${sysName}*\n\n` +
        `⚠️ *O SEU PACOTE AINDA NÃO CHEGOU?*\n` +
        `Por favor, envie uma mensagem para o número acima contendo:\n` +
        `1. O *recibo/comprovativo* da transferência.\n` +
        `2. O *número de telefone* onde devia cair a recarga.\n` +
        `3. O *horário aproximado* do envio.\n\n` +
        `⚡ *A nossa equipa responde e resolve qualquer situação com prioridade máxima!*`
    );
}

function gerarPainelAjudaCompleto() {
    return `✨ *𝗞𝗔𝗡𝗘𝗧 𝟮.𝟬 • 𝗣𝗔𝗡𝗘𝗟 𝗗𝗘 𝗖𝗢𝗠𝗔𝗡𝗗𝗢𝗦* ✨
━━━━━━━━━━━━━━━━━━━━━

📊 *𝗘𝗦𝗧𝗔𝗧𝗜́𝗦𝗧𝗜𝗖𝗔𝗦 𝗘 𝗥𝗘𝗟𝗔𝗧𝗢́𝗥𝗜𝗢𝗦*
🔹 *!hoje* / *!vendas* - Relatório diário + Crescimento das vendas
🔹 *!amanha* - Relatório consolidado de ontem
🔹 *!relatorio* - Relatório geral de vendas avançado
🔹 *.leads* - Total de clientes na base de dados

⚙️ *𝗚𝗘𝗦𝗧𝗔̃𝗢 𝗗𝗢 𝗦𝗜𝗦𝗧𝗘𝗠𝗔 𝗘 𝗠𝗔𝗡𝗨𝗧𝗘𝗡𝗖̧𝗔̃𝗢*
🔹 *.manutencao* - Ativa o modo de manutenção do bot 🛑
🔹 *.online* - Desativa o modo de manutenção e traz o bot online 🟢
🔹 */status* - Verifica o status operacional dos telefones e do ADB 📱
🔹 */limpar* - Limpa a fila de transações pendentes/antigas 🧹
🔹 */tentar [ref]* - Força o reprocessamento de uma referência pendente 🔄

🛡️ *𝗦𝗘𝗚𝗨𝗥𝗔𝗡𝗖̧𝗔, 𝗚𝗥𝗨𝗣𝗢𝗦 𝗘 𝗗𝗘𝗙𝗘𝗦𝗔*
🔹 *.banir [número]* - Bane e bloqueia um número em todos os grupos
🔹 *.desbanir [número]* - Remove o banimento do número
🔹 *.banidos* - Lista todos os números banidos do sistema
🔹 *!abrir* / *!fechar* - Abre ou fecha o grupo para mensagens
🔹 *.idgrupo* - Exibe o ID do grupo atual para whitelisting

📢 *𝗠𝗔𝗥𝗞𝗘𝗧𝗜𝗡𝗚, 𝗕𝗢́𝗡𝗨𝗦 𝗘 𝗔𝗦𝗦𝗜𝗡𝗔𝗧𝗨𝗥𝗔𝗦*
🔹 *!convite* - Gera o código de indicação do cliente para bónus 🎁
🔹 *.estudante* - Exibe a tabela promocional de estudante

💰 *𝗧𝗔𝗕𝗘𝗟𝗔 𝗘 𝗘𝗡𝗩𝗜𝗢 𝗠𝗔𝗡𝗨𝗔𝗟*
🔹 *Menu* / *Tabela* - Abre a tabela de pacotes atualizada
🔹 *!pagamento* - Mostra dados para M-Pesa e E-Mola
🔹 *.addtabela* - Adiciona ou atualiza pacotes no sistema
🔹 *.addpagamento* - Atualiza dados bancários M-Pesa/E-Mola
🔹 *.enviar [número] [MB]* - Realiza envio manual direto de megas`;
}

// ══════════════════════════════════════════════════
// ══════════════════════════════════════════════════
// CALCULADOR PROPORCIONAL INTELIGENTE (VALORES FORA DA TABELA)
// Converte qualquer valor em megas justos protegendo rigorosamente o lucro
// ══════════════════════════════════════════════════
function calcularPacoteProporcional(valor, jid = null) {
    const vNum = Math.round(parseFloat(String(valor).replace(',', '.')));
    if (isNaN(vNum) || vNum < 5) return null; // valor mínimo de segurança

    // Custo de compra dinâmico configurado (Padrão: 17.5 MT por GB)
    const custoGb = Number(DYN_CFG.CUSTO_GB_MT) || 17.5;
    const custoPorMb = custoGb / 1024;

    // 1. Obter pontos da tabela de referência (preferência absoluta pela tabela exclusiva do Grupo!)
    const pontos = [];
    let origemPersonalizada = false;

    if (jid && String(jid).endsWith('@g.us') && DYN_CFG.TABELAS_GRUPO && DYN_CFG.TABELAS_GRUPO[jid]) {
        const grpCfg = DYN_CFG.TABELAS_GRUPO[jid];
        const grpTabs = grpCfg.TABELAS || grpCfg;
        for (const [catName, catObj] of Object.entries(grpTabs)) {
            if (catObj && typeof catObj === 'object') {
                for (const [pStr, pObj] of Object.entries(catObj)) {
                    const p = parseFloat(pStr);
                    const mb = Number(pObj.quantidade_mb || pObj.quantidade || 0);
                    if (!isNaN(p) && p > 0 && mb > 0) {
                        pontos.push({ preco: p, mb, cat: catName });
                    }
                }
            }
        }
        if (pontos.length > 0) origemPersonalizada = true;
    }

    if (pontos.length === 0 && DYN_CFG.TABELAS) {
        for (const catName of ['24hrs', 'semanal', 'mensal']) {
            const catObj = DYN_CFG.TABELAS[catName];
            if (catObj && typeof catObj === 'object') {
                for (const [pStr, pObj] of Object.entries(catObj)) {
                    const p = parseFloat(pStr);
                    const mb = Number(pObj.quantidade_mb || pObj.quantidade || 0);
                    if (!isNaN(p) && p > 0 && mb > 0) {
                        pontos.push({ preco: p, mb, cat: catName });
                    }
                }
            }
        }
    }

    pontos.sort((a, b) => a.preco - b.preco);

    // ⚡ ADAPTAÇÃO TOTAL E DINÂMICA: Detecta o preço de venda de 1GB da tabela ativa (Geral ou Grupo)
    let precoVendaGb = Number(DYN_CFG.PRECO_VENDA_GB_MT) || 23.0;
    const ponto1Gb = pontos.find(p => p.mb === 1024 || (p.mb >= 1000 && p.mb <= 1048));
    if (ponto1Gb && ponto1Gb.preco > 0) {
        precoVendaGb = ponto1Gb.preco;
    } else if (pontos.length > 0) {
        const maiores = pontos.filter(p => p.mb >= 1000);
        if (maiores.length > 0) {
            precoVendaGb = Math.round((maiores[0].preco / (maiores[0].mb / 1024)) * 10) / 10;
        }
    }

    let mbEstimado = 0;
    if (vNum >= precoVendaGb) {
        // Para valores a partir de 1GB, entrega estritamente proporcional ao preço do GB da tabela ativa
        mbEstimado = Math.floor((vNum / precoVendaGb) * 1024);
    } else if (pontos.length > 0 && vNum >= pontos[0].preco) {
        // Interpolação linear entre os pontos da tabela
        let pInf = pontos[0];
        let pSup = pontos[pontos.length - 1];
        for (let i = 0; i < pontos.length - 1; i++) {
            if (vNum >= pontos[i].preco && vNum <= pontos[i + 1].preco) {
                pInf = pontos[i];
                pSup = pontos[i + 1];
                break;
            }
        }
        const deltaPreco = pSup.preco - pInf.preco;
        const fator = deltaPreco > 0 ? (vNum - pInf.preco) / deltaPreco : 0;
        mbEstimado = Math.round(pInf.mb + fator * (pSup.mb - pInf.mb));
    } else {
        // Para valores abaixo do menor pacote da tabela (ex: 5 a 10 MT), garantir margem mínima de 40% de lucro
        const gastoMaximo = vNum * 0.60;
        mbEstimado = Math.floor(gastoMaximo / custoPorMb);
    }

    // 2. 🛡️ PROTEÇÃO RIGOROSA DE LUCRO (Meta de Lucro >= 50 MT a cada 10 vendas)
    let tetoMbPermitido = 0;
    if (vNum >= 11 && vNum <= 22) {
        // Para valores de 11 a 22 MT: o lucro por venda NUNCA pode ser menor que 5.00 MT!
        // Custo máximo = vNum - 5.00 MT
        tetoMbPermitido = Math.floor((vNum - 5.00) / custoPorMb);
    } else if (vNum > 22) {
        // Para valores >= 23 MT: o custo não pode exceder a margem oficial (23 MT venda x 17.5 MT custo)
        const margemCustoMax = (custoGb / precoVendaGb); // ~0.7608 (76.1% custo, 23.9% lucro)
        tetoMbPermitido = Math.floor((vNum * margemCustoMax) / custoPorMb);
    } else {
        // Para valores < 11 MT: margem mínima de 40%
        tetoMbPermitido = Math.floor((vNum * 0.60) / custoPorMb);
    }

    if (tetoMbPermitido > 0 && mbEstimado > tetoMbPermitido) {
        mbEstimado = tetoMbPermitido;
    }

    // Arredondamento comercial amigável (múltiplos de 50 MB para pacotes grandes, ou 10 MB para pequenos)
    if (mbEstimado >= 1000) {
        mbEstimado = Math.floor(mbEstimado / 50) * 50;
    } else {
        mbEstimado = Math.floor(mbEstimado / 10) * 10;
    }

    if (mbEstimado < 100) mbEstimado = 100;

    const nomeFormatado = mbEstimado >= 1024 ? `${(mbEstimado / 1024).toFixed(1)} GB` : `${mbEstimado} MB`;

    return {
        nome: `${nomeFormatado} 24h`,
        mb: mbEstimado,
        tipo: '24hrs',
        preco: vNum,
        calculado: true,
        origem: origemPersonalizada ? 'calculador_grupo_exclusivo' : 'calculador_proporcional',
        origemPersonalizada
    };
}

// ══════════════════════════════════════════════════
// BUSCA DE PACOTE PELO VALOR (COM SUPORTE A TABELAS POR GRUPO)
// ══════════════════════════════════════════════════
function buscarPacotePorValor(valor, jid = null) {
    const vStr = String(Math.round(parseFloat(String(valor).replace(',', '.'))));
    const vNum = parseInt(vStr);

    // 1. PRIORIDADE MÁXIMA: Tabela específica do Grupo (se a mensagem veio de um grupo configurado)
    if (jid && String(jid).endsWith('@g.us') && DYN_CFG.TABELAS_GRUPO && DYN_CFG.TABELAS_GRUPO[jid]) {
        const grpCfg = DYN_CFG.TABELAS_GRUPO[jid];
        const grpTabs = grpCfg.TABELAS || grpCfg;
        for (const cat of ['24hrs', 'semanal', 'mensal', 'ilimitado', 'especial', 'estudantes', 'saldo']) {
            if (grpTabs[cat] && grpTabs[cat][vStr]) {
                const p = grpTabs[cat][vStr];
                return { nome: p.nome, mb: p.quantidade_mb || p.quantidade, tipo: cat, preco: vNum, origem: 'grupo_especifico' };
            }
        }
    }

    // 2. Tabela Geral do Sistema (Diários, Semanais, Mensais, Ilimitados, Especiais)
    if (DYN_CFG.TABELAS['24hrs'] && DYN_CFG.TABELAS['24hrs'][vStr]) {
        const p = DYN_CFG.TABELAS['24hrs'][vStr];
        return { nome: p.nome, mb: p.quantidade_mb || p.quantidade, tipo: '24hrs', preco: vNum };
    }
    if (DYN_CFG.TABELAS['semanal'] && DYN_CFG.TABELAS['semanal'][vStr]) {
        const p = DYN_CFG.TABELAS['semanal'][vStr];
        return { nome: p.nome, mb: p.quantidade_mb || p.quantidade, tipo: 'semanal', preco: vNum };
    }
    if (DYN_CFG.TABELAS['mensal'] && DYN_CFG.TABELAS['mensal'][vStr]) {
        const p = DYN_CFG.TABELAS['mensal'][vStr];
        return { nome: p.nome, mb: p.quantidade_mb || p.quantidade, tipo: 'mensal', preco: vNum };
    }
    if (DYN_CFG.TABELAS['ilimitado'] && DYN_CFG.TABELAS['ilimitado'][vStr]) {
        const p = DYN_CFG.TABELAS['ilimitado'][vStr];
        return { nome: p.nome, mb: p.quantidade_mb || p.quantidade, tipo: 'ilimitado', preco: vNum };
    }
    const pEspeciais = (DYN_CFG.PLANOS_ESPECIAIS && Object.keys(DYN_CFG.PLANOS_ESPECIAIS).length > 0)
        ? { ...DEFAULT_PLANOS_ESPECIAIS, ...DYN_CFG.PLANOS_ESPECIAIS }
        : DEFAULT_PLANOS_ESPECIAIS;

    if (pEspeciais && pEspeciais[vStr]) {
        const p = pEspeciais[vStr];
        const isFaseado = (p.tipo === 'faseado') || String(p.nome).toLowerCase().includes('faseado');
        const tipoFinal = isFaseado ? 'faseado' : 'renovavel';
        const mbInicial = p.inicial || (isFaseado ? 1024 : 3072);
        const mbTotal = p.total || (mbInicial + (p.diaria || (isFaseado ? 1024 : 100)) * (isFaseado ? 4 : 7));
        return { 
            nome: p.nome, 
            mb: mbTotal, 
            mb_inicial: mbInicial,
            tipo: tipoFinal, 
            preco: vNum 
        };
    }
    if (DYN_CFG.TABELAS_FORNECIMENTO && DYN_CFG.TABELAS_FORNECIMENTO[vStr]) {
        const p = DYN_CFG.TABELAS_FORNECIMENTO[vStr];
        return { nome: p.nome, mb: p.quantidade_mb || 0, tipo: 'saldo', preco: vNum };
    }

    // 3. Fallback: procurar em qualquer grupo se não foi achado na tabela geral
    if (DYN_CFG.TABELAS_GRUPO) {
        for (const [gJid, grpObj] of Object.entries(DYN_CFG.TABELAS_GRUPO)) {
            if (!String(gJid).endsWith('@g.us')) continue;
            const grpTabs = grpObj.TABELAS || grpObj;
            for (const cat of ['24hrs', 'semanal', 'mensal', 'ilimitado', 'especial']) {
                if (grpTabs[cat] && grpTabs[cat][vStr]) {
                    const p = grpTabs[cat][vStr];
                    return { nome: p.nome, mb: p.quantidade_mb || p.quantidade, tipo: cat, preco: vNum, origem: 'fallback_outro_grupo' };
                }
            }
        }
    }

    // 4. Tolerância ±1 MT (arredondamento)
    for (const delta of [1, -1]) {
        const nearStr = String(vNum + delta);
        if (DYN_CFG.TABELAS['24hrs'] && DYN_CFG.TABELAS['24hrs'][nearStr]) {
            const p = DYN_CFG.TABELAS['24hrs'][nearStr];
            return { nome: p.nome, mb: p.quantidade_mb || p.quantidade, tipo: '24hrs', preco: vNum + delta };
        }
        if (DYN_CFG.TABELAS['semanal'] && DYN_CFG.TABELAS['semanal'][nearStr]) {
            const p = DYN_CFG.TABELAS['semanal'][nearStr];
            return { nome: p.nome, mb: p.quantidade_mb || p.quantidade, tipo: 'semanal', preco: vNum + delta };
        }
    }

    // 5. ⚡ CALCULADOR AUTOMÁTICO INTELIGENTE (valores fora da tabela)
    const pacoteCalculado = calcularPacoteProporcional(vNum, jid);
    if (pacoteCalculado) {
        console.log(`🧮 [CALCULADOR PROPORCIONAL] Valor ${vNum} MT fora da tabela convertido em ${pacoteCalculado.mb} MB!`);
        return pacoteCalculado;
    }

    return null;
}

// ══════════════════════════════════════════════════
// DETECÇÃO FLEXÍVEL DE COMPROVATIVOS (PRIVADO E GRUPO)
// Igual ao bot original - identifica qualquer formato M-Pesa/e-Mola
// ══════════════════════════════════════════════════
const pendingPayments = new Map(); // chave: jid + ":" + senderNumber
const lidToPhoneMap = new Map([
    ['216054655656152', '258850401416'],
    ['167894566592572', '258850401416']
]); // chave: cleanLid -> cleanPhone

function extrairValorMT(texto) {
    if (!texto) return null;
    const mTransf = texto.match(/Transferiste\s+([\d.,]+)\s*(?:MT|MZN|Mts?)/i);
    if (mTransf) return mTransf[1].replace(/\s/g, '').replace(',', '.');
    const mReceb = texto.match(/(?:Recebeste|Recebeu|Creditado|Depositado)\s+([\d.,]+)\s*(?:MT|MZN|Mts?)/i);
    if (mReceb) return mReceb[1].replace(/\s/g, '').replace(',', '.');
    const mValor = texto.match(/Valor\s*[:.]?\s*([\d.,]+)\s*(?:MT|MZN|Mts?)/i);
    if (mValor) return mValor[1].replace(/\s/g, '').replace(',', '.');
    const mGeral = texto.match(/([\d.,]+)\s*(?:MT|MZN|Mts?)\b/i);
    if (mGeral) return mGeral[1].replace(/\s/g, '').replace(',', '.');
    return null;
}

function extrairTxId(texto) {
    if (!texto) return null;

    // 1. Padrão explícito com label de ID/Transação/Ref (MÁXIMA PRIORIDADE - 100% certeiro)
    // Cobre: 'ID da transacao: PP251205.2043.k61611', 'ID da transacao PP...', 'ID Trans: PP260819.0642.B03818', 'Ref: DHJ4L92EBZW', 'TxId: ...'
    const mExplicit = texto.match(/(?:ID\s*(?:da)?\s*transa[cç][aã]o|ID\s*Trans(?:a[cç][aã]o)?|TxId|Ref(?:er[eê]ncia)?|Transa[cç][aã]o(?:\s*N[oº.]?)?)\s*[:.]?\s*([A-Z0-9]+(?:\.[A-Z0-9]+)*)/i);
    if (mExplicit && mExplicit[1]) {
        let cand = mExplicit[1].toUpperCase().trim();
        if (cand.endsWith('.')) cand = cand.slice(0, -1);
        if (!/^(258)?8[2-7]\d{7}$/.test(cand) && cand.length >= 6) {
            return cand;
        }
    }

    // 2. Padrão específico e-Mola / Vodacom PP: PP + 6 dígitos data + 4 dígitos hora + código alfanumérico
    // Ex: PP260818.1138.924955, PP251205.2043.k61611, PP260819.0642.B03818
    const mPP = texto.match(/\b((?:PP|N|T)[0-9]{6,}(?:\.[A-Z0-9]{2,15}){1,4})\b/i) || texto.match(/\b(PP[0-9]{6}\.[0-9]{4}\.[A-Z0-9]{4,8})\b/i);
    if (mPP && mPP[1]) {
        let cand = mPP[1].toUpperCase().trim();
        if (cand.endsWith('.')) cand = cand.slice(0, -1);
        return cand;
    }

    // 3. Padrão específico M-Pesa com 'Confirmado [CODE]' (permite pontos para casos PP e outros)
    const mConf = texto.match(/Confirmado\s+([A-Z0-9]+(?:\.[A-Z0-9]+)*)\b/i);
    if (mConf && mConf[1]) {
        let c = mConf[1].toUpperCase().trim();
        if (c.endsWith('.')) c = c.slice(0, -1);
        if (!/^(258)?8[2-7]\d{7}$/.test(c) && c.length >= 6) return c;
    }

    // 4. Padrão alfanumérico padrão M-Pesa (10 a 12 caracteres com letras e números misturados)
    const mAlphanum = texto.match(/\b([A-Z][A-Z0-9]{9,12})\b/);
    if (mAlphanum && mAlphanum[1]) {
        const c = mAlphanum[1].toUpperCase().trim();
        const commonIgnored = ['CONFIRMADO', 'TRANSFERISTE', 'RECEBESTE', 'NOTIFICACAO', 'COMPROVATIVO', 'AUTOMATICA'];
        if (!commonIgnored.includes(c) && /[0-9]/.test(c)) {
            return c;
        }
    }

    // 5. Fallback geral original aperfeiçoado
    const commonWords = [
        'CONFIRMADO', 'RECEBESTE', 'TRANSFERISTE', 'RECEBEU', 'SALDO', 'VODACOM', 'MOVITEL',
        'EMOLA', 'MPESA', 'PAGAMENTO', 'OPERADORA', 'CONTA', 'VALOR', 'AUTOMATICAMENTE',
        'EXEMPLO', 'COMPROVATIVO', 'DESTINATARIO', 'TRANSFERENCIA', 'INSTANTANEA',
        'ACTIVACAO', 'ATIVACAO', 'NOTIFICACAO', 'MENSAGEM', 'VERIFICADO', 'TRANSAÇÃO', 'TRANSACAO'
    ];
    const regex = /\b([A-Z0-9]{6,25}(?:\.[A-Z0-9]{2,15})*)\b/gi;
    let match;
    let results = [];
    
    while ((match = regex.exec(texto)) !== null) {
        let ref = match[1].toUpperCase().trim();
        if (ref.endsWith('.')) ref = ref.slice(0, -1);
        if (commonWords.includes(ref)) continue;
        if (/^(258)?(8[2-7]\d{7})$/.test(ref)) continue; // telefone, ignora
        if (/^8[2-7]X+$/i.test(ref)) continue; // exemplo de máscara como 84XXXXXXX
        
        const temLetra = /[A-Z]/.test(ref);
        const temNumero = /[0-9]/.test(ref);
        
        if (temLetra && temNumero) {
            results.push({ val: ref, score: 100 });
        } else if (ref.length >= 8 && temNumero) {
            results.push({ val: ref, score: 50 });
        }
    }
    
    if (results.length === 0) return 'TXN-' + Date.now();
    return results.sort((a,b) => b.score - a.score || b.val.length - a.val.length)[0].val;
}

// ══════════════════════════════════════════════════════════════════════════
// VALIDADORES ESTRITOS DE COMPROVATIVO: APENAS M-PESA E E-MOLA SÃO VÁLIDOS!
// ══════════════════════════════════════════════════════════════════════════

function isMpesaReceipt(texto) {
    if (!texto) return false;
    const cleanLower = String(texto).trim().toLowerCase();

    // 1. Rejeições estritas: transferências de saldo/crédito, recarga voucher, txuna, empréstimo, bónus
    if (/(?:saldo\s+(?:de\s+)?(?:voz|dados|megas|internet|recarga|principal)|transferiste\s+saldo|recebeste\s+saldo|transferiu\s+saldo|recebeu\s+saldo|txuna|empr[eé]stimo|recarga\s+(?:de\s+)?\d|b[oó]nus)/i.test(cleanLower)) {
        return false;
    }

    // 2. Rejeitar mensagens de bancos e outros canais se não for M-Pesa
    if (/(?:bci|millennium|bim|standard\s*bank|moza|banco|carteira\s*m[oó]vel|mkesh|tmcel)/i.test(cleanLower) && !cleanLower.includes('m-pesa') && !cleanLower.includes('mpesa')) {
        return false;
    }

    // 3. Indicadores M-Pesa obrigatórios (Confirmado ou palavra-chave M-Pesa)
    const hasMpesaKeyword = /\bm-?pesa\b/i.test(cleanLower);
    const hasConfirmado = /\bconfirmado\b/i.test(cleanLower);
    if (!hasMpesaKeyword && !hasConfirmado) {
        return false;
    }

    // 4. Ação de transação em dinheiro
    const hasAction = /(?:recebeu|recebeste|depositou|creditou|transferiste|transferiu|pagou|enviou)\s+(?:de\s+)?[\d.,]+\s*(?:mt|mzn|mts?)/i.test(cleanLower) ||
                      /[\d.,]+\s*(?:mt|mzn|mts?)\s+(?:de|para)\s+/i.test(cleanLower);

    // 5. Valor monetário em MT/MZN
    const hasValor = /[\d.,]+\s*(?:mt|mzn|mts?)\b/i.test(cleanLower);

    return (hasMpesaKeyword || hasConfirmado) && hasAction && hasValor;
}

function isEmolaReceipt(texto) {
    if (!texto) return false;
    const cleanLower = String(texto).trim().toLowerCase();

    // 1. Rejeições estritas: partilha de saldo de voz/dados, empréstimo, recarga
    if (/(?:partilha\s+de\s+saldo|saldo\s+(?:de\s+)?(?:voz|dados|megas|internet)|cr[eé]dito\s+emprestado|empresta\s+movitel|recarga\s+(?:de\s+)?\d)/i.test(cleanLower)) {
        return false;
    }

    // 2. Rejeitar mensagens de bancos e outros
    if (/(?:bci|millennium|bim|standard\s*bank|moza|banco)/i.test(cleanLower) && !cleanLower.includes('emola') && !cleanLower.includes('e-mola')) {
        return false;
    }

    // 3. Indicadores e-Mola obrigatórios (ID da transação PP... ou palavra-chave e-Mola)
    const hasEmolaKeyword = /\be-?mola\b/i.test(cleanLower);
    const hasIdTrans = /\b(?:id\s*(?:da\s*)?transa[cç][aã]o|id\s*trans|transaction\s*id)\b/i.test(cleanLower);
    const hasPPCode = /\bpp[0-9]{6}\b/i.test(cleanLower);

    if (!hasEmolaKeyword && !hasIdTrans && !hasPPCode) {
        return false;
    }

    // 4. Valor monetário em MT/MZN
    const hasValor = /[\d.,]+\s*(?:mt|mzn|mts?)\b/i.test(cleanLower);

    return hasValor;
}

function isComprovativo(texto) {
    if (!texto) return false;
    return isMpesaReceipt(texto) || isEmolaReceipt(texto);
}

function separarMultiplosComprovativos(texto) {
    if (!texto) return [];
    const regexDivisor = /(?=(?:\bConfirmado\s+[A-Z0-9]{6,}|\b(?:ID\s*(?:da\s*)?transa[cç][aã]o|Transaction\s*ID|ID\s*Trans)\b))/gi;
    let blocos = texto.split(regexDivisor).map(b => b.trim()).filter(b => b.length > 15);
    if (blocos.length < 2) {
        const porLinhas = texto.split(/(?:\r?\n){2,}/).map(b => b.trim()).filter(b => b.length > 15);
        if (porLinhas.length >= 2) blocos = porLinhas;
    }
    const comprovativos = [];
    const idsVistos = new Set();
    for (const bloco of blocos) {
        // 🛑 APENAS processa o bloco se for comprovativo genuíno M-Pesa ou e-Mola!
        if (!isComprovativo(bloco)) continue;

        const val = extrairValorMT(bloco);
        const tx = extrairTxId(bloco);
        if (val && tx && !idsVistos.has(tx)) {
            idsVistos.add(tx);
            const isEmola = isEmolaReceipt(bloco);
            comprovativos.push({
                txn_id: tx,
                valor: parseFloat(val),
                metodo: isEmola ? 'emola' : 'mpesa',
                metodoNome: isEmola ? 'e-Mola' : 'M-Pesa',
                raw: bloco
            });
        }
    }
    return comprovativos;
}

function getNumerosDeposito() {
    const list = new Set();
    try {
        const pay = getPaymentDetails();
        if (pay.mpesa_num) {
            const c = String(pay.mpesa_num).replace(/\D/g, '').slice(-9);
            if (c.length === 9) list.add(c);
        }
        if (pay.emola_num) {
            const c = String(pay.emola_num).replace(/\D/g, '').slice(-9);
            if (c.length === 9) list.add(c);
        }
    } catch (e) {
        console.warn('⚠️ [PAGAMENTO] Erro ao obter números de depósito:', e.message);
    }
    list.add('856268811');
    list.add('864882152');
    return list;
}

function isNumeroDeposito(num) {
    if (!num) return false;
    const clean = String(num).replace(/\D/g, '').slice(-9);
    return getNumerosDeposito().has(clean);
}

function extrairNumeroDestino(texto) {
    if (!texto) return null;
    const clean = String(texto).trim();
    const digitsOnly = clean.replace(/[^\d]/g, '');

    // Se o texto for exatamente um número de telefone com ou sem 258
    if (/^(?:258)?(8[4-5]\d{7})$/.test(digitsOnly)) {
        const num = digitsOnly.slice(-9);
        if (!isNumeroDeposito(num)) return num;
        return null;
    }

    // Buscar qualquer número Vodacom (84 ou 85) de 9 dígitos no texto
    const regex = /(?:^|[^\d])(?:258)?(8[4-5]\s*\d{3}\s*\d{4}|8[4-5]\d{7})(?=[^\d]|$)/g;
    let match;
    let candidates = [];
    while ((match = regex.exec(clean)) !== null) {
        const rawNum = match[1].replace(/\s+/g, '');
        if (/^8[4-5]\d{7}$/.test(rawNum) && !isNumeroDeposito(rawNum)) {
            candidates.push(rawNum);
        }
    }
    return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

function extrairNumeroDestinoAbaixoDoComprovativo(texto) {
    if (!texto) return null;
    const lines = String(texto).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    // Se só tem 1 linha, o cliente enviou apenas o comprovativo sem número abaixo
    if (lines.length < 2) return null;

    // Verificar da última linha para cima até a segunda linha
    for (let i = lines.length - 1; i >= 1; i--) {
        const l = lines[i];
        // Se a linha contém termos da operadora, faz parte do comprovativo
        if (/(?:confirmado|transferiste|recebeste|recebeu|transferiu|saldo|taxa foi|liga 100|m-pesa|e-mola|vodacom|movitel|em caso de duvida)/i.test(l)) {
            continue;
        }
        const num = extrairNumeroDestino(l);
        if (num && !isNumeroDeposito(num)) {
            return num;
        }
    }
    return null;
}

function isPerguntaOnlineBot(texto) {
    if (!texto) return false;
    const s = String(texto).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    return /\b(?:estao|esta|estas|tao|ta|tas)\s+(?:on|online|ativo|ativos|activos?|ativas?|funcionar|funcionando|operacional|a\s+trabalhar|pronto|prontos)\b/i.test(s) ||
           /\b(?:online|ta\s+on|tao\s+on|estas?\s+ai|alguem\s+ai|voce\s+esta\s+ativo|vc\s+esta\s+ativo|estao\s+ativos?)\b/i.test(s) ||
           /^(?:on|online|ativo|activos?)\??$/i.test(s);
}

function isPerguntaComprarBot(texto) {
    if (!texto) return false;
    const s = String(texto).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    return /\b(?:posso\s+(?:comprar|pagar|transferir|mandar|pedir|fazer\s+pedido|recarregar))\b/i.test(s) ||
           /\b(?:tem\s+(?:megas?|dados?|net|saldo|recarga))\b/i.test(s) ||
           /\b(?:estao\s+a\s+vender|ainda\s+tem\s+(?:megas?|net)|quero\s+comprar)\b/i.test(s);
}

function gerarRespostaStatusOnline() {
    if (modoManutencao) {
        return (
            `⚠️ *KA-NET EM MANUTENÇÃO MOMENTÂNEA* ⏳\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `De momento o sistema está em pausa para manutenção rápida e melhorias técnicas.\n\n` +
            `Voltamos a operar normalmente dentro de instantes! Agradecemos a compreensão. 🌐`
        );
    }
    return (
        `🟢⚡ *SIM, ESTAMOS 100% ONLINE!* 📶\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `O sistema automático Ka-Net está totalmente ativo e a despachar recargas 24/7 sem paragens.\n\n` +
        `📲 *Como comprar agora:*\n` +
        `1. Transfira o valor para o *M-Pesa* ou *e-Mola*.\n` +
        `2. Envie aqui o comprovativo com o seu número Vodacom.\n\n` +
        `⚡ _A sua recarga entra imediatamente no mesmo segundo!_`
    );
}

function gerarRespostaPossoComprar() {
    if (modoManutencao) {
        return (
            `⚠️ *SISTEMA EM MANUTENÇÃO* ⏳\n` +
            `De momento não estamos a aceitar novos pedidos. Voltamos dentro de instantes!`
        );
    }
    const { mpesa_num, emola_num } = getPagamentoDetails();
    return (
        `🚀✨ *SIM, PODE COMPRAR À VONTADE!* 🛒\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Temos todos os pacotes disponíveis para ativação imediata!\n\n` +
        `💳 *Contas Oficiais Ka-Net:*\n` +
        `🇲🇿 *M-Pesa:* \`${mpesa_num}\` _(Kelven Junior)_\n` +
        `🇲🇿 *e-Mola:* \`${emola_num}\` _(Catia Anabela)_\n\n` +
        `📝 _Basta transferir e enviar o comprovativo aqui com o seu número Vodacom._`
    );
}

function extrairTextoAbaixoDoComprovativo(texto) {
    if (!texto) return '';
    const lines = String(texto).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return '';
    const nonReceiptLines = [];
    for (let i = 1; i < lines.length; i++) {
        const l = lines[i];
        if (/(?:confirmado|transferiste|recebeste|recebeu|transferiu|saldo|taxa foi|liga 100|m-pesa|e-mola|vodacom|movitel|em caso de duvida)/i.test(l)) {
            continue;
        }
        nonReceiptLines.push(l);
    }
    return nonReceiptLines.join('\n');
}

function processarAddTabelaCompleta(corpo, targetJid = null) {
    function _parseToMB(sizeStr) {
        sizeStr = sizeStr.trim().replace(/,/g, '.');
        const gMatch = sizeStr.match(/([\d.]+)\s*GB/i);
        if (gMatch) return Math.round(parseFloat(gMatch[1]) * 1024);
        const mMatch = sizeStr.match(/([\d.]+)\s*MB/i);
        if (mMatch) return Math.round(parseFloat(mMatch[1]));
        const num = parseFloat(sizeStr);
        return isNaN(num) ? 0 : Math.round(num);
    }

    const lines = corpo.split(/\n/);
    let currentSection = null;
    let newTabelas = { '24hrs': {}, 'semanal': {}, 'mensal': {}, 'ilimitado': {}, 'saldo': {} };
    let contador = 0;

    for (const rawLine of lines) {
        const line = rawLine.replace(/[*_~`┌┐└┘│─]/g, '').trim();
        if (/DI[AÁ]R/i.test(line)) { currentSection = '24hrs'; continue; }
        if (/SEMAN/i.test(line)) { currentSection = 'semanal'; continue; }
        if (/MENS/i.test(line)) { currentSection = 'mensal'; continue; }
        if (/ILIMITAD/i.test(line) || /VODACOM|MOVITEL/i.test(line)) { currentSection = 'ilimitado'; continue; }
        if (/SALDO|FORNEC/i.test(line)) { currentSection = 'saldo'; continue; }

        if (!currentSection) continue;

        const priceMatch = line.match(/([\d.,]+)\s*MT\b/i) || line.match(/[-—👉:]\s*([\d]+)\s*$/);
        const sizeMatch = line.match(/([\d.,]+\s*(?:GB|MB))\b/i);

        if (priceMatch && sizeMatch) {
            const preco = Math.round(parseFloat(priceMatch[1].replace(',', '.')));
            const mb = _parseToMB(sizeMatch[1]);
            const nome = sizeMatch[1].trim() + (currentSection === '24hrs' ? ' 24h' : currentSection === 'semanal' ? ' 7 Dias' : ' Mensal');

            if (preco > 0 && mb > 0) {
                newTabelas[currentSection][String(preco)] = {
                    quantidade: mb,
                    nome,
                    quantidade_mb: mb,
                    periodo: currentSection,
                    tipo: currentSection
                };
                contador++;
            }
        }
    }

    if (contador > 0) {
        const resumo = [];
        const catNomes = { '24hrs': '📦 24hrs', 'semanal': '📅 Semanal', 'mensal': '📆 Mensal', 'ilimitado': '🌐 Ilimitado', 'saldo': '💳 Saldo' };
        
        // Se foi especificado um grupo, salvar como tabela exclusiva do grupo
        if (targetJid && String(targetJid).endsWith('@g.us')) {
            if (!DYN_CFG.TABELAS_GRUPO) DYN_CFG.TABELAS_GRUPO = {};
            if (!DYN_CFG.TABELAS_GRUPO[targetJid]) DYN_CFG.TABELAS_GRUPO[targetJid] = { TABELAS: {} };
            if (!DYN_CFG.TABELAS_GRUPO[targetJid].TABELAS) DYN_CFG.TABELAS_GRUPO[targetJid].TABELAS = {};

            for (const cat of Object.keys(newTabelas)) {
                if (Object.keys(newTabelas[cat]).length > 0) {
                    DYN_CFG.TABELAS_GRUPO[targetJid].TABELAS[cat] = newTabelas[cat];
                    resumo.push(`${catNomes[cat] || cat}: *${Object.keys(newTabelas[cat]).length} pacotes*`);
                }
            }
            salvarBotConfig();
            return `✅ *TABELA EXCLUSIVA DESTE GRUPO ATUALIZADA!* 👥\n\n${resumo.join('\n')}\n\n_Total: ${contador} pacotes salvos exclusivamente para este grupo._\n_Clientes aqui verão e comprarão por estes preços!_`;
        }

        // Caso contrário, salvar na Tabela Geral do Sistema
        for (const cat of Object.keys(newTabelas)) {
            if (Object.keys(newTabelas[cat]).length > 0) {
                // FULL REPLACE — remove all stale old entries for this category
                DYN_CFG.TABELAS[cat] = newTabelas[cat];
                resumo.push(`${catNomes[cat] || cat}: *${Object.keys(newTabelas[cat]).length} pacotes*`);
            }
        }
        salvarBotConfig();
        return `✅ *TABELA GERAL ATUALIZADA COM SUCESSO!*\n\n${resumo.join('\n')}\n\n_Total: ${contador} pacotes substituídos no sistema geral._`;
    }

    return `⚠️ Não foi possível identificar pacotes na tabela colada.\nUse o formato:\n*1GB 24h - 23 MT*`;
}

let firestoreDbInstance = null;
const fileHashCache = new Map();
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
                    if (fileHashCache.get(file) !== content) {
                        fileHashCache.set(file, content);
                        batch.set(db.collection('whatsapp_cloud_auth').doc(encodeURIComponent(file)), {
                            content,
                            updatedAt: Date.now()
                        }, { merge: true });
                        count++;
                        if (count % 400 === 0) {
                            await batch.commit();
                            batch = db.batch();
                        }
                    }
                }
            }
            if (count % 400 !== 0 && count > 0) {
                await batch.commit();
            }
            if (count > 0) {
                console.log(`💾 [BAILEYS NUVEM] ${count} ficheiros de sessão sincronizados no Firestore.`);
            }
        } catch (e) {
            console.warn('⚠️ [BAILEYS NUVEM] Falha no backup para Firestore:', e.message);
        }
    }, 5000);
}

async function restoreAuthFromFirestore(db) {
    if (!db) return;
    try {
        const credsExist = fs.existsSync(path.join(AUTH_DIR, 'creds.json'));
        if (credsExist) {
            console.log('ℹ️ [BAILEYS NUVEM] creds.json local presente. Pulando restore do Firestore para evitar conflito.');
            return;
        }
        const snap = await db.collection('whatsapp_cloud_auth').get();
        if (snap.empty) {
            console.log('ℹ️ [BAILEYS NUVEM] Nenhuma sessão prévia no Firestore.');
            return;
        }
        if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
        for (const doc of snap.docs) {
            const fileName = decodeURIComponent(doc.id);
            const content = doc.data().content;
            if (content) {
                fs.writeFileSync(path.join(AUTH_DIR, fileName), content, 'utf8');
            }
        }
        console.log(`📥 [BAILEYS NUVEM] ${snap.size} ficheiros de sessão restaurados do Firestore! Sessão recuperada sem QR.`);
    } catch (e) {
        console.warn('⚠️ [BAILEYS NUVEM] Falha ao restaurar sessão do Firestore:', e.message);
    }
}

async function restoreConfigsFromFirestore(db) {
    if (!db) return;
    try {
        const doc = await db.collection('bot_settings').doc('pricing_tables').get();
        if (doc.exists) {
            const data = doc.data();
            if (data && data.TABELAS) {
                // ── Deep merge: preservar TABELAS_GRUPO do bot_config.js como base,
                // e fundir com os dados do Firestore por grupo (Firestore prevalece por grupo,
                // mas grupos só existentes localmente não são apagados).
                const localTabelasGrupo = DYN_CFG.TABELAS_GRUPO || {};
                const remoteTabelasGrupo = data.TABELAS_GRUPO || {};
                const mergedTabelasGrupo = { ...localTabelasGrupo };
                for (const [jid, grpData] of Object.entries(remoteTabelasGrupo)) {
                    // Dados do Firestore têm prioridade (são os mais recentes editados em runtime)
                    mergedTabelasGrupo[jid] = grpData;
                }

                // Aplicar o resto normalmente, mas TABELAS_GRUPO usa o merge profundo
                DYN_CFG = { ...DYN_CFG, ...data, TABELAS_GRUPO: mergedTabelasGrupo };
                if (DYN_CFG.MODO_MANUTENCAO !== undefined) modoManutencao = !!DYN_CFG.MODO_MANUTENCAO;
                if (!DYN_CFG.TABELAS_GRUPO) DYN_CFG.TABELAS_GRUPO = {};
                const mudou = limparDuplicatasTabelas();
                console.log(`📥 [FIRESTORE CONFIG] Tabelas restauradas! Grupos configurados: ${Object.keys(DYN_CFG.TABELAS_GRUPO).length}`);
                if (mudou) {
                    salvarBotConfig();
                } else {
                    try {
                        const content = '// GERADO PELO SISTEMA KA-NET CLOUD (CACHE FIRESTORE)\nmodule.exports = ' + JSON.stringify(DYN_CFG, null, 4) + ';\n';
                        fs.writeFileSync(BOT_CONFIG_PATH, content, 'utf8');
                    } catch (_) {
                        console.warn('⚠️ [CACHE] Erro ao salvar BOT_CONFIG local:', _.message);
                    }
                }
            }
        } else {
            console.log('📤 [FIRESTORE CONFIG] Fazendo upload inicial das tabelas padrão para o Firestore...');
            await db.collection('bot_settings').doc('pricing_tables').set(DYN_CFG, { merge: true });
        }

        const locDoc = await db.collection('bot_settings').doc('local_config').get();
        if (locDoc.exists) {
            const locData = locDoc.data();
            if (locData) {
                LOCAL_CFG = { ...LOCAL_CFG, ...locData };
                console.log('📥 [FIRESTORE CONFIG] Configurações locais restauradas do Firestore!');
                try {
                    fs.writeFileSync(LOCAL_CONFIG_PATH, JSON.stringify(LOCAL_CFG, null, 2), 'utf8');
                } catch (_) {
                    console.warn('⚠️ [CACHE] Erro ao salvar LOCAL_CONFIG local:', _.message);
                }
            }
        }
    } catch (err) {
        console.warn('⚠️ [FIRESTORE CONFIG] Falha ao sincronizar configurações do Firestore:', err.message);
    }
}

// ══════════════════════════════════════════════════
// MOTOR PRINCIPAL BAILEYS
// ══════════════════════════════════════════════════
let reconnectAttempts = 0;
let isConnecting = false;

async function startWhatsApp(orderCallback, db = null) {
    if (db) firestoreDbInstance = db;
    if (orderCallback) orderDispatchCallback = orderCallback;

    if (isConnecting) {
        console.log('⏳ [BAILEYS] Inicialização já em andamento. Ignorando chamada concorrente.');
        return;
    }
    isConnecting = true;

    try {
        if (firestoreDbInstance) {
            await restoreAuthFromFirestore(firestoreDbInstance);
            await restoreConfigsFromFirestore(firestoreDbInstance);

            // ── Restaurar SMS de pagamento do Firebase (sobrevive a restarts) ──
            try {
                const snapSms = await firestoreDbInstance.collection('sms_payments').orderBy('processedAt', 'desc').limit(1000).get();
                if (!snapSms.empty) {
                    let countSms = 0;
                    snapSms.docs.forEach(doc => {
                        const d = doc.data();
                        const tid = d.txn_id || doc.id;
                        if (tid && !smsPaymentsMap.has(tid)) {
                            smsPaymentsMap.set(tid, d);
                            countSms++;
                        }
                    });
                    if (countSms > 0) console.log(`📥 [FIREBASE] ${countSms} confirmações de pagamento restauradas do Firestore.`);
                }
            } catch (e) {
                console.warn('⚠️ [FIREBASE] Erro ao restaurar sms_payments:', e.message);
            }

            // ── Restaurar transações anti-fraude do Firebase ──
            try {
                const snapTxn = await firestoreDbInstance.collection('transacoes_processadas').orderBy('timestamp', 'desc').limit(2000).get();
                if (!snapTxn.empty) {
                    let countTxn = 0;
                    snapTxn.docs.forEach(doc => {
                        const d = doc.data();
                        const tid = doc.id;
                        if (tid && !transacoesProcessadasMap.has(tid)) {
                            transacoesProcessadasMap.set(tid, d);
                            transacoesProcessadas.add(tid);
                            countTxn++;
                        }
                    });
                    if (countTxn > 0) console.log(`🔒 [FIREBASE] ${countTxn} transações anti-fraude restauradas do Firestore.`);
                }
            } catch (e) {
                console.warn('⚠️ [FIREBASE] Erro ao restaurar transacoes_processadas:', e.message);
            }
        }

        // Limpeza prévia de socket anterior se existir
        if (sock) {
            try {
                sock.ev.removeAllListeners();
                sock.ws?.close();
                sock.end?.(undefined);
            } catch (e) {
                console.warn('⚠️ [BAILEYS] Erro ao fechar socket anterior:', e.message);
            }
            sock = null;
        }

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const { version } = await fetchLatestBaileysVersion();

        console.log(`📡 [BAILEYS] Iniciando Ka-Net WhatsApp Cloud v${version.join('.')}...`);

        sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: true,
            auth: state,
            browser: ['Ubuntu', 'Chrome', '20.0.04'],
            syncFullHistory: false,          // não tentar sincronizar histórico todo (evita timeouts)
            markOnlineOnConnect: false,      // não marcar como online (menos detecção)
            generateHighQualityLinkPreview: false,
            getMessage: async () => ({ conversation: '' })
        });

        sock.ev.on('creds.update', async () => {
            await saveCreds();
            if (firestoreDbInstance) {
                backupAuthToFirestore(firestoreDbInstance);
            }
        });

        customerServices.setWhatsAppNotifier((jid, text) => {
            sendTextMessage(jid, text).catch(() => {});
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                connectionStatus = 'qr_ready';
                reconnectAttempts = 0;
                try {
                    currentQrBase64 = await QRCode.toDataURL(qr);
                    console.log('📱 [BAILEYS] Novo QR Code gerado em /qr');
                } catch (e) {
                    console.warn('⚠️ [BAILEYS] Erro ao converter QR Code para base64:', e.message);
                }
            }

            if (connection === 'close') {
                isConnecting = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const errMsg = lastDisconnect?.error?.message || (lastDisconnect?.error ? String(lastDisconnect.error) : 'sem msg');
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                connectionStatus = 'disconnected';
                currentQrBase64 = null;
                addLog(`🔌 [DESCONEXÃO] Código: ${statusCode} | Motivo: ${errMsg} | Reconectar: ${shouldReconnect}`);
                console.log(`🔌 [BAILEYS] Conexão fechada (${statusCode} - ${errMsg}). Reconectar: ${shouldReconnect}`);
                
                try {
                    sock.ws?.close();
                } catch (e) {
                    console.warn('⚠️ [BAILEYS] Erro ao fechar WebSocket na desconexão:', e.message);
                }

                if (shouldReconnect) {
                    const isRestartRequired = statusCode === DisconnectReason.restartRequired || statusCode === 515;
                    const delay = isRestartRequired ? 1000 : Math.min(3000 * Math.pow(2, Math.min(reconnectAttempts, 4)), 30000);
                    if (!isRestartRequired) reconnectAttempts++;
                    console.log(`⏳ [BAILEYS] ${isRestartRequired ? 'Stream reset (515) - Reconexão imediata em 1s...' : `Aguardando ${delay / 1000}s antes de reconectar (tentativa #${reconnectAttempts})...`}`);
                    setTimeout(() => startWhatsApp(orderDispatchCallback, firestoreDbInstance), delay);
                } else {
                    console.warn('🚪 [BAILEYS] Sessão encerrada (loggedOut). A limpar credenciais antigas e gerar novo QR Code...');
                    reconnectAttempts = 0;
                    try {
                        if (fs.existsSync(AUTH_DIR)) {
                            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                            fs.mkdirSync(AUTH_DIR, { recursive: true });
                        }
                    } catch (e) {
                        console.error('Erro ao limpar AUTH_DIR:', e.message);
                    }
                    if (firestoreDbInstance) {
                        firestoreDbInstance.collection('whatsapp_cloud_auth').get().then(snap => {
                            const b = firestoreDbInstance.batch();
                            snap.docs.forEach(doc => b.delete(doc.ref));
                            return b.commit();
                        }).catch(e => console.warn('⚠️ [FIRESTORE] Erro ao limpar whatsapp_cloud_auth:', e.message));
                    }
                    console.log('🔄 [BAILEYS] A reiniciar para gerar novo QR Code limpo...');
                    setTimeout(() => startWhatsApp(orderDispatchCallback, firestoreDbInstance), 3000);
                }
            } else if (connection === 'open') {
                isConnecting = false;
                connectionStatus = 'connected';
                currentQrBase64 = null;
                reconnectAttempts = 0; // reset após conexão bem-sucedida
                connectedUser = sock.user?.id || 'KaNet Cloud Bot';
                addLog(`✅ WhatsApp Conectado com SUCESSO! Logado como: ${connectedUser}`);
                if (firestoreDbInstance) {
                    backupAuthToFirestore(firestoreDbInstance);
                }
            }
        });

        // Cache de metadados de grupos para verificação ultra-rápida de admins
        const groupMetaCache = new Map();
        async function getCachedGroupMetadata(groupJid) {
            const now = Date.now();
            const cached = groupMetaCache.get(groupJid);
            if (cached && (now - cached.timestamp < 300000)) {
                return cached.meta;
            }
            if (sock && connectionStatus === 'connected') {
                try {
                    const meta = await sock.groupMetadata(groupJid);
                    groupMetaCache.set(groupJid, { meta, timestamp: now });
                    return meta;
                } catch (e) {
                    addLog(`⚠️ [GROUP META ERRO] ${groupJid}: ${e.message}`);
                }
            }
            return null;
        }

        // Cache para evitar boas-vindas duplicadas em curto intervalo
        const recentGroupWelcomes = new Map();

        async function processarBoasVindasGrupo(groupJid, rawParticipants) {
            if (!groupJid || !groupJid.endsWith('@g.us')) return;
            if (!Array.isArray(rawParticipants) || rawParticipants.length === 0) return;
            if (botSilenciado) return;

            const myJid = sock?.user?.id ? sock.user.id.split(':')[0].replace(/\D/g, '') : '';
            const now = Date.now();
            const validParticipants = [];
            let botWasAdded = false;

            for (const p of rawParticipants) {
                const rawStr = String(p || '');
                const numOnly = rawStr.split('@')[0].split(':')[0].replace(/\D/g, '');
                if (!numOnly && !rawStr.endsWith('@lid')) continue;

                // Verificar se é o próprio bot
                if (myJid && numOnly === myJid) {
                    botWasAdded = true;
                    continue;
                }

                const fullJid = rawStr.includes('@') ? rawStr : `${numOnly}@s.whatsapp.net`;
                const cacheKey = `${groupJid}_${numOnly || rawStr}`;

                const lastSent = recentGroupWelcomes.get(cacheKey) || 0;
                if (now - lastSent < 45000) {
                    // Já recebeu boas-vindas neste grupo nos últimos 45 segundos
                    continue;
                }

                recentGroupWelcomes.set(cacheKey, now);
                validParticipants.push(fullJid);
            }

            // Limpar cache antigo
            if (recentGroupWelcomes.size > 200) {
                for (const [k, time] of recentGroupWelcomes.entries()) {
                    if (now - time > 120000) recentGroupWelcomes.delete(k);
                }
            }

            // Se o próprio bot foi adicionado ao grupo, apresentar-se!
            if (botWasAdded) {
                await new Promise(r => setTimeout(r, 1200));
                let groupName = 'Grupo Ka-Net';
                try {
                    const meta = await getCachedGroupMetadata(groupJid);
                    if (meta && meta.subject) groupName = meta.subject;
                } catch (_) {}

                const { mpesa_num, mpesa_name, emola_num, emola_name } = getPaymentDetails();
                const { supportNum, sysName } = getSuporteDetails();

                const introText =
                    `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n` +
                    `  🤖 *${sysName.toUpperCase()} ONLINE NO GRUPO!* 🇲🇿\n` +
                    `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                    `Olá a todos do *${groupName}*! 👋\n` +
                    `Estou conectado e pronto para ativar pacotes de internet Vodacom de forma *100% automática* 24 horas por dia! ⚡\n\n` +
                    `📌 *COMO FUNCIONA:\n` +
                    `• Digite *Menu* para ver a tabela completa de pacotes e preços.\n` +
                    `• Faça o pagamento para:\n` +
                    `   🔴 *M-Pesa:* \`${mpesa_num}\` (${mpesa_name})\n` +
                    `   🟡 *e-Mola:* \`${emola_num}\` (${emola_name})\n` +
                    `• Cole o comprovativo aqui no grupo ou no meu privado com o seu número Vodacom para receber na hora!\n\n` +
                    `📞 *Suporte:* Digite *Suporte* ou ligue para *${supportNum}*.\n` +
                    `Boas compras a todos! 🌐✨`;

                await sock.sendMessage(groupJid, { text: introText });
                addLog(`🤖 [APRESENTAÇÃO NO GRUPO] Bot apresentado no grupo ${groupJid} ("${groupName}")`);
            }

            if (validParticipants.length === 0) return;

            // Aguardar 1.5s para sincronização dos dados do grupo
            await new Promise(r => setTimeout(r, 1500));

            let groupName = 'Grupo Ka-Net';
            try {
                const meta = await getCachedGroupMetadata(groupJid);
                if (meta && meta.subject) groupName = meta.subject;
            } catch (_) {}

            const welcomeObj = gerarMensagemBoasVindasGrupo(groupName, validParticipants);
            await sock.sendMessage(groupJid, {
                text: welcomeObj.text,
                mentions: welcomeObj.mentions
            });
            addLog(`✅ [BOAS-VINDAS ENVIADAS NO GRUPO] "${groupName}" para: ${validParticipants.join(', ')}`);
        }

        // ── BOAS-VINDAS AUTOMÁTICAS PARA NOVOS PARTICIPANTES EM GRUPOS (EVENTO DE GRUPO) ──
        sock.ev.on('group-participants.update', async (update) => {
            try {
                const { id, participants, action } = update || {};
                if (!id || !Array.isArray(participants) || participants.length === 0) return;

                if (action === 'add') {
                    addLog(`👥 [NOVO MEMBRO NO GRUPO EVENT] ${participants.length} participante(s) entraram no grupo ${id}`);
                    await processarBoasVindasGrupo(id, participants);
                }
            } catch (err) {
                console.warn('⚠️ [GRUPO BOAS-VINDAS ERRO]:', err.message);
            }
        });

        // ── PROCESSADOR DE MENSAGENS ─────────────────────────────
        sock.ev.on('messages.upsert', async (m) => {
            try {
                if (m.type !== 'notify') return;
                for (const msg of m.messages) {
                    if (msg.key.fromMe) continue;
                    const jid = msg.key.remoteJid;
                    if (!jid) continue;

                    // 🛡️ FILTRO ANTI-BACKLOG: Ignora mensagens recebidas com mais de 5 minutos de atraso (evita que o bot responda mensagens antigas acumuladas)
                    const msgTimestampSec = Number(msg.messageTimestamp) || 0;
                    if (msgTimestampSec > 0) {
                        const msgAgeMs = Date.now() - (msgTimestampSec * 1000);
                        if (msgAgeMs > 5 * 60 * 1000) { // > 5 minutos
                            addLog(`⏳ [MSG ANTIGA IGNORADA] Mensagem acumulada de ${jid} (${Math.round(msgAgeMs / 1000)}s atrás). Descartada.`);
                            continue;
                        }
                    }

                    // 👥 BOAS-VINDAS: Novo membro que entra via link de convite ou adicionado (detectado via StubType do WhatsApp)
                    if (jid.endsWith('@g.us') && (msg.messageStubType === 27 || msg.messageStubType === 28 || msg.messageStubType === 31)) {
                        const stParticipants = msg.messageStubParameters || [];
                        if (stParticipants.length > 0) {
                            addLog(`👥 [NOVO MEMBRO STUB ${msg.messageStubType}] ${stParticipants.join(', ')} no grupo ${jid}`);
                            await processarBoasVindasGrupo(jid, stParticipants);
                            continue;
                        }
                    }

                    const isImage = !!msg.message?.imageMessage;
                    const isAudio = !!(msg.message?.audioMessage || msg.message?.pttMessage);
                    const isDocument = !!(msg.message?.documentMessage);
                    const docMime = msg.message?.documentMessage?.mimetype || '';
                    const isPdf = isDocument && docMime.toLowerCase().includes('pdf');
                    let text = msg.message?.conversation ||
                                 msg.message?.extendedTextMessage?.text ||
                                 msg.message?.imageMessage?.caption ||
                                 msg.message?.documentMessage?.caption || '';

                    // ── 📸 GEMINI VISION: Analisa print de M-Pesa/e-Mola ──────────────────────
                    if (isImage && !isComprovativo(text) && geminiAI.isConfigured()) {
                        try {
                            const imgBuffer = await downloadMediaMessage(msg, 'buffer', {});
                            const mimeType = msg.message?.imageMessage?.mimetype || 'image/jpeg';
                            addLog(`🖼️ [GEMINI VISION] Analisando imagem de ${jid}`);
                            const analise = await geminiAI.analisarPrintPagamento(imgBuffer, mimeType);

                            if (analise && analise.valido && analise.txnId) {
                                const sClean = String(analise.servico || '').toLowerCase();
                                const isMpesaOrEmola = sClean.includes('mpesa') || sClean.includes('m-pesa') || sClean.includes('emola') || sClean.includes('e-mola');
                                if (!isMpesaOrEmola) {
                                    addLog(`🛑 [GEMINI VISION] Imagem rejeitada: serviço "${analise.servico}" não é M-Pesa nem e-Mola.`);
                                    await sock.sendMessage(jid, {
                                        text: `⚠️ *Aviso Ka-Net:* O sistema aceita exclusivamente comprovativos oficiais de *M-Pesa* ou *e-Mola*. Outros serviços ou bancos não são aceitos.`
                                    });
                                    continue;
                                }
                                const rawOuSintetico = `Confirmado ${analise.txnId}. Recebeste ${analise.valor || 0}.00MT de KaNet\n` + (analise.raw_text || '');
                                const legenda = text.trim();
                                text = legenda ? `${rawOuSintetico}\n${legenda}` : rawOuSintetico;
                                addLog(`🖼️ [GEMINI VISION] Print válido! Serviço: ${analise.servico} | Valor: ${analise.valor} MT | TxnID: ${analise.txnId}`);
                                await sock.sendMessage(jid, {
                                    text: `📸 *Comprovativo detetado pela IA!*\n\n` +
                                          `🏦 Serviço: *${analise.servico || 'M-Pesa/e-Mola'}*\n` +
                                          `💰 Valor: *${analise.valor} MT*\n` +
                                          `🔑 Referência: *${analise.txnId}*\n\n` +
                                          `⏳ A validar com a operadora...`
                                });
                            } else if (analise && !analise.valido) {
                                // Não é comprovativo — acionar aviso visual amigável
                                text = '__gemini_visual_query__';
                            } else if (!analise) {
                                addLog(`🖼️ [GEMINI VISION] Falha ao analisar imagem`);
                                continue;
                            }
                        } catch (imgErr) {
                            addLog(`🖼️ [GEMINI VISION] Erro ao processar imagem: ${imgErr.message}`);
                            continue;
                        }
                    }

                    // ── 📄 GEMINI PDF: Analisa documento PDF de pagamento ─────────────────────
                    if (isPdf && geminiAI.isConfigured()) {
                        try {
                            const pdfBuffer = await downloadMediaMessage(msg, 'buffer', {});
                            addLog(`📄 [GEMINI PDF] Analisando documento PDF de ${jid}`);
                            const analise = await geminiAI.analisarDocumentoPDF(pdfBuffer);

                            if (analise && analise.valido && analise.txnId) {
                                const sClean = String(analise.servico || '').toLowerCase();
                                const isMpesaOrEmola = sClean.includes('mpesa') || sClean.includes('m-pesa') || sClean.includes('emola') || sClean.includes('e-mola');
                                if (!isMpesaOrEmola) {
                                    addLog(`🛑 [GEMINI PDF] Documento rejeitado: serviço "${analise.servico}" não é M-Pesa nem e-Mola.`);
                                    await sock.sendMessage(jid, {
                                        text: `⚠️ *Aviso Ka-Net:* O sistema aceita exclusivamente comprovativos oficiais de *M-Pesa* ou *e-Mola*. Outros serviços ou bancos não são aceitos.`
                                    });
                                    continue;
                                }
                                const rawOuSintetico = `Confirmado ${analise.txnId}. Recebeste ${analise.valor || 0}.00MT de KaNet\n` + (analise.raw_text || '');
                                const legenda = text.trim();
                                text = legenda ? `${rawOuSintetico}\n${legenda}` : rawOuSintetico;
                                addLog(`📄 [GEMINI PDF] Documento válido! Serviço: ${analise.servico} | Valor: ${analise.valor} MT | TxnID: ${analise.txnId}`);
                                await sock.sendMessage(jid, {
                                    text: `📄 *Comprovativo PDF lido pela IA!*\n\n` +
                                          `🏦 Serviço: *${analise.servico || 'M-Pesa/e-Mola/Banco'}*\n` +
                                          `💰 Valor: *${analise.valor} MT*\n` +
                                          `🔑 Referência: *${analise.txnId}*\n\n` +
                                          `⏳ A validar com a operadora...`
                                });
                            } else if (analise && !analise.valido) {
                                await sock.sendMessage(jid, {
                                    text: `📄 Recebi o teu PDF, mas não encontrei dados de pagamento nele.\n\n` +
                                          `Por favor, envia o *SMS de confirmação* (texto) do M-Pesa ou e-Mola, ou um *print/screenshot* do comprovativo.`
                                });
                                continue;
                            } else {
                                addLog(`📄 [GEMINI PDF] Falha ao analisar PDF`);
                                await sock.sendMessage(jid, {
                                    text: `📄 Não consegui ler o PDF. Podes enviar o *texto do SMS* ou um *print* do comprovativo?`
                                });
                                continue;
                            }
                        } catch (pdfErr) {
                            addLog(`📄 [GEMINI PDF] Erro ao processar PDF: ${pdfErr.message}`);
                            await sock.sendMessage(jid, {
                                text: `📄 Tive dificuldade a ler o PDF. Tenta enviar o *SMS de texto* ou um *print* do comprovativo.`
                            });
                            continue;
                        }
                    }

                    // ── 🎙️ GEMINI AUDIO: Transcreve mensagem de voz ───────────────────────────
                    if (isAudio && geminiAI.isConfigured()) {
                        try {
                            const audioBuffer = await downloadMediaMessage(msg, 'buffer', {});
                            const audioMsg = msg.message?.audioMessage || msg.message?.pttMessage;
                            const mimeType = audioMsg?.mimetype || 'audio/ogg; codecs=opus';
                            addLog(`🎙️ [GEMINI AUDIO] Transcrevendo áudio de ${jid}`);
                            const transcricao = await geminiAI.transcreverAudio(audioBuffer, mimeType);

                            if (transcricao && transcricao.transcricao) {
                                addLog(`🎙️ [GEMINI AUDIO] Transcrição: "${transcricao.transcricao}" | Intenção: ${transcricao.intencao}`);

                                // Se identificou número e valor = cliente quer comprar
                                if (transcricao.intencao === 'compra' && transcricao.numero_destino && transcricao.valor_pedido) {
                                    text = `${transcricao.numero_destino} ${transcricao.valor_pedido}`;
                                    const payDetails = getPaymentDetails();
                                    await sock.sendMessage(jid, {
                                        text: `🎙️ *Ouvi o teu áudio com clareza!*\n\n` +
                                              `_"${transcricao.transcricao}"_\n\n` +
                                              `📱 *Número a Ativar:* ${transcricao.numero_destino}\n` +
                                              `💵 *Valor do Pacote:* ${transcricao.valor_pedido} MT\n` +
                                              `━━━━━━━━━━━━━━━━━━\n` +
                                              `⚠️ *ATENÇÃO:* Para a ativação ser concluída com sucesso, *envie aqui o SMS de confirmação (comprovativo)* do M-Pesa ou e-Mola!\n\n` +
                                              `📌 *Contas de Pagamento:*\n` +
                                              `🔴 *M-Pesa:* \`${payDetails.mpesa_num}\` (${payDetails.mpesa_name})\n` +
                                              `🟡 *e-Mola:* \`${payDetails.emola_num}\` (${payDetails.emola_name})\n\n` +
                                              `Assim que colares o texto do comprovativo ou enviares o print, os teus megas caem no mesmo segundo!`
                                    });
                                    continue;
                                } else {
                                    // Usar transcrição como texto para o Cérebro com orientação de envio de comprovativo
                                    text = transcricao.transcricao;
                                }
                            } else {
                                await sock.sendMessage(jid, {
                                    text: `🎙️ Não consegui ouvir bem. Podes enviar mensagem escrita?`
                                });
                                continue;
                            }
                        } catch (audioErr) {
                            addLog(`🎙️ [GEMINI AUDIO] Erro ao processar áudio: ${audioErr.message}`);
                            await sock.sendMessage(jid, {
                                text: `🎙️ Não consegui ouvir o áudio. Podes enviar mensagem escrita?`
                            });
                            continue;
                        }
                    }

                    if (!text.trim()) continue;

                    addLog(`📨 [RECEBIDA] JID: ${jid.endsWith('@g.us') ? 'GRUPO' : 'PRIVADO'} (${jid}) | Texto: "${text.slice(0, 50)}"`);

                    // Candidatos a identificador do remetente (suporte a LID e números alternativos)
                    let realSender = msg.key.participant || msg.participant || msg.key.remoteJidAlt || jid;
                    if (String(realSender).endsWith('@lid')) {
                        if (msg.key.remoteJidAlt && !String(msg.key.remoteJidAlt).endsWith('@lid')) {
                            realSender = msg.key.remoteJidAlt;
                        } else if (msg.key.participantPn && !String(msg.key.participantPn).endsWith('@lid')) {
                            realSender = msg.key.participantPn;
                        } else if (msg.participantPn && !String(msg.participantPn).endsWith('@lid')) {
                            realSender = msg.participantPn;
                        }
                    }

                    const rawLidClean = (msg.key.participant && String(msg.key.participant).endsWith('@lid'))
                        ? String(msg.key.participant).replace(/\D/g, '')
                        : (String(realSender).endsWith('@lid') ? String(realSender).replace(/\D/g, '') : null);

                    let senderClean = String(realSender).split('@')[0].split(':')[0].replace(/\D/g, '');

                    // Se senderClean parece número real de Moçambique, registrar no mapa se houver LID
                    const isSenderPhone = (senderClean.length === 12 && senderClean.startsWith('258') && /^2588[2-7]\d{7}$/.test(senderClean)) ||
                                          (senderClean.length === 9 && /^8[2-7]\d{7}$/.test(senderClean));
                    if (isSenderPhone && rawLidClean) {
                        lidToPhoneMap.set(rawLidClean, senderClean.startsWith('258') ? senderClean : '258' + senderClean);
                    } else if (!isSenderPhone && rawLidClean && lidToPhoneMap.has(rawLidClean)) {
                        // Se o senderClean é um LID, resgatar o telefone real previamente associado
                        senderClean = lidToPhoneMap.get(rawLidClean);
                    }

                    const senderNumber = senderClean; // Alias utilizado em toda a lógica abaixo
                    // Remove menções (@258... ou @nome) e cria comando limpo sem prefixos (. ! / #)
                    const textSemMencoes = text.replace(/@\d+/g, '').replace(/@[\w.-]+/g, '').trim();
                    const cleanText = (textSemMencoes || text).trim().toLowerCase();
                    const cleanCmd = cleanText.replace(/^[.!/#]/, '').trim();

                    // Normalizador de opções numéricas (1, 1., 1), [1], opção 1, opcao 1, numero 1, 1 - menu, etc.)
                    const sLimpoOpcao = cleanCmd.replace(/^[\[(]/, '').replace(/[\])]$/, '').trim();
                    const matchOpcaoMenu = sLimpoOpcao.match(/^(?:op[cç][aã]o|opt|n[uú]mero|n[oº]|n)?\s*([1-7])(?:\s*[.):\-—]|\s+.*|$)/i) ||
                                           cleanCmd.match(/^([1-7])\uFE0F?\u20E3?$/);
                    const opcaoMenuNum = matchOpcaoMenu ? matchOpcaoMenu[1] : null;

                    // Lista de todos os identificadores possíveis que o Baileys nos dá
                    const candidateSenders = [
                        msg.key?.participantPn,
                        msg.participantPn,
                        msg.key?.participant,
                        msg.participant,
                        msg.key?.remoteJidAlt,
                        msg.key?.remoteJid,
                        realSender,
                        senderNumber
                    ].filter(Boolean);

                    let senderIsMaster = candidateSenders.some(s => isMaster(s));

                    // 🛡️ SEGURANÇA: Administradores de Grupo de WhatsApp NÃO são Master do Sistema.
                    // Apenas os números estritamente cadastrados em getMasterNumbers() possuem poderes de envio manual e controle.

                    // Se o remetente for master e tiver LID, salvar dinamicamente esse LID para sempre reconhecer
                    if (senderIsMaster) {
                        for (const cand of candidateSenders) {
                            if (String(cand).endsWith('@lid')) {
                                const lidClean = String(cand).replace(/\D/g, '');
                                if (!DYN_CFG.MASTER_LIDS) DYN_CFG.MASTER_LIDS = [];
                                if (!DYN_CFG.MASTER_LIDS.includes(lidClean)) {
                                    DYN_CFG.MASTER_LIDS.push(lidClean);
                                    salvarBotConfig();
                                    console.log(`👑 [MASTER LID VINCULADO] Novo LID de Admin registado: ${lidClean}`);
                                }
                                lidToPhoneMap.set(lidClean, '258850401416');
                            }
                        }
                    }

                    const nomeCliente = msg.pushName || 'Cliente';

                    // Registar Lead
                    clientesLeads.add(senderNumber);

                    console.log(`🔎 [DEBUG] sender=${senderNumber} | isMaster=${senderIsMaster} | isGrupo=${jid.endsWith('@g.us')} | banido=${banidosSet.has(senderNumber)} | modoManut=${modoManutencao}`);

                    // Se o bot estiver silenciado, ignorar TUDO (exceto master)
                    if (botSilenciado && !senderIsMaster) {
                        console.log(`🤫 [DEBUG] Bloqueado: bot silenciado`);
                        continue;
                    }

                    // Se estiver banido, ignorar
                    if (banidosSet.has(senderNumber) && !senderIsMaster) {
                        console.log(`🚫 [DEBUG] Bloqueado: banido`);
                        continue;
                    }

                    // Se o grupo estiver fechado (vendas desativadas neste grupo), ignorar silenciosamente
                    const isGrupo = jid.endsWith('@g.us');
                    const gruposFechados = DYN_CFG.GRUPOS_FECHADOS || [];
                    if (isGrupo && gruposFechados.includes(jid) && !senderIsMaster) {
                        console.log(`🚫 [DEBUG] Bloqueado: grupo fechado`);
                        // Grupo fechado — bot não responde para não-admins
                        continue;
                    }

                    // Se estiver em manutenção e não for Master, avisar
                    if (modoManutencao && !senderIsMaster) {
                        await sock.sendMessage(jid, { text: '🛑 *SISTEMA EM MANUTENÇÃO*\n\nEstamos atualizando os nossos servidores para melhor atendê-lo. Por favor, tente novamente mais tarde!' });
                        continue;
                    }


                    console.log(`📩 [MSG] ${senderNumber} ${senderIsMaster ? '👑' : ''}: ${text.substring(0, 60)}`);

                    const reply = async (resposta) => {
                        await sock.sendMessage(jid, { text: resposta });
                    };

                    // ── 🎯 COMANDOS DO FASEADO MENSAL INTERATIVO ─────────────────────────────
                    // SIM / NÃO / sacar Xgb / meu saldo — processados antes de tudo
                    const textLimpo = cleanText.trim();
                    const isSim = ['sim', 's', 'yes'].includes(textLimpo);
                    const isNao = ['nao', 'não', 'n', 'no'].includes(textLimpo);
                    const saqueRegex = /^[.!]?sacar\s+(\d+(?:[.,]\d+)?)\s*(gb|mb|g|m)?(?:\s+(?:para\s+)?(8[2-7]\d{7}))?$/i;
                    const matchSaque = textLimpo.match(saqueRegex);
                    const isSaque = !!matchSaque;
                    const isMeuSaldo = ['meu saldo', 'saldo', 'meu plano', 'plano'].includes(textLimpo);

                    if (isSim || isNao) {
                        // Verificar se tem plano faseado_mensal aguardando confirmação
                        const apiBase = `http://localhost:${process.env.PORT || 3000}`;
                        try {
                            const axios = require('axios');
                            const endpoint = isSim ? '/api/plans/confirmar' : '/api/plans/pular';
                            const resp = await axios.post(`${apiBase}${endpoint}`, { numero: senderNumber }, { timeout: 8000 });
                            if (resp.data && resp.data.success) {
                                await reply(resp.data.mensagem);
                                addLog(`✅ [PLANO MENSAL] ${senderNumber} → ${isSim ? 'SIM' : 'NÃO'} | ${resp.data.acao}`);
                                continue;
                            }
                            // Se não houver plano pendente, deixar cair para processamento normal
                        } catch (e) { /* continuar processamento normal se erro */ }
                    }

                    if (isSaque) {
                        try {
                            const axios = require('axios');
                            const qtd = parseFloat(matchSaque[1].replace(',', '.'));
                            const unidade = (matchSaque[2] || 'mb').toLowerCase();
                            const mbSolicitado = (unidade === 'gb' || unidade === 'g') ? Math.round(qtd * 1024) : Math.round(qtd);
                            const numDestinoSaque = matchSaque[3] ? matchSaque[3].slice(-9) : null;
                            const apiBase = `http://localhost:${process.env.PORT || 3000}`;
                            const resp = await axios.post(`${apiBase}/api/plans/saque`, {
                                numero: senderNumber,
                                mb: mbSolicitado,
                                numero_destino: numDestinoSaque
                            }, { timeout: 8000 });
                            if (resp.data && resp.data.success) {
                                await reply(resp.data.mensagem);
                                addLog(`💸 [SAQUE] ${senderNumber} → ${mbSolicitado}MB (Destino: ${numDestinoSaque || senderNumber}) | Saldo: ${resp.data.saldo_restante}MB`);
                            } else {
                                await reply(`❌ ${resp.data?.error || 'Não foi possível processar o saque. Verifique o seu saldo com *meu saldo*.'}`);
                            }
                            continue;
                        } catch (e) {
                            await reply(`❌ Erro ao processar saque: ${e.response?.data?.error || e.message}`);
                            continue;
                        }
                    }

                    if (isMeuSaldo) {
                        try {
                            const axios = require('axios');
                            const apiBase = `http://localhost:${process.env.PORT || 3000}`;
                            const resp = await axios.get(`${apiBase}/api/plans/meu-saldo/${senderNumber}`, { timeout: 5000 });
                            if (resp.data && resp.data.success && resp.data.planos.length > 0) {
                                const p = resp.data.planos[0];
                                const tipoLabel = p.tipo === 'faseado_mensal' ? 'Faseado Mensal' : p.tipo === 'faseado' ? 'Faseado' : 'Renovável';
                                const proxData = p.proxima_entrega ? new Date(p.proxima_entrega).toLocaleString('pt-PT', { timeZone: 'Africa/Maputo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'N/A';
                                const mbDiarF = p.mb_diaria >= 1024 ? `${(p.mb_diaria/1024).toFixed(1)}GB` : `${p.mb_diaria}MB`;
                                const confMsg = p.aguardando_confirmacao ? `\n\n❓ *Entrega pendente de confirmação!* Responda *SIM* para receber ou *NÃO* para adiar.` : '';
                                await reply(
                                    `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n` +
                                    `  📊 *MEU PLANO KA-NET* 📊\n` +
                                    `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                                    `📦 *Tipo:* ${tipoLabel}\n` +
                                    `💾 *Saldo Restante:* *${p.saldo_formatado}*\n` +
                                    `📅 *Entrega diária:* ${mbDiarF}\n` +
                                    `⏰ *Próxima entrega:* ${proxData}\n` +
                                    `✅ *Entregas feitas:* ${p.entregas_feitas}` +
                                    confMsg +
                                    `\n\n💡 Use *sacar Xgb* para sacar a qualquer hora.`
                                );
                                addLog(`📊 [MEU SALDO] ${senderNumber} consultou saldo: ${p.saldo_formatado}`);
                                continue;
                            }
                        } catch (e) { /* sem plano — resposta normal abaixo */ }
                    }
                    // ── FIM DOS COMANDOS DO FASEADO MENSAL ───────────────────────────────────

                    // ── 1. AGUARDANDO NÚMERO DE DESTINO APÓS COMPROVATIVO ──

                    // Caso o cliente esteja aguardando validação da operadora e tenha enviado o número agora:
                    const itemAguardandoOp = [...aguardandoOperadora.values()].find(it => 
                        (it.senderNumber === senderNumber || (rawLidClean && it.rawLidClean === rawLidClean) || it.jid === jid) && !it.numDestino
                    );
                    if (itemAguardandoOp) {
                        const numDestino = extrairNumeroDestino(text);
                        if (numDestino) {
                            itemAguardandoOp.numDestino = numDestino;
                            salvarAguardandoOperadora();
                            if (rawLidClean) {
                                lidToPhoneMap.set(rawLidClean, numDestino.startsWith('258') ? numDestino : '258' + numDestino);
                            }
                            await reply(
                                `📲 *NÚMERO DE DESTINO REGISTADO:* *${numDestino}*\n\n` +
                                `⏳ O seu comprovativo (\`${itemAguardandoOp.txn_id}\`) continua no status *Aguardando Confirmação da Operadora*.\n` +
                                `Assim que a rede ${itemAguardandoOp.metodoNome} confirmar o valor (*${itemAguardandoOp.valor} MT*), o pacote será enviado imediatamente para este número!`
                            );
                            continue;
                        }
                    }

                    const pendingMatch = findPendingPayment(jid, senderNumber, rawLidClean);
                    if (pendingMatch) {
                        const { key: targetKey, pay } = pendingMatch;
                        if (pay.aguardando_numero) {
                            // Se o cliente enviar "1", "menu", "cancelar" ou "sair", liberta o pagamento pendente para permitir ver o menu
                            if (opcaoMenuNum === '1' || ['menu', 'tabela', 'cancelar', 'sair', 'voltar', 'tabelas'].includes(cleanCmd)) {
                                pendingPayments.delete(targetKey);
                            } else
                            // ── NOVO: PAGAMENTO COMBINADO / SOMA DE COMPROVATIVOS SEQUENCIAIS ──
                            if (isComprovativo(text)) {
                                const novoValor = extrairValorMT(text);
                                const novoTxnId = extrairTxId(text);
                                const isEmolaPattern = /^(ID\s*(da\s*)?transa[cç][aã]o|Transaction\s*ID|ID\s*Trans)/i.test(text.trim());
                                const isMpesaPattern = /^Confirmado\s+[A-Z0-9]{8,}|PP2\d{5}\.\d{4}/i.test(text.trim());
                                const novoMetodo = isEmolaPattern ? 'emola' : isMpesaPattern ? 'mpesa' : /e-?mola|emola|movitel|864882152/i.test(text) ? 'emola' : 'mpesa';
                                const novoMetodoNome = novoMetodo === 'emola' ? 'e-Mola' : 'M-Pesa';

                                // 1. Verificar se é repetição da mesma sessão
                                if (novoTxnId && (pay.txn_id === novoTxnId || (Array.isArray(pay.txn_ids) && pay.txn_ids.includes(novoTxnId)))) {
                                    const vTotal = pay.valor_total || pay.valor;
                                    await reply(
                                        `⚠️ *COMPROVATIVO JÁ ADICIONADO!*\n━━━━━━━━━━━━━━━━━━\n` +
                                        `A transação (\`${novoTxnId}\`) já foi registrada no seu pagamento pendente.\n\n` +
                                        `💰 *Total Acumulado:* *${vTotal} MT*\n` +
                                        `📲 Por favor, envie agora o seu *número Vodacom* que deve receber os megas.`
                                    );
                                    continue;
                                }

                                // 2. Verificar se a transação é falsa ou já utilizada no sistema
                                let jaUsada = false;
                                if (novoTxnId) {
                                    if (transacoesProcessadas.has(novoTxnId)) jaUsada = true;
                                    const reg = transacoesProcessadasMap.get(novoTxnId);
                                    if (reg && (reg.status === 'completed' || (reg.sender && reg.sender !== senderNumber))) {
                                        jaUsada = true;
                                    }
                                }

                                if (jaUsada || !novoValor) {
                                    const valorValido = pay.valor_total || pay.valor;
                                    const pacValido = buscarPacotePorValor(valorValido, jid);
                                    await reply(
                                        `⚠️ *SEGUNDO COMPROVATIVO INVÁLIDO OU JÁ UTILIZADO* ❌\n━━━━━━━━━━━━━━━━━━\n` +
                                        `A transação (\`${novoTxnId || 'N/D'}\`) é inválida ou já foi utilizada anteriormente no sistema.\n\n` +
                                        `💰 *Saldo Válido Mantido:* *${valorValido} MT*\n` +
                                        `📦 *Pacote Correspondente:* *${pacValido ? pacValido.nome : valorValido + ' MT'}*\n\n` +
                                        `📲 *O que fazer agora:*\n` +
                                        `• Envie agora o seu *número Vodacom* para receber o pacote referente aos *${valorValido} MT* já confirmados.\n` +
                                        `• Ou envie outro comprovativo válido caso deseje somar mais valor!`
                                    );
                                    continue;
                                }

                                // 3. Transação válida! Acumular saldo
                                if (!Array.isArray(pay.txn_ids)) pay.txn_ids = [pay.txn_id];
                                if (!Array.isArray(pay.transacoes)) pay.transacoes = [{ txn_id: pay.txn_id, valor: parseFloat(pay.valor), metodo: pay.metodo || 'mpesa', metodoNome: pay.metodo === 'emola' ? 'e-Mola' : 'M-Pesa', validado: true }];

                                pay.txn_ids.push(novoTxnId);
                                pay.transacoes.push({
                                    txn_id: novoTxnId,
                                    valor: parseFloat(novoValor),
                                    metodo: novoMetodo,
                                    metodoNome: novoMetodoNome,
                                    validado: true
                                });
                                pay.valor_total = (pay.valor_total || parseFloat(pay.valor)) + parseFloat(novoValor);
                                pay.valor = pay.valor_total;
                                pay.pacote = buscarPacotePorValor(pay.valor_total, jid);

                                // Lock no banco de transações
                                transacoesProcessadas.add(novoTxnId);
                                transacoesProcessadasMap.set(novoTxnId, {
                                    sender: senderNumber,
                                    jid,
                                    valor: parseFloat(novoValor),
                                    status: 'locked',
                                    timestamp: Date.now()
                                });
                                salvarTransacoes();

                                // Marcar SMS da operadora como usado se já tiver chegado
                                const smsOp = findSmsPayment(novoTxnId);
                                if (smsOp) {
                                    smsOp.usado = true;
                                    smsOp.usadoPor = senderNumber;
                                    smsOp.usadoEm = Date.now();
                                    salvarSmsPayments();
                                }

                                // Verificar se o cliente já enviou o número na linha abaixo do 2º comprovativo
                                const numDestinoInline2 = extrairNumeroDestinoAbaixoDoComprovativo(text);
                                if (!numDestinoInline2) {
                                    const listaTxns = pay.transacoes.map((t, idx) => `  ${idx + 1}. *${t.valor} MT* (${t.metodoNome || t.metodo} - \`${t.txn_id}\`)`).join('\n');
                                    const pacoteAtual = pay.pacote;
                                    const volStr = pacoteAtual && pacoteAtual.mb ? (pacoteAtual.mb >= 1024 ? `${(pacoteAtual.mb/1024).toFixed(1)}GB` : `${pacoteAtual.mb}MB`) : '';

                                    await reply(
                                        `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n` +
                                        `  🎉 *PAGAMENTO COMBINADO ADICIONADO!* ➕\n` +
                                        `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                                        `Mais *${novoValor} MT* (${novoMetodoNome}) adicionados à sua compra!\n\n` +
                                        `📋 *Comprovativos Juntos:*\n` +
                                        listaTxns + `\n` +
                                        `━━━━━━━━━━━━━━━━━━\n` +
                                        `💰 *TOTAL ACUMULADO:* *${pay.valor_total} MT*\n` +
                                        `📦 *Pacote Resultante:* *${pacoteAtual ? pacoteAtual.nome : pay.valor_total + ' MT'}*${volStr ? ' (' + volStr + ')' : ''}\n\n` +
                                        `📲 *PARA QUAL NÚMERO DEVEMOS ENVIAR?\n` +
                                        `Por favor, envie agora o seu *número Vodacom* (ex: *84XXXXXXX* ou *85XXXXXXX*).\n` +
                                        `_(Ou envie mais um comprovativo se desejar somar mais valor)_`
                                    );
                                    continue;
                                }
                            }
                            // ── MULTI-DESTINO QUANDO O CLIENTE ENVIA MÚLTIPLOS NÚMEROS APÓS O COMPROVATIVO ──
                            const textoAbaixo2 = extrairTextoAbaixoDoComprovativo(text);
                            const multiDest = customerServices.parseMultiDestino(textoAbaixo2 || text, parseFloat(pay.valor), (v) => buscarPacotePorValor(v, jid));
                            if (multiDest && multiDest.length >= 2) {
                                pendingPayments.delete(targetKey);
                                multiDest.forEach((item, idx) => {
                                    const subOrderId = `WA-${pay.txn_id}-${idx + 1}-${Date.now()}`;
                                    historicoVendas.push({
                                        orderId: subOrderId,
                                        numero: item.phone,
                                        mb: item.mb,
                                        valor: parseFloat(pay.valor) / multiDest.length,
                                        timestamp: Date.now()
                                    });
                                    if (orderDispatchCallback) {
                                        orderDispatchCallback({
                                            orderId: subOrderId,
                                            numero: item.phone,
                                            quantidade: item.mb,
                                            modo: 'diario',
                                            jid,
                                            sender: pay.senderNumber || senderNumber,
                                            senderName: pay.senderName || nomeCliente,
                                            txn_id: `${pay.txn_id}-${idx + 1}`,
                                            valor: parseFloat(pay.valor) / multiDest.length
                                        });
                                    }
                                });

                                if (pay.txn_id) {
                                    transacoesProcessadas.add(pay.txn_id);
                                    transacoesProcessadasMap.set(pay.txn_id, {
                                        sender: senderNumber,
                                        jid,
                                        destinos: multiDest,
                                        valor: parseFloat(pay.valor),
                                        status: 'completed',
                                        completedAt: Date.now()
                                    });
                                    salvarTransacoes();
                                }

                                const { supportNum } = getSuporteDetails();
                                const resumo = multiDest.map((d, i) => {
                                    const vol = d.mb >= 1024 ? `${(d.mb/1024).toFixed(1)}GB` : `${d.mb}MB`;
                                    return `  ${i + 1}. *${d.phone}* ➔ *${vol}*`;
                                }).join('\n');

                                await reply(
                                    `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n` +
                                    `  🎉 *PAGAMENTO DIVIDIDO COM SUCESSO!* ⚡\n` +
                                    `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                                    `O seu pagamento de *${pay.valor} MT* foi validado e distribuído entre *${multiDest.length} destinatários*:\n\n` +
                                    resumo + `\n\n` +
                                    `🔖 *Ref:* \`${pay.txn_id}\`\n` +
                                    `🚀 *Todas as ativações automáticas já foram despachadas!*\n\n` +
                                    `📞 *Suporte:* Envie *Suporte* ou ligue para *${supportNum}*`
                                );
                                if (geminiAI.isConfigured()) geminiAI.limparHistoricoConversa(senderNumber);
                                continue;
                            }

                            const numDestino = extrairNumeroDestino(text);
                            if (numDestino) {
                                pendingPayments.delete(targetKey);
                                if (rawLidClean) {
                                    lidToPhoneMap.set(rawLidClean, numDestino.startsWith('258') ? numDestino : '258' + numDestino);
                                }
                                const isCombined = Array.isArray(pay.transacoes) && pay.transacoes.length > 1;
                                const combinedTxnId = (pay.txn_ids && pay.txn_ids.length > 0) ? pay.txn_ids.join('+') : pay.txn_id;
                                const valorFinal = pay.valor_total || parseFloat(pay.valor);
                                const pacote = pay.pacote || buscarPacotePorValor(valorFinal, jid);
                                const orderId = 'WA-' + (isCombined ? pay.txn_ids[0] : pay.txn_id) + '-' + Date.now();

                                const { supportNum } = getSuporteDetails();
                                const metodoStr = isCombined
                                    ? pay.transacoes.map(t => `${t.valor} MT (${t.metodoNome || t.metodo})`).join(' + ')
                                    : `${valorFinal} MT (${pay.metodo === 'emola' ? 'e-Mola' : 'M-Pesa'})`;

                                await reply(
                                    `✅ *PEDIDO RECEBIDO* ⚡\n` +
                                    `━━━━━━━━━━━━━━━━━━\n` +
                                    `📦 *Pacote:* *${pacote ? pacote.nome : valorFinal + ' MT'}*\n` +
                                    `📲 *Destino:* *${numDestino}*\n` +
                                    `💳 *Valor:* *${metodoStr}*\n` +
                                    `🔖 *Ref:* \`${combinedTxnId}\`\n` +
                                    `━━━━━━━━━━━━━━━━━━\n` +
                                    `🚀 *Ativação em andamento...*\n` +
                                    `_Receberá a confirmação em instantes._`
                                );

                                // Registar venda
                                historicoVendas.push({
                                    orderId,
                                    numero: numDestino,
                                    mb: pacote ? pacote.mb : 1024,
                                    valor: parseFloat(pay.valor),
                                    timestamp: Date.now()
                                });
                                if (isCombined && Array.isArray(pay.transacoes)) {
                                    for (const t of pay.transacoes) {
                                        transacoesProcessadas.add(t.txn_id);
                                        const reg = transacoesProcessadasMap.get(t.txn_id) || {};
                                        transacoesProcessadasMap.set(t.txn_id, {
                                            ...reg,
                                            sender: senderNumber,
                                            jid,
                                            numeroDestino: numDestino,
                                            valor: t.valor,
                                            status: 'completed',
                                            completedAt: Date.now(),
                                            isCombined: true,
                                            parentTxn: combinedTxnId
                                        });
                                    }
                                    salvarTransacoes();
                                } else if (pay.txn_id) {
                                    transacoesProcessadas.add(pay.txn_id);
                                    const reg = transacoesProcessadasMap.get(pay.txn_id) || {};
                                    transacoesProcessadasMap.set(pay.txn_id, {
                                        ...reg,
                                        sender: senderNumber,
                                        jid,
                                        numeroDestino: numDestino,
                                        valor: valorFinal,
                                        status: 'completed',
                                        completedAt: Date.now()
                                    });
                                    salvarTransacoes();
                                }

                                const origemMsg = jid.endsWith('@g.us') ? 'Grupo WhatsApp' : 'Privado';
                                const tabelaOrigem = pacote && pacote.origem === 'grupo_especifico' ? 'Tabela Exclusiva deste Grupo' : 'Tabela Padrão Geral';
                                enviarNotificacaoGrupo(
                                    `🔔 *NOVO PEDIDO REGISTADO* ⚡\n` +
                                    `━━━━━━━━━━━━━━━━━━\n` +
                                    `📋 *Ref:* \`${orderId}\`\n` +
                                    `📲 *Destino:* *${numDestino}*\n` +
                                    `📦 *Pacote:* *${pacote ? pacote.nome : pay.valor + ' MT'}*\n` +
                                    `💳 *Valor:* *${pay.valor} MT* (${pay.metodo === 'emola' ? 'e-Mola' : 'M-Pesa'})\n` +
                                    `👤 *Cliente:* *${nomeCliente}* (${senderNumber})\n` +
                                    `🏢 *Origem:* *${origemMsg}*\n` +
                                    `🏷️ *Tabela:* *${tabelaOrigem}*\n` +
                                    `🕒 *Hora:* ${new Date().toLocaleString('pt-PT', { timeZone: 'Africa/Maputo' })}\n` +
                                    `━━━━━━━━━━━━━━━━━━\n` +
                                    `⏳ *Status:* Enviado para o Celular USSD`
                                );

                                if (orderDispatchCallback) {
                                    orderDispatchCallback({
                                        orderId,
                                        numero: numDestino,
                                        quantidade: pacote ? pacote.mb : 1024,
                                        modo: pacote ? pacote.tipo : 'diario',
                                        jid,
                                        sender: pay.senderNumber || senderNumber,
                                        senderName: pay.senderName || nomeCliente,
                                        txn_id: combinedTxnId,
                                        valor: valorFinal
                                    });
                                }
                                if (geminiAI.isConfigured()) geminiAI.limparHistoricoConversa(senderNumber);
                                continue;
                            } else {
                                if (isNumeroDeposito(text)) {
                                    await reply(`⚠️ O número digitado (*${text.trim()}*) é a conta de depósito do sistema.\n\nPor favor, envie o seu *próprio número Vodacom* (ex: *84XXXXXXX* ou *85XXXXXXX*) para onde deseja receber a recarga.`);
                                    continue;
                                }
                                // Se for em grupo e o texto não parecer minimamente um número (ex: conversa normal), ignora
                                const pareceNumero = /\d{4,}/.test(text);
                                if (pareceNumero || !jid.endsWith('@g.us')) {
                                    await reply(`⚠️ Por favor, envie um número Vodacom válido com 9 dígitos (ex: *84XXXXXXX* ou *85XXXXXXX*).`);
                                    continue;
                                }
                            }
                        }
                    }

                    // ── 1.0 COMANDO PARA TESTAR BOAS-VINDAS NO GRUPO ──
                    if (cleanCmd === 'testarboasvindas' || cleanCmd === '.testarboasvindas' || cleanCmd === 'boasvindas' || cleanCmd === '.boasvindas') {
                        if (jid.endsWith('@g.us')) {
                            let gName = 'Grupo Ka-Net';
                            try {
                                const meta = await getCachedGroupMetadata(jid);
                                if (meta && meta.subject) gName = meta.subject;
                            } catch (_) {}
                            const welcomeObj = gerarMensagemBoasVindasGrupo(gName, [senderNumber + '@s.whatsapp.net']);
                            await sock.sendMessage(jid, {
                                text: welcomeObj.text,
                                mentions: welcomeObj.mentions
                            });
                            addLog(`🧪 [TESTE BOAS-VINDAS GRUPO] Disparado por ${senderNumber} em ${jid}`);
                            continue;
                        } else {
                            await reply('💡 Envie *.testarboasvindas* dentro de um *grupo* para visualizar a mensagem que os novos membros recebem!');
                            continue;
                        }
                    }

                    // ── 1.1 COMANDO .txenecar / .txenekar (CRÉDITO DE INTERNET DIÁRIO) ──
                    const ehCmdTxenecar = cleanCmd === 'txenecar' || cleanCmd.startsWith('txenecar ') ||
                                          cleanCmd === 'txenekar' || cleanCmd.startsWith('txenekar ') ||
                                          cleanCmd === 'txeneco' || cleanCmd.startsWith('txeneco ');
                    if (ehCmdTxenecar) {
                        const rawArgs = text.replace(/^[.!/#]?(txenecar|txenekar|txeneco)\s*/i, '').trim();
                        if (!rawArgs) {
                            await reply(gerarInfoTxenecoCompleta(senderNumber));
                            continue;
                        }

                        const parts = rawArgs.split(/\s+/);
                        let rawQtd = parts[0];
                        let rawDest = parts[1] || (parts[2] ? parts[2] : null);

                        let mbNum = 0;
                        if (/gb|g$/i.test(rawQtd)) {
                            mbNum = Math.round(parseFloat(rawQtd.replace(/,/g, '.').replace(/[^\d.]/g, '')) * 1024);
                        } else if (/mb|m$/i.test(rawQtd)) {
                            mbNum = Math.round(parseFloat(rawQtd.replace(/,/g, '.').replace(/[^\d.]/g, '')));
                        } else {
                            const val = parseFloat(rawQtd.replace(/,/g, '.'));
                            if (!isNaN(val)) {
                                mbNum = val <= 10 ? Math.round(val * 1024) : Math.round(val);
                            }
                        }

                        const destNum = extrairNumeroDestino(rawDest || rawArgs) || (parts.length >= 2 ? extrairNumeroDestino(parts[parts.length - 1]) : null);

                        if (!destNum) {
                            await reply(`⚠️ Número de destino não encontrado. Use:\n👉 *.txenecar ${rawQtd} <número_vodacom>*\nExemplo: *.txenecar 1gb 841234567*`);
                            continue;
                        }

                        const resTxn = await customerServices.solicitarTxeneco({
                            senderPhone: senderNumber,
                            mbSolicitado: mbNum,
                            numDestino: destNum,
                            jid,
                            senderName: nomeCliente
                        });
                        await reply(resTxn.mensagem);
                        continue;
                    }

                    // ── 1.2 COMANDO .pagar (LIQUIDAÇÃO OU AMORTIZAÇÃO DE DÍVIDA DE TXENECO) ──
                    const ehCmdPagar = cleanCmd === 'pagar' || cleanCmd.startsWith('pagar ') ||
                                       cleanCmd === 'pagardivida' || cleanCmd.startsWith('pagardivida ');
                    if (ehCmdPagar) {
                        const rawComprovativo = text.replace(/^[.!/#]?(pagardivida|pagar)\s*/i, '').trim();
                        if (!rawComprovativo) {
                            const divida = customerServices.getClienteDivida(targetPhone);
                            if (!divida || !divida.restanteMt || divida.restanteMt <= 0) {
                                await reply(
                                    `ℹ️ *SEM DÍVIDAS DE TXENECO*\n━━━━━━━━━━━━━━━━━━\n` +
                                    `Você não possui nenhuma dívida ativa de Txeneco pendente.\n` +
                                    `O seu limite de crédito está totalmente livre!`
                                );
                            } else {
                                await reply(
                                    `📌 *SUA DÍVIDA ATIVA DE TXENECO*\n━━━━━━━━━━━━━━━━━━\n` +
                                    `💰 *Valor restante devido:* *${divida.restanteMt} MT*\n` +
                                    `💾 *Volume em uso:* *${divida.activeDebtMb || 0} MB*\n\n` +
                                    `💡 Para liquidar total ou parcialmente, efetue a transferência M-Pesa ou e-Mola e envie:\n` +
                                    `👉 *.pagar <comprovativo>*`
                                );
                            }
                            continue;
                        }

                        const valorPago = extrairValorMT(rawComprovativo);
                        const txnId = extrairTxId(rawComprovativo);

                        const resPagar = await customerServices.processarPagamentoDivida({
                            senderPhone: senderNumber,
                            valorPago,
                            txnId,
                            rawText: rawComprovativo,
                            jid
                        });

                        if (resPagar.success && txnId) {
                            transacoesProcessadas.add(txnId);
                            transacoesProcessadasMap.set(txnId, {
                                sender: senderNumber,
                                jid,
                                valor: valorPago,
                                status: 'completed',
                                tipo: 'pagamento_txeneco',
                                timestamp: Date.now()
                            });
                            salvarTransacoes();
                            const smsRec = findSmsPayment(txnId);
                            if (smsRec) {
                                smsRec.usado = true;
                                smsRec.usadoPor = `${senderNumber}_txeneco_quitacao`;
                                smsRec.usadoEm = Date.now();
                                salvarSmsPayments();
                            }
                        }

                        await reply(resPagar.mensagem);

                        // 🎉 Agradecimento público no grupo onde o cliente solicitou ou no grupo oficial
                        if (resPagar.quitado) {
                            let grupoAgradecimento = null;
                            if (jid.endsWith('@g.us')) grupoAgradecimento = jid;
                            else if (resPagar.jidOrigem && resPagar.jidOrigem.endsWith('@g.us')) grupoAgradecimento = resPagar.jidOrigem;
                            else if (DYN_CFG.GRUPO_NOTIFICACOES) grupoAgradecimento = DYN_CFG.GRUPO_NOTIFICACOES;

                            if (grupoAgradecimento && sock) {
                                const mentionUser = `258${senderNumber}@s.whatsapp.net`;
                                sock.sendMessage(grupoAgradecimento, {
                                    text: `🎉 *TXENECO REGULARIZADO COM SUCESSO!* 👏\n` +
                                          `━━━━━━━━━━━━━━━━━━\n` +
                                          `O cliente @${senderNumber} acabou de quitar 100% da sua dívida de Txeneco!\n\n` +
                                          `🔓 *Status:* Crédito totalmente restaurado!\n` +
                                          `🙏 *MUITO OBRIGADO PELA SUA PREFERÊNCIA E HONESTIDADE!* 🌟✨`,
                                    mentions: [mentionUser]
                                }).catch(e => console.warn('⚠️ Erro ao postar agradecimento no grupo:', e.message));
                            }
                        }

                        continue;
                    }

                    // ── 1.3 COMANDOS DE CONFIGURAR NÚMERO / RECEPTOR PADRÃO ──
                    const ehCmdConfigurar = 
                        cleanCmd.startsWith('configurar') || cleanCmd.startsWith('configurarnumero') ||
                        cleanCmd.startsWith('definirreceptor') || cleanCmd.startsWith('setreceptor') || cleanCmd.startsWith('receptor') ||
                        cleanCmd.startsWith('definirnumero') || cleanCmd.startsWith('setnumero');

                    if (ehCmdConfigurar) {
                        const rawBody = text.replace(/^[.!/#]?(configurar|configurarnumero|definirreceptor|setreceptor|receptor|definirnumero|setnumero)\s*/i, '').trim();

                        let pagadores = [];
                        let receptor = null;

                        // Extrair numeros COM repeticoes para detectar numero duplicado
                        const rawAllNums = [...rawBody.matchAll(/(?:258)?(8[2-7]\d{7})/g)].map(m => m[1]);

                        if (rawAllNums.length === 0) {
                            await reply(gerarGuiaConfigurarNumero(senderNumber));
                            continue;

                        } else if (rawAllNums.length === 1) {
                            // Apenas 1 numero unico: receptor e esse
                            receptor = rawAllNums[0];
                            const cleanSender = customerServices.normalizarTelefone(senderNumber);
                            if (cleanSender && cleanSender.length === 9) {
                                pagadores = [cleanSender, receptor];
                            } else {
                                // Se veio de grupo anônimo / LID, o número informado é tanto pagador quanto receptor
                                pagadores = [receptor];
                            }
                            if (rawLidClean) {
                                lidToPhoneMap.set(rawLidClean, '258' + receptor);
                            }

                        } else {
                            // LOGICA: ULTIMO numero = receptor, PRIMEIROS = pagadores
                            // Se o receptor aparecer repetido, e tambem pagador.
                            //
                            // Exemplos:
                            //   .configurar 851234567 849998888             -> receptor=849998888, pagador=851234567
                            //   .configurar 856268811 840401416 840401414   -> receptor=840401414, pagadores=[856268811,840401416]
                            //   .configurar 856268811 840401416 para 840401414 -> receptor=840401414, pagadores=[856268811,840401416]
                            //   .configurar 856268811 840401416 para 840401416 -> receptor=840401416, pagadores=[856268811,840401416]
                            //   .configurar 840401416 840401416 -> receptor=840401416, pagadores=[840401416]

                            receptor = rawAllNums[rawAllNums.length - 1];
                            const pagadoresRaw    = rawAllNums.slice(0, -1);
                            const receptorRepetido = pagadoresRaw.includes(receptor);

                            pagadores = [...new Set(pagadoresRaw)];
                            if (!receptorRepetido) {
                                pagadores = pagadores.filter(p => p !== receptor);
                            }
                            if (pagadores.length === 0) pagadores = [receptor];

                            // Se o número de WhatsApp do cliente for válido de 9 dígitos e não estiver na lista, incluir
                            const cleanSender = customerServices.normalizarTelefone(senderNumber);
                            if (cleanSender && cleanSender.length === 9 && !pagadores.includes(cleanSender)) {
                                pagadores.push(cleanSender);
                            }
                            if (rawLidClean) {
                                lidToPhoneMap.set(rawLidClean, '258' + receptor);
                            }
                        }

                        const resDef = customerServices.definirReceptorPadrao(pagadores, receptor, jid);
                        await reply(resDef.mensagem);
                        continue;
                    }

                    const ehCmdRemoverReceptor = 
                        cleanCmd === 'removerreceptor' || cleanCmd.startsWith('removerreceptor ') ||
                        cleanCmd === 'limparreceptor' || cleanCmd === 'delreceptor' ||
                        cleanCmd === 'desconfigurar' || cleanCmd.startsWith('desconfigurar ') ||
                        cleanCmd === 'removernumero' || cleanCmd.startsWith('removernumero ') ||
                        cleanCmd === 'limparnumero';

                    if (ehCmdRemoverReceptor) {
                        const rawTarget = text.replace(/^[.!/#]?(removerreceptor|limparreceptor|delreceptor|desconfigurar|removernumero|limparnumero)\s*/i, '').trim();
                        const pagador = extrairNumeroDestino(rawTarget);
                        let ownerRef = senderNumber;
                        if (rawLidClean && lidToPhoneMap.has(rawLidClean)) {
                            ownerRef = lidToPhoneMap.get(rawLidClean);
                        }
                        const resRem = customerServices.removerReceptorPadrao(pagador, ownerRef);
                        await reply(resRem.mensagem);
                        continue;
                    }

                    const ehCmdMeuReceptor = 
                        cleanCmd === 'meureceptor' || cleanCmd === 'receptorpadrao' || cleanCmd === 'verreceptor' ||
                        cleanCmd === 'meunumero' || cleanCmd === 'vernumero' || cleanCmd === 'consultarnumero' ||
                        cleanCmd === 'meu numero' || cleanCmd === 'ver numero' ||
                        cleanCmd.startsWith('meureceptor ') || cleanCmd.startsWith('meunumero ');

                    if (ehCmdMeuReceptor) {
                        const argNum = extrairNumeroDestino(text.replace(/^[.!/#]?(meureceptor|receptorpadrao|verreceptor|meunumero|vernumero|consultarnumero|meu numero|ver numero)\s*/i, ''));
                        const targetConsult = argNum || senderNumber;
                        let lista = customerServices.obterReceptoresPorOwner(targetConsult);
                        if ((!lista || lista.length === 0) && rawLidClean && lidToPhoneMap.has(rawLidClean)) {
                            lista = customerServices.obterReceptoresPorOwner(lidToPhoneMap.get(rawLidClean));
                        }
                        if (lista && lista.length > 0) {
                            const receptorFixo = lista[0].targetPhone;
                            const linhasPagadores = lista.map((r, i) => `  ${i + 1}. *${r.payerPhone}*`).join('\n');
                            await reply(
                                `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n` +
                                `  📱 *SEU NÚMERO CONFIGURADO* ⚡\n` +
                                `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                                `📲 *Número Receptor Fixo:* *${receptorFixo}*\n\n` +
                                `📱 *Número(s) Pagador(es) Vinculado(s):*\n${linhasPagadores}\n\n` +
                                `🚀 Sempre que pagar por *qualquer um* desses números, os megas cairão automaticamente em *${receptorFixo}* sem precisar de enviar comprovativo!\n\n` +
                                `💡 Para desativar e voltar ao modo manual, envie: *.desconfigurar*`
                            );
                        } else {
                            await reply(gerarGuiaConfigurarNumero(senderNumber));
                        }
                        continue;
                    }

                    // ── 1.5 CONSULTA DE STATUS DE COMPRAS & FIDELIDADE VIP ──
                    const cmdWords = cleanCmd.split(/\s+/);
                    const ehConsultaCompras = ['minhascompras', 'compras', 'meustatus', 'vip', 'statusvip'].includes(cmdWords[0]);
                    if (ehConsultaCompras) {
                        let targetPhone = null;

                        // 1. Se o cliente indicou um número explícito (.compras 841234567)
                        if (cmdWords.length > 1) {
                            const spec = customerServices.normalizarTelefone(cmdWords[1]);
                            if (spec && spec.length === 9) targetPhone = spec;
                        }

                        // 2. Se o remetente for Master Kelven e não passou outro número
                        if (!targetPhone && senderIsMaster) {
                            targetPhone = '850401416';
                        }

                        // 3. Se tiver LID mapeado previamente para número de telefone
                        if (!targetPhone && rawLidClean && lidToPhoneMap.has(rawLidClean)) {
                            const mapped = lidToPhoneMap.get(rawLidClean);
                            const norm = customerServices.normalizarTelefone(mapped);
                            if (norm && norm.length === 9) targetPhone = norm;
                        }

                        // 4. Se o senderNumber for um telefone válido de Moçambique
                        if (!targetPhone) {
                            const norm = customerServices.normalizarTelefone(senderNumber);
                            if (norm && norm.length === 9) targetPhone = norm;
                        }

                        // 5. Se ainda for anônimo (ex: participante de grupo com LID oculto pelo WhatsApp)
                        if (!targetPhone || targetPhone.length !== 9) {
                            await reply(
                                `⚠️ *NÚMERO NÃO IDENTIFICADO NO GRUPO*\n` +
                                `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                                `Devido à privacidade do WhatsApp, o seu número está oculto neste grupo.\n\n` +
                                `👉 *Para consultar as suas compras, envie:*\n` +
                                `*.compras <seu_número>*\n` +
                                `_Exemplo:_ *.compras 841234567*\n\n` +
                                `💡 _Ou envie *.compras* em privado com este bot!_ 📲`
                            );
                            continue;
                        }

                        // Buscar compras de forma garantida (memória -> Firestore client_loyalty -> Firestore orders)
                        const info = await customerServices.obterComprasCliente(targetPhone);
                        const total = info.totalCompras || 0;
                        const teto = customerServices.calcularTetoTxeneco(total);
                        const divida = customerServices.getClienteDivida(targetPhone);
                        const divMb = divida ? (divida.activeDebtMb || 0) : 0;
                        const dispMb = Math.max(0, teto - divMb);
                        const tetoF = teto >= 1024 ? `${(teto/1024).toFixed(1)}GB` : `${teto}MB`;
                        const dispF = dispMb >= 1024 ? `${(dispMb/1024).toFixed(1)}GB` : `${dispMb}MB`;

                        let statusNivel = '';
                        let dicaProgresso = '';

                        if (total < 101) {
                            const faltam = 101 - total;
                            statusNivel = '🥉 *Cliente Regular*';
                            dicaProgresso = `🎯 *Faltam apenas ${faltam} compras* para você desbloquear o *Status VIP* e ter direito a *até 2.0 GB de Txeneco (crédito)* sempre que precisar!`;
                        } else if (total < 500) {
                            const faltam500 = 500 - total;
                            statusNivel = '🌟 *CLIENTE VIP (Nível 1)*';
                            dicaProgresso = `🔓 *Txeneco Liberado:* até *${tetoF}* (Disponível agora: *${dispF}*)\n` +
                                            `🎯 *Faltam ${faltam500} compras* para subir para o *Nível Mestre VIP (4.0 GB)*!`;
                        } else {
                            statusNivel = '👑 *MESTRE VIP (Nível Máximo)*';
                            dicaProgresso = `🔓 *Txeneco Máximo Liberado:* até *${tetoF}* (Disponível agora: *${dispF}*)`;
                        }

                        addLog(`🛒 [.compras] Solicitante: ${senderNumber} | Destino: ${targetPhone} | Total: ${total}`);

                        await reply(
                            `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n` +
                            `  📊 *SEU HISTÓRICO DE COMPRAS* 🏆\n` +
                            `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                            `📱 *Cliente:* *${targetPhone}*\n` +
                            `🏷️ *Nível Atual:* ${statusNivel}\n` +
                            `🛒 *Total de Compras:* *${total} compras*\n\n` +
                            dicaProgresso + `\n\n` +
                            (total >= 101 ? `💡 *Para pedir internet a crédito:*\n👉 *.txenecar <quantidade> <número>*\n\n` : '') +
                            `🙏 _Obrigado pela preferência e confiança diária na Ka-Net!_ 🌐✨`
                        );
                        continue;
                    }

                    // ── 1.4 COMANDOS DE BÔNUS (ADMIN MASTER & CLIENTE) ──
                    const ehCmdDarBonus = cleanCmd.startsWith('darbonus') || cleanCmd.startsWith('addbonus');
                    if (ehCmdDarBonus) {
                        if (!senderIsMaster) {
                            await reply('🚫 *ACESSO NEGADO*\n━━━━━━━━━━━━━━━━━━━\n⚠️ Comando restrito ao Administrador Master.');
                            continue;
                        }
                        const rawBody = text.replace(/^[.!/#]?(darbonus|addbonus)\s*/i, '').trim();
                        const parts = rawBody.split(/\s+/);
                        if (parts.length < 2) {
                            await reply('💡 Uso correto: *.darbonus <número_cliente> <quantidade_mb_ou_gb>*\nExemplo: *.darbonus 841234567 1000* ou *.darbonus 841234567 1gb*');
                            continue;
                        }
                        const targetTel = extrairNumeroDestino(parts[0]) || parts[0];
                        let rawQtd = parts[1];
                        let mbNum = 0;
                        if (/gb|g$/i.test(rawQtd)) {
                            mbNum = Math.round(parseFloat(rawQtd.replace(/,/g, '.').replace(/[^\d.]/g, '')) * 1024);
                        } else if (/mb|m$/i.test(rawQtd)) {
                            mbNum = Math.round(parseFloat(rawQtd.replace(/,/g, '.').replace(/[^\d.]/g, '')));
                        } else {
                            const val = parseFloat(rawQtd.replace(/,/g, '.'));
                            mbNum = val <= 10 ? Math.round(val * 1024) : Math.round(val);
                        }

                        const resBonus = customerServices.atribuirBonusAdmin(targetTel, mbNum, senderNumber);
                        await reply(resBonus.mensagemAdmin);

                        try {
                            const clientJid = `258${targetTel.slice(-9)}@s.whatsapp.net`;
                            await sock.sendMessage(clientJid, { text: resBonus.mensagemCliente });
                        } catch (_) {}
                        continue;
                    }

                    const ehCmdConsultarBonus = cleanCmd.startsWith('consultarbonus') || cleanCmd.startsWith('verbonus');
                    if (ehCmdConsultarBonus) {
                        if (!senderIsMaster) {
                            await reply('🚫 *ACESSO NEGADO*\n━━━━━━━━━━━━━━━━━━━\n⚠️ Comando restrito ao Administrador Master.');
                            continue;
                        }
                        const rawBody = text.replace(/^[.!/#]?(consultarbonus|verbonus)\s*/i, '').trim();
                        const targetTel = extrairNumeroDestino(rawBody) || rawBody;
                        const saldoMb = customerServices.consultarBonus(targetTel);
                        const sldF = saldoMb >= 1024 ? `${(saldoMb/1024).toFixed(1)}GB (${saldoMb}MB)` : `${saldoMb}MB`;
                        await reply(`🎁 *SALDO DE BÔNUS DO CLIENTE ${targetTel}:* *${sldF}*`);
                        continue;
                    }

                    const ehCmdMeuBonus = cleanCmd === 'meubonus' || cleanCmd === 'bonus';
                    if (ehCmdMeuBonus) {
                        const saldoMb = customerServices.consultarBonus(senderNumber);
                        if (saldoMb <= 0) {
                            await reply(
                                `🎁 *SALDO DE BÔNUS KA-NET*\n━━━━━━━━━━━━━━━━━━\n` +
                                `Você não possui saldo de bônus acumulado no momento.\n` +
                                `Fique atento às nossas promoções e sorteios no grupo!`
                            );
                        } else {
                            const sldF = saldoMb >= 1024 ? `${(saldoMb/1024).toFixed(1)}GB (${saldoMb}MB)` : `${saldoMb}MB`;
                            await reply(
                                `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n` +
                                `  🎁 *SEU SALDO DE BÔNUS KA-NET* 🎁\n` +
                                `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                                `💾 *Saldo Disponível:* *${sldF}*\n\n` +
                                `💡 *Como Sacar:*\n` +
                                `Você pode sacar quando quiser para qualquer número usando:\n` +
                                `👉 *.sacarbonus <quantidade> [número]*\n` +
                                `_Exemplo: .sacarbonus 1gb_ ou _.sacarbonus 500mb 841234567_`
                            );
                        }
                        continue;
                    }

                    const ehCmdSacarBonus = cleanCmd.startsWith('sacarbonus') || cleanCmd.startsWith('resgatarbonus');
                    if (ehCmdSacarBonus) {
                        const rawBody = text.replace(/^[.!/#]?(sacarbonus|resgatarbonus)\s*/i, '').trim();
                        const parts = rawBody.split(/\s+/);
                        if (parts.length < 1 || !parts[0]) {
                            await reply('💡 Uso correto: *.sacarbonus <quantidade> [número]*\nExemplo: *.sacarbonus 1gb* ou *.sacarbonus 500mb 841234567*');
                            continue;
                        }
                        let rawQtd = parts[0];
                        let mbNum = 0;
                        if (/gb|g$/i.test(rawQtd)) {
                            mbNum = Math.round(parseFloat(rawQtd.replace(/,/g, '.').replace(/[^\d.]/g, '')) * 1024);
                        } else if (/mb|m$/i.test(rawQtd)) {
                            mbNum = Math.round(parseFloat(rawQtd.replace(/,/g, '.').replace(/[^\d.]/g, '')));
                        } else {
                            const val = parseFloat(rawQtd.replace(/,/g, '.'));
                            mbNum = val <= 10 ? Math.round(val * 1024) : Math.round(val);
                        }

                        const rawDest = parts[1] || (parts[2] ? parts[2] : null);
                        const destNum = rawDest ? (extrairNumeroDestino(rawDest) || parts[1]) : senderNumber;

                        const resSacar = await customerServices.sacarBonus({
                            senderPhone: senderNumber,
                            mbSolicitado: mbNum,
                            numDestino: destNum,
                            jid
                        });
                        await reply(resSacar.mensagem);
                        continue;
                    }

                    // ── 2. COMANDO .addtabela e .addtabelagrupo (ADMIN MASTER) ──
                    const ehCmdAddTabela = cleanText.startsWith('.addtabela') || cleanText.startsWith('!addtabela') ||
                                           cleanText.startsWith('.addtabelagrupo') || cleanText.startsWith('!addtabelagrupo');
                    if (ehCmdAddTabela) {
                        if (!senderIsMaster) {
                            await reply('🚫 *ACESSO NEGADO*\n━━━━━━━━━━━━━━━━━━━\n⚠️ Comando restrito ao Administrador Master.');
                            continue;
                        }

                        const isExplicitGrupo = cleanText.startsWith('.addtabelagrupo') || cleanText.startsWith('!addtabelagrupo');
                        let body = text.replace(/^[.!](addtabelagrupo|addtabela)\s*/i, '').trim();

                        // Determinar se o destino é um grupo específico ou geral
                        let targetGrupoJid = null;
                        if (isExplicitGrupo && jid.endsWith('@g.us')) {
                            targetGrupoJid = jid;
                        } else if (jid.endsWith('@g.us')) {
                            if (/^geral\b/i.test(body)) {
                                targetGrupoJid = null;
                                body = body.replace(/^geral\s*/i, '').trim();
                            } else if (/^grupo\b/i.test(body)) {
                                targetGrupoJid = jid;
                                body = body.replace(/^grupo\s*/i, '').trim();
                            } else {
                                // Se enviado dentro do grupo sem dizer "geral", define para este grupo
                                targetGrupoJid = jid;
                            }
                        }

                        if (/DI[AÁ]R|SEMAN|MENS|ILIMIT|SALDO|GB|MB/i.test(body) && body.length > 30) {
                            const res = processarAddTabelaCompleta(body, targetGrupoJid);
                            await reply(res);
                            continue;
                        }

                        const parts = body.split(/\s+/);
                        if (parts.length >= 4) {
                            const cat = parts[0].toLowerCase();
                            const preco = String(parts[1]).replace(/\D/g, '');
                            const mb = parseInt(parts[2]);
                            const nome = parts.slice(3).join(' ') || `${mb}MB`;

                            const catsValidas = ['24hrs', 'semanal', 'mensal', 'ilimitado', 'estudantes', 'saldo'];
                            if (!catsValidas.includes(cat)) {
                                await reply(`⚠️ Categoria inválida. Use uma de:\n\`24hrs\`, \`semanal\`, \`mensal\`, \`ilimitado\`, \`estudantes\`, \`saldo\``);
                                continue;
                            }

                            if (targetGrupoJid) {
                                if (!DYN_CFG.TABELAS_GRUPO) DYN_CFG.TABELAS_GRUPO = {};
                                if (!DYN_CFG.TABELAS_GRUPO[targetGrupoJid]) DYN_CFG.TABELAS_GRUPO[targetGrupoJid] = { TABELAS: {} };
                                if (!DYN_CFG.TABELAS_GRUPO[targetGrupoJid].TABELAS) DYN_CFG.TABELAS_GRUPO[targetGrupoJid].TABELAS = {};
                                if (!DYN_CFG.TABELAS_GRUPO[targetGrupoJid].TABELAS[cat]) DYN_CFG.TABELAS_GRUPO[targetGrupoJid].TABELAS[cat] = {};

                                DYN_CFG.TABELAS_GRUPO[targetGrupoJid].TABELAS[cat][preco] = {
                                    quantidade: mb,
                                    nome,
                                    quantidade_mb: mb,
                                    periodo: cat,
                                    tipo: cat
                                };
                                salvarBotConfig();
                                await reply(`✅ *Pacote Adicionado EXCLUSIVAMENTE a este Grupo!* 👥\n\n📂 Categoria: *${cat}*\n💰 Preço: *${preco} MT*\n📦 Megas: *${mb} MB*\n🏷️ Nome: *${nome}*`);
                                continue;
                            } else {
                                if (!DYN_CFG.TABELAS[cat]) DYN_CFG.TABELAS[cat] = {};
                                DYN_CFG.TABELAS[cat][preco] = {
                                    quantidade: mb,
                                    nome,
                                    quantidade_mb: mb,
                                    periodo: cat,
                                    tipo: cat
                                };
                                salvarBotConfig();
                                await reply(`✅ *Pacote Adicionado na Tabela Geral!* 🌐\n\n📂 Categoria: *${cat}*\n💰 Preço: *${preco} MT*\n📦 Megas: *${mb} MB*\n🏷️ Nome: *${nome}*`);
                                continue;
                            }
                        }

                        await reply(
                            `💡 *USO DO COMANDO .addtabela*\n━━━━━━━━━━━━━━━━━━━\n\n` +
                            `*Tabela Completa (Cole a tabela inteira após o comando):*\n` +
                            `• No grupo: \`.addtabela [tabela]\` ➔ Define tabela deste grupo\n` +
                            `• Geral: \`.addtabela geral [tabela]\` ➔ Define tabela geral do sistema\n\n` +
                            `*Pacote Individual:*\n\`.addtabela [categoria] [preço] [megas] [nome]\`\n` +
                            `_Exemplo:_ \`.addtabela 24hrs 25 1024 1GB 24h\`\n\n` +
                            `*Restaurar Tabela Padrão no Grupo:*\n\`.resetartabela\` (neste grupo)`
                        );
                        continue;
                    }

                    // ── COMANDO .resetartabela / .tabelapadrao (ADMIN MASTER) ──
                    if (['.resetartabela', '!resetartabela', '.tabelapadrao', '!tabelapadrao'].includes(cleanText)) {
                        if (!senderIsMaster) { await reply('🚫 Apenas Admin.'); continue; }
                        if (!jid.endsWith('@g.us')) {
                            let resetou = false;
                            if (DYN_CFG.TABELAS_GRUPO && DYN_CFG.TABELAS_GRUPO[jid]) {
                                delete DYN_CFG.TABELAS_GRUPO[jid];
                                resetou = true;
                            }
                            if (DYN_CFG.TABELAS_GRUPO) {
                                for (const k of Object.keys(DYN_CFG.TABELAS_GRUPO)) {
                                    if (!k.endsWith('@g.us')) {
                                        delete DYN_CFG.TABELAS_GRUPO[k];
                                        resetou = true;
                                    }
                                }
                            }
                            if (resetou) {
                                salvarBotConfig();
                                await reply('🔄 *CONFIGURAÇÕES DO PRIVADO RESETADAS!*\n\nOverrides removidos. O chat privado está a usar 100% a *Tabela Geral Padrão*.');
                            } else {
                                await reply('ℹ️ No chat privado, o bot já utiliza diretamente a *Tabela Geral* do sistema.\nPara alterar a tabela geral, envie:\n`.addtabela [tabela]`');
                            }
                            continue;
                        }
                        if (DYN_CFG.TABELAS_GRUPO && DYN_CFG.TABELAS_GRUPO[jid]) {
                            delete DYN_CFG.TABELAS_GRUPO[jid];
                            salvarBotConfig();
                            await reply('🔄 *TABELA DO GRUPO RESETADA!*\n\nEste grupo voltou a usar a *Tabela Geral Padrão* do sistema.');
                        } else {
                            await reply('ℹ️ Este grupo já está a usar a Tabela Padrão do sistema.');
                        }
                        continue;
                    }

                    // ── 3. COMANDO .addpagamento (ADMIN MASTER) ───────────────
                    if (cleanText.startsWith('.addpagamento') || cleanText.startsWith('!addpagamento')) {
                        if (!senderIsMaster) {
                            await reply('🚫 *ACESSO NEGADO*\n━━━━━━━━━━━━━━━━━━━\n⚠️ Comando restrito ao Administrador Master.');
                            continue;
                        }

                        const body = text.replace(/^[.!]addpagamento\s*/i, '').trim();
                        const parts = body.split(/\s+/);

                        if (parts.length >= 3) {
                            const tipo = parts[0].toLowerCase();
                            const num = parts[1].replace(/\D/g, '');
                            const nomeTitular = parts.slice(2).join(' ');

                            if (tipo.includes('mpesa')) {
                                LOCAL_CFG.mpesa_number = num;
                                LOCAL_CFG.mpesa_name = nomeTitular;
                                DYN_CFG.MPESA_NUMBER = num;
                                DYN_CFG.MPESA_NAME = nomeTitular;
                                salvarLocalConfig();
                                salvarBotConfig();
                                await reply(`✅ *M-Pesa Atualizado com Sucesso!*\n\n📱 Número: *${num}*\n👤 Titular: *${nomeTitular}*`);
                                continue;
                            } else if (tipo.includes('emola')) {
                                LOCAL_CFG.emola_number = num;
                                LOCAL_CFG.emola_name = nomeTitular;
                                DYN_CFG.EMOLA_NUMBER = num;
                                DYN_CFG.EMOLA_NAME = nomeTitular;
                                salvarLocalConfig();
                                salvarBotConfig();
                                await reply(`✅ *e-Mola Atualizado com Sucesso!*\n\n📱 Número: *${num}*\n👤 Titular: *${nomeTitular}*`);
                                continue;
                            }
                        }

                        await reply(`💡 *USO DO COMANDO .addpagamento*\n\`.addpagamento [mpesa/emola] [número] [nome do titular]\``);
                        continue;
                    }

                    // ── 4. COMANDO .enviar (ENVIO MANUAL DIRETO) ────────────
                    if (cleanText.startsWith('.enviar') || cleanText.startsWith('!enviar') || cleanText.startsWith('/enviar') || cleanText.startsWith('comprar ')) {
                        if (!senderIsMaster) {
                            await reply(`🚫 *ACESSO NEGADO*\n━━━━━━━━━━━━━━━━━━━\n⚠️ Comando restrito ao Administrador Master.\n\n📱 _Seu número detectado:_ *${senderNumber}*`);
                            continue;
                        }

                        const body = text.replace(/^[.!/]enviar\s*/i, '').replace(/^comprar\s*/i, '').trim();
                        const parts = body.split(/\s+/);

                        if (parts.length >= 2) {
                            let numDest = '';
                            let megas = 0;

                            if (parts[0].length >= 9 && /^8[234567]/.test(parts[0])) {
                                numDest = parts[0].replace(/\D/g, '');
                                megas = parseInt(parts[1]);
                            } else if (parts[1].length >= 9 && /^8[234567]/.test(parts[1])) {
                                megas = parseInt(parts[0]);
                                numDest = parts[1].replace(/\D/g, '');
                            }

                            if (numDest && megas > 0) {
                                const orderId = 'MANUAL-' + Date.now();
                                addLog(`👑 [COMANDO MANUAL EXECUTADO] Autor: ${senderNumber} | Destino: ${numDest} | Megas: ${megas}MB | Ref: ${orderId}`);
                                await reply(
                                    `⚡ *ENVIO MANUAL DISPACHADO!*\n━━━━━━━━━━━━━━━━━━━\n` +
                                    `📱 Destino: *${numDest}*\n` +
                                    `📦 Quantidade: *${megas} MB*\n` +
                                    `👤 Autor: *${senderNumber}*\n` +
                                    `🆔 Ordem: \`${orderId}\`\n\n` +
                                    `⏳ A enviar ordem ao celular ativo...`
                                );

                                if (orderDispatchCallback) {
                                    orderDispatchCallback({
                                        orderId,
                                        numero: numDest,
                                        quantidade: megas,
                                        modo: 'diario',
                                        jid,
                                        sender: senderNumber
                                    });
                                }
                                continue;
                            }
                        }

                        await reply(`💡 *Formato:* \`.enviar [número] [MB]\`\n_Exemplo:_ \`.enviar 841234567 1024\``);
                        continue;
                    }

                    // ── 5. PAINEL DE COMANDOS COMPLETO ──────────────────────
                    if (['.comandos', '!comandos', '/comandos', 'comandos', 'ajuda', '/ajuda', '!ajuda'].includes(cleanText)) {
                        await reply(gerarPainelAjudaCompleto());
                        continue;
                    }

                    // ── 6. COMANDOS DE RELATÓRIO E ESTATÍSTICA (ADMIN) ──────
                    if (['!hoje', '!vendas', '.vendas', '/vendas'].includes(cleanText)) {
                        if (!senderIsMaster) { await reply('🚫 Restrito ao Admin.'); continue; }
                        const hoje = new Date().toDateString();
                        const vendasHoje = historicoVendas.filter(v => new Date(v.timestamp).toDateString() === hoje);
                        const totalMT = vendasHoje.reduce((acc, v) => acc + v.valor, 0);
                        const totalMB = vendasHoje.reduce((acc, v) => acc + v.mb, 0);

                        await reply(
                            `📊 *RELATÓRIO DE VENDAS DE HOJE*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                            `💰 *Total Faturado:* ${totalMT.toFixed(2)} MT\n` +
                            `📦 *Total de Megas:* ${_fmtSize(totalMB)}\n` +
                            `🧾 *Quantidade de Vendas:* ${vendasHoje.length}\n` +
                            `👥 *Clientes Únicos:* ${new Set(vendasHoje.map(v => v.numero)).size}`
                        );
                        continue;
                    }

                    if (['!amanha', '!relatorio', '.relatorio'].includes(cleanText)) {
                        if (!senderIsMaster) { await reply('🚫 Restrito ao Admin.'); continue; }
                        const totalMT = historicoVendas.reduce((acc, v) => acc + v.valor, 0);
                        const totalMB = historicoVendas.reduce((acc, v) => acc + v.mb, 0);

                        await reply(
                            `📈 *RELATÓRIO GERAL ACUMULADO*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                            `💰 *Faturamento Total:* ${totalMT.toFixed(2)} MT\n` +
                            `📦 *Volume de Dados:* ${_fmtSize(totalMB)}\n` +
                            `🧾 *Total de Pedidos:* ${historicoVendas.length}\n` +
                            `👥 *Total de Leads (Clientes):* ${clientesLeads.size}`
                        );
                        continue;
                    }

                    if (cleanText === '.leads') {
                        if (!senderIsMaster) { await reply('🚫 Restrito ao Admin.'); continue; }
                        await reply(`👥 *TOTAL DE CLIENTES REGISTADOS:* ${clientesLeads.size} números.`);
                        continue;
                    }

                    // ── 7. MANUTENÇÃO E CONTROLE OPERACIONAL (ADMIN) ────────
                    if (cleanText === '.manutencao') {
                        if (!senderIsMaster) { await reply('🚫 Restrito ao Admin.'); continue; }
                        modoManutencao = true;
                        DYN_CFG.MODO_MANUTENCAO = true;
                        salvarBotConfig();
                        await reply('🛑 *Modo de Manutenção ATIVADO.* Clientes normais receberão aviso de manutenção.');
                        continue;
                    }

                    if (cleanText === '.online') {
                        if (!senderIsMaster) { await reply('🚫 Restrito ao Admin.'); continue; }
                        modoManutencao = false;
                        DYN_CFG.MODO_MANUTENCAO = false;
                        salvarBotConfig();
                        await reply('🟢 *Modo de Manutenção DESATIVADO.* Sistema online para todos os clientes.');
                        continue;
                    }


                    if (['/status', '!status', '.status', 'status'].includes(cleanText) && senderIsMaster) {
                        await reply(
                            `📊 *STATUS DO SISTEMA KA-NET CLOUD*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                            `🤖 *Cloud Bot:* Online 24h/7d (Render)\n` +
                            `📱 *WhatsApp:* Conectado (${connectedUser})\n` +
                            `🛑 *Manutenção:* ${modoManutencao ? 'ATIVA' : 'DESATIVADA'}\n` +
                            `👑 *Admins Master:* ${getMasterNumbers().join(', ')}\n` +
                            `🔔 *Grupo Notificações:* \`${getGrupoNotificacoes()}\`\n` +
                            `🚨 *Grupo Erros:* \`${getGrupoErros()}\`\n` +
                            `👥 *Leads Ativos:* ${clientesLeads.size}\n` +
                            `🕐 *Horário do Servidor:* ${new Date().toLocaleString('pt-PT', { timeZone: 'Africa/Maputo' })}`
                        );
                        continue;
                    }

                    if (cleanText === '/limpar' && senderIsMaster) {
                        pendingPayments.clear();
                        transacoesProcessadas.clear();
                        transacoesProcessadasMap.clear();
                        salvarTransacoes();
                        await reply('🧹 *Fila de pagamentos pendentes e registos anti-duplicação limpos com sucesso!*');
                        continue;
                    }

                    // ── GERENCIAMENTO DOS GRUPOS DE NOTIFICAÇÃO E ERROS (ADMIN) ──
                    if (cleanText === '.idgrupo' || cleanText === '!idgrupo') {
                        if (jid.endsWith('@g.us')) {
                            await reply(`📋 *ID DO GRUPO ATUAL:*\n\`${jid}\``);
                        } else {
                            await reply(`ℹ️ Este comando deve ser executado dentro de um grupo.`);
                        }
                        continue;
                    }

                    if (cleanText === '.setnotificacoes' && senderIsMaster) {
                        if (!jid.endsWith('@g.us')) {
                            await reply(`⚠️ Este comando deve ser usado dentro do grupo de notificações.`);
                            continue;
                        }
                        LOCAL_CFG.grupo_notificacoes = jid;
                        DYN_CFG.GRUPO_NOTIFICACOES = jid;
                        salvarLocalConfig();
                        salvarBotConfig();
                        await reply(`✅ *Grupo de Notificações definido com sucesso!*\n\n📋 *ID:* \`${jid}\`\n🔔 Todas as notificações de vendas e recargas ativadas serão enviadas para cá.`);
                        continue;
                    }

                    if (cleanText === '.seterros' && senderIsMaster) {
                        if (!jid.endsWith('@g.us')) {
                            await reply(`⚠️ Este comando deve ser usado dentro do grupo de erros.`);
                            continue;
                        }
                        LOCAL_CFG.grupo_erros = jid;
                        DYN_CFG.GRUPO_ERROS = jid;
                        salvarLocalConfig();
                        salvarBotConfig();
                        await reply(`🚨 *Grupo de Erros definido com sucesso!*\n\n📋 *ID:* \`${jid}\`\n⚠️ Todos os alertas de falhas e problemas serão enviados para cá.`);
                        continue;
                    }

                    if (cleanText === '.grupos' && senderIsMaster) {
                        await reply(
                            `📋 *GRUPOS CONFIGURADOS NO SISTEMA*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                            `🔔 *Notificações:* \`${getGrupoNotificacoes() || 'Não configurado'}\`\n` +
                            `🚨 *Erros:* \`${getGrupoErros() || 'Não configurado'}\`\n\n` +
                            `💡 *Como alterar:*\n` +
                            `• Entre no grupo e envie *.setnotificacoes*\n` +
                            `• Entre no grupo e envie *.seterros*`
                        );
                        continue;
                    }

                    // ── CONTROLE FINANCEIRO: PREÇO DE COMPRA DO GB (ADMIN MASTER) ──
                    if ((cleanText === '.custogb' || cleanText.startsWith('.custogb ')) && senderIsMaster) {
                        const partes = cleanText.split(/\s+/);
                        if (partes.length > 1) {
                            const novoCusto = parseFloat(partes[1].replace(',', '.'));
                            if (!isNaN(novoCusto) && novoCusto > 0) {
                                DYN_CFG.CUSTO_GB_MT = novoCusto;
                                salvarBotConfig();
                                await reply(
                                    `🏷️ *PREÇO DE COMPRA DO GB ATUALIZADO!*\n` +
                                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                                    `💰 *Novo Custo de Compra:* *${novoCusto.toFixed(2)} MT / GB*\n` +
                                    `📉 *Custo por MB:* *${(novoCusto / 1024).toFixed(4)} MT / MB*\n\n` +
                                    `✅ Salvo na nuvem e ativo no Calculador Inteligente e no Relatório de Lucro!`
                                );
                            } else {
                                await reply(`⚠️ Valor inválido. Exemplo de uso: *.custogb 20*`);
                            }
                        } else {
                            const atual = Number(DYN_CFG.CUSTO_GB_MT) || 20;
                            await reply(
                                `🏷️ *CUSTO DE COMPRA ATUAL DO GB:*\n` +
                                `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                                `💰 *${atual.toFixed(2)} MT / GB* (${(atual / 1024).toFixed(4)} MT / MB)\n\n` +
                                `💡 Para alterar, envie: *.custogb [valor]* (ex: *.custogb 22*)`
                            );
                        }
                        continue;
                    }

                    // ── RELATÓRIO DE LUCRO LÍQUIDO REAL POR PERÍODO (ADMIN MASTER) ──
                    if ((cleanText === '.lucro' || cleanText.startsWith('.lucro ')) && senderIsMaster) {
                        const param = cleanText.replace('.lucro', '').trim().toLowerCase() || 'hoje';
                        const now = new Date();
                        let startDate = new Date();
                        let tituloPeriodo = 'HOJE';

                        if (param === 'hoje' || param === 'today' || param === 'diario') {
                            const todayStr = now.toLocaleDateString('sv-SE', { timeZone: 'Africa/Maputo' });
                            startDate = new Date(todayStr + 'T00:00:00+02:00');
                            tituloPeriodo = `HOJE (${now.toLocaleDateString('pt-PT', { timeZone: 'Africa/Maputo' })})`;
                        } else if (param === 'semana' || param === 'week' || param === 'semanal') {
                            startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                            tituloPeriodo = 'ÚLTIMOS 7 DIAS';
                        } else if (param === 'mes' || param === 'month' || param === 'mensal') {
                            startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
                            tituloPeriodo = 'ÚLTIMOS 30 DIAS';
                        } else {
                            startDate = new Date(0);
                            tituloPeriodo = 'HISTÓRICO COMPLETO';
                        }

                        const startMs = startDate.getTime();
                        const custoGb = Number(DYN_CFG.CUSTO_GB_MT) || 20;

                        const mapOrders = new Map();

                        // 1. Vendas locais
                        historicoVendas.forEach(v => {
                            const ts = v.timestamp ? new Date(v.timestamp).getTime() : 0;
                            if (ts >= startMs) {
                                mapOrders.set(v.orderId || `${v.timestamp}-${v.numero}`, {
                                    valor: Number(v.valor) || 0,
                                    mb: Number(v.mb) || 0
                                });
                            }
                        });

                        // 2. Vendas do Firestore se disponível
                        if (firestoreDbInstance) {
                            try {
                                const snap = await firestoreDbInstance.collection('orders').orderBy('createdAt', 'desc').limit(300).get();
                                snap.docs.forEach(doc => {
                                    const d = doc.data();
                                    const id = d.orderId || d.id || doc.id;
                                    const t = d.completedAt || d.createdAt ? new Date(d.completedAt || d.createdAt).getTime() : 0;
                                    if (t >= startMs && (d.status === 'completed' || d.success === true)) {
                                        mapOrders.set(id, {
                                            valor: Number(d.valor || d.valor_pago || 0),
                                            mb: Number(d.quantidade || 0)
                                        });
                                    }
                                });
                            } catch (_) {
                                console.warn('⚠️ [FIRESTORE] Erro ao buscar vendas do dia para relatório:', _.message);
                            }
                        }

                        let faturamentoBruto = 0;
                        let totalMegas = 0;
                        mapOrders.forEach(o => {
                            faturamentoBruto += o.valor;
                            totalMegas += o.mb;
                        });

                        // Breakdown de confirmações operadora
                        let mpesaTotal = 0;
                        let emolaTotal = 0;
                        smsPaymentsMap.forEach(p => {
                            const ts = p.processedAt || p.timestamp ? new Date(p.processedAt || p.timestamp).getTime() : 0;
                            if (ts >= startMs) {
                                const val = Number(p.valor) || 0;
                                const isEmola = (p.metodo === 'emola' || /^(ID|PP26)/i.test(p.txn_id || ''));
                                if (isEmola) emolaTotal += val;
                                else mpesaTotal += val;
                            }
                        });

                        const volumeGb = totalMegas / 1024;
                        const custoTotalDados = volumeGb * custoGb;
                        const lucroLiquido = faturamentoBruto - custoTotalDados;
                        const margemPct = faturamentoBruto > 0 ? (lucroLiquido / faturamentoBruto) * 100 : 0;

                        await reply(
                            `📊 *RELATÓRIO FINANCEIRO & LUCRO REAL*\n` +
                            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                            `📅 *Período:* ${tituloPeriodo}\n\n` +
                            `💰 *Faturamento Bruto:* *${faturamentoBruto.toFixed(2)} MT*\n` +
                            `📦 *Volume Vendido:* *${volumeGb.toFixed(2)} GB* (${totalMegas.toLocaleString()} MB)\n` +
                            `🔢 *Pedidos Concluídos:* *${mapOrders.size}*\n\n` +
                            `🏷️ *Custo de Compra:* *${custoGb.toFixed(2)} MT / GB*\n` +
                            `📉 *Custo dos Dados:* *${custoTotalDados.toFixed(2)} MT*\n` +
                            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                            `📈 *LUCRO LÍQUIDO:* *${lucroLiquido >= 0 ? '+' : ''}${lucroLiquido.toFixed(2)} MT*\n` +
                            `📊 *Margem de Lucro:* *${margemPct.toFixed(1)}%*\n` +
                            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                            `💳 *Recebido por Operadora:*\n` +
                            `• 🟥 M-Pesa: *${mpesaTotal.toFixed(2)} MT*\n` +
                            `• 🟨 e-Mola: *${emolaTotal.toFixed(2)} MT*\n\n` +
                            `💡 *Comandos disponíveis:*\n` +
                            `• *.lucro hoje* | *.lucro semana* | *.lucro mes*\n` +
                            `• *.custogb [valor]* (para atualizar o preço do GB)`
                        );
                        continue;
                    }

                    // ── 8. BANIMENTOS E SEGURANÇA (ADMIN) ───────────────────
                    if (cleanText.startsWith('.banir ') && senderIsMaster) {
                        const num = text.replace('.banir', '').replace(/\D/g, '');
                        if (num) {
                            banidosSet.add(num);
                            await reply(`🚫 Número *${num}* foi banido do sistema.`);
                        }
                        continue;
                    }

                    if (cleanText.startsWith('.desbanir ') && senderIsMaster) {
                        const num = text.replace('.desbanir', '').replace(/\D/g, '');
                        if (num) {
                            banidosSet.delete(num);
                            await reply(`✅ Número *${num}* foi desbanido do sistema.`);
                        }
                        continue;
                    }

                    if (cleanText === '.banidos' && senderIsMaster) {
                        const lista = Array.from(banidosSet);
                        await reply(`🚫 *NÚMEROS BANIDOS:* ${lista.length > 0 ? lista.join(', ') : 'Nenhum'}`);
                        continue;
                    }

                    // ── 9. COMPROVATIVO UNIVERSAL (M-PESA / E-MOLA) ──────────
                    if (isComprovativo(text)) {
                        // ── NOVO: DETECÇÃO DE MÚLTIPLOS COMPROVATIVOS NA MESMA MENSAGEM ──
                        const multiCompMsg = separarMultiplosComprovativos(text);
                        if (multiCompMsg && multiCompMsg.length >= 2) {
                            console.log(`💳 [COMPROVATIVOS COMBINADOS NA MESMA MSG] Detectados ${multiCompMsg.length} comprovativos!`);
                            const validas = [];
                            const rejeitadas = [];

                            for (const c of multiCompMsg) {
                                let jaUsada = transacoesProcessadas.has(c.txn_id);
                                const reg = transacoesProcessadasMap.get(c.txn_id);
                                if (reg && (reg.status === 'completed' || (reg.sender && reg.sender !== senderNumber))) {
                                    jaUsada = true;
                                }
                                if (jaUsada) {
                                    rejeitadas.push({ ...c, motivo: 'já utilizada anteriormente' });
                                } else {
                                    validas.push(c);
                                }
                            }

                            if (validas.length === 0) {
                                await reply(
                                    `⚠️ *TODAS AS CONFIRMAÇÕES SÃO INVÁLIDAS OU JÁ UTILIZADAS* ❌\n━━━━━━━━━━━━━━━━━━\n` +
                                    `Nenhum dos ${multiCompMsg.length} comprovativos pôde ser aceito no sistema.\n\n` +
                                    rejeitadas.map(r => `• ${r.metodoNome} (\`${r.txn_id}\`): ${r.motivo}`).join('\n') +
                                    `\n\n💡 Por favor, certifique-se de enviar comprovativos válidos e não reutilizados.`
                                );
                                continue;
                            }

                            const valorTotalValido = validas.reduce((acc, cur) => acc + cur.valor, 0);
                            const pacoteCombinado = buscarPacotePorValor(valorTotalValido, jid);
                            const combinedTxnId = validas.map(v => v.txn_id).join('+');
                            const numDestinoInline = extrairNumeroDestinoAbaixoDoComprovativo(text);
                            const { supportNum } = getSuporteDetails();

                            // Dar lock nas transações válidas
                            for (const v of validas) {
                                transacoesProcessadas.add(v.txn_id);
                                transacoesProcessadasMap.set(v.txn_id, {
                                    sender: senderNumber,
                                    jid,
                                    valor: v.valor,
                                    status: numDestinoInline ? 'completed' : 'locked',
                                    numeroDestino: numDestinoInline || null,
                                    isCombined: true,
                                    parentTxn: combinedTxnId,
                                    timestamp: Date.now()
                                });
                                const smsOp = findSmsPayment(v.txn_id);
                                if (smsOp) {
                                    smsOp.usado = true;
                                    smsOp.usadoPor = senderNumber;
                                    smsOp.usadoEm = Date.now();
                                    salvarSmsPayments();
                                }
                            }
                            salvarTransacoes();

                            const listaValidTxt = validas.map((v, i) => `  ${i + 1}. *${v.valor} MT* (${v.metodoNome} - \`${v.txn_id}\`)`).join('\n');
                            const avisoRejeitadas = rejeitadas.length > 0
                                ? `\n\n⚠️ *Atenção:* ${rejeitadas.length} comprovativo(s) descartado(s) por serem inválidos ou já utilizados:\n` + rejeitadas.map(r => `• \`${r.txn_id}\` (${r.valor} MT) - ${r.motivo}`).join('\n')
                                : '';

                            if (numDestinoInline) {
                                const orderId = 'WA-' + validas[0].txn_id + '-' + Date.now();
                                await reply(
                                    `✅ *PEDIDO RECEBIDO (COMBINADO)* ⚡\n` +
                                    `━━━━━━━━━━━━━━━━━━\n` +
                                    `📦 *Pacote:* *${pacoteCombinado ? pacoteCombinado.nome : valorTotalValido + ' MT'}*\n` +
                                    `📲 *Destino:* *${numDestinoInline}*\n` +
                                    `💰 *Total:* *${valorTotalValido} MT*\n` +
                                    `🔖 *Refs:* \`${combinedTxnId}\`` +
                                    avisoRejeitadas + `\n` +
                                    `━━━━━━━━━━━━━━━━━━\n` +
                                    `🚀 *Ativação em andamento...*\n` +
                                    `_Receberá a confirmação em instantes._`
                                );

                                historicoVendas.push({
                                    orderId,
                                    numero: numDestinoInline,
                                    mb: pacoteCombinado ? pacoteCombinado.mb : 1024,
                                    valor: valorTotalValido,
                                    timestamp: Date.now()
                                });

                                if (orderDispatchCallback) {
                                    orderDispatchCallback({
                                        orderId,
                                        numero: numDestinoInline,
                                        quantidade: pacoteCombinado ? pacoteCombinado.mb : 1024,
                                        modo: pacoteCombinado ? pacoteCombinado.tipo : 'diario',
                                        jid,
                                        sender: senderNumber,
                                        senderName: nomeCliente,
                                        txn_id: combinedTxnId,
                                        valor: valorTotalValido
                                    });
                                }
                                if (geminiAI.isConfigured()) geminiAI.limparHistoricoConversa(senderNumber);
                                continue;
                            } else {
                                const pendingKey = `${jid}:${senderNumber}`;
                                pendingPayments.set(pendingKey, {
                                    txn_ids: validas.map(v => v.txn_id),
                                    txn_id: validas[0].txn_id,
                                    transacoes: validas,
                                    valor_total: valorTotalValido,
                                    valor: valorTotalValido,
                                    metodo: validas[0].metodo,
                                    senderName: nomeCliente,
                                    senderNumber,
                                    pacote: pacoteCombinado,
                                    aguardando_numero: true
                                });

                                await reply(
                                    `✅ *PAGAMENTO COMBINADO RECEBIDO* 💳\n` +
                                    `━━━━━━━━━━━━━━━━━━\n` +
                                    listaValidTxt + `\n` +
                                    `💰 *Total:* *${valorTotalValido} MT*\n` +
                                    `📦 *Pacote:* *${pacoteCombinado ? pacoteCombinado.nome : valorTotalValido + ' MT'}*\n` +
                                    `🔖 *Refs:* \`${combinedTxnId}\`` +
                                    avisoRejeitadas + `\n` +
                                    `━━━━━━━━━━━━━━━━━━\n` +
                                    `📲 *Para qual número enviar?*\n` +
                                    `_Responda com o número Vodacom (ex: 84XXXXXXX)_`
                                );
                                continue;
                            }
                        }
                        const valor = extrairValorMT(text);
                        const txn_id = extrairTxId(text);
                        // Detecção fiável: e-Mola começa com "ID da transacao" / "Transaction ID"
                        // M-Pesa começa com "Confirmado DJDXXXXXX" ou tem código "PP26..."
                        const isEmolaPattern = /^(ID\s*(da\s*)?transa[cç][aã]o|Transaction\s*ID|ID\s*Trans)/i.test(text.trim());
                        const isMpesaPattern = /^Confirmado\s+[A-Z0-9]{8,}|PP2\d{5}\.\d{4}/i.test(text.trim());
                        const metodo = isEmolaPattern
                            ? 'emola'
                            : isMpesaPattern
                                ? 'mpesa'
                                : /e-?mola|emola|movitel|864882152|catia/i.test(text) ? 'emola' : 'mpesa';
                        const metodoNome = metodo === 'emola' ? 'e-Mola' : 'M-Pesa';

                        // ── REGRA 1: SEGURANÇA MÁXIMA ANTI-DUPLICAÇÃO E LOCK EXCLUSIVO ──
                        if (txn_id) {
                            let registoExistente = transacoesProcessadasMap.get(txn_id);
                            if (!registoExistente) {
                                for (const [k, v] of transacoesProcessadasMap.entries()) {
                                    if (matchTxnId(k, txn_id)) {
                                        registoExistente = v;
                                        break;
                                    }
                                }
                            }

                            if (registoExistente) {
                                if (registoExistente.isAutoReceptor) {
                                    await reply(
                                        `⚠️ *PAGAMENTO JÁ PROCESSADO AUTOMATICAMENTE*\n━━━━━━━━━━━━━━━━━━\n` +
                                        `A recarga referente a esta transação (\`${txn_id}\`) de *${registoExistente.valor || valor} MT* já foi entregue automaticamente para o seu número receptor padrão: *${registoExistente.autoTarget || registoExistente.numeroDestino}*!\n\n` +
                                        `✨ Não é necessário enviar o comprovativo no WhatsApp.`
                                    );
                                    continue;
                                } else if (registoExistente.status === 'completed') {
                                    await reply(
                                        `⚠️ *CONFIRMAÇÃO JÁ UTILIZADA*\n━━━━━━━━━━━━━━━━━━\n` +
                                        `❌ Esta transação (\`${txn_id}\`) já foi utilizada anteriormente no sistema e não pode ser reutilizada.\n\n` +
                                        `⏳ Cada comprovativo só é válido para uma única ativação de pacote.`
                                    );
                                    continue;
                                } else if (registoExistente.sender && registoExistente.sender !== senderNumber) {
                                    await reply(
                                        `🚫 *CONFIRMAÇÃO BLOQUEADA*\n━━━━━━━━━━━━━━━━━━\n` +
                                        `❌ Esta transação (\`${txn_id}\`) já foi submetida por outro cliente e está protegida!\n\n` +
                                        `🔒 Por questões de segurança, nenhuma confirmação pode ser compartilhada ou utilizada por duas contas diferentes.`
                                    );
                                    continue;
                                } else if (registoExistente.status === 'locked') {
                                    await reply(
                                        `ℹ️ *AGUARDANDO O SEU NÚMERO*\n━━━━━━━━━━━━━━━━━━\n` +
                                        `Você já submeteu esta confirmação (\`${txn_id}\`).\n\n` +
                                        `📲 Por favor, envie agora apenas o seu *número Vodacom* que deve receber os megas (ex: *84XXXXXXX* ou *85XXXXXXX*).`
                                    );
                                    continue;
                                }
                            } else {
                                let jaProcessada = transacoesProcessadas.has(txn_id);
                                if (!jaProcessada) {
                                    for (const item of transacoesProcessadas) {
                                        if (matchTxnId(item, txn_id)) {
                                            jaProcessada = true;
                                            break;
                                        }
                                    }
                                }
                                if (jaProcessada) {
                                    await reply(
                                        `⚠️ *CONFIRMAÇÃO JÁ UTILIZADA*\n━━━━━━━━━━━━━━━━━━\n` +
                                        `❌ Esta transação (\`${txn_id}\`) já foi processada anteriormente no sistema.\n\n` +
                                        `⏳ Cada comprovativo só é válido para uma única ativação de pacote.`
                                    );
                                    continue;
                                }
                            }
                        }

                        console.log(`💳 [COMPROVATIVO DETECTADO] ${metodoNome} | Ref: ${txn_id} | Valor: ${valor} MT | Remetente: ${senderNumber}`);

                        if (!valor) {
                            await reply(
                                `⚠️ *Comprovativo detectado, mas não foi possível ler o valor!*\n\n` +
                                `Por favor, certifique-se de que o valor em MT está visível (ex: *25 MT*).`
                            );
                            continue;
                        }

                        const pacote = buscarPacotePorValor(valor, jid);
                        if (!pacote) {
                            await reply(
                                `⚠️ *Comprovativo ${metodoNome} recebido!*\n\n` +
                                `🆔 Ref: *${txn_id}*\n💰 Valor: *${valor} MT*\n\n` +
                                `Porém, não encontramos um pacote correspondente a este valor na tabela.\n` +
                                `Digite *Menu* para verificar os preços disponíveis.`
                            );
                            
                            // Avisar o Grupo de Notificações para o admin não perder o dinheiro!
                            const origemMsg = jid.endsWith('@g.us') ? 'Grupo WhatsApp' : 'Privado';
                            enviarNotificacaoGrupo(
                                `⚠️ *PAGAMENTO SEM PACOTE CORRESPONDENTE* ⚠️\n` +
                                `━━━━━━━━━━━━━━━━━━\n` +
                                `🔖 *Ref:* \`${txn_id || 'N/D'}\`\n` +
                                `💳 *Valor Pago:* *${valor} MT* (${metodoNome})\n` +
                                `👤 *Cliente:* *${nomeCliente}* (${senderNumber})\n` +
                                `🏢 *Origem:* *${origemMsg}*\n` +
                                `🕒 *Hora:* ${new Date().toLocaleString('pt-PT', { timeZone: 'Africa/Maputo' })}\n` +
                                `━━━━━━━━━━━━━━━━━━\n` +
                                `❗ *Atenção:* O cliente pagou ${valor} MT mas este valor não consta na tabela deste grupo/sistema. Verificar e atender manualmente!`
                            );
                            continue;
                        }

                        const { supportNum } = getSuporteDetails();
                        const numDestinoInline = extrairNumeroDestinoAbaixoDoComprovativo(text);

                        // ── 📦 DIVISÃO MULTI-DESTINO EM PAGAMENTO ÚNICO ──
                        const textoAbaixoDoComprovativo = extrairTextoAbaixoDoComprovativo(text);
                        const multiDestinos = customerServices.parseMultiDestino(textoAbaixoDoComprovativo || text, parseFloat(valor), (v) => buscarPacotePorValor(v, jid));
                        if (multiDestinos && multiDestinos.length >= 2) {
                            console.log(`📦 [MULTI-DESTINO DETECTADO] Dividindo ${valor} MT entre ${multiDestinos.length} números:`, multiDestinos);

                            const smsOperadora = findSmsPayment(txn_id);
                            if (smsOperadora) {
                                smsOperadora.usado = true;
                                smsOperadora.usadoPor = senderNumber;
                                smsOperadora.usadoEm = Date.now();
                                salvarSmsPayments();
                            }

                            multiDestinos.forEach((item, idx) => {
                                const subOrderId = `WA-${txn_id}-${idx + 1}-${Date.now()}`;
                                historicoVendas.push({
                                    orderId: subOrderId,
                                    numero: item.phone,
                                    mb: item.mb,
                                    valor: parseFloat(valor) / multiDestinos.length,
                                    timestamp: Date.now()
                                });
                                if (orderDispatchCallback) {
                                    orderDispatchCallback({
                                        orderId: subOrderId,
                                        numero: item.phone,
                                        quantidade: item.mb,
                                        modo: 'diario',
                                        jid,
                                        sender: senderNumber,
                                        senderPhone: senderNumber, // Cliente é quem compra/paga, NUNCA o destinatário
                                        senderName: nomeCliente,
                                        txn_id: `${txn_id}-${idx + 1}`,
                                        valor: parseFloat(valor) / multiDestinos.length
                                    });
                                }
                            });

                            if (txn_id) {
                                transacoesProcessadas.add(txn_id);
                                transacoesProcessadasMap.set(txn_id, {
                                    sender: senderNumber,
                                    jid,
                                    destinos: multiDestinos,
                                    valor: parseFloat(valor),
                                    status: 'completed',
                                    timestamp: Date.now()
                                });
                                salvarTransacoes();
                            }

                            const resumo = multiDestinos.map((d, i) => {
                                const vol = d.mb >= 1024 ? `${(d.mb/1024).toFixed(1)}GB` : `${d.mb}MB`;
                                return `  ${i + 1}. *${d.phone}* ➔ *${vol}*`;
                            }).join('\n');

                            await reply(
                                `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n` +
                                `  🎉 *PAGAMENTO DIVIDIDO COM SUCESSO!* ⚡\n` +
                                `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                                `O seu pagamento de *${valor} MT* (${metodoNome}) foi validado e distribuído entre *${multiDestinos.length} destinatários*:\n\n` +
                                resumo + `\n\n` +
                                `🔖 *Ref:* \`${txn_id}\`\n` +
                                `🚀 *Todas as ativações automáticas já foram enviadas para os modems!*\n\n` +
                                `📞 *Suporte:* Envie *Suporte* ou ligue para *${supportNum}*`
                            );

                            const origemMsg = jid.endsWith('@g.us') ? 'Grupo WhatsApp' : 'Privado';
                            enviarNotificacaoGrupo(
                                `🔔 *NOVO PEDIDO MULTI-DESTINO PROCESSADO* ⚡\n` +
                                `━━━━━━━━━━━━━━━━━━\n` +
                                `📋 *Ref:* \`${txn_id}\`\n` +
                                `💳 *Valor Pago:* *${valor} MT* (${metodoNome})\n` +
                                `👤 *Cliente:* *${nomeCliente}* (${senderNumber})\n` +
                                `🏢 *Origem:* *${origemMsg}*\n` +
                                `📦 *Distribuição:*\n` +
                                resumo + `\n` +
                                `━━━━━━━━━━━━━━━━━━\n` +
                                `⏳ *Status:* Enviados para os Celulares USSD`
                            );

                            if (geminiAI.isConfigured()) geminiAI.limparHistoricoConversa(senderNumber);
                            continue;
                        }

                        // ── VALIDAÇÃO REAL CONTRA CONFIRMAÇÃO DA OPERADORA (M-PESA / E-MOLA) ──
                        const smsOperadora = findSmsPayment(txn_id);
                        const jaConfirmadoPelaOperadora = smsOperadora && !smsOperadora.usado;

                        if (jaConfirmadoPelaOperadora) {
                            // ✅ A OPERADORA JÁ CONFIRMOU O VALOR!
                            console.log(`✅ [VALIDAÇÃO IMEDIATA] Ref ${txn_id} já confirmada pela operadora! Ativando...`);
                            smsOperadora.usado = true;
                            smsOperadora.usadoPor = senderNumber;
                            smsOperadora.usadoEm = Date.now();
                            salvarSmsPayments();

                            if (numDestinoInline) {
                                const orderId = 'WA-' + txn_id + '-' + Date.now();
                                await reply(
                                    `✅ *PEDIDO RECEBIDO* ⚡\n` +
                                    `━━━━━━━━━━━━━━━━━━\n` +
                                    `📦 *Pacote:* *${pacote.nome}*${pacote.calculado ? ' ⚡ _(Calculado)_' : ''}\n` +
                                    `📲 *Destino:* *${numDestinoInline}*\n` +
                                    `💳 *Valor:* *${valor} MT* (${metodoNome})\n` +
                                    `🔖 *Ref:* \`${txn_id}\`\n` +
                                    `━━━━━━━━━━━━━━━━━━\n` +
                                    `🚀 *Ativação em andamento...*\n` +
                                    `_Receberá a confirmação em instantes._`
                                );

                                historicoVendas.push({
                                    orderId,
                                    numero: numDestinoInline,
                                    mb: pacote.mb,
                                    valor: parseFloat(valor),
                                    timestamp: Date.now()
                                });
                                if (txn_id) {
                                    transacoesProcessadas.add(txn_id);
                                    transacoesProcessadasMap.set(txn_id, {
                                        sender: senderNumber,
                                        jid,
                                        numeroDestino: numDestinoInline,
                                        valor: parseFloat(valor),
                                        status: 'completed',
                                        timestamp: Date.now()
                                    });
                                    salvarTransacoes();
                                }

                                const origemMsg = jid.endsWith('@g.us') ? 'Grupo WhatsApp' : 'Privado';
                                const tabelaOrigem = pacote.origem === 'grupo_especifico' ? 'Tabela Exclusiva deste Grupo' : 'Tabela Padrão Geral';
                                enviarNotificacaoGrupo(
                                    `🔔 *NOVO PEDIDO VALIDADO PELA OPERADORA* ⚡\n` +
                                    `━━━━━━━━━━━━━━━━━━\n` +
                                    `📋 *Ref:* \`${orderId}\`\n` +
                                    `📲 *Destino:* *${numDestinoInline}*\n` +
                                    `📦 *Pacote:* *${pacote.nome}*\n` +
                                    `💳 *Valor:* *${valor} MT* (${metodoNome})\n` +
                                    `👤 *Cliente:* *${nomeCliente}* (${senderNumber})\n` +
                                    `🏢 *Origem:* *${origemMsg}*\n` +
                                    `🏷️ *Tabela:* *${tabelaOrigem}*\n` +
                                    `🕒 *Hora:* ${new Date().toLocaleString('pt-PT', { timeZone: 'Africa/Maputo' })}\n` +
                                    `━━━━━━━━━━━━━━━━━━\n` +
                                    `⏳ *Status:* Enviado para ativação USSD`
                                );

                                if (orderDispatchCallback) {
                                    if (rawLidClean && numDestinoInline) {
                                        lidToPhoneMap.set(rawLidClean, numDestinoInline.startsWith('258') ? numDestinoInline : '258' + numDestinoInline);
                                    }
                                    orderDispatchCallback({
                                        orderId,
                                        numero: numDestinoInline,
                                        quantidade: pacote.mb,
                                        modo: pacote.tipo,
                                        jid,
                                        sender: senderNumber,
                                        senderJid: msg.key.participant || msg.participant || realSender || jid,
                                        senderPhone: senderNumber, // Cliente é quem compra/paga, NUNCA o destinatário
                                        senderName: nomeCliente,
                                        txn_id,
                                        valor
                                    });
                                }
                                if (geminiAI.isConfigured()) geminiAI.limparHistoricoConversa(senderNumber);
                                continue;
                            } else {
                                // ── VERIFICAR RECEPTOR PADRÃO CONFIGURADO VIA .configurar ──
                                let receptorConfig = customerServices.obterReceptorPadrao(senderNumber);
                                if (!receptorConfig && rawLidClean && lidToPhoneMap.has(rawLidClean)) {
                                    receptorConfig = customerServices.obterReceptorPadrao(lidToPhoneMap.get(rawLidClean));
                                }
                                if (!receptorConfig && smsOperadora && smsOperadora.remetente) {
                                    receptorConfig = customerServices.obterReceptorPadrao(smsOperadora.remetente);
                                }
                                if (receptorConfig && receptorConfig.targetPhone) {
                                    const numReceptor = receptorConfig.targetPhone;
                                    const orderId = 'WA-' + txn_id + '-' + Date.now();
                                    console.log(`⚡ [AUTO-RECEPTOR] Comprovativo de ${senderNumber} → receptor configurado: ${numReceptor}`);

                                    registrarTransacaoAutoReceptor(txn_id, numReceptor, parseFloat(valor), senderNumber);

                                    historicoVendas.push({
                                        orderId,
                                        numero: numReceptor,
                                        mb: pacote.mb,
                                        valor: parseFloat(valor),
                                        timestamp: Date.now()
                                    });

                                    const origemMsg = jid.endsWith('@g.us') ? 'Grupo WhatsApp' : 'Privado';
                                    enviarNotificacaoGrupo(
                                        `🔔 *NOVO PEDIDO (AUTO-RECEPTOR)* ⚡\n` +
                                        `━━━━━━━━━━━━━━━━━━\n` +
                                        `📋 *Ref:* \`${orderId}\`\n` +
                                        `📲 *Destino (Receptor Fixo):* *${numReceptor}*\n` +
                                        `📦 *Pacote:* *${pacote.nome}*\n` +
                                        `💳 *Valor:* *${valor} MT* (${metodoNome})\n` +
                                        `👤 *Pagador:* *${nomeCliente}* (${senderNumber})\n` +
                                        `🏢 *Origem:* *${origemMsg}*\n` +
                                        `🕒 *Hora:* ${new Date().toLocaleString('pt-PT', { timeZone: 'Africa/Maputo' })}\n` +
                                        `━━━━━━━━━━━━━━━━━━\n` +
                                        `⏳ *Status:* Enviado automaticamente via receptor configurado`
                                    );

                                    await reply(
                                        `✅ *PEDIDO AUTOMÁTICO CONFIRMADO* ⚡\n` +
                                        `━━━━━━━━━━━━━━━━━━\n` +
                                        `📦 *Pacote:* *${pacote.nome}*\n` +
                                        `📲 *Receptor Fixo:* *${numReceptor}*\n` +
                                        `💳 *Valor:* *${valor} MT* (${metodoNome})\n` +
                                        `🔖 *Ref:* \`${txn_id}\`\n` +
                                        `━━━━━━━━━━━━━━━━━━\n` +
                                        `🚀 *Ativação automática em andamento!*\n` +
                                        `_Sem precisar de enviar número — receptor fixo ativo!_`
                                    );

                                    if (orderDispatchCallback) {
                                        orderDispatchCallback({
                                            orderId,
                                            numero: numReceptor,
                                            quantidade: pacote.mb,
                                            modo: pacote.tipo,
                                            jid,
                                            sender: senderNumber,
                                            senderName: nomeCliente,
                                            txn_id,
                                            valor
                                        });
                                    }
                                    if (geminiAI.isConfigured()) geminiAI.limparHistoricoConversa(senderNumber);
                                    continue;
                                }

                                // Sem receptor configurado — pedir o número manualmente
                                if (txn_id) {
                                    transacoesProcessadas.add(txn_id);
                                    transacoesProcessadasMap.set(txn_id, {
                                        sender: senderNumber,
                                        jid,
                                        valor: parseFloat(valor),
                                        status: 'locked',
                                        timestamp: Date.now()
                                    });
                                    salvarTransacoes();
                                }

                                const pendingKey = `${jid}:${senderNumber}`;
                                pendingPayments.set(pendingKey, {
                                    txn_id,
                                    valor,
                                    metodo,
                                    senderName: nomeCliente,
                                    senderNumber,
                                    aguardando_numero: true
                                });

                                await reply(
                                    `✅ *COMPROVATIVO VALIDADO* ⚡\n` +
                                    `━━━━━━━━━━━━━━━━━━\n` +
                                    `📦 *Pacote:* *${pacote.nome}* (${pacote.mb} MB)${pacote.calculado ? ' ⚡ _(Calculado)_' : ''}\n` +
                                    `💳 *Valor:* *${valor} MT* (${metodoNome})\n` +
                                    `🔖 *Ref:* \`${txn_id}\`\n` +
                                    `━━━━━━━━━━━━━━━━━━\n` +
                                    `📲 *Para qual número enviar?*\n` +
                                    `_Responda com o número Vodacom (ex: 84XXXXXXX)_`
                                );
                                continue;
                            }
                        } else {
                            // ⏳ A CONFIRMAÇÃO DA OPERADORA AINDA NÃO CHEGOU AO SISTEMA!
                            // Colocar em status "Aguardando Confirmação da Operadora" por até 10 minutos
                            const itemExistente = findItemAguardandoOperadora(txn_id);
                            if (itemExistente) {
                                await reply(
                                    `⏳ *COMPROVATIVO JÁ EM VERIFICAÇÃO* ⏳\n━━━━━━━━━━━━━━━━━━\n` +
                                    `A transação \`${txn_id}\` já está no status *Aguardando Confirmação da Operadora*.\n\n` +
                                    `Assim que a rede ${metodoNome} confirmar o recebimento do valor (*${valor} MT*), o seu pedido será processado automaticamente!`
                                );
                                continue;
                            }

                            console.log(`⏳ [AGUARDANDO OPERADORA] Ref ${txn_id} (${valor} MT) - Cliente: ${senderNumber}. Iniciando timer de 10 minutos.`);

                            const itemAguardando = {
                                txn_id,
                                valor: parseFloat(valor),
                                metodo,
                                metodoNome,
                                jid,
                                senderNumber,
                                rawLidClean,
                                realSender,
                                nomeCliente,
                                // Usar receptor configurado via .configurar se existir e não vier número inline
                                numDestino: numDestinoInline || (() => {
                                    let rc = customerServices.obterReceptorPadrao(senderNumber);
                                    if (!rc && rawLidClean && lidToPhoneMap.has(rawLidClean)) {
                                        rc = customerServices.obterReceptorPadrao(lidToPhoneMap.get(rawLidClean));
                                    }
                                    return rc && rc.targetPhone ? rc.targetPhone : null;
                                })(),
                                pacote,
                                timestamp: Date.now(),
                                timer: null
                            };

                            itemAguardando.timer = setTimeout(() => {
                                expirarItemAguardandoOperadora(txn_id);
                            }, 600_000); // 10 minutos

                            aguardandoOperadora.set(txn_id, itemAguardando);
                            salvarAguardandoOperadora();

                            // Responder imediatamente ao cliente
                            await reply(
                                `⏳ *COMPROVATIVO RECEBIDO* 📡\n` +
                                `━━━━━━━━━━━━━━━━━━\n` +
                                `📦 *Pacote:* *${pacote.nome}*${pacote.calculado ? ' ⚡ _(Calculado)_' : ''}\n` +
                                (numDestinoInline ? `📲 *Destino:* *${numDestinoInline}*\n` : '') +
                                `💳 *Valor:* *${valor} MT* (${metodoNome})\n` +
                                `🔖 *Ref:* \`${txn_id}\`\n` +
                                `━━━━━━━━━━━━━━━━━━\n` +
                                `_Aguardando confirmação da rede ${metodoNome} (30s a 2 min). Ativação automática assim que confirmado!_`
                            );

                            // Notificar o grupo de notificações
                            const origemMsg = jid.endsWith('@g.us') ? 'Grupo WhatsApp' : 'Privado';
                            enviarNotificacaoGrupo(
                                `⏳ *COMPROVATIVO EM VERIFICAÇÃO (${metodoNome.toUpperCase()})*\n` +
                                `━━━━━━━━━━━━━━━━━━\n` +
                                `📋 *Ref:* \`${txn_id}\`\n` +
                                `💳 *Valor:* *${valor} MT*\n` +
                                `📦 *Pacote:* *${pacote.nome}*\n` +
                                `👤 *Cliente:* *${nomeCliente}* (${senderNumber})\n` +
                                (numDestinoInline ? `📲 *Destino:* *${numDestinoInline}*\n` : '') +
                                `🏢 *Origem:* *${origemMsg}*\n` +
                                `⏳ *Status:* Aguardando SMS da operadora (limite 2 min)...`
                            );
                            continue;
                        }
                    }

                    // ── 11A. COMANDO !INDICADO / CÓDIGO DE CONVITE (KN-XXXX) ───────────────
                    const mIndicado = cleanText.match(/^[.!/#]?(?:indicado|fui\s+indicado(?:\s+por)?|convite)\s*[:=]?\s*([a-zA-Z0-9\-_]+)/i) ||
                                      cleanText.match(/codigo\s+(?:de\s+)?(?:indicad[oa]|convite)\s*[:=]?\s*([a-zA-Z0-9\-_]+)/i) ||
                                      cleanText.match(/^(kn[-_]?[0-9]{3,6})$/i);
                    if (mIndicado) {
                        const codPadrinho = mIndicado[1].trim();
                        const resInd = customerServices.vincularIndicacao(senderNumber, codPadrinho);
                        await reply(resInd.mensagem);
                        continue;
                    }

                    // ── 11. SISTEMA DE FIDELIDADE E INDICAÇÃO (OPÇÃO 4) ───────────────
                    if (opcaoMenuNum === '4' || ['4', '4️⃣', '!convite', 'convite', '!fidelidade', 'fidelidade', 'indicar', 'indicacao', 'indicação', 'indica e ganha'].includes(cleanCmd)) {
                        const statusInd = customerServices.obterStatusIndicacao(senderNumber);
                        const meuCodigo = (statusInd && statusInd.codigo) ? statusInd.codigo : customerServices.gerarCodigoConviteUnico(senderNumber);
                        const amigosNaRodada = statusInd ? statusInd.amigosAtuais : 0;
                        const faltam = statusInd ? statusInd.faltam : 3;
                        const totalBonus = statusInd ? statusInd.totalBonusMegas : 0;

                        const botPhone = (sock && sock.user && sock.user.id) ? sock.user.id.split(':')[0].split('@')[0] : '258XXXXXXXXX';
                        const linkCompartilhar = `https://wa.me/${botPhone}?text=!indicado%20${meuCodigo}`;

                        await reply(
                            `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n` +
                            `  🎁 *PROGRAMA INDICA E GANHA* ⚡\n` +
                            `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                            `Indica *3 amigos* para comprarem na *Ka-Net* e ganha *500 MB GRÁTIS*! 🚀\n\n` +
                            `🔗 *O Teu Código:* \`${meuCodigo}\`\n` +
                            `👥 *Progresso Atual:* *${amigosNaRodada} de 3 amigos* já compraram\n` +
                            `🎯 *Faltam:* *${faltam} amigo(s)* para o próximo bónus de 500 MB!\n` +
                            (totalBonus > 0 ? `🏆 *Total Ganho Até Hoje:* *${totalBonus} MB* grátis!\n\n` : `\n`) +
                            `💡 *Como funciona?*\n` +
                            `1. Copia o texto abaixo e manda para os teus amigos ou grupos.\n` +
                            `2. O teu amigo clica no link e compra qualquer pacote pela 1ª vez.\n` +
                            `3. Ao completar 3 amigos, o robô ativa *500 MB* no teu número na hora! ⚡\n\n` +
                            `━━━━━━━━━━━━━━━━━━\n` +
                            `👇 *Copia e envia aos teus amigos:*\n\n` +
                            `"Ei! Compra megas automáticos e baratos no WhatsApp da Ka-Net via M-Pesa/e-Mola. Entrega em segundos! ⚡\n\n` +
                            `👉 Clica aqui para ativar com o meu código: ${linkCompartilhar}"`
                        );
                        continue;
                    }

                    // ── 11B. CALCULADOR PROPORCIONAL INTERATIVO (VALORES EM METICAIS) ──
                    const ehConsultaCalcAjuda = ['calc', 'calcular', 'calculador', 'calculadora', '!calc', '.calc', '/calc'].includes(cleanCmd);
                    if (ehConsultaCalcAjuda) {
                        await reply(
                            `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n` +
                            `  🧮 *CALCULADOR DE MEGAS KA-NET* ⚡\n` +
                            `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                            `Calculamos megas exatos para *qualquer valor* em Meticais que transferir!\n\n` +
                            `💡 *Como consultar:*\n` +
                            `• Digite: *.calc 35* ou *.calc 80*\n` +
                            `• Ou pergunte: *quanto dá 35 mt?*\n` +
                            `• Ou envie apenas o valor: *35 mt*\n\n` +
                            `⚡ _Aceitamos qualquer valor a partir de 5 MT com ativação automática 24h!_`
                        );
                        continue;
                    }

                    // Detetar consultas: .calc 19, quantos megas terá com 19mt, quanto dá 19 mt, 19 mt dá quantos megas, 19 mt
                    let valorConsultaCalc = null;
                    const cleanSemAcento = cleanText.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

                    const mCalcCmd = cleanSemAcento.match(/^[.!/#]?(?:calc|calcular|calcula)\s+(\d+)\s*(?:mt|mzn|meticais)?$/i);
                    const mQuantosMegas = cleanSemAcento.match(/quantos?\s+(?:megas?|mb|mbs|gigas?|gb|gbs)?.*?(?:com|para|de|por|\s)\s*(\d+)\s*(?:mt|mzn|meticais|\b)/i);
                    const mSePagar = cleanSemAcento.match(/(?:se\s+)?(?:pagar|mandar|enviar|transferir|depositar)\s+(\d+)\s*(?:mt|mzn|meticais)?.*?(?:megas?|mb|gigas?|gb|quanto)/i);
                    const mQuantoDa = cleanSemAcento.match(/^quanto\s+(?:da|e|fica|custa|rende|vale)\s+(\d+)\s*(?:mt|mzn|meticais)?\??$/i);
                    const mInvertido = cleanSemAcento.match(/^(\d+)\s*(?:mt|mzn|meticais)\s+(?:da|sao|rende|vale|equivale|tem|recebo)/i);
                    const mValorPuro = cleanSemAcento.match(/^(\d+)\s*(?:mt|mzn|meticais)$/i);

                    if (mCalcCmd) valorConsultaCalc = parseInt(mCalcCmd[1]);
                    else if (mQuantosMegas && mQuantosMegas[1]) valorConsultaCalc = parseInt(mQuantosMegas[1]);
                    else if (mSePagar && mSePagar[1]) valorConsultaCalc = parseInt(mSePagar[1]);
                    else if (mQuantoDa) valorConsultaCalc = parseInt(mQuantoDa[1]);
                    else if (mInvertido) valorConsultaCalc = parseInt(mInvertido[1]);
                    else if (mValorPuro) {
                        const vp = parseInt(mValorPuro[1]);
                        if (vp >= 5 && vp <= 5000) valorConsultaCalc = vp;
                    }

                    if (valorConsultaCalc && valorConsultaCalc >= 5) {
                        const pkg = buscarPacotePorValor(valorConsultaCalc, jid);
                        if (pkg && pkg.mb > 0) {
                            const { mpesa_num, mpesa_name, emola_num, emola_name } = getPaymentDetails();
                            const volFormatado = pkg.mb >= 1024 ? `${(pkg.mb / 1024).toFixed(1)} GB` : `${pkg.mb} MB`;
                            const taxaMbMt = (pkg.mb / valorConsultaCalc).toFixed(1);
                            const catNome = pkg.calculado ? 'Cálculo Proporcional Automático ⚡' : (pkg.tipo === '24hrs' ? 'Pacote Diário (24h)' : (pkg.tipo === 'semanal' ? 'Pacote Semanal (7 dias)' : 'Pacote Mensal'));

                            await reply(
                                `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n` +
                                `  🧮 *CÁLCULO DE MEGAS KA-NET* ⚡\n` +
                                `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                                `Para o valor de *${valorConsultaCalc} MT*, você recebe:\n\n` +
                                `╭─────────────────────────────╮\n` +
                                `│ 💰 *Valor Pago:* *${valorConsultaCalc} MT*\n` +
                                `│ 📦 *Recebe:* *${volFormatado}* (${pkg.mb} MB)\n` +
                                `│ ⏱️ *Validade:* 24 Horas\n` +
                                `│ 📈 *Rendimento:* ~${taxaMbMt} MB por MT\n` +
                                `│ 🏷️ *Categoria:* ${catNome}\n` +
                                `╰─────────────────────────────╯\n\n` +
                                `⚡ *COMO ATIVAR AGORA:*\n` +
                                `1️⃣ Transfira *${valorConsultaCalc} MT* para uma das contas:\n` +
                                `   🔴 *M-Pesa:* \`${mpesa_num}\` (${mpesa_name})\n` +
                                `   🟡 *e-Mola:* \`${emola_num}\` (${emola_name})\n` +
                                `2️⃣ Envie a confirmação (SMS ou print) aqui com o seu número Vodacom na última linha.\n` +
                                `3️⃣ O robô ativa os teus megas no mesmo segundo! 🚀`
                            );
                            continue;
                        }
                    }

                    // ── 12. TABELA DE ESTUDANTES (OPÇÃO 3) ────────────────────────────
                    if (opcaoMenuNum === '3' || ['3', '3️⃣', 'estudante', 'estudantes', 'escola', 'escolar'].includes(cleanCmd) || cleanText.includes('estudante')) {
                        await reply(gerarMenuEstudante());
                        continue;
                    }

                    // ── 13. MENU / TABELA ORIGINAL (OPÇÃO 1) ──────────────────────────
                    const ehPedidoMenu = (opcaoMenuNum === '1') || [
                        '1', '1️⃣', 'menu', 'tabela', 'tabelas', 'pacote', 'pacotes', 'plano', 'planos',
                        'preco', 'precos', 'preço', 'preços', 'valores', 'megas', 'gigas', 'comprar'
                    ].includes(cleanCmd) || 
                    cleanCmd === 'menu' || cleanCmd.startsWith('menu ') || 
                    cleanCmd.startsWith('tabela ') || cleanCmd.startsWith('preço') || cleanCmd.startsWith('preco') ||
                    cleanText.includes('tabela') || 
                    cleanText.includes('preco') || 
                    cleanText.includes('preço') || 
                    cleanText.includes('pacote') || 
                    cleanText.includes('valores') ||
                    cleanText.includes('como comprar') ||
                    cleanText.includes('quero comprar') ||
                    cleanText.includes('manda a tabela') ||
                    cleanText.includes('manda tabela') ||
                    cleanText.includes('quero megas') ||
                    cleanText.includes('tem megas');

                    if (ehPedidoMenu) {
                        addLog(`📋 [RESPONDENDO] Menu/Tabela enviado para ${jid}`);
                        await reply(gerarMenuOriginal(jid));
                        continue;
                    }

                    // ── 14. PAGAMENTO ORIGINAL (OPÇÃO 2) ──────────────────────────────
                    const ehPedidoPagamento = (opcaoMenuNum === '2') || [
                        '2', '2️⃣', 'pagamento', 'pagar', 'conta', 'contas', 'mpesa', 'emola', 'dados de pagamento'
                    ].includes(cleanCmd) || 
                    cleanCmd.startsWith('pagamento') ||
                    cleanText.includes('pagamento') ||
                    cleanText.includes('como pagar') ||
                    cleanText.includes('formas de pagamento') ||
                    cleanText.includes('dados de pagamento') ||
                    cleanText.includes('numero de pagamento') ||
                    cleanText.includes('número de pagamento');

                    if (ehPedidoPagamento) {
                        addLog(`💳 [RESPONDENDO] Formas de Pagamento enviadas para ${jid}`);
                        await reply(gerarMensagemPagamento(nomeCliente));
                        continue;
                    }

                    // ── 15. SUPORTE & AJUDA (OPÇÃO 5 OU QUANDO NÃO RECEBEU O PACOTE) ──
                    const ehPedidoSuporte = (opcaoMenuNum === '5') || ['5', '5️⃣', 'suporte', 'ajuda', 'socorro', 'contato', 'contacto', 'admin'].includes(cleanCmd);
                    const ehReclamacaoPacote = [
                        'nao recebi', 'não recebi', 'nao chegou', 'não chegou', 'ainda nao', 'ainda não',
                        'cade meu', 'cadê meu', 'onde esta meu', 'onde está o meu', 'nao ativou', 'não ativou',
                        'nao funciona', 'não funciona', 'demora', 'pacote nao', 'pacote não', 'sem megas', 'sem internet'
                    ].some(frase => cleanText.includes(frase));

                    if (ehPedidoSuporte || ehReclamacaoPacote) {
                        await reply(gerarMensagemSuporte(nomeCliente));
                        continue;
                    }

                    // ── 16.5 GUIA DE CONFIGURAR NÚMERO / RECEPTOR PADRÃO (OPÇÃO 7) ──
                    const ehConsultaConfigurarNumero = (opcaoMenuNum === '7') || [
                        '7', '7️⃣', 'configurar', 'configurar numero', 'configurarnumero', 'como configurar', 'como configurar numero',
                        'como configurar meu numero', 'ajuda configurar', 'guia configurar', 'recarga automatica', 'sem comprovativo',
                        'recarga direta', 'envio automatico'
                    ].includes(cleanCmd) ||
                    cleanText.includes('como configurar numero') ||
                    cleanText.includes('como configurar o numero') ||
                    cleanText.includes('como configurar meu numero') ||
                    cleanText.includes('configurar meu numero') ||
                    cleanText.includes('recarga automatica sem comprovativo');

                    if (ehConsultaConfigurarNumero) {
                        await reply(gerarGuiaConfigurarNumero(senderNumber));
                        continue;
                    }

                    // ── 16. GUIA DO TXENECO / CRÉDITO DE INTERNET (OPÇÃO 6) ──────────
                    const ehConsultaTxeneco = (opcaoMenuNum === '6') || [
                        '6', '6️⃣', 'txeneca', 'txeneco', 'txenecar', 'txenekar', 'tcheneca', 'tcheneco', 'tchenecar',
                        'emprestimo', 'emprestimos', 'empréstimo', 'empréstimos', 'credito', 'crédito', 'adiantamento'
                    ].includes(cleanCmd) ||
                    cleanText.includes('como funciona o txeneca') ||
                    cleanText.includes('como funciona txeneca') ||
                    cleanText.includes('o que e txeneca') ||
                    cleanText.includes('o que é txeneca') ||
                    cleanText.includes('o que e o txeneca') ||
                    cleanText.includes('o que é o txeneca') ||
                    cleanText.includes('taxa do txeneca') ||
                    cleanText.includes('taxa txeneca') ||
                    cleanText.includes('quando pagar txeneca') ||
                    cleanText.includes('como pagar txeneca') ||
                    cleanText.includes('quando pagar') ||
                    cleanText.includes('regras txeneca') ||
                    cleanText.includes('como txenecar') ||
                    cleanText.includes('quero txenecar') ||
                    cleanText.includes('quero credito') ||
                    cleanText.includes('quero crédito') ||
                    cleanText.includes('posso txenecar');

                    if (ehConsultaTxeneco) {
                        addLog(`⚡ [RESPONDENDO] Guia e Info de Txeneco enviado para ${jid}`);
                        await reply(gerarInfoTxenecoCompleta(senderNumber));
                        continue;
                    }


                    // ── 16. SAUDAÇÃO / BOAS VINDAS PADRÃO (PRIVADO OU SAUDAÇÃO EXPLÍCITA) ─
                    const isGroupMsg = jid.endsWith('@g.us');
                    const textNorm = (cleanText || '')
                        .normalize('NFD')
                        .replace(/[\u0300-\u036f]/g, '')
                        .replace(/[^\w\s]/g, ' ')
                        .replace(/\s+/g, ' ')
                        .trim();

                    const regexSaudacao = /^(?:ola|oi+|bom dia|boa tarde|boa noite|tudo bem|td bem|tudo bom|opa|salve|alo|hello|hi|eae|eai|start|iniciar|comecar|bot|ka net|kanet|ajuda|info|ajude|menu)(?:\s|$)/i;
                    const ehSaudacaoExplicita = regexSaudacao.test(textNorm) ||
                        /^(?:ola|oi+|opa|salve)\s+(?:tudo bem|como esta|amigo|mano|irmao|boa|bom)/i.test(textNorm) ||
                        /^(?:como esta|tudo bem|td bem)\??$/i.test(textNorm) ||
                        ['preciso de megas', 'quero megas', 'comprar', 'quero net', 'preciso de net', 'quero comprar', 'como comprar', 'como funciona', 'quanto custa', 'preco', 'precos'].some(w => textNorm.startsWith(w));

                    if (ehSaudacaoExplicita) {
                        addLog(`👋 [SAUDAÇÃO] Mensagem padrão de boas-vindas enviada para ${jid}`);
                        await reply(gerarMensagemBoasVindas(nomeCliente, senderNumber));
                        continue;
                    }

                    // ── 17. MENSAGEM DIRECIONADA OU PERGUNTAS AO BOT NO GRUPO ──
                    if (isGroupMsg) {
                        const myJidNumber = sock?.user?.id ? sock.user.id.split(':')[0].replace(/\D/g, '') : '258876692062';
                        const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
                        const mentionedJids = (contextInfo?.mentionedJid || []).map(j => String(j).replace(/\D/g, ''));
                        
                        const isCallToBot = mentionedJids.some(m => m.includes(myJidNumber)) || 
                                           text.includes(myJidNumber) || 
                                           /^(?:@?bot|kanet|ka-net)[,:\s]/i.test(cleanCmd) ||
                                           /^(?:@?bot|kanet|ka-net)$/i.test(cleanCmd) ||
                                           cleanText.startsWith('@bot') ||
                                           cleanText.startsWith('bot ') ||
                                           cleanText === 'bot';

                        const queryGroup = cleanCmd.replace(/^(?:@?bot|kanet|ka-net)[,:\s]*/i, '').trim();

                        // Resposta instantânea de Status Online no grupo
                        if (isPerguntaOnlineBot(queryGroup || cleanCmd) && (isCallToBot || isPerguntaOnlineBot(cleanCmd))) {
                            addLog(`🟢 [STATUS ON GRUPO] Respondendo para ${senderNumber} em ${jid}`);
                            await reply(gerarRespostaStatusOnline());
                            continue;
                        }

                        // Resposta instantânea se Pode Comprar no grupo
                        if (isPerguntaComprarBot(queryGroup || cleanCmd) && (isCallToBot || isPerguntaComprarBot(cleanCmd))) {
                            addLog(`🛒 [POSSO COMPRAR GRUPO] Respondendo para ${senderNumber} em ${jid}`);
                            await reply(gerarRespostaPossoComprar());
                            continue;
                        }

                        if (isCallToBot) {
                            if (!queryGroup || queryGroup === 'menu' || queryGroup === 'ajuda') {
                                addLog(`📢 [BOT MENCIONADO EM GRUPO] Enviando menu para ${jid}`);
                                await reply(gerarMenuOriginal(jid));
                                continue;
                            }
                            if (geminiAI.isConfigured()) {
                                addLog(`🧠 [GEMINI BRAIN GRUPO] Respondendo: "${queryGroup}" para ${senderNumber}`);
                                const respostaIa = await geminiAI.cerebroGemini(senderNumber, queryGroup, {
                                    nomeCliente,
                                    modoManutencao
                                });
                                if (respostaIa) {
                                    await reply(respostaIa);
                                    continue;
                                }
                            }
                            await reply(gerarMenuOriginal(jid));
                            continue;
                        }

                        // Se for mensagem de grupo comum e não bateu nenhum comando/comprovativo/menu, ignorar para não poluir
                        addLog(`ℹ️ [GRUPO DESCARTADO] Sem comando reconhecido: "${cleanCmd}" em ${jid}`);
                        continue;
                    }

                    // Se for __gemini_visual_query__ (imagem que não era comprovativo de pagamento):
                    if (text === '__gemini_visual_query__') {
                        if (geminiAI.isConfigured()) {
                            await reply(
                                `📸 *Imagem recebida!*\n\n` +
                                `Não consegui identificar um comprovativo válido de *M-Pesa* ou *e-Mola* nesta imagem.\n\n` +
                                `💡 *Dica:* Envie o print nítido do SMS onde apareça o valor (MT) e o código da transação.`
                            );
                        }
                        continue;
                    }

                    // Respostas instantâneas no privado: "estão on?", "posso comprar?", etc.
                    if (isPerguntaOnlineBot(cleanCmd)) {
                        addLog(`🟢 [STATUS ON PRIVADO] Respondendo para ${senderNumber}`);
                        await reply(gerarRespostaStatusOnline());
                        continue;
                    }

                    if (isPerguntaComprarBot(cleanCmd)) {
                        addLog(`🛒 [POSSO COMPRAR PRIVADO] Respondendo para ${senderNumber}`);
                        await reply(gerarRespostaPossoComprar());
                        continue;
                    }

                    // Se for mensagem privada e for conversacional, acionar Cérebro Gemini!
                    if (geminiAI.isConfigured() && geminiAI.isMensagemConversacional(cleanCmd)) {
                        addLog(`🧠 [GEMINI BRAIN PRIVADO] Conversando com ${senderNumber} (${nomeCliente}): "${cleanCmd}"`);
                        const respostaIa = await geminiAI.cerebroGemini(senderNumber, cleanCmd, {
                            nomeCliente,
                            modoManutencao
                        });
                        if (respostaIa) {
                            await reply(respostaIa);
                            continue;
                        }
                    }

                    // No privado, se o cliente mandar algo desconhecido, enviar as boas-vindas de suporte
                    await reply(gerarMensagemBoasVindas(nomeCliente, senderNumber));
                }
            } catch (err) {
                addLog(`❌ [ERRO MSG]: ${err.message}`);
                console.error('❌ [BAILEYS MSG ERROR]:', err);
            }
        });

    } catch (e) {
        isConnecting = false;
        console.error('❌ [BAILEYS INIT ERROR]:', e);
        setTimeout(() => startWhatsApp(orderDispatchCallback), 10000);
    }
}

function getStatus() {
    return {
        status: connectionStatus,
        user: connectedUser,
        hasQr: !!currentQrBase64,
        qrImage: currentQrBase64,
        modoManutencao,
        gruposFechados: DYN_CFG.GRUPOS_FECHADOS || []
    };
}

async function sendTextMessage(jid, text, options = {}) {
    if (sock && connectionStatus === 'connected') {
        const payload = typeof text === 'string' ? { text } : { ...text };
        if (options && options.mentions && Array.isArray(options.mentions)) {
            payload.mentions = options.mentions;
        } else if (typeof payload.text === 'string') {
            const matches = payload.text.match(/@(\d{9,15})/g);
            if (matches) {
                payload.mentions = matches
                    .map(m => m.replace('@', ''))
                    .filter(num => (num.length === 12 && num.startsWith('258')) || num.length === 9)
                    .map(num => (num.startsWith('258') ? num : '258' + num) + '@s.whatsapp.net');
            }
        }
        return await sock.sendMessage(jid, payload);
    }
    return false;
}

async function getGroups() {
    if (sock && connectionStatus === 'connected') {
        try {
            const groups = await sock.groupFetchAllParticipating();
            return Object.values(groups).map(g => ({
                jid: g.id,
                name: g.subject || 'Grupo Sem Nome',
                participants_count: (g.participants || []).length,
                creation: g.creation,
                owner: g.owner || g.subjectOwner
            }));
        } catch(e) {
            console.error('⚠️ [BAILEYS] Erro ao buscar grupos participantes:', e.message);
        }
    }
    return [];
}

/**
 * Ativa ou desativa o modo de manutenção global.
 * Bloqueia compras em grupos E em privado para todos os não-admins.
 */
function setModoManutencao(ativo) {
    modoManutencao = !!ativo;
    DYN_CFG.MODO_MANUTENCAO = modoManutencao;
    salvarBotConfig();
    return modoManutencao;
}

function getModoManutencao() {
    return modoManutencao;
}

/**
 * Silencia completamente o bot — ignora todas as mensagens de não-admins.
 * Útil para manutenção silenciosa ou quando o admin não quer resposta automática.
 */
function setBotSilenciado(ativo) {
    botSilenciado = !!ativo;
    return botSilenciado;
}

function getBotSilenciado() {
    return botSilenciado;
}

/**
 * Ativa ou desativa vendas para um grupo específico.
 * Quando fechado, o bot ignora mensagens de não-admins nesse grupo.
 * @returns {boolean} true = grupo agora fechado, false = grupo agora aberto
 */
function toggleGrupoFechado(jid) {
    if (!DYN_CFG.GRUPOS_FECHADOS) DYN_CFG.GRUPOS_FECHADOS = [];
    const idx = DYN_CFG.GRUPOS_FECHADOS.indexOf(jid);
    if (idx === -1) {
        DYN_CFG.GRUPOS_FECHADOS.push(jid);
    } else {
        DYN_CFG.GRUPOS_FECHADOS.splice(idx, 1);
    }
    salvarBotConfig();
    return DYN_CFG.GRUPOS_FECHADOS.includes(jid);
}

function getJidForOrder(orderId) {
    if (!orderId) return null;
    for (const [txnId, reg] of transacoesProcessadasMap.entries()) {
        if (orderId.includes(txnId)) return reg.jid;
    }
    const v = historicoVendas.find(x => x.orderId === orderId);
    if (v && v.jid) return v.jid;
    return null;
}

/**
 * Processa a ativação quando a operadora confirma o pagamento (M-Pesa / e-Mola)
 */
async function processarPedidoAguardandoConfirmado(item, valorPago, metodo) {
    try {
        const smsRec = findSmsPayment(item.txn_id);
        if (smsRec) {
            smsRec.usado = true;
            smsRec.usadoPor = item.senderNumber;
            smsRec.usadoEm = Date.now();
            salvarSmsPayments();
        }

        const { supportNum } = getSuporteDetails();
        const metodoNome = (metodo || item.metodo) === 'emola' ? 'e-Mola' : 'M-Pesa';

        if (item.numDestino) {
            const orderId = 'WA-' + item.txn_id + '-' + Date.now();

            if (sock) {
                await sock.sendMessage(item.jid, {
                    text: `✅ *PEDIDO RECEBIDO* ⚡\n` +
                          `━━━━━━━━━━━━━━━━━━\n` +
                          `📦 *Pacote:* *${item.pacote.nome}*\n` +
                          `📲 *Destino:* *${item.numDestino}*\n` +
                          `💳 *Valor:* *${valorPago} MT* (${metodoNome})\n` +
                          `🔖 *Ref:* \`${item.txn_id}\`\n` +
                          `━━━━━━━━━━━━━━━━━━\n` +
                          `🚀 *Ativação em andamento...*\n` +
                          `_Receberá a confirmação em instantes._`
                });
            }

            historicoVendas.push({
                orderId,
                numero: item.numDestino,
                mb: item.pacote.mb,
                valor: valorPago,
                timestamp: Date.now()
            });

            transacoesProcessadas.add(item.txn_id);
            transacoesProcessadasMap.set(item.txn_id, {
                sender: item.senderNumber,
                jid: item.jid,
                numeroDestino: item.numDestino,
                valor: valorPago,
                status: 'completed',
                timestamp: Date.now()
            });
            salvarTransacoes();

            const origemMsg = item.jid.endsWith('@g.us') ? 'Grupo WhatsApp' : 'Privado';
            const tabelaOrigem = item.pacote.origem === 'grupo_especifico' ? 'Tabela Exclusiva deste Grupo' : 'Tabela Padrão Geral';
            enviarNotificacaoGrupo(
                `🔔 *NOVO PEDIDO VALIDADO PELA OPERADORA* ⚡\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `📋 *Ref:* \`${orderId}\`\n` +
                `📲 *Destino:* *${item.numDestino}*\n` +
                `📦 *Pacote:* *${item.pacote.nome}*\n` +
                `💳 *Valor:* *${valorPago} MT* (${metodoNome})\n` +
                `👤 *Cliente:* *${item.nomeCliente}* (${item.senderNumber})\n` +
                `🏢 *Origem:* *${origemMsg}*\n` +
                `🏷️ *Tabela:* *${tabelaOrigem}*\n` +
                `🕒 *Hora:* ${new Date().toLocaleString('pt-PT', { timeZone: 'Africa/Maputo' })}\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `⏳ *Status:* Validado via SMS da Operadora. Enviado para ativação USSD!`
            );

            if (orderDispatchCallback) {
                if (item.rawLidClean && item.numDestino) {
                    lidToPhoneMap.set(item.rawLidClean, item.numDestino.startsWith('258') ? item.numDestino : '258' + item.numDestino);
                }
                orderDispatchCallback({
                    orderId,
                    numero: item.numDestino,
                    quantidade: item.pacote.mb,
                    modo: item.pacote.tipo,
                    jid: item.jid,
                    sender: item.senderNumber,
                    senderJid: item.realSender || item.jid,
                    senderPhone: item.senderNumber, // Cliente é quem compra/paga, NUNCA o destinatário
                    senderName: item.nomeCliente,
                    txn_id: item.txn_id,
                    valor: valorPago
                });
            }
        } else {
            // ── VERIFICAR RECEPTOR CONFIGURADO VIA .configurar ──
            let receptorConfig = customerServices.obterReceptorPadrao(item.senderNumber);
            if (!receptorConfig && item.rawLidClean && lidToPhoneMap.has(item.rawLidClean)) {
                receptorConfig = customerServices.obterReceptorPadrao(lidToPhoneMap.get(item.rawLidClean));
            }
            if (!receptorConfig && smsOperadora && smsOperadora.remetente) {
                receptorConfig = customerServices.obterReceptorPadrao(smsOperadora.remetente);
            }
            if (receptorConfig && receptorConfig.targetPhone) {
                const numReceptor = receptorConfig.targetPhone;
                const orderId = 'WA-' + item.txn_id + '-' + Date.now();
                console.log(`⚡ [AUTO-RECEPTOR SMS] Operadora confirmou para ${item.senderNumber} → receptor fixo: ${numReceptor}`);

                registrarTransacaoAutoReceptor(item.txn_id, numReceptor, parseFloat(valorPago), item.senderNumber);

                historicoVendas.push({
                    orderId,
                    numero: numReceptor,
                    mb: item.pacote.mb,
                    valor: parseFloat(valorPago),
                    timestamp: Date.now()
                });

                const origemMsg = item.jid.endsWith('@g.us') ? 'Grupo WhatsApp' : 'Privado';
                enviarNotificacaoGrupo(
                    `🔔 *NOVO PEDIDO (AUTO-RECEPTOR + OPERADORA)* ⚡\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `📋 *Ref:* \`${orderId}\`\n` +
                    `📲 *Destino (Receptor Fixo):* *${numReceptor}*\n` +
                    `📦 *Pacote:* *${item.pacote.nome}*\n` +
                    `💳 *Valor:* *${valorPago} MT* (${metodoNome})\n` +
                    `👤 *Pagador:* *${item.nomeCliente}* (${item.senderNumber})\n` +
                    `🏢 *Origem:* *${origemMsg}*\n` +
                    `🕒 *Hora:* ${new Date().toLocaleString('pt-PT', { timeZone: 'Africa/Maputo' })}\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `⚡ *Status:* Validado pela operadora + receptor fixo aplicado!`
                );

                if (sock) {
                    await sock.sendMessage(item.jid, {
                        text: `✅ *PEDIDO AUTOMÁTICO CONFIRMADO* ⚡\n` +
                              `━━━━━━━━━━━━━━━━━━\n` +
                              `📦 *Pacote:* *${item.pacote.nome}*\n` +
                              `📲 *Receptor Fixo:* *${numReceptor}*\n` +
                              `💳 *Valor:* *${valorPago} MT* (${metodoNome})\n` +
                              `🔖 *Ref:* \`${item.txn_id}\`\n` +
                              `━━━━━━━━━━━━━━━━━━\n` +
                              `🚀 *Ativação automática em andamento!*\n` +
                              `_Receptor fixo ativo — sem necessidade de enviar número!_`
                    });
                }

                if (orderDispatchCallback) {
                    orderDispatchCallback({
                        orderId,
                        numero: numReceptor,
                        quantidade: item.pacote.mb,
                        modo: item.pacote.tipo,
                        jid: item.jid,
                        sender: item.senderNumber,
                        senderName: item.nomeCliente,
                        txn_id: item.txn_id,
                        valor: valorPago
                    });
                }
                return;
            }

            // Sem receptor configurado — pedir o número ao cliente
            const pendingKey = `${item.jid}:${item.senderNumber}`;
            pendingPayments.set(pendingKey, {
                txn_id: item.txn_id,
                valor: valorPago,
                metodo: item.metodo,
                senderName: item.nomeCliente,
                senderNumber: item.senderNumber,
                rawLidClean: item.rawLidClean,
                realSender: item.realSender,
                pacote: item.pacote,
                aguardando_numero: true
            });

            transacoesProcessadas.add(item.txn_id);
            transacoesProcessadasMap.set(item.txn_id, {
                sender: item.senderNumber,
                jid: item.jid,
                valor: valorPago,
                status: 'locked',
                timestamp: Date.now()
            });
            salvarTransacoes();

            if (sock) {
                await sock.sendMessage(item.jid, {
                    text: `✅ *COMPROVATIVO VALIDADO* ⚡\n` +
                          `━━━━━━━━━━━━━━━━━━\n`
 +
                          `📦 *Pacote:* *${item.pacote.nome}* (${item.pacote.mb} MB)\n` +
                          `💳 *Valor:* *${valorPago} MT* (${metodoNome})\n` +
                          `🔖 *Ref:* \`${item.txn_id}\`\n` +
                          `━━━━━━━━━━━━━━━━━━\n` +
                          `📲 *Para qual número enviar?*\n` +
                          `_Responda com o número Vodacom (ex: 84XXXXXXX)_`
                });
            }
        }
    } catch (e) {
        console.error('❌ Erro ao processar pedido confirmado pós-operadora:', e);
    }
}

/**
 * Chamado quando um SMS real de dinheiro recebido chega via /api/sms/payment
 */
function registrarSmsPayment({ txn_id, valor, remetente, metodo, raw_sms }) {
    if (!txn_id) return;
    const cleanTxnId = String(txn_id).trim().toUpperCase();
    const vNum = parseFloat(valor);
    console.log(`💰 [SMS OPERADORA REGISTADO] Ref: ${cleanTxnId} | Valor: ${vNum} MT | Remetente: ${remetente} (${metodo})`);

    let existing = findSmsPayment(cleanTxnId);
    if (!existing) {
        existing = {
            txn_id: cleanTxnId,
            valor: vNum,
            remetente: remetente || '',
            metodo: metodo || 'mpesa',
            raw_sms: raw_sms || '',
            timestamp: Date.now(),
            usado: false
        };
        smsPaymentsMap.set(cleanTxnId, existing);
        salvarSmsPayments();
    }

    // Se houver algum cliente aguardando no status "Aguardando Confirmação da Operadora":
    const matchAguardando = findItemAguardandoOperadora(cleanTxnId);
    if (matchAguardando) {
        const { key, item } = matchAguardando;
        aguardandoOperadora.delete(key);
        salvarAguardandoOperadora();
        if (item.timer) {
            clearTimeout(item.timer);
            item.timer = null;
        }

        console.log(`🎉 [OPERADORA VALIDOU] Cliente ${item.senderNumber} estava aguardando ref ${item.txn_id || key} (SMS ref: ${cleanTxnId}). Processando imediatamente!`);
        processarPedidoAguardandoConfirmado(item, vNum, metodo || item.metodo);
    }
}

function registrarTransacaoAutoReceptor(cleanTxnId, targetPhone, valor, payerPhone) {
    if (!cleanTxnId) return;
    const txnClean = String(cleanTxnId).trim().toUpperCase();
    transacoesProcessadas.add(txnClean);
    transacoesProcessadasMap.set(txnClean, {
        status: 'completed',
        isAutoReceptor: true,
        autoTarget: targetPhone,
        numeroDestino: targetPhone,
        valor: Number(valor),
        sender: payerPhone,
        completedAt: Date.now()
    });
    const smsRec = findSmsPayment(txnClean);
    if (smsRec) {
        smsRec.usado = true;
        smsRec.usadoPor = `auto_receptor_${targetPhone}`;
        smsRec.usadoEm = Date.now();
    }
    salvarTransacoes();
    salvarSmsPayments();
    console.log(`⚡ [AUTO-RECEPTOR REGISTADO] Ref: ${txnClean} vinculada a ${targetPhone}`);
}

async function resetSession(db) {
    console.log('🧹 [BAILEYS] Reset total de sessão WhatsApp solicitado.');
    try {
        if (sock) {
            try {
                sock.ev.removeAllListeners();
                sock.ws?.close();
                sock.end?.(undefined);
            } catch(e) {
                console.warn('⚠️ [BAILEYS] Erro ao fechar socket no resetSession:', e.message);
            }
            sock = null;
        }
        if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            fs.mkdirSync(AUTH_DIR, { recursive: true });
        }
        if (db) {
            try {
                const snap = await db.collection('whatsapp_cloud_auth').get();
                const b = db.batch();
                snap.docs.forEach(d => b.delete(d.ref));
                await b.commit();
            } catch(e) {
                console.warn('⚠️ [FIRESTORE] Erro ao deletar whatsapp_cloud_auth no resetSession:', e.message);
            }
        }
        connectionStatus = 'connecting';
        currentQrBase64 = null;
        isConnecting = false;
        reconnectAttempts = 0;
        setTimeout(() => startWhatsApp(orderDispatchCallback, db), 1500);
        return { success: true, message: 'Sessão limpa. Novo QR Code a ser gerado...' };
    } catch(e) {
        return { success: false, error: e.message };
    }
}

/**
 * Altera as definições de todos ou de grupos específicos no WhatsApp para 'announcement' (apenas admins enviam mensagens)
 * e envia o comunicado com a mensagem/motivo especificado pelo operador.
 */
async function closeGroupsWithReason(motivo, targetJids = null) {
    if (!sock || connectionStatus !== 'connected') {
        throw new Error('WhatsApp não está conectado');
    }
    const allGroups = await getGroups();
    const jidsToClose = targetJids && Array.isArray(targetJids) && targetJids.length > 0
        ? targetJids
        : allGroups.map(g => g.jid);

    if (!DYN_CFG.GRUPOS_FECHADOS) DYN_CFG.GRUPOS_FECHADOS = [];
    const results = [];
    const msgTexto = 
        `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n` +
        `  🛑 *GRUPO TEMPORARIAMENTE FECHADO* 🛑\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
        `📢 *Comunicado Oficial:*\n` +
        `${motivo || 'Atendimento suspenso temporariamente.'}\n\n` +
        `⏱️ *O bot informará assim que as vendas e o atendimento forem reabertos.*\n` +
        `_Agradecemos a compreensão de todos!_ 🙏`;

    for (const jid of jidsToClose) {
        try {
            // 1. Alterar definições do grupo no WhatsApp (apenas admins podem enviar mensagens)
            await sock.groupSettingUpdate(jid, 'announcement');
            
            // 2. Enviar mensagem explicativa no grupo
            await sock.sendMessage(jid, { text: msgTexto });

            // 3. Registar no estado interno do bot
            if (!DYN_CFG.GRUPOS_FECHADOS.includes(jid)) {
                DYN_CFG.GRUPOS_FECHADOS.push(jid);
            }
            results.push({ jid, ok: true });
        } catch(e) {
            console.error(`⚠️ [FECHAR GRUPO ERRO] ${jid}: ${e.message}`);
            results.push({ jid, ok: false, error: e.message });
        }
    }
    salvarBotConfig();
    return { count: results.filter(r => r.ok).length, total: jidsToClose.length, results };
}

/**
 * Reabre grupos no WhatsApp (not_announcement) permitindo que todos enviem mensagens
 * e notifica a reabertura no grupo.
 */
async function openAllGroups(targetJids = null) {
    if (!sock || connectionStatus !== 'connected') {
        throw new Error('WhatsApp não está conectado');
    }
    modoManutencao = false;
    DYN_CFG.MODO_MANUTENCAO = false;
    DYN_CFG.GRUPOS_FECHADOS = [];
    salvarBotConfig();

    const allGroups = await getGroups();
    const jidsToOpen = targetJids && Array.isArray(targetJids) && targetJids.length > 0
        ? targetJids
        : allGroups.map(g => g.jid);

    const results = [];
    const msgTexto = 
        `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n` +
        `  🟢 *GRUPO REABERTO COM SUCESSO!* 🎉\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
        `✅ *As vendas e o atendimento já estão 100% operacionais!*\n` +
        `_Envie a palavra desejada para realizar o seu pedido._ 📶`;

    for (const jid of jidsToOpen) {
        try {
            // 1. Alterar definições no WhatsApp (todos podem enviar mensagens)
            await sock.groupSettingUpdate(jid, 'not_announcement');

            // 2. Enviar mensagem de abertura
            await sock.sendMessage(jid, { text: msgTexto });

            // 3. Remover do estado interno de fechados
            if (DYN_CFG.GRUPOS_FECHADOS) {
                const idx = DYN_CFG.GRUPOS_FECHADOS.indexOf(jid);
                if (idx !== -1) DYN_CFG.GRUPOS_FECHADOS.splice(idx, 1);
            }
            results.push({ jid, ok: true });
        } catch(e) {
            console.error(`⚠️ [ABRIR GRUPO ERRO] ${jid}: ${e.message}`);
            results.push({ jid, ok: false, error: e.message });
        }
    }
    salvarBotConfig();
    return { count: results.filter(r => r.ok).length, total: jidsToOpen.length, results };
}

/**
 * Envia um comunicado / anúncio formatado para todos os grupos (ou grupos específicos)
 * sem alterar as definições de quem pode digitar no grupo.
 */
async function sendAnnouncementToGroups(mensagem, targetJids = null) {
    if (!sock || connectionStatus !== 'connected') {
        throw new Error('WhatsApp não está conectado');
    }
    const allGroups = await getGroups();
    const jidsToAnnounce = targetJids && Array.isArray(targetJids) && targetJids.length > 0
        ? targetJids
        : allGroups.map(g => g.jid);

    const results = [];
    const msgTexto = 
        `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n` +
        `  📢 *COMUNICADO KA-NET* 📢\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
        `${mensagem || 'Comunicado geral para todos os clientes.'}\n\n` +
        `_Atenciosamente, Equipa KA-NET_ 📶`;

    for (const jid of jidsToAnnounce) {
        try {
            await sock.sendMessage(jid, { text: msgTexto });
            results.push({ jid, ok: true });
        } catch(e) {
            console.error(`⚠️ [COMUNICADO GRUPO ERRO] ${jid}: ${e.message}`);
            results.push({ jid, ok: false, error: e.message });
        }
    }
    return { count: results.filter(r => r.ok).length, total: jidsToAnnounce.length, results };
}


// ────────────────────────────────────────────────────────────────
// MOTOR AUTOMÁTICO DE LEMBRETES DE TXENECO (3X AO DIA)
// ────────────────────────────────────────────────────────────────
async function executarLembretesDividas() {
    try {
        if (!sock || connectionStatus !== 'connected') return;
        const agora = new Date();
        const horaStr = agora.toLocaleTimeString('pt-PT', { timeZone: 'Africa/Maputo', hour12: false });
        const dataStr = agora.toLocaleDateString('pt-PT', { timeZone: 'Africa/Maputo' });
        const hora = parseInt(horaStr.split(':')[0], 10);

        // 3 Horários de envio por dia (Fuso de Maputo / Moçambique):
        // 1. Manhã: 08:00 às 11:59
        // 2. Tarde: 12:00 às 16:59
        // 3. Noite: 17:00 às 21:59
        let slot = null;
        if (hora >= 8 && hora < 12) slot = { slotId: `${dataStr}:manha`, turno: 'Manhã' };
        else if (hora >= 12 && hora < 17) slot = { slotId: `${dataStr}:tarde`, turno: 'Tarde' };
        else if (hora >= 17 && hora < 22) slot = { slotId: `${dataStr}:noite`, turno: 'Noite' };

        if (!slot) return; // Não envia de madrugada para não incomodar o cliente

        const devedores = customerServices.obterDevedoresAtivos();
        if (!devedores || devedores.length === 0) return;

        for (const dev of devedores) {
            // Se já enviou neste turno de hoje, não repete
            if (dev.ultimoLembreteSlot === slot.slotId) continue;

            const clientPhone = dev.phone;
            const jidPrivado = `258${clientPhone}@s.whatsapp.net`;
            const volStr = dev.activeDebtMb >= 1024 ? `${(dev.activeDebtMb / 1024).toFixed(1)}GB` : `${dev.activeDebtMb}MB`;
            const nomeStr = dev.senderName ? `*${dev.senderName}*` : `Cliente *${clientPhone}*`;

            // 1. Lembrete no PRIVADO do cliente
            const msgPrivado = (
                `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n` +
                `  ⏰ *LEMBRETE DE PAGAMENTO TXENECO* ⏳\n` +
                `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                `Olá ${nomeStr}! Este é um lembrete do seu adiantamento de internet no Ka-Net:\n\n` +
                `💰 *Valor Pendente a Liquidar:* *${dev.restanteMt} MT*\n` +
                `📦 *Internet Adiantada:* *${volStr}*\n` +
                `🏷️ *Taxa de Serviço (10%):* já inclusa no valor acima\n\n` +
                `💡 *Como Efetuar o Pagamento:*\n` +
                `1. Transfira o valor de *${dev.restanteMt} MT* via M-Pesa ou e-Mola.\n` +
                `2. Envie aqui o comprovativo com o comando:\n` +
                `👉 *.pagar <comprovativo>*\n\n` +
                `🔓 _Assim que quitar, o seu limite de Txeneco será totalmente liberado!_\n` +
                `🛒 _Lembramos que pode continuar a fazer recargas normais normalmente._ 🌐✨`
            );

            sock.sendMessage(jidPrivado, { text: msgPrivado }).catch(e => {
                console.warn(`⚠️ [LEMBRETE PRIVADO FALHOU] ${clientPhone}:`, e.message);
            });

            // 2. Lembrete no GRUPO (onde o cliente interagiu ou no grupo oficial)
            let targetGrupoJid = null;
            if (dev.jidOrigem && dev.jidOrigem.endsWith('@g.us')) {
                targetGrupoJid = dev.jidOrigem;
            } else if (DYN_CFG.GRUPO_NOTIFICACOES) {
                targetGrupoJid = DYN_CFG.GRUPO_NOTIFICACOES;
            }

            if (targetGrupoJid) {
                const mentionJid = `258${clientPhone}@s.whatsapp.net`;
                const msgGrupo = (
                    `⏰ *AVISO DE REGULARIZAÇÃO TXENECO* ⏳\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `Olá @${clientPhone}! Lembramos que tens um saldo pendente de Txeneco de *${dev.restanteMt} MT* (*${volStr}*).\n\n` +
                    `💳 Para quitar e liberar novo crédito de internet, efetue o pagamento e envie no privado do bot:\n` +
                    `👉 *.pagar <comprovativo>*\n\n` +
                    `🛒 _(Você pode continuar a comprar recargas normais a qualquer momento!)_`
                );

                sock.sendMessage(targetGrupoJid, {
                    text: msgGrupo,
                    mentions: [mentionJid]
                }).catch(e => {
                    console.warn(`⚠️ [LEMBRETE GRUPO FALHOU] ${clientPhone}:`, e.message);
                });
            }

            customerServices.registrarLembreteEnviado(clientPhone, slot.slotId);
            console.log(`⏰ [LEMBRETE TXENECO ENVIADO] Cliente ${clientPhone} (${slot.turno}): ${dev.restanteMt} MT.`);
        }
    } catch (err) {
        console.error('❌ [ERRO LEMBRETES TXENECO]:', err.message);
    }
}

// Iniciar verificação automática a cada 15 minutos
setInterval(executarLembretesDividas, 15 * 60 * 1000);
// E agendar primeira verificação 1 minuto após início
setTimeout(executarLembretesDividas, 60 * 1000);

module.exports = { 
    startWhatsApp, 
    getStatus, 
    getConnectionStatus: getStatus,
    resetSession,
    sendTextMessage, 
    enviarMensagemTexto: sendTextMessage,
    enviarNotificacaoGrupo, 
    enviarErroGrupo, 
    getGrupoNotificacoes, 
    getGrupoErros,
    getGroups,
    setModoManutencao,
    getModoManutencao,
    setBotSilenciado,
    getBotSilenciado,
    toggleGrupoFechado,
    closeGroupsWithReason,
    openAllGroups,
    sendAnnouncementToGroups,
    getJidForOrder,
    registrarSmsPayment,
    registrarTransacaoAutoReceptor,
    salvarSmsPayments,
    smsPaymentsMap,
    aguardandoOperadora,
    setPaymentFinder,
    findSmsPayment,
    findItemAguardandoOperadora,
    salvarAguardandoOperadora,
    limparDuplicatasTabelas,
    salvarBotConfig,
    calcularPacoteProporcional,
    buscarPacotePorValor,
    separarMultiplosComprovativos,
    executarLembretesDividas,
    get DYN_CFG() { return DYN_CFG; },
    getRecentLogs: () => recentLogs
};

