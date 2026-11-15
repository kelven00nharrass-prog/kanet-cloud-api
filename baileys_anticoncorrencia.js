/**
 * ==============================================================================
 * AXION CLOUD WHATSAPP ENGINE — ANTICONCORRÊNCIA & ESPIÃO (SESSÃO SECUNDÁRIA)
 * ==============================================================================
 * Sessão dedicada para infiltração, extração de membros de grupos de concorrentes
 * e alimentação contínua da Blacklist Anticoncorrência do Axion System.
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

let sock = null;
let currentQrBase64 = null;
let connectionStatus = 'offline';
let connectedUser = null;
let firestoreDbInstance = null;
let isConnecting = false;
let reconnectAttempts = 0;
let mainBaileysEngine = null;

function setBaileysEngine(engine) {
    mainBaileysEngine = engine;
}

// Diretório de autenticação da sessão Anticoncorrência
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys_anticoncorrencia');
if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
}

// Arquivo da lista de concorrentes (compartilhado com o bot principal)
const CONCORRENTES_FILE = path.join(__dirname, 'concorrentes_db.json');

function carregarConcorrentes() {
    try {
        if (fs.existsSync(CONCORRENTES_FILE)) {
            const data = JSON.parse(fs.readFileSync(CONCORRENTES_FILE, 'utf8'));
            if (Array.isArray(data)) return new Set(data.map(n => String(n).replace(/\D/g, '')));
        }
    } catch (e) {
        console.warn('⚠️ [ANTICONCORRÊNCIA] Erro ao carregar concorrentes_db.json:', e.message);
    }
    return new Set();
}

function salvarConcorrentes(concorrentesSet) {
    try {
        const arr = Array.from(concorrentesSet);
        fs.writeFileSync(CONCORRENTES_FILE, JSON.stringify(arr, null, 2), 'utf8');
        
        // Backup no Firestore se disponível
        if (firestoreDbInstance) {
            firestoreDbInstance.collection('configuracoes').doc('anticoncorrencia_blacklist').set({
                numeros: arr,
                total: arr.length,
                updatedAt: new Date().toISOString()
            }).catch(() => {});
        }
        return true;
    } catch (e) {
        console.error('❌ [ANTICONCORRÊNCIA] Erro ao salvar concorrentes_db.json:', e.message);
        return false;
    }
}

// Cache de grupos detectados pela sessão espiã
let cachedGrupos = [];

const recentLogs = [];
function addLog(msg) {
    const entry = `[${new Date().toLocaleTimeString('pt-PT', { timeZone: 'Africa/Maputo' })}] ${msg}`;
    console.log(entry);
    recentLogs.unshift(entry);
    if (recentLogs.length > 50) recentLogs.pop();
}

// Validação do Master Kelven
function isMaster(numero) {
    if (!numero) return false;
    const clean = String(numero).replace(/\D/g, '');
    const clean9 = (clean.startsWith('258') && clean.length >= 11) ? clean.substring(3) : clean;

    if (clean.includes('850401416') || clean.includes('856116039') || clean.includes('856268811') ||
        clean9.includes('850401416') || clean9.includes('856116039') || clean9.includes('856268811') ||
        clean.includes('216054655656152')) {
        return true;
    }
    return false;
}

// Backup para Firestore da sessão
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
                    batch.set(db.collection('whatsapp_anticoncorrencia_auth').doc(encodeURIComponent(file)), {
                        content,
                        updatedAt: new Date().toISOString()
                    });
                    count++;
                }
            }
            if (count > 0) {
                await batch.commit();
                console.log(`☁️ [ANTICONCORRÊNCIA FIRESTORE] Backup de ${count} ficheiros de autenticação concluído.`);
            }
        } catch (e) {
            console.warn('⚠️ [ANTICONCORRÊNCIA FIRESTORE] Falha no backup:', e.message);
        }
    }, 5000);
}

async function restoreAuthFromFirestore(db) {
    if (!db) return;
    try {
        const snap = await db.collection('whatsapp_anticoncorrencia_auth').get();
        if (!snap.empty) {
            console.log(`☁️ [ANTICONCORRÊNCIA FIRESTORE] Restaurando ${snap.docs.length} ficheiros de sessão...`);
            for (const doc of snap.docs) {
                const fileName = decodeURIComponent(doc.id);
                const filePath = path.join(AUTH_DIR, fileName);
                fs.writeFileSync(filePath, doc.data().content, 'utf8');
            }
        }
        
        // Restaurar blacklist também
        const docBlacklist = await db.collection('configuracoes').doc('anticoncorrencia_blacklist').get();
        if (docBlacklist.exists) {
            const data = docBlacklist.data();
            if (Array.isArray(data.numeros)) {
                fs.writeFileSync(CONCORRENTES_FILE, JSON.stringify(data.numeros, null, 2), 'utf8');
                console.log(`🛡️ [ANTICONCORRÊNCIA FIRESTORE] ${data.numeros.length} concorrentes restaurados da nuvem.`);
            }
        }
    } catch (e) {
        console.warn('⚠️ [ANTICONCORRÊNCIA FIRESTORE] Falha ao restaurar:', e.message);
    }
}

/**
 * Atualiza e lista grupos onde a sessão espiã participa
 */
async function listarGruposDisponiveis() {
    if (!sock) return [];
    try {
        const groups = await sock.groupFetchAllParticipating();
        cachedGrupos = Object.values(groups).map((g, idx) => ({
            indice: idx + 1,
            id: g.id,
            subject: g.subject || 'Grupo sem nome',
            size: g.size || (g.participants ? g.participants.length : 0),
            participants: g.participants || []
        }));
        return cachedGrupos;
    } catch (e) {
        console.error('❌ [ANTICONCORRÊNCIA] Erro ao listar grupos:', e.message);
        return [];
    }
}

/**
 * Extrai todos os participantes de um grupo escolhido e grava na lista negra
 */
async function extrairMembrosGrupo(identificadorGrupo) {
    if (!sock) return { success: false, mensagem: 'Sessão espiã não está conectada!' };

    try {
        await listarGruposDisponiveis();
        
        let grupoAlvo = null;
        const indice = parseInt(identificadorGrupo, 10);
        if (!isNaN(indice) && indice > 0 && indice <= cachedGrupos.length) {
            grupoAlvo = cachedGrupos[indice - 1];
        } else {
            // Busca por nome ou ID
            const termo = String(identificadorGrupo).toLowerCase().trim();
            grupoAlvo = cachedGrupos.find(g => 
                g.id === identificadorGrupo || 
                g.subject.toLowerCase().includes(termo)
            );
        }

        if (!grupoAlvo) {
            return {
                success: false,
                mensagem: `❌ Grupo "${identificadorGrupo}" não foi encontrado. Use *.ext grupos* para ver os números dos grupos.`
            };
        }

        // Buscar metadados frescos do grupo para garantir todos participantes
        const meta = await sock.groupMetadata(grupoAlvo.id);
        const participants = meta.participants || [];

        if (participants.length === 0) {
            return { success: false, mensagem: `⚠️ O grupo "${meta.subject}" parece estar vazio ou inacessível.` };
        }

        const setAtual = carregarConcorrentes();
        let adicionados = 0;
        let ignorados = 0;

        for (const p of participants) {
            const rawId = p.id || '';
            const num = rawId.split('@')[0].replace(/\D/g, '');
            if (!num || num.length < 8) continue;

            // Não adicionar o próprio Master ou contas de pagamento à lista de concorrentes
            if (isMaster(num) || num === '856268811' || num === '879691565') {
                ignorados++;
                continue;
            }

            if (!setAtual.has(num)) {
                setAtual.add(num);
                adicionados++;
            }
        }

        salvarConcorrentes(setAtual);

        // 🚨 REMOÇÃO IMEDIATA: Executa a varredura e expulsão instantânea nos seus grupos agora mesmo!
        let infoExpulsao = '';
        if (mainBaileysEngine && typeof mainBaileysEngine.expurgarConcorrentesDeTodosGrupos === 'function') {
            try {
                console.log('🚨 [ANTICONCORRÊNCIA] Disparando expurgo imediato nos grupos do bot principal...');
                const resExp = await mainBaileysEngine.expurgarConcorrentesDeTodosGrupos();
                if (resExp && resExp.totalRemovidos > 0) {
                    infoExpulsao = `\n\n🚨 *EXPULSÃO IMEDIATA REALIZADA:*\nForam encontrados e removidos *${resExp.totalRemovidos}* concorrentes que já estavam nos seus grupos!\n• ` + resExp.gruposAfetados.join('\n• ');
                }
            } catch (eExp) {
                console.warn('⚠️ [ANTICONCORRÊNCIA] Falha no expurgo automático após extração:', eExp.message);
            }
        }

        return {
            success: true,
            grupoNome: meta.subject,
            totalMembros: participants.length,
            adicionados,
            totalBlacklist: setAtual.size,
            mensagem: `✅ *EXTRAÇÃO CONCLUÍDA COM SUCESSO!*\n\n` +
                      `👥 *Grupo Alvo:* ${meta.subject}\n` +
                      `📊 *Total de Membros no Grupo:* ${participants.length}\n` +
                      `🎯 *Novos Concorrentes Cadastrados:* ${adicionados}\n` +
                      `🛡️ *Total Geral na Blacklist:* ${setAtual.size} números.\n` +
                      `⚡ *Ação Imediata:* Qualquer um destes números foi ou será expulso na hora de todos os seus grupos!` +
                      infoExpulsao
        };
    } catch (e) {
        console.error('❌ [ANTICONCORRÊNCIA] Erro na extração de membros:', e);
        return { success: false, mensagem: `❌ Erro ao extrair membros: ${e.message}` };
    }
}

/**
 * Inicializa a sessão WhatsApp do Anticoncorrência
 */
async function startWhatsApp(db = null) {
    if (isConnecting) return;
    isConnecting = true;
    firestoreDbInstance = db;

    try {
        addLog('🕵️ [ANTICONCORRÊNCIA] Iniciando WhatsApp Espião...');
        await restoreAuthFromFirestore(db);

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['Axion Anticoncorrencia', 'Chrome', '1.0.0'],
            syncFullHistory: false
        });

        sock.ev.on('creds.update', async () => {
            await saveCreds();
            backupAuthToFirestore(firestoreDbInstance);
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                connectionStatus = 'connecting';
                try {
                    currentQrBase64 = await QRCode.toDataURL(qr);
                    addLog('📱 [ANTICONCORRÊNCIA] Novo QR Code gerado para pareamento.');
                } catch (e) {
                    console.error('❌ [ANTICONCORRÊNCIA] Erro ao converter QR Code:', e);
                }
            }

            if (connection === 'close') {
                connectionStatus = 'offline';
                currentQrBase64 = null;
                isConnecting = false;

                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                addLog(`⚠️ [ANTICONCORRÊNCIA] Conexão fechada. Motivo: ${statusCode}. Reconectar: ${shouldReconnect}`);

                if (shouldReconnect) {
                    reconnectAttempts++;
                    const delay = Math.min(reconnectAttempts * 3000, 20000);
                    setTimeout(() => startWhatsApp(firestoreDbInstance), delay);
                }
            } else if (connection === 'open') {
                connectionStatus = 'connected';
                currentQrBase64 = null;
                isConnecting = false;
                reconnectAttempts = 0;
                connectedUser = sock.user?.id || 'Conectado';
                addLog(`✅ [ANTICONCORRÊNCIA] WhatsApp Espião ONLINE com sucesso! Usuário: ${connectedUser}`);
                
                // Pré-carrega grupos
                setTimeout(() => listarGruposDisponiveis(), 4000);
            }
        });

        // ── PROCESSADOR DE MENSAGENS E COMANDOS ESPIÕES ──
        sock.ev.on('messages.upsert', async (m) => {
            try {
                if (m.type !== 'notify') return;
                for (const msg of m.messages) {
                    if (msg.key.fromMe) continue;
                    const jid = msg.key.remoteJid;
                    if (!jid) continue;

                    const sender = msg.key.participant || jid;
                    const cleanSender = sender.split('@')[0].replace(/\D/g, '');

                    // Comandos de controle restritos ao Master Kelven
                    if (!isMaster(cleanSender)) continue;

                    let text = msg.message?.conversation ||
                               msg.message?.extendedTextMessage?.text ||
                               msg.message?.imageMessage?.caption || '';
                    text = String(text).trim();
                    if (!text) continue;

                    const cleanCmd = text.toLowerCase().trim();

                    // Resposta utilitária
                    const reply = async (txt) => {
                        try {
                            await sock.sendMessage(jid, { text: txt }, { quoted: msg });
                        } catch (e) {
                            console.error('❌ [ANTICONCORRÊNCIA] Erro ao enviar resposta:', e.message);
                        }
                    };

                    // 1. LISTAR GRUPOS
                    if (cleanCmd === '.ext grupos' || cleanCmd === '.gruposconcorrencia' || cleanCmd === '.ext') {
                        const grupos = await listarGruposDisponiveis();
                        if (grupos.length === 0) {
                            await reply('ℹ️ Nenhum grupo encontrado nesta conta de WhatsApp. Adicione este número nos grupos que deseja vigiar!');
                            continue;
                        }

                        let out = `🕵️ *GRUPOS ENCONTRADOS PARA EXTRAÇÃO (${grupos.length}):*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
                        grupos.forEach((g) => {
                            out += `*${g.indice}.* ${g.subject}\n`;
                            out += `   👥 Membros: ${g.size} | ID: \`${g.id}\`\n\n`;
                        });
                        out += `💡 *Para extrair os membros, envie:*\n*.ext extrair <número do grupo>*\n_Exemplo:_ *.ext extrair 1*`;
                        await reply(out);
                        continue;
                    }

                    // 2. EXTRAIR PARTICIPANTES DE UM GRUPO ESPECÍFICO
                    if (cleanCmd.startsWith('.ext extrair ') || cleanCmd.startsWith('.extrair ')) {
                        const param = text.replace(/^[.!/]?(ext extrair|extrair)\s+/i, '').trim();
                        if (!param) {
                            await reply('⚠️ Indique o número ou nome do grupo. Exemplo: *.ext extrair 1*');
                            continue;
                        }

                        await reply(`⏳ _A analisar o grupo e extrair concorrentes... Por favor aguarde._`);
                        const res = await extrairMembrosGrupo(param);
                        await reply(res.mensagem);
                        continue;
                    }

                    // 3. STATUS DA BLACKLIST
                    if (cleanCmd === '.ext status' || cleanCmd === '.blacklist ver' || cleanCmd === '.concorrentes') {
                        const setAtual = carregarConcorrentes();
                        await reply(`🛡️ *SISTEMA ANTICONCORRÊNCIA AXION*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                                    `📊 *Total de Concorrentes na Blacklist:* ${setAtual.size} números.\n` +
                                    `⚡ *Status do Espião:* ${connectionStatus.toUpperCase()}\n\n` +
                                    `_Qualquer um destes números será expulso imediatamente ao tentar entrar ou enviar mensagens nos seus grupos!_`);
                        continue;
                    }

                    // 4. ADICIONAR MANUALMENTE CONCORRENTE
                    if (cleanCmd.startsWith('.blacklist add ') || cleanCmd.startsWith('.concorrente add ')) {
                        const numerosRaw = text.replace(/^[.!/]?(blacklist add|concorrente add)\s+/i, '');
                        const lista = numerosRaw.split(/[,;\s]+/).map(n => n.replace(/\D/g, '')).filter(n => n.length >= 8);
                        
                        if (lista.length === 0) {
                            await reply('⚠️ Nenhum número válido detectado. Exemplo: *.blacklist add 841234567, 859876543*');
                            continue;
                        }

                        const setAtual = carregarConcorrentes();
                        let addCount = 0;
                        for (const n of lista) {
                            if (!setAtual.has(n)) {
                                setAtual.add(n);
                                addCount++;
                            }
                        }
                        salvarConcorrentes(setAtual);
                        await reply(`✅ Adicionados *${addCount}* números à Lista Negra de Concorrentes! Total agora: *${setAtual.size}*.`);
                        continue;
                    }

                    // 5. REMOVER MANUALMENTE DE CONCORRENTES
                    if (cleanCmd.startsWith('.blacklist del ') || cleanCmd.startsWith('.concorrente del ')) {
                        const num = text.replace(/^[.!/]?(blacklist del|concorrente del)\s+/i, '').replace(/\D/g, '');
                        const setAtual = carregarConcorrentes();
                        if (setAtual.has(num)) {
                            setAtual.delete(num);
                            salvarConcorrentes(setAtual);
                            await reply(`✅ Número *${num}* foi removido da Lista Negra de Concorrentes!`);
                        } else {
                            await reply(`ℹ️ O número *${num}* não estava na lista.`);
                        }
                        continue;
                    }

                    // 6. AJUDA DE COMANDOS
                    if (cleanCmd === '.ext ajuda' || cleanCmd === '.anticoncorrencia') {
                        await reply(`🕵️ *COMANDOS DO SISTEMA ANTICONCORRÊNCIA:*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                                    `• *.ext grupos* ➔ Lista todos os grupos onde este espião está.\n` +
                                    `• *.ext extrair <número>* ➔ Extrai todos os membros do grupo para a blacklist.\n` +
                                    `• *.ext status* ➔ Mostra o total de concorrentes bloqueados.\n` +
                                    `• *.blacklist add <números>* ➔ Adiciona números manualmente.\n` +
                                    `• *.blacklist del <número>* ➔ Remove um número da blacklist.`);
                        continue;
                    }
                }
            } catch (err) {
                console.error('❌ [ANTICONCORRÊNCIA MSG ERRO]:', err.message);
            }
        });

    } catch (e) {
        isConnecting = false;
        connectionStatus = 'offline';
        console.error('❌ [ANTICONCORRÊNCIA FATAL] Erro ao iniciar:', e);
    }
}

function getStatus() {
    return {
        status: connectionStatus,
        hasQr: !!currentQrBase64,
        qrImage: currentQrBase64,
        user: connectedUser,
        totalConcorrentes: carregarConcorrentes().size
    };
}

async function resetSession(db = null) {
    try {
        if (sock) {
            sock.end(undefined);
            sock = null;
        }
        currentQrBase64 = null;
        connectionStatus = 'offline';
        connectedUser = null;
        isConnecting = false;

        if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            fs.mkdirSync(AUTH_DIR, { recursive: true });
        }

        if (db) {
            const snap = await db.collection('whatsapp_anticoncorrencia_auth').get();
            if (!snap.empty) {
                let batch = db.batch();
                snap.docs.forEach(d => batch.delete(d.ref));
                await batch.commit();
            }
        }

        setTimeout(() => startWhatsApp(db), 1500);
        return { success: true, message: 'Sessão Anticoncorrência reiniciada. Novo QR Code será gerado.' };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

module.exports = {
    startWhatsApp,
    getStatus,
    resetSession,
    listarGruposDisponiveis,
    extrairMembrosGrupo,
    carregarConcorrentes,
    salvarConcorrentes,
    setBaileysEngine
};
