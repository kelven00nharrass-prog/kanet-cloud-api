/**
 * ==============================================================================
 * KA-NET CUSTOMER SERVICES & ADVANCED LOYALTY ENGINE
 * ==============================================================================
 * Módulo para gerenciar:
 * 1. Sistema de Fidelidade & Histórico de Compras por Cliente (Banco Seguro Firestore + Cache Local)
 * 2. Sistema de Txeneco (Crédito de Internet Diário para Clientes com >100 compras)
 *    - Limites: >550MB e <2048MB por pedido
 *    - Tetos de crédito: 200 compras -> 2GB (2048MB), 500 compras -> 4GB (4096MB)
 *    - Taxa de 10% no pagamento da dívida
 *    - Pagamento total ou parcial via comando .pagar
 * 3. Número Receptor Padrão Automático (Envio sem comprovativo M-Pesa/e-Mola e anti-duplicação)
 * 4. Sistema de Bônus Administrativo (Concessão pelo Master e saque interativo pelo cliente)
 * 5. Parser e Distribuição Multi-Destino em Pagamento Único
 */

const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.resolve(__dirname, 'customer_services_cache.json');

// Estruturas de dados em memória
const clientLoyalty = new Map();       // phone -> { phone, totalCompras: number, ultimaCompra: string, historico: [] }
const clientLoans = new Map();         // phone -> { phone, activeDebtMb: number, totalDevidoMt: number, valorPagoMt: number, restanteMt: number, status: 'pago'|'pendente', historico: [] }
const defaultRecipients = new Map();   // payerPhone -> { payerPhone, targetPhone, ownerJid, registeredAt: string }
const clientBonuses = new Map();       // phone -> { phone, bonusMb: number, historico: [] }
const clientReferrals = new Map();     // phone -> { phone, referredFriends: [], completedBonuses: number, totalBonusMegas: number, history: [] }
const friendToReferrer = new Map();    // friendPhone -> referrerPhone
const codeToReferrer = new Map();      // code (ex: "KN-4821") -> referrerPhone
const phoneToCode = new Map();         // referrerPhone -> code
const lidToPhone = new Map();          // lidClean -> realPhone (9 digits)
const unlimitedSubscriptions = new Map(); // subId -> { id, phone, lid, jid, nomeCliente, planoNome, tipoPlano, valor, numeroDestino, dataInicio, dataExpiracao, diasValidade, status, intencaoRenovacao, dataConfirmacao, notificado_3dias, notificado_12h, notificado_30min, historicoRenovacoes, createdAt, updatedAt }
const aguardandoDestinoBonus = new Map(); // identifier -> { padrinhoTel, padrinhoJid, mb: 500, timestamp }

function temAguardandoDestinoBonus(identificador) {
    if (!identificador) return false;
    const clean = String(identificador).split('@')[0].split(':')[0].replace(/\D/g, '');
    return aguardandoDestinoBonus.has(clean) || aguardandoDestinoBonus.has(identificador);
}

function obterAguardandoDestinoBonus(identificador) {
    if (!identificador) return null;
    const clean = String(identificador).split('@')[0].split(':')[0].replace(/\D/g, '');
    return aguardandoDestinoBonus.get(clean) || aguardandoDestinoBonus.get(identificador) || null;
}

function removerAguardandoDestinoBonus(identificador) {
    if (!identificador) return;
    const clean = String(identificador).split('@')[0].split(':')[0].replace(/\D/g, '');
    aguardandoDestinoBonus.delete(clean);
    aguardandoDestinoBonus.delete(identificador);
}

function registrarAguardandoDestinoBonus(identificador, dados) {
    if (!identificador) return;
    const clean = String(identificador).split('@')[0].split(':')[0].replace(/\D/g, '');
    if (clean) aguardandoDestinoBonus.set(clean, dados);
    aguardandoDestinoBonus.set(identificador, dados);
}

let firestoreDb = null;
let whatsAppNotifier = null;

function setWhatsAppNotifier(fn) {
    whatsAppNotifier = fn;
}
let orderDispatcher = null;
let valorFromMbHelper = null;

// Normalizador de telefone Moçambicano (retorna sempre 9 dígitos válidos: 82/83/84/85/86/87XXXXXXX)
function normalizarTelefone(tel) {
    if (!tel) return '';
    const limpo = String(tel).split('@')[0].split(':')[0].replace(/\D/g, '');
    if (limpo.length === 12 && limpo.startsWith('258') && /^2588[2-7]\d{7}$/.test(limpo)) {
        return limpo.slice(3);
    }
    if (limpo.length === 9 && /^8[2-7]\d{7}$/.test(limpo)) {
        return limpo;
    }
    const m = limpo.match(/(?:258)?(8[2-7]\d{7})/);
    if (m) return m[1];
    return '';
}

// ── PERSISTÊNCIA REFORÇADA: CACHE LOCAL EM JSON + BACKUP AUTOMÁTICO ───────────
const CACHE_BACKUP_FILE = path.resolve(__dirname, 'customer_services_cache.bak.json');
const CACHE_SEED_FILE = path.resolve(__dirname, 'customer_services_seed.json');

function salvarCacheLocal() {
    try {
        const payload = {
            loyalty: [...clientLoyalty.entries()],
            loans: [...clientLoans.entries()],
            defaultRecipients: [...defaultRecipients.entries()],
            bonuses: [...clientBonuses.entries()],
            referrals: [...clientReferrals.entries()],
            friendReferrers: [...friendToReferrer.entries()],
            referralCodes: [...codeToReferrer.entries()],
            lidMap: [...lidToPhone.entries()],
            subscriptions: [...unlimitedSubscriptions.entries()],
            savedAt: new Date().toISOString()
        };
        const content = JSON.stringify(payload, null, 2);
        const tempFile = CACHE_FILE + '.tmp';
        
        // 1. Gravar primeiro em ficheiro temporário para evitar truncamento em caso de queda de energia
        fs.writeFileSync(tempFile, content, 'utf8');
        
        // 2. Criar cópia de segurança do cache anterior (.bak)
        if (fs.existsSync(CACHE_FILE)) {
            try { fs.copyFileSync(CACHE_FILE, CACHE_BACKUP_FILE); } catch (_) {}
        }
        
        // 3. Substituição atómica e segura
        fs.renameSync(tempFile, CACHE_FILE);
    } catch (err) {
        console.warn('⚠️ [CUSTOMER-SERVICES] Erro ao salvar cache local:', err.message);
    }
}

function carregarCacheLocal() {
    let raw = null;
    let fonte = CACHE_FILE;

    try {
        if (fs.existsSync(CACHE_FILE)) {
            raw = fs.readFileSync(CACHE_FILE, 'utf8');
        } else if (fs.existsSync(CACHE_BACKUP_FILE)) {
            console.log('🔄 [CUSTOMER-SERVICES] Cache principal ausente, restaurando cópia de segurança (.bak)...');
            raw = fs.readFileSync(CACHE_BACKUP_FILE, 'utf8');
            fonte = CACHE_BACKUP_FILE;
        } else if (fs.existsSync(CACHE_SEED_FILE)) {
            console.log('🌱 [CUSTOMER-SERVICES] Cache ausente, carregando semente inicial (customer_services_seed.json)...');
            raw = fs.readFileSync(CACHE_SEED_FILE, 'utf8');
            fonte = CACHE_SEED_FILE;
        }

        if (!raw) return;

        const data = JSON.parse(raw);
        if (Array.isArray(data.loyalty)) {
            data.loyalty.forEach(([k, v]) => clientLoyalty.set(k, v));
        }
        if (Array.isArray(data.loans)) {
            data.loans.forEach(([k, v]) => clientLoans.set(k, v));
        }
        if (Array.isArray(data.defaultRecipients)) {
            data.defaultRecipients.forEach(([k, v]) => defaultRecipients.set(k, v));
        }
        if (Array.isArray(data.bonuses)) {
            data.bonuses.forEach(([k, v]) => clientBonuses.set(k, v));
        }
        if (Array.isArray(data.referrals)) {
            data.referrals.forEach(([k, v]) => clientReferrals.set(k, v));
        }
        if (Array.isArray(data.friendReferrers)) {
            data.friendReferrers.forEach(([k, v]) => friendToReferrer.set(k, v));
        }
        if (Array.isArray(data.referralCodes)) {
            data.referralCodes.forEach(([k, v]) => {
                codeToReferrer.set(k.toUpperCase(), v);
                phoneToCode.set(v, k.toUpperCase());
            });
        }
        if (Array.isArray(data.lidMap)) {
            data.lidMap.forEach(([k, v]) => lidToPhone.set(k, v));
        }
        if (Array.isArray(data.subscriptions)) {
            data.subscriptions.forEach(([k, v]) => unlimitedSubscriptions.set(k, v));
        }
        console.log(`📦 [CUSTOMER-SERVICES] Cache carregado (${path.basename(fonte)}): ${clientLoyalty.size} clientes fidelidade, ${clientLoans.size} empréstimos, ${defaultRecipients.size} receptores, ${clientBonuses.size} bônus.`);
    } catch (err) {
        console.warn('⚠️ [CUSTOMER-SERVICES] Falha ao ler cache principal, tentando backup:', err.message);
        try {
            if (fs.existsSync(CACHE_BACKUP_FILE)) {
                const bakRaw = fs.readFileSync(CACHE_BACKUP_FILE, 'utf8');
                const bakData = JSON.parse(bakRaw);
                if (Array.isArray(bakData.loyalty)) bakData.loyalty.forEach(([k, v]) => clientLoyalty.set(k, v));
                if (Array.isArray(bakData.loans)) bakData.loans.forEach(([k, v]) => clientLoans.set(k, v));
                if (Array.isArray(bakData.defaultRecipients)) bakData.defaultRecipients.forEach(([k, v]) => defaultRecipients.set(k, v));
                if (Array.isArray(bakData.bonuses)) bakData.bonuses.forEach(([k, v]) => clientBonuses.set(k, v));
                if (Array.isArray(bakData.referrals)) bakData.referrals.forEach(([k, v]) => clientReferrals.set(k, v));
                if (Array.isArray(bakData.friendReferrers)) bakData.friendReferrers.forEach(([k, v]) => friendToReferrer.set(k, v));
                if (Array.isArray(bakData.referralCodes)) bakData.referralCodes.forEach(([k, v]) => { codeToReferrer.set(k.toUpperCase(), v); phoneToCode.set(v, k.toUpperCase()); });
                console.log('✅ [CUSTOMER-SERVICES] Restaurado com sucesso a partir do backup!');
            }
        } catch (e2) {
            console.error('❌ [CUSTOMER-SERVICES] Erro crítico em ambos os caches:', e2.message);
        }
    }
}

// ── PERSISTÊNCIA: FIRESTORE (BANCO SEGURO EM NUVEM) ───────────────────────────

async function salvarNoFirestore(collectionName, docId, data) {
    if (!firestoreDb) return;
    try {
        await firestoreDb.collection(collectionName).doc(String(docId)).set(data, { merge: true });
    } catch (err) {
        console.warn(`⚠️ [FIRESTORE SYNC] Erro ao salvar doc ${docId} em ${collectionName}:`, err.message);
    }
}

async function deletarNoFirestore(collectionName, docId) {
    if (!firestoreDb) return;
    try {
        await firestoreDb.collection(collectionName).doc(String(docId)).delete();
    } catch (err) {
        console.warn(`⚠️ [FIRESTORE SYNC] Erro ao deletar doc ${docId} de ${collectionName}:`, err.message);
    }
}

async function restaurarDoFirestore() {
    if (!firestoreDb) return;
    console.log('🔄 [FIRESTORE RESTORE] Sincronizando dados de fidelidade, empréstimos e receptores...');
    
    // 1. Loyalty
    try {
        const snap = await firestoreDb.collection('client_loyalty').get();
        if (!snap.empty) {
            snap.docs.forEach(doc => {
                const d = doc.data();
                let key = normalizarTelefone(d.phone || doc.id);
                if (!key) {
                    const limpo = String(d.phone || doc.id).replace(/\D/g, '');
                    if (limpo && limpo.length >= 8) key = limpo;
                }
                if (key) {
                    const existing = clientLoyalty.get(key) || {};
                    const total = Math.max(existing.totalCompras || 0, d.totalCompras || 0);
                    clientLoyalty.set(key, { ...existing, ...d, phone: key, totalCompras: total });
                }
            });
            console.log(`👤 [FIRESTORE] ${snap.size} registros de fidelidade carregados.`);
        }
    } catch (e) {
        console.warn('⚠️ [FIRESTORE] Erro ao carregar client_loyalty:', e.message);
    }

    // 2. Loans (Txeneco)
    try {
        const snap = await firestoreDb.collection('client_loans').get();
        if (!snap.empty) {
            snap.docs.forEach(doc => {
                const d = doc.data();
                const key = normalizarTelefone(d.phone || doc.id);
                if (key) clientLoans.set(key, { ...d, phone: key });
            });
            console.log(`💳 [FIRESTORE] ${snap.size} registros de empréstimos (Txeneco) carregados.`);
        }
    } catch (e) {
        console.warn('⚠️ [FIRESTORE] Erro ao carregar client_loans:', e.message);
    }

    // 3. Default Recipients
    try {
        const snap = await firestoreDb.collection('client_default_recipients').get();
        if (!snap.empty) {
            defaultRecipients.clear();
            snap.docs.forEach(doc => {
                const d = doc.data();
                const key = normalizarTelefone(d.payerPhone || doc.id);
                if (key) defaultRecipients.set(key, { ...d, payerPhone: key });
            });
            console.log(`📲 [FIRESTORE] ${defaultRecipients.size} configurações de receptor padrão ativas e sincronizadas.`);
        }
    } catch (e) {
        console.warn('⚠️ [FIRESTORE] Erro ao carregar client_default_recipients:', e.message);
    }

    // 4. Bonuses
    try {
        const snap = await firestoreDb.collection('client_bonuses').get();
        if (!snap.empty) {
            snap.docs.forEach(doc => {
                const d = doc.data();
                const key = normalizarTelefone(d.phone || doc.id);
                if (key) clientBonuses.set(key, { ...d, phone: key });
            });
            console.log(`🎁 [FIRESTORE] ${snap.size} carteiras de bônus carregadas.`);
        }
    } catch (e) {
        console.warn('⚠️ [FIRESTORE] Erro ao carregar client_bonuses:', e.message);
    }

    // 5. Mapeamento LID -> Telefone
    try {
        const snap = await firestoreDb.collection('client_lid_map').get();
        if (!snap.empty) {
            snap.docs.forEach(doc => {
                const d = doc.data();
                const lid = String(d.lid || doc.id).replace(/\D/g, '');
                const phone = normalizarTelefone(d.phone);
                if (lid && phone) lidToPhone.set(lid, phone);
            });
            console.log(`🔗 [FIRESTORE] ${snap.size} mapeamentos LID -> Telefone carregados.`);
        }
    } catch (e) {
        console.warn('⚠️ [FIRESTORE] Erro ao carregar client_lid_map:', e.message);
    }

    // 6. Códigos de Convite (Referral Codes)
    try {
        const snap = await firestoreDb.collection('referral_codes').get();
        if (!snap.empty) {
            snap.docs.forEach(doc => {
                const d = doc.data();
                const code = String(d.code || doc.id).trim().toUpperCase();
                const phone = String(d.phone || '').trim();
                if (code && phone) {
                    codeToReferrer.set(code, phone);
                    phoneToCode.set(phone, code);
                }
            });
            console.log(`🎟️ [FIRESTORE] ${snap.size} códigos de convite carregados.`);
        }
    } catch (e) {
        console.warn('⚠️ [FIRESTORE] Erro ao carregar referral_codes:', e.message);
    }

    // 7. Vínculos de Indicação (Amigo -> Padrinho)
    try {
        const snap = await firestoreDb.collection('client_friend_referrers').get();
        if (!snap.empty) {
            snap.docs.forEach(doc => {
                const d = doc.data();
                const amigo = String(d.amigo || doc.id).trim();
                const padrinho = String(d.padrinho || '').trim();
                if (amigo && padrinho) {
                    friendToReferrer.set(amigo, padrinho);
                }
            });
            console.log(`🤝 [FIRESTORE] ${snap.size} vínculos amigo -> padrinho carregados.`);
        }
    } catch (e) {
        console.warn('⚠️ [FIRESTORE] Erro ao carregar client_friend_referrers:', e.message);
    }

    // 8. Histórico de Indicações (Client Referrals)
    try {
        const snap = await firestoreDb.collection('client_referrals').get();
        if (!snap.empty) {
            snap.docs.forEach(doc => {
                const d = doc.data();
                const phone = String(d.phone || doc.id).trim();
                if (phone) clientReferrals.set(phone, d);
            });
            console.log(`👥 [FIRESTORE] ${snap.size} históricos de indicação carregados.`);
        }
    } catch (e) {
        console.warn('⚠️ [FIRESTORE] Erro ao carregar client_referrals:', e.message);
    }

    // 8.1 Assinaturas de Pacotes Ilimitados (30 Dias)
    try {
        const snap = await firestoreDb.collection('unlimited_subscriptions').get();
        if (!snap.empty) {
            snap.docs.forEach(doc => {
                const d = doc.data();
                const key = d.id || doc.id;
                if (key) {
                    unlimitedSubscriptions.set(key, { ...d, id: key });
                }
            });
            console.log(`📡 [FIRESTORE] ${snap.size} assinaturas de pacotes ilimitados carregadas.`);
        }
    } catch (e) {
        console.warn('⚠️ [FIRESTORE] Erro ao carregar unlimited_subscriptions:', e.message);
    }

        // 9. Reconciliação robusta de histórico de compras a partir de pedidos concluídos no Firestore
    try {
        console.log('🔄 [FIRESTORE] Reconciliando histórico de compras a partir de pedidos concluídos...');
        const ordersSnap = await firestoreDb.collection('orders')
            .where('status', '==', 'completed')
            .limit(2000)
            .get();

        if (!ordersSnap.empty) {
            const ordersByPhone = new Map();
            const orderHistoryByPhone = new Map();

            ordersSnap.docs.forEach(d => {
                const o = d.data();
                const candidates = [
                    o.cliente_solicitante,
                    o.senderPhone,
                    o.pagador,
                    o.senderNumber,
                    o.sender,
                    o.numero
                ];
                let phone = '';
                for (const c of candidates) {
                    if (!c) continue;
                    const res = resolverTelefoneDeIdentificador(c) || normalizarTelefone(c);
                    if (res && res.length === 9 && /^8[2-7]\d{7}$/.test(res)) {
                        phone = res;
                        break;
                    }
                }
                if (!phone) {
                    for (const c of candidates) {
                        if (!c) continue;
                        const norm = normalizarTelefone(c);
                        if (norm && norm.length === 9) {
                            phone = norm;
                            break;
                        }
                    }
                }

                // Se houver LID associado ao pedido e descobrimos o telefone do comprador, vincular!
                const orderLid = (o.senderJid && String(o.senderJid).endsWith('@lid'))
                    ? String(o.senderJid).replace(/\D/g, '')
                    : ((o.jid && String(o.jid).endsWith('@lid')) ? String(o.jid).replace(/\D/g, '') : null);
                if (orderLid && phone) {
                    vincularLidTelefone(orderLid, phone);
                }

                if (phone && phone.length === 9) {
                    ordersByPhone.set(phone, (ordersByPhone.get(phone) || 0) + 1);
                    if (!orderHistoryByPhone.has(phone)) {
                        orderHistoryByPhone.set(phone, []);
                    }
                    const histList = orderHistoryByPhone.get(phone);
                    if (histList.length < 30) {
                        histList.push({
                            orderId: o.orderId || d.id,
                            valor: Number(o.valor || o.valor_pago) || 0,
                            mb: Number(o.quantidade) || 0,
                            data: o.completedAt || o.createdAt || new Date().toISOString()
                        });
                    }
                }
            });

            let atualizados = 0;
            for (const [phone, count] of ordersByPhone.entries()) {
                const existing = clientLoyalty.get(phone) || { phone, totalCompras: 0, historico: [] };
                const maxCompras = Math.max(existing.totalCompras || 0, count);
                const combinedHistory = (existing.historico && existing.historico.length > 0)
                    ? existing.historico
                    : (orderHistoryByPhone.get(phone) || []);

                if (maxCompras > (existing.totalCompras || 0) || !clientLoyalty.has(phone)) {
                    clientLoyalty.set(phone, {
                        ...existing,
                        phone,
                        totalCompras: maxCompras,
                        historico: combinedHistory
                    });
                    atualizados++;
                }
            }
            console.log(`✅ [FIRESTORE] Reconciliação concluída: ${ordersByPhone.size} clientes com compras confirmadas (${atualizados} atualizados/restaurados).`);
            salvarCacheLocal();
        }
    } catch (e) {
        console.warn('⚠️ [FIRESTORE] Erro ao reconciliar compras históricas:', e.message);
    }

    salvarCacheLocal();
}

// ── INICIALIZADOR DO MÓDULO ───────────────────────────────────────────────────

function initCustomerServices(db, dispatcherFn, getValMbFn) {
    firestoreDb = db;
    orderDispatcher = dispatcherFn;
    valorFromMbHelper = getValMbFn;
    carregarCacheLocal();
    if (firestoreDb) {
        setTimeout(() => restaurarDoFirestore(), 2500);
    }
}



// ── GESTÃO DE IDENTIDADES WHATSAPP (LID -> NÚMERO REAL) ─────────────────────

/**
 * Vincula um LID do WhatsApp (identidade oculta/privada) ao telefone real do cliente
 */
function vincularLidTelefone(lid, tel) {
    if (!lid || !tel) return;
    const limpoLid = String(lid).split('@')[0].split(':')[0].replace(/\D/g, '');
    const phone = normalizarTelefone(tel);
    if (!limpoLid || !phone || limpoLid === phone) return;

    lidToPhone.set(limpoLid, phone);
    
    // Se o cliente gerou um código com o LID antes de sabermos o telefone, migra para o telefone!
    if (phoneToCode.has(limpoLid)) {
        const existingCode = phoneToCode.get(limpoLid);
        codeToReferrer.set(existingCode, phone);
        phoneToCode.set(phone, existingCode);
        console.log(`📦 [LID MIGRATION] Código ${existingCode} do LID ${limpoLid} migrado para o telefone ${phone}!`);
    } else if (phoneToCode.has(phone)) {
        const existingCode = phoneToCode.get(phone);
        phoneToCode.set(limpoLid, existingCode);
    }

    // Se o amigo foi indicado via LID, migrar vínculo para o telefone
    if (friendToReferrer.has(limpoLid)) {
        const padr = friendToReferrer.get(limpoLid);
        friendToReferrer.set(phone, padr);
    }

    // Se há registro de indicações no LID, fundir com o registro do telefone
    if (clientReferrals.has(limpoLid)) {
        const lidRec = clientReferrals.get(limpoLid);
        const phoneRec = clientReferrals.get(phone) || {
            phone,
            referredFriends: [],
            completedBonuses: 0,
            totalBonusMegas: 0,
            history: []
        };
        for (const am of (lidRec.referredFriends || [])) {
            if (!phoneRec.referredFriends.includes(am)) {
                phoneRec.referredFriends.push(am);
            }
        }
        phoneRec.completedBonuses = Math.max(phoneRec.completedBonuses || 0, lidRec.completedBonuses || 0);
        phoneRec.totalBonusMegas = Math.max(phoneRec.totalBonusMegas || 0, lidRec.totalBonusMegas || 0);
        clientReferrals.set(phone, phoneRec);
    }

    // Unificar fidelidade e histórico de compras (clientLoyalty)
    if (clientLoyalty.has(limpoLid)) {
        const lidLoyalty = clientLoyalty.get(limpoLid);
        const phoneLoyalty = clientLoyalty.get(phone) || {
            phone,
            totalCompras: 0,
            ultimaCompra: null,
            historico: []
        };
        const comprasLid = lidLoyalty.totalCompras || 0;
        const comprasPhone = phoneLoyalty.totalCompras || 0;
        const histMap = new Map();
        for (const h of (phoneLoyalty.historico || [])) {
            if (h.orderId) histMap.set(String(h.orderId), h);
        }
        for (const h of (lidLoyalty.historico || [])) {
            if (h.orderId && !histMap.has(String(h.orderId))) histMap.set(String(h.orderId), h);
        }
        phoneLoyalty.historico = Array.from(histMap.values()).slice(0, 30);
        phoneLoyalty.totalCompras = Math.max(comprasPhone, comprasLid, histMap.size);
        if (!phoneLoyalty.ultimaCompra || (lidLoyalty.ultimaCompra && lidLoyalty.ultimaCompra > phoneLoyalty.ultimaCompra)) {
            phoneLoyalty.ultimaCompra = lidLoyalty.ultimaCompra;
        }
        clientLoyalty.set(phone, phoneLoyalty);
        clientLoyalty.set(limpoLid, { ...phoneLoyalty, phone });
        salvarNoFirestore('client_loyalty', phone, phoneLoyalty);
        console.log(`💎 [FIDELIDADE UNIFICADA] LID ${limpoLid} e Telefone ${phone} unificados. Total compras: ${phoneLoyalty.totalCompras}`);
    } else if (clientLoyalty.has(phone)) {
        clientLoyalty.set(limpoLid, clientLoyalty.get(phone));
    }

    salvarCacheLocal();
    salvarNoFirestore('client_lid_map', limpoLid, { lid: limpoLid, phone, updatedAt: new Date().toISOString() });
    console.log(`🔗 [LID MAPPING] LID ${limpoLid} vinculado ao telefone ${phone}`);
}

/**
 * Resolve o telefone real de um identificador (seja telefone direto ou LID)
 */
function resolverTelefoneDeIdentificador(identificador) {
    if (!identificador) return '';
    const phone = normalizarTelefone(identificador);
    if (phone) return phone;
    const limpo = String(identificador).split('@')[0].split(':')[0].replace(/\D/g, '');
    if (lidToPhone.has(limpo)) {
        return lidToPhone.get(limpo);
    }
    const rec = defaultRecipients.get(limpo);
    if (rec && rec.targetPhone) {
        const t = normalizarTelefone(rec.targetPhone);
        if (t) return t;
    }
    const loyaltyRec = clientLoyalty.get(limpo);
    if (loyaltyRec && loyaltyRec.phone && loyaltyRec.phone !== limpo) {
        const lp = normalizarTelefone(loyaltyRec.phone);
        if (lp) return lp;
    }
    return '';
}

function obterTodosLids() {
    return new Map(lidToPhone);
}

// ── SISTEMA DE INDICAÇÕES (INDICA E GANHA: 3 AMIGOS = 500 MB GRÁTIS) ─────────

/**
 * Gera ou recupera um código curto e exclusivo de indicação para o cliente (ex: KN-4821)
 */
function gerarCodigoConviteUnico(phoneOrLid) {
    let padrinho = normalizarTelefone(phoneOrLid);
    if (!padrinho) {
        padrinho = resolverTelefoneDeIdentificador(phoneOrLid);
    }
    const chave = padrinho || String(phoneOrLid).split('@')[0].split(':')[0].replace(/\D/g, '');
    if (!chave) return '';
    
    // 1. Já existe código para a chave direta (LID ou Telefone)?
    if (phoneToCode.has(chave)) {
        return phoneToCode.get(chave);
    }
    // 2. Se a chave era LID mas temos o telefone, e o telefone já tem código?
    if (padrinho && phoneToCode.has(padrinho)) {
        const cod = phoneToCode.get(padrinho);
        phoneToCode.set(chave, cod);
        return cod;
    }
    
    let codigo = '';
    let tentativas = 0;
    while (tentativas < 100) {
        const randNum = Math.floor(1000 + Math.random() * 9000);
        const cand = `KN-${randNum}`;
        if (!codeToReferrer.has(cand)) {
            codigo = cand;
            break;
        }
        tentativas++;
    }
    if (!codigo) {
        codigo = `KN-${chave.slice(-4)}`;
    }

    codeToReferrer.set(codigo, chave);
    phoneToCode.set(chave, codigo);
    if (padrinho && padrinho !== chave) {
        phoneToCode.set(padrinho, codigo);
        codeToReferrer.set(codigo, padrinho); // Padrinho com telefone 9 dígitos tem precedência
    }
    salvarCacheLocal();
    salvarNoFirestore('referral_codes', codigo, { code: codigo, phone: padrinho || chave, createdAt: new Date().toISOString() });
    return codigo;
}

/**
 * Traduz um código de convite (ex: KN-4821) ou número para o telefone ou identificador do padrinho
 */
function obterTelefonePorCodigo(inputCodigo) {
    if (!inputCodigo) return '';
    const clean = String(inputCodigo).trim().toUpperCase();
    let ref = '';
    if (codeToReferrer.has(clean)) {
        ref = codeToReferrer.get(clean);
    } else {
        const semHifen = clean.replace(/[^A-Z0-9]/g, '');
        for (const [code, target] of codeToReferrer.entries()) {
            if (code.replace(/[^A-Z0-9]/g, '') === semHifen) {
                ref = target;
                break;
            }
        }
    }
    if (ref) {
        const telReal = resolverTelefoneDeIdentificador(ref) || normalizarTelefone(ref);
        if (telReal) return telReal;
        return ref; // Pode ser LID se ainda não vinculado a telefone
    }
    const tel = normalizarTelefone(inputCodigo);
    if (tel && tel.length === 9) {
        return tel;
    }
    return '';
}

/**
 * Vincula um amigo ao código de convite do padrinho
 */
function vincularIndicacao(amigoTelOrLid, codigoOuTel) {
    let amigo = normalizarTelefone(amigoTelOrLid);
    if (!amigo) {
        amigo = resolverTelefoneDeIdentificador(amigoTelOrLid);
    }
    const amigoChave = amigo || String(amigoTelOrLid).split('@')[0].split(':')[0].replace(/\D/g, '');
    const padrinho = obterTelefonePorCodigo(codigoOuTel);

    if (!amigoChave) {
        return { success: false, mensagem: '❌ Identificador do amigo inválido.' };
    }
    if (!padrinho) {
        return { success: false, mensagem: '❌ Código de convite inválido ou não encontrado. Verifique o código (ex: *KN-4821*) e tente novamente!' };
    }
    if (amigoChave === padrinho || (amigo && amigo === padrinho)) {
        return { success: false, mensagem: '❌ Você não pode usar o seu próprio código de convite!' };
    }

    // Se o amigo já é cliente com compras anteriores, indicação não se aplica
    const comprasAmigo = amigo ? getComprasCount(amigo) : 0;
    if (comprasAmigo > 0) {
        return { success: false, mensagem: '⚠️ O programa "Indica e Ganha" é válido para a *primeira compra* de novos clientes. Você já possui compras registradas na Ka-Net! Mas você pode gerar o seu próprio código com *!convite* para indicar amigos e ganhar 500 MB!' };
    }

    // Se o amigo já foi indicado por alguém
    if (friendToReferrer.has(amigoChave) || (amigo && friendToReferrer.has(amigo))) {
        const jaPadrinho = friendToReferrer.get(amigoChave) || (amigo ? friendToReferrer.get(amigo) : null);
        const codExib = phoneToCode.get(jaPadrinho) || jaPadrinho;
        return { success: false, mensagem: `⚠️ Você já foi indicado anteriormente pelo código *${codExib}*.` };
    }

    // Gravar vínculo
    friendToReferrer.set(amigoChave, padrinho);
    if (amigo && amigo !== amigoChave) {
        friendToReferrer.set(amigo, padrinho);
    }
    salvarCacheLocal();
    salvarNoFirestore('client_friend_referrers', amigoChave, { amigo: amigoChave, padrinho, data: new Date().toISOString() });

    const codPadrinhoExib = phoneToCode.get(padrinho) || padrinho;
    console.log(`🤝 [INDICAÇÃO] Amigo ${amigoChave} vinculado ao padrinho ${padrinho} (Código: ${codPadrinhoExib})`);
    return {
        success: true,
        padrinho,
        codigo: codPadrinhoExib,
        mensagem: `🎉 *CÓDIGO DE CONVITE ATIVADO!*\n\nVocê foi indicado pelo código *${codPadrinhoExib}*.\n\nAo concluir a sua primeira compra de Megas na Ka-Net, a indicação será confirmada e o seu amigo pontuará no sistema! 🚀`
    };
}

/**
 * Processa a compra de um cliente e pontua o padrinho (se houver)
 */
function processarCompraIndicacao(compradorTel) {
    const comprador = normalizarTelefone(compradorTel);
    if (!comprador) return null;

    // 1. Procurar padrinho pelo telefone direto do comprador
    let padrinho = friendToReferrer.get(comprador);

    // 2. Se não achou, procurar por qualquer LID associado a este comprador
    if (!padrinho) {
        for (const [lid, phone] of lidToPhone.entries()) {
            if (phone === comprador && friendToReferrer.has(lid)) {
                padrinho = friendToReferrer.get(lid);
                friendToReferrer.set(comprador, padrinho); // Fixar vínculo no telefone direto
                break;
            }
        }
    }

    // 3. Se ainda não achou, procurar em defaultRecipients
    if (!padrinho) {
        for (const [lid, rec] of defaultRecipients.entries()) {
            if (rec && normalizarTelefone(rec.targetPhone) === comprador && friendToReferrer.has(lid)) {
                padrinho = friendToReferrer.get(lid);
                friendToReferrer.set(comprador, padrinho);
                break;
            }
        }
    }

    if (!padrinho) return null;

    // Resolver telefone real do padrinho se for LID
    const padrinhoTel = resolverTelefoneDeIdentificador(padrinho) || (normalizarTelefone(padrinho) || padrinho);

    let rec = clientReferrals.get(padrinhoTel) || clientReferrals.get(padrinho);
    if (!rec) {
        rec = {
            phone: padrinhoTel,
            referredFriends: [],
            completedBonuses: 0,
            totalBonusMegas: 0,
            history: []
        };
    }

    if (!Array.isArray(rec.referredFriends)) rec.referredFriends = [];
    if (!Array.isArray(rec.history)) rec.history = [];

    // Se este amigo já pontuou para este padrinho, não duplica
    if (rec.referredFriends.includes(comprador)) return null;

    rec.referredFriends.push(comprador);
    // Salvar em ambas as chaves para sincronização perfeita
    clientReferrals.set(padrinhoTel, rec);
    if (padrinho !== padrinhoTel) {
        clientReferrals.set(padrinho, rec);
    }

    const totalNaRodada = rec.referredFriends.length;
    const codPadrinho = phoneToCode.get(padrinhoTel) || phoneToCode.get(padrinho) || padrinhoTel;
    console.log(`🎁 [INDICA E GANHA] Padrinho ${padrinhoTel} (${codPadrinho}) recebeu indicação do amigo ${comprador} (${totalNaRodada}/3)`);

    const padrinhoJid = `258${padrinhoTel}@s.whatsapp.net`;

    if (totalNaRodada < 3) {
        salvarCacheLocal();
        salvarNoFirestore('client_referrals', padrinhoTel, rec);
        if (padrinho !== padrinhoTel) {
            salvarNoFirestore('client_referrals', padrinho, rec);
        }

        // Notificar padrinho do progresso
        if (whatsAppNotifier) {
            const faltam = 3 - totalNaRodada;
            const msgAviso = 
                `🎉 *NOVO AMIGO COMPROU COM O TEU CÓDIGO!* ⚡\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `O teu amigo *${comprador}* acabou de comprar na Ka-Net!\n\n` +
                `👥 *Progresso Atual:* *${totalNaRodada} de 3 amigos*\n` +
                `🎁 *Faltam apenas:* *${faltam} amigo(s)* para ganhares *500 MB GRÁTIS*!\n\n` +
                `_Continua a partilhar o teu código: *${codPadrinho}*_`;
            try { whatsAppNotifier(padrinhoJid, msgAviso); } catch (_) {}
        }
        return { status: 'progress', padrinho: padrinhoTel, totalNaRodada };
    }

    // 🎉 ATINGIU 3 AMIGOS! BÓNUS DE 500 MB CONQUISTADO!
    rec.completedBonuses = (rec.completedBonuses || 0) + 1;
    rec.totalBonusMegas = (rec.totalBonusMegas || 0) + 500;
    const amigosRodadaConcluida = [...rec.referredFriends];
    rec.history.unshift({
        amigos: amigosRodadaConcluida,
        data: new Date().toISOString(),
        mb: 500
    });
    rec.referredFriends = []; // Reseta rodada para poder ganhar de novo!

    // Creditar os 500 MB na carteira de bónus do padrinho (clientBonuses)
    let bRecord = clientBonuses.get(padrinhoTel) || { phone: padrinhoTel, bonusMb: 0, historico: [] };
    bRecord.bonusMb = (bRecord.bonusMb || 0) + 500;
    if (!Array.isArray(bRecord.historico)) bRecord.historico = [];
    bRecord.historico.unshift({
        tipo: 'bonus_indica_3_amigos',
        mb: 500,
        amigos: amigosRodadaConcluida,
        data: new Date().toISOString()
    });
    clientBonuses.set(padrinhoTel, bRecord);
    if (padrinho && padrinho !== padrinhoTel) {
        clientBonuses.set(padrinho, bRecord);
    }
    salvarNoFirestore('client_bonuses', padrinhoTel, bRecord);

    salvarCacheLocal();
    salvarNoFirestore('client_referrals', padrinhoTel, rec);
    if (padrinho !== padrinhoTel) {
        salvarNoFirestore('client_referrals', padrinho, rec);
    }

    // Registar no estado "Aguardando Destino do Bónus"
    const pendBonusData = {
        padrinhoTel,
        padrinhoJid,
        mb: 500,
        timestamp: Date.now()
    };
    registrarAguardandoDestinoBonus(padrinhoTel, pendBonusData);
    if (padrinho && padrinho !== padrinhoTel) {
        registrarAguardandoDestinoBonus(padrinho, pendBonusData);
    }

    console.log(`🎁 [BONUS 500MB CONQUISTADO] Padrinho ${padrinhoTel} completou 3 amigos! Perguntando onde deseja receber o bónus via WhatsApp.`);

    // Perguntar ao padrinho para onde quer enviar os 500 MB
    if (whatsAppNotifier) {
        const msgPremio = 
            `🏆 *PARABÉNS! VOCÊ GANHOU 500 MB GRÁTIS!* ⚡\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🎉 *3 amigos* que usaram o teu código já compraram na *Ka-Net*!\n\n` +
            `🎁 *Bónus Conquistado:* *500 MB (Diário)*\n\n` +
            `📲 *Onde deseja receber os seus 500 MB?*\n` +
            `1️⃣ Digite *1* para receber neste número (*${padrinhoTel}*)\n` +
            `2️⃣ Ou responda com o *número de destino* (ex: *84XXXXXXX* ou *85XXXXXXX*) para enviar para outro celular!\n\n` +
            `💾 _Os teus 500 MB já estão guardados no teu saldo. Se preferir usar outro dia, pode responder mais tarde ou consultar com *.meubonus*!_`;
        try { whatsAppNotifier(padrinhoJid, msgPremio); } catch (_) {}
    }

    return { status: 'rewarded_pending_choice', padrinho: padrinhoTel, totalNaRodada: 3, mb: 500 };
}

/**
 * Retorna as estatísticas de indicação de um cliente
 */
function obterStatusIndicacao(telefoneOrLid) {
    let phone = normalizarTelefone(telefoneOrLid);
    if (!phone) {
        phone = resolverTelefoneDeIdentificador(telefoneOrLid);
    }
    const chave = phone || String(telefoneOrLid).split('@')[0].split(':')[0].replace(/\D/g, '');
    if (!chave) return null;
    
    const codigo = phoneToCode.get(chave) || (phone ? phoneToCode.get(phone) : null) || gerarCodigoConviteUnico(chave);

    // Identificadores válidos do padrinho (LID, telefone, etc.)
    const padrinhoKeys = new Set([chave]);
    if (phone) padrinhoKeys.add(phone);
    for (const [l, p] of lidToPhone.entries()) {
        if (p === chave || p === phone || l === chave) {
            padrinhoKeys.add(l);
            if (p) padrinhoKeys.add(p);
        }
    }

    // Buscar carteira de compras dos amigos indicados
    let rec = null;
    for (const pk of padrinhoKeys) {
        if (clientReferrals.has(pk)) {
            rec = clientReferrals.get(pk);
            break;
        }
    }
    if (!rec) {
        rec = {
            phone: phone || chave,
            referredFriends: [],
            completedBonuses: 0,
            totalBonusMegas: 0
        };
    }

    // Contar amigos cadastrados que ativaram o código deste padrinho
    const amigosCadastradosSet = new Set();
    for (const [amigoKey, pad] of friendToReferrer.entries()) {
        if (padrinhoKeys.has(pad)) {
            const amigoReal = resolverTelefoneDeIdentificador(amigoKey) || normalizarTelefone(amigoKey) || amigoKey;
            amigosCadastradosSet.add(amigoReal);
        }
    }

    const amigosCadastrados = amigosCadastradosSet.size;
    const amigosCompraram = Array.isArray(rec.referredFriends) ? rec.referredFriends.length : 0;

    return {
        phone: phone || chave,
        codigo,
        amigosCadastrados,
        amigosAtuais: amigosCompraram,
        faltam: Math.max(0, 3 - amigosCompraram),
        completedBonuses: rec.completedBonuses || 0,
        totalBonusMegas: rec.totalBonusMegas || 0,
        amigosNaRodada: rec.referredFriends || []
    };
}

// ── 1. GESTÃO DE FIDELIDADE (CONTAGEM DE COMPRAS) ──────────────────────────────

function gerarMensagemDesbloqueioVip(totalCompras) {
    if (totalCompras === 1) {
        return (
            '╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n' +
            '  🎉 *BEM-VINDO(A) À FAMÍLIA KA-NET!* 🌟\n' +
            '╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n' +
            'Parabéns pela sua primeira compra na Ka-Net! 🚀✨\n\n' +
            '🎁 *SEU NÚMERO JÁ FOI CADASTRADO NO CLUBE DE FIDELIDADE:*\n' +
            '• A partir de agora, todas as suas recargas contam no seu histórico! 📊\n' +
            '• ⚡ Você já pode enviar *.configurar* para receber internet automática nas próximas vezes sem precisar de mandar comprovativo!\n' +
            '• 💸 Ao acumular compras, você sobe de nível e desbloqueia o *Txeneco* (internet a crédito de confiança)!\n\n' +
            '🙏 _Muito obrigado pela sua preferência e bem-vindo(a) à Ka-Net!_ 🌐🤝'
        );
    }
    if (totalCompras === 100) {
        return (
            '╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n' +
            '  🎉 *PARABÉNS! VOCÊ É CLIENTE VIP!* 🌟\n' +
            '╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n' +
            'Incrível! Você acaba de completar a sua *100ª compra* na Ka-Net! 🏆✨\n\n' +
            '🔓 *NOVO BENEFÍCIO DESBLOQUEADO: TXENECO* ⚡\n' +
            'Pela sua fidelidade, você agora tem crédito de internet liberado sempre que precisar e estiver sem saldo!\n\n' +
            '🥉 *Nível Bronze:* até *3.0 GB* de limite\n' +
            '📦 *Faixa por Pedido:* a partir de *350 MB*\n\n' +
            '💡 *Como pedir quando precisar:*\n' +
            '👉 *.txenecar 1gb 84XXXXXXX*\n\n' +
            '💳 *Como pagar a dívida (taxa 10%):*\n' +
            '👉 *.pagar <comprovativo>*\n\n' +
            '🆙 _Ao atingir 200 compras, seu limite subirá para 5 GB!_\n' +
            '🙏 _Muito obrigado pela confiança e por fazer parte da família Ka-Net!_ 🌐✨'
        );
    }
    if (totalCompras === 200) {
        return (
            '╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n' +
            '  🥈 *NOVO NÍVEL ALCANÇADO: PRATA!* 💎\n' +
            '╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n' +
            'Sensacional! Você atingiu a marca de *200 compras* na Ka-Net! 🚀🔥\n\n' +
            '🔓 *O SEU LIMITE DE TXENECO SUBIU PARA 5.0 GB!* ⚡\n' +
            'Agora você pode txenecar pacotes de até *5 GB* no total sempre que precisar!\n\n' +
            '💡 *Como pedir:*\n' +
            '👉 *.txenecar 3gb 84XXXXXXX*\n\n' +
            '👑 _Próxima meta: Ao atingir 800 compras, você escolhe qualquer valor até 10 GB!_\n' +
            '🙏 _Muito obrigado pela sua preferência!_ 🌐✨'
        );
    }
    if (totalCompras === 800) {
        return (
            '╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n' +
            '  👑 *NÍVEL OURO VIP SUPREMO!* 👑\n' +
            '╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n' +
            'INCRÍVEL! Você atingiu a lendária marca de *800 compras* na Ka-Net! 🌟🚀🔥\n\n' +
            '🔓 *CRÉDITO TOTALMENTE LIVRE: ATÉ 10 GB!* ⚡\n' +
            'Você é um dos clientes mais fiéis de todo o sistema! Agora você tem a liberdade de escolher qualquer quantidade até *10 GB* a crédito!\n\n' +
            '💡 *Como pedir:*\n' +
            '👉 *.txenecar 5gb 84XXXXXXX* ou *.txenecar 10gb 84XXXXXXX*\n\n' +
            '👑 _Toda a equipe Ka-Net agradece pela sua lealdade incomparável!_ 🌐✨'
        );
    }
    return null;
}


function registrarCompra(telefoneOuId, orderId, valor = 0, mb = 0) {
    if (!telefoneOuId) return;
    let phone = resolverTelefoneDeIdentificador(telefoneOuId) || normalizarTelefone(telefoneOuId);
    const rawDigits = String(telefoneOuId).split('@')[0].split(':')[0].replace(/\D/g, '');
    
    if (!phone && rawDigits.length >= 8) {
        phone = rawDigits;
    }
    if (!phone) return;

    if (rawDigits && phone && rawDigits !== phone && !normalizarTelefone(rawDigits)) {
        vincularLidTelefone(rawDigits, phone);
    }

    const record = clientLoyalty.get(phone) || {
        phone,
        totalCompras: 0,
        ultimaCompra: null,
        historico: []
    };

    if (!Array.isArray(record.historico)) record.historico = [];

    // Idempotência: não duplicar compras se o orderId já estiver registrado
    if (orderId && record.historico.some(h => String(h.orderId) === String(orderId))) {
        console.log(`ℹ️ [FIDELIDADE] Pedido ${orderId} já computado anteriormente para ${phone}. Total mantido: ${record.totalCompras}`);
        return {
            totalCompras: record.totalCompras,
            milestone: null,
            mensagemVip: null
        };
    }

    record.totalCompras = (record.totalCompras || 0) + 1;
    record.ultimaCompra = new Date().toISOString();
    
    // Manter histórico das últimas 30 compras
    record.historico.unshift({
        orderId: orderId || `ORD_${Date.now()}`,
        valor: Number(valor) || 0,
        mb: Number(mb) || 0,
        data: record.ultimaCompra
    });
    if (record.historico.length > 30) record.historico.pop();

    clientLoyalty.set(phone, record);
    if (rawDigits && rawDigits !== phone) {
        clientLoyalty.set(rawDigits, record);
    }
    salvarCacheLocal();
    salvarNoFirestore('client_loyalty', phone, record);

    console.log(`💳 [FIDELIDADE] Compra registrada para ${phone}. Total de compras: ${record.totalCompras}`);
    try { processarCompraIndicacao(phone); } catch (e) { console.warn('⚠️ Erro ao processar bônus indicação:', e.message); }
    const milestoneMsg = gerarMensagemDesbloqueioVip(record.totalCompras);
    return {
        totalCompras: record.totalCompras,
        milestone: record.totalCompras === 1 ? 'primeira_compra' : record.totalCompras === 100 ? 'vip_100' : record.totalCompras === 200 ? 'vip_200' : record.totalCompras === 800 ? 'vip_800' : null,
        mensagemVip: milestoneMsg
    };
}

function getComprasCount(identificador) {
    if (!identificador) return 0;
    
    // 1. Tenta resolver para telefone real
    const phone = resolverTelefoneDeIdentificador(identificador) || normalizarTelefone(identificador);
    if (phone && clientLoyalty.has(phone)) {
        const rec = clientLoyalty.get(phone);
        if (rec && typeof rec.totalCompras === 'number' && rec.totalCompras > 0) {
            return rec.totalCompras;
        }
    }

    // 2. Tenta por dígitos puros (pode ser chave de LID)
    const rawDigits = String(identificador).split('@')[0].split(':')[0].replace(/\D/g, '');
    if (rawDigits && clientLoyalty.has(rawDigits)) {
        const rec = clientLoyalty.get(rawDigits);
        if (rec && typeof rec.totalCompras === 'number' && rec.totalCompras > 0) {
            return rec.totalCompras;
        }
    }

    // 3. Tenta mapa LID -> Telefone
    if (rawDigits && lidToPhone.has(rawDigits)) {
        const mappedTel = lidToPhone.get(rawDigits);
        if (mappedTel && clientLoyalty.has(mappedTel)) {
            const rec = clientLoyalty.get(mappedTel);
            if (rec && typeof rec.totalCompras === 'number' && rec.totalCompras > 0) {
                return rec.totalCompras;
            }
        }
    }

    // 4. Tenta verificar por receptor padrão configurado
    if (rawDigits && defaultRecipients.has(rawDigits)) {
        const def = defaultRecipients.get(rawDigits);
        if (def && def.targetPhone) {
            const defNorm = normalizarTelefone(def.targetPhone);
            if (defNorm && clientLoyalty.has(defNorm)) {
                const rec = clientLoyalty.get(defNorm);
                if (rec && typeof rec.totalCompras === 'number' && rec.totalCompras > 0) {
                    return rec.totalCompras;
                }
            }
        }
    }

    return 0;
}

/**
 * Consulta de fidelidade garantida com fallbacks automáticos:
 * 1. Cache em memória (ultra-rápido)
 * 2. Coleção client_loyalty no Firestore
 * 3. Varredura direta na coleção orders (pedidos com status completed)
 */
async function obterComprasCliente(telefone) {
    const phone = resolverTelefoneDeIdentificador(telefone) || normalizarTelefone(telefone);
    const rawDigits = String(telefone || '').split('@')[0].split(':')[0].replace(/\D/g, '');
    const searchKey = phone || rawDigits;
    if (!searchKey) return { phone: '', totalCompras: 0, existe: false };

    // 1. Verificar cache em memória
    let record = (phone && clientLoyalty.get(phone)) || (rawDigits && clientLoyalty.get(rawDigits));
    if (record && typeof record.totalCompras === 'number' && record.totalCompras > 0) {
        return { phone: record.phone || phone || searchKey, totalCompras: record.totalCompras, record, existe: true };
    }

    // 2. Fallback ao Firestore se em memória estiver zerado ou ausente
    if (firestoreDb) {
        try {
            const docId = phone || searchKey;
            const doc = await firestoreDb.collection('client_loyalty').doc(docId).get();
            if (doc.exists) {
                const data = doc.data();
                const total = Math.max(record?.totalCompras || 0, data.totalCompras || 0);
                record = { ...record, ...data, phone: docId, totalCompras: total };
                clientLoyalty.set(docId, record);
                salvarCacheLocal();
                return { phone: docId, totalCompras: total, record, existe: true };
            }

            // 3. Se nem no client_loyalty existir, buscar directamente em orders completed
            console.log(`🔍 [LOYALTY FALLBACK] Buscando compras históricas de ${searchKey} em orders...`);
            const ordersSnap = await firestoreDb.collection('orders')
                .where('status', '==', 'completed')
                .limit(2000)
                .get();

            if (!ordersSnap.empty) {
                let count = 0;
                let historico = [];
                ordersSnap.docs.forEach(d => {
                    const o = d.data();
                    const candidates = [o.senderPhone, o.cliente_solicitante, o.pagador, o.senderNumber, o.sender, o.numero];
                    const match = candidates.some(c => {
                        if (!c) return false;
                        const res = resolverTelefoneDeIdentificador(c) || normalizarTelefone(c);
                        if (phone && res === phone) return true;
                        const dClean = String(c).split('@')[0].split(':')[0].replace(/\D/g, '');
                        return dClean === searchKey;
                    });
                    if (match) {
                        count++;
                        historico.push({
                            orderId: o.orderId || d.id,
                            valor: Number(o.valor || o.valor_pago) || 0,
                            mb: Number(o.quantidade) || 0,
                            data: o.completedAt || o.createdAt || new Date().toISOString()
                        });
                    }
                });

                if (count > 0) {
                    record = {
                        phone: phone || searchKey,
                        totalCompras: count,
                        ultimaCompra: historico[0]?.data || new Date().toISOString(),
                        historico: historico.slice(0, 30)
                    };
                    clientLoyalty.set(phone || searchKey, record);
                    salvarCacheLocal();
                    salvarNoFirestore('client_loyalty', phone || searchKey, record);
                    console.log(`✅ [LOYALTY FALLBACK] ${phone || searchKey}: encontradas ${count} compras passadas em orders.`);
                    return { phone: phone || searchKey, totalCompras: count, record, existe: true };
                }
            }
        } catch (e) {
            console.warn(`⚠️ [CUSTOMER-SERVICES] Erro ao buscar compras de ${searchKey} no Firestore:`, e.message);
        }
    }

    return { phone: phone || searchKey, totalCompras: record?.totalCompras || 0, record, existe: !!record };
}

// ── 2. SISTEMA DE TXENECO (CRÉDITO DE INTERNET) ───────────────────────────────

/**
 * Calcula o limite máximo de MB que o cliente pode tomar emprestado com base nas compras
 */
function calcularTetoTxeneco(compras) {
    if (compras < 100) return 0;        // Exclusivo para quem tem a partir de 100 compras
    if (compras >= 800) return 10240;   // 800+ compras -> até 10GB (cliente escolhe a quantidade)
    if (compras >= 200) return 5120;    // 200 a 799 compras -> até 5GB
    return 3072;                        // 100 a 199 compras -> até 3GB
}

/**
 * Processa a solicitação de Txeneco
 */
async function solicitarTxeneco({ senderPhone, mbSolicitado, numDestino, jid, senderName }) {
    const phone = normalizarTelefone(senderPhone);
    const dest = normalizarTelefone(numDestino);
    const qtdMb = parseInt(mbSolicitado, 10);

    if (!phone) {
        return { success: false, mensagem: '❌ Número de cliente não identificado.' };
    }
    if (!dest || dest.length !== 9 || !/^8[2-7]\d{7}$/.test(dest)) {
        return { success: false, mensagem: '⚠️ Número de destino inválido. Use um número de Moçambique com 9 dígitos (ex: *84XXXXXXX* ou *85XXXXXXX*).' };
    }

    // 1. Validação da quantidade solicitada (mínimo 350MB, máximo 10GB)
    if (isNaN(qtdMb) || qtdMb < 350 || qtdMb > 10240) {
        return {
            success: false,
            mensagem: `⚠️ *QUANTIDADE INVÁLIDA PARA TXENECO*\n━━━━━━━━━━━━━━━━━━\n` +
                      `A quantidade escolhida deve ser de no mínimo *350 MB* e até no máximo *10 GB* (10240 MB) de acordo com o seu nível de fidelidade.\n\n` +
                      `💡 _Exemplos válidos:_ *.txenecar 1gb ${dest}*, *.txenecar 3gb ${dest}* ou *.txenecar 5gb ${dest}*.`
        };
    }

    // 2. Validação da fidelidade (a partir de 100 compras)
    const totalCompras = getComprasCount(phone);
    if (totalCompras < 100) {
        const faltam = 100 - totalCompras;
        return {
            success: false,
            mensagem: `🚫 *PRIVILÉGIO EXCLUSIVO DE CLIENTE FIEL*\n━━━━━━━━━━━━━━━━━━\n` +
                      `O serviço *Txeneco Ka-Net* é um benefício reservado exclusivamente para clientes com *100 ou mais compras* realizadas.\n\n` +
                      `📊 *O seu total de compras:* *${totalCompras}*\n` +
                      `🎯 Faltam apenas *${faltam} compras* para desbloquear o seu crédito de até *3 GB*!\n\n` +
                      `🛒 Continue a comprar na Ka-Net para liberar o seu benefício!`
        };
    }

    // 3. Teto máximo baseado nas compras
    const tetoMaximoMb = calcularTetoTxeneco(totalCompras);

    // 4. Verificar dívida ativa
    const loanRecord = clientLoans.get(phone) || {
        phone,
        activeDebtMb: 0,
        totalDevidoMt: 0,
        valorPagoMt: 0,
        restanteMt: 0,
        status: 'pago',
        historico: []
    };

    const dividaAtualMb = loanRecord.activeDebtMb || 0;

    // 🛡️ REGRA ESTRITA: Enquanto tiver dívida ativa pendente, NÃO pode txenecar mais!
    if (loanRecord.status === 'pendente' && (loanRecord.restanteMt > 0 || dividaAtualMb > 0)) {
        return {
            success: false,
            mensagem: `⚠️ *VOCÊ JÁ POSSUI UM TXENECO ATIVO PENDENTE* 💳\n` +
                      `━━━━━━━━━━━━━━━━━━\n` +
                      `Enquanto tiver uma dívida pendente, não é permitido solicitar novo crédito.\n\n` +
                      `💰 *Valor Atual a Liquidar:* *${loanRecord.restanteMt} MT* (com taxa de 10%)\n` +
                      `📦 *Txeneco Ativo em Uso:* *${dividaAtualMb >= 1024 ? (dividaAtualMb/1024).toFixed(1)+'GB' : dividaAtualMb+'MB'}*\n\n` +
                      `💡 *Como Quitar a Dívida:*\n` +
                      `Transfira o valor via M-Pesa ou e-Mola e envie aqui o comando:\n` +
                      `👉 *.pagar <comprovativo>*\n\n` +
                      `🛒 _Lembre-se: Você pode continuar a comprar recargas normais a qualquer momento!_`
        };
    }

    const limiteDisponivelMb = Math.max(0, tetoMaximoMb - dividaAtualMb);

    if (qtdMb > limiteDisponivelMb) {
        const dispF = limiteDisponivelMb >= 1024 ? `${(limiteDisponivelMb / 1024).toFixed(0)}GB` : `${limiteDisponivelMb}MB`;
        const tetoF = tetoMaximoMb >= 1024 ? `${(tetoMaximoMb / 1024).toFixed(0)}GB` : `${tetoMaximoMb}MB`;
        const divF = dividaAtualMb >= 1024 ? `${(dividaAtualMb / 1024).toFixed(0)}GB` : `${dividaAtualMb}MB`;
        
        let proximoNivel = '';
        if (totalCompras < 200) {
            proximoNivel = `\n🆙 *Próximo Nível:* Ao atingir *200 compras*, seu limite sobe para *5 GB*! (Faltam ${200 - totalCompras})`;
        } else if (totalCompras < 800) {
            proximoNivel = `\n👑 *Nível VIP Ouro:* Ao atingir *800 compras*, você poderá escolher a quantidade que quiser até *10 GB*! (Faltam ${800 - totalCompras})`;
        }

        return {
            success: false,
            mensagem: `⚠️ *LIMITE DE TXENECO INSUFICIENTE*\n━━━━━━━━━━━━━━━━━━\n` +
                      `Você solicitou: *${qtdMb >= 1024 ? (qtdMb/1024).toFixed(1)+'GB' : qtdMb+'MB'}*\n` +
                      `Seu limite disponível restante: *${dispF}*\n\n` +
                      `📊 *Detalhes da sua Conta:*\n` +
                      `• Teto total (${totalCompras} compras): *${tetoF}*\n` +
                      `• Txeneco ativo em uso: *${divF}*\n` +
                      `• Dívida financeira pendente: *${loanRecord.restanteMt || 0} MT*\n` +
                      proximoNivel + `\n\n` +
                      `💡 Ajuste o valor ou pague a dívida pendente com *.pagar <comprovativo>*`
        };
    }

    // 5. Calcular valor em Meticais correspondente ao pacote diário + Taxa de 10%
    let valorBaseMt = 0;
    if (typeof valorFromMbHelper === 'function') {
        valorBaseMt = Number(valorFromMbHelper(qtdMb, 'diario')) || 0;
    }
    if (!valorBaseMt || valorBaseMt <= 0) {
        // Fallback proporcional: aproximadamente ~25MT por 1GB diário
        valorBaseMt = Math.round((qtdMb / 1024) * 25);
        if (valorBaseMt < 14) valorBaseMt = 14;
    }

    // Taxa de 10% sobre o valor da quantidade
    const taxa10Mt = Math.ceil(valorBaseMt * 0.10);
    const totalNovoEmprestimoMt = valorBaseMt + taxa10Mt;

    // 6. Atualizar registro de dívida do cliente
    loanRecord.activeDebtMb = dividaAtualMb + qtdMb;
    loanRecord.totalDevidoMt = (loanRecord.totalDevidoMt || 0) + totalNovoEmprestimoMt;
    loanRecord.restanteMt = (loanRecord.restanteMt || 0) + totalNovoEmprestimoMt;
    loanRecord.status = 'pendente';
    loanRecord.jidOrigem = jid || loanRecord.jidOrigem || null;
    loanRecord.senderName = senderName || loanRecord.senderName || null;
    loanRecord.ultimoLembreteSlot = null;

    const orderId = `TXN-${Date.now()}`;
    if (!Array.isArray(loanRecord.historico)) loanRecord.historico = [];
    loanRecord.historico.unshift({
        orderId,
        mb: qtdMb,
        destino: dest,
        valorBaseMt,
        taxa10Mt,
        totalDevidoMt: totalNovoEmprestimoMt,
        data: new Date().toISOString()
    });

    clientLoans.set(phone, loanRecord);
    salvarCacheLocal();
    salvarNoFirestore('client_loans', phone, loanRecord);

    // 7. Disparar ordem de internet para o Gateway Celular (Linha Diária)
    if (orderDispatcher) {
        orderDispatcher({
            orderId,
            numero: dest,
            quantidade: qtdMb,
            modo: 'diario',
            jid: jid || `258${phone}@s.whatsapp.net`,
            sender: phone,
            senderPhone: phone,
            senderName: senderName || 'Cliente Txeneco',
            txn_id: orderId,
            valor: 0 // Valor zero pois é a crédito
        });
    }

    const novoDisponivelMb = tetoMaximoMb - loanRecord.activeDebtMb;
    const novoDispF = novoDisponivelMb >= 1024 ? `${(novoDisponivelMb / 1024).toFixed(1)}GB` : `${novoDisponivelMb}MB`;
    const qtdFormatada = qtdMb >= 1024 ? `${(qtdMb / 1024).toFixed(1)}GB (${qtdMb}MB)` : `${qtdMb}MB`;

    return {
        success: true,
        orderId,
        mb: qtdMb,
        destino: dest,
        mensagem: `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n` +
                  `  ⚡ *TXENECO CONCEDIDO COM SUCESSO!* 📦\n` +
                  `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                  `Parabéns! Pela sua fidelidade de *${totalCompras} compras*, o seu crédito foi liberado:\n\n` +
                  `📲 *Destino:* *${dest}*\n` +
                  `📦 *Quantidade:* *${qtdFormatada}*\n` +
                  `💵 *Valor do Pacote:* ${valorBaseMt} MT\n` +
                  `🏷️ *Taxa de Serviço (10%):* ${taxa10Mt} MT\n` +
                  `💰 *Total a Liquidar:* *${totalNovoEmprestimoMt} MT*\n` +
                  `━━━━━━━━━━━━━━━━━━\n` +
                  `📌 *Saldo Total da sua Dívida:* *${loanRecord.restanteMt} MT*\n` +
                  `💾 *Limite de Txeneco Restante:* *${novoDispF}*\n\n` +
                  `🚀 *Os megas já estão a ser enviados para o seu número!*\n\n` +
                  `💡 *Como Pagar:*\n` +
                  `Pague via M-Pesa ou e-Mola e envie aqui o comando:\n` +
                  `👉 *.pagar <comprovativo>*`
    };
}

// ── 3. PAGAMENTO DA DÍVIDA DO TXENECO (.pagar) ────────────────────────────────

/**
 * Processa o pagamento de dívida via .pagar <confirmacao>
 */
async function processarPagamentoDivida({ senderPhone, valorPago, txnId, rawText, jid }) {
    const phone = normalizarTelefone(senderPhone);
    const vPago = parseFloat(valorPago);

    if (!phone) {
        return { success: false, mensagem: '❌ Número de cliente não identificado.' };
    }

    const loanRecord = clientLoans.get(phone);
    if (!loanRecord || !loanRecord.restanteMt || loanRecord.restanteMt <= 0) {
        return {
            success: false,
            mensagem: `ℹ️ *SEM DÍVIDAS ATIVAS*\n━━━━━━━━━━━━━━━━━━\n` +
                      `Você não possui nenhuma dívida de Txeneco pendente no momento.\n` +
                      `O seu limite de crédito está totalmente livre!`
        };
    }

    if (isNaN(vPago) || vPago <= 0) {
        return {
            success: false,
            mensagem: `⚠️ *VALOR NÃO DETECTADO*\n━━━━━━━━━━━━━━━━━━\n` +
                      `Não foi possível identificar o valor pago no comprovativo.\n` +
                      `Por favor, certifique-se de colar o SMS de confirmação completo com o valor (ex: *Recebeste 25.00MT*).`
        };
    }

    const totalCompras = getComprasCount(phone);
    const tetoMaximoMb = calcularTetoTxeneco(totalCompras);
    const dividaAnteriorMt = loanRecord.restanteMt;

    if (vPago >= dividaAnteriorMt) {
        // Quitação Total
        const trocoMt = vPago - dividaAnteriorMt;
        loanRecord.valorPagoMt = (loanRecord.valorPagoMt || 0) + dividaAnteriorMt;
        loanRecord.restanteMt = 0;
        loanRecord.activeDebtMb = 0;
        loanRecord.status = 'pago';

        clientLoans.set(phone, loanRecord);
        salvarCacheLocal();
        salvarNoFirestore('client_loans', phone, loanRecord);

        const tetoF = tetoMaximoMb >= 1024 ? `${(tetoMaximoMb / 1024).toFixed(1)}GB` : `${tetoMaximoMb}MB`;
        const trocoMsg = trocoMt > 0 ? `\n💵 *Saldo a Favor (Troco):* *${trocoMt} MT* (guardado no sistema)` : '';

        return {
            success: true,
            quitado: true,
            trocoMt,
            jidOrigem: loanRecord.jidOrigem || null,
            mensagem: `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n` +
                      `  🎉 *DÍVIDA 100% LIQUIDADA!* ⚡\n` +
                      `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                      `Confirmamos com sucesso o seu pagamento de *${vPago} MT* (Ref: \`${txnId || 'PAGAMENTO'}\`).\n\n` +
                      `✅ *Status da Dívida:* TOTALMENTE PAGA E ENCERRADA!\n` +
                      `💰 *Valor Liquidado:* ${dividaAnteriorMt} MT` +
                      trocoMsg + `\n\n` +
                      `🔓 *O seu crédito de Txeneco foi totalmente restaurado para ${tetoF}!* Já pode solicitar internet adiantada sempre que precisar.\n\n` +
                      `🙏 *MUITO OBRIGADO PELA SUA HONESTIDADE E PREFERÊNCIA!* 🌟✨\n` +
                      `_A Ka-Net valoriza imensamente clientes fiéis e pontuais como você._ 🌐🤝`
        };
    } else {
        // Quitação Parcial
        const novoRestanteMt = dividaAnteriorMt - vPago;
        loanRecord.valorPagoMt = (loanRecord.valorPagoMt || 0) + vPago;
        loanRecord.restanteMt = novoRestanteMt;

        // Abate proporcional dos MB bloqueados
        const proporcaoPaga = vPago / (loanRecord.totalDevidoMt || dividaAnteriorMt);
        const mbAbatido = Math.round((loanRecord.activeDebtMb || 0) * proporcaoPaga);
        loanRecord.activeDebtMb = Math.max(0, (loanRecord.activeDebtMb || 0) - mbAbatido);

        clientLoans.set(phone, loanRecord);
        salvarCacheLocal();
        salvarNoFirestore('client_loans', phone, loanRecord);

        return {
            success: true,
            quitado: false,
            valorPago: vPago,
            restanteMt: novoRestanteMt,
            jidOrigem: loanRecord.jidOrigem || null,
            mensagem: `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n` +
                      `  ⚠️ *PAGAMENTO PARCIAL RECEBIDO* 💳\n` +
                      `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                      `Muito obrigado! Recebemos *${vPago} MT* da sua dívida (Ref: \`${txnId || 'PAGAMENTO'}\`).\n\n` +
                      `💰 *Dívida Anterior:* ${dividaAnteriorMt} MT\n` +
                      `💵 *Valor Abatido:* ${vPago} MT\n` +
                      `🔴 *VALOR QUE AINDA FALTA:* *${novoRestanteMt} MT*\n\n` +
                      `📌 Para concluir a quitação do resto, efetue o pagamento dos *${novoRestanteMt} MT* restantes e envie novamente:\n` +
                      `👉 *.pagar <comprovativo>*\n\n` +
                      `🙏 _Agradecemos pelo seu esforço em manter a sua conta em dia!_ ✨`
        };
    }
}

function getClienteDivida(telefone) {
    const phone = normalizarTelefone(telefone);
    if (!phone) return null;
    return clientLoans.get(phone) || null;
}

// ── 4. AUTOMAÇÃO DE NÚMERO RECEPTOR PADRÃO ─────────────────────────────────────

function definirReceptorPadrao(payerPhones, targetPhone, ownerJid = null) {
    const destino = normalizarTelefone(targetPhone);

    if (!destino || destino.length !== 9 || !/^8[2-7]\d{7}$/.test(destino)) {
        return { success: false, mensagem: '⚠️ Número receptor inválido. Indique o número Vodacom de 9 dígitos que deve receber os megas (ex: *84XXXXXXX* ou *85XXXXXXX*).' };
    }

    let payers = (Array.isArray(payerPhones) ? payerPhones : [payerPhones])
        .map(p => normalizarTelefone(p))
        .filter(p => p && p.length === 9);

    // Se nenhum pagador válido de 9 dígitos foi encontrado (ex: comando veio com LID de grupo), usar o próprio destino
    if (payers.length === 0) {
        payers = [destino];
    }

    const salvos = [];
    payers.forEach(pagador => {
        const record = {
            payerPhone: pagador,
            targetPhone: destino,
            ownerJid: ownerJid || `258${pagador}@s.whatsapp.net`,
            registeredAt: new Date().toISOString()
        };
        defaultRecipients.set(pagador, record);
        salvarNoFirestore('client_default_recipients', pagador, record);
        salvos.push(pagador);
        console.log(`📲 [RECEPTOR PADRÃO] Pagador ${pagador} -> Receptor Fixo: ${destino}`);
    });

    salvarCacheLocal();

    // Sincronizar também no seed caso exista no disco
    try {
        if (fs.existsSync(CACHE_SEED_FILE)) {
            const seedRaw = fs.readFileSync(CACHE_SEED_FILE, 'utf8');
            const seedObj = JSON.parse(seedRaw);
            seedObj.defaultRecipients = [...defaultRecipients.entries()];
            fs.writeFileSync(CACHE_SEED_FILE, JSON.stringify(seedObj, null, 2), 'utf8');
        }
    } catch (_) {}

    const listaPagadores = salvos.map((p, i) => `  ${i + 1}. *${p}*`).join('\n');
    return {
        success: true,
        pagadores: salvos,
        destino,
        mensagem: `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n` +
                  `  ✅ *RECEPTOR PADRÃO CONFIGURADO!* ⚡\n` +
                  `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                  `📱 *Número(s) Pagador(es) Vinculado(s):*\n${listaPagadores}\n\n` +
                  `📲 *Número Receptor Fixo:* *${destino}*\n\n` +
                  `🚀 *COMO FUNCIONA AGORA:*\n` +
                  `Sempre que você transferir dinheiro a partir de *qualquer um* desses números (seja M-Pesa ou e-Mola), os megas serão *enviados automaticamente para ${destino}* sem precisar de enviar comprovativo no WhatsApp!\n\n` +
                  `💡 _Para consultar:_ *.meureceptor*\n` +
                  `💡 _Para desativar:_ *.removerreceptor*`
    };
}

function obterReceptorPadrao(payerPhone) {
    if (!payerPhone) return null;
    const pagador = normalizarTelefone(payerPhone);
    if (!pagador) return null;
    return defaultRecipients.get(pagador) || null;
}

function listarTodosReceptores() {
    return Array.from(defaultRecipients.values());
}

function obterReceptoresPorOwner(ownerIdentifier) {
    if (!ownerIdentifier) return [];
    const clean = normalizarTelefone(ownerIdentifier);
    const results = [];
    for (const [payer, rec] of defaultRecipients.entries()) {
        const ownerClean = normalizarTelefone(rec.ownerJid || '');
        if (
            (clean && (payer === clean || ownerClean === clean || rec.targetPhone === clean)) ||
            (rec.ownerJid && rec.ownerJid.includes(String(ownerIdentifier)))
        ) {
            results.push(rec);
        }
    }
    return results;
}

function removerReceptorPadrao(targetIdentifier, ownerIdentifier = null) {
    const cleanTarget = normalizarTelefone(targetIdentifier);
    const cleanOwner = normalizarTelefone(ownerIdentifier || targetIdentifier);

    let removidos = 0;
    const paraRemover = [];

    if (cleanTarget) {
        // Remover tanto se informou o número pagador quanto se informou o número receptor
        for (const [payer, rec] of defaultRecipients.entries()) {
            if (payer === cleanTarget || rec.targetPhone === cleanTarget) {
                paraRemover.push(payer);
            }
        }
    } else {
        // Remover todos vinculados a este cliente/WhatsApp
        for (const [payer, rec] of defaultRecipients.entries()) {
            const ownerClean = normalizarTelefone(rec.ownerJid || '');
            if (
                (cleanOwner && (payer === cleanOwner || ownerClean === cleanOwner || rec.targetPhone === cleanOwner)) ||
                (ownerIdentifier && rec.ownerJid && rec.ownerJid.includes(String(ownerIdentifier)))
            ) {
                paraRemover.push(payer);
            }
        }
    }

    [...new Set(paraRemover)].forEach(payer => {
        defaultRecipients.delete(payer);
        deletarNoFirestore('client_default_recipients', payer);
        removidos++;
    });

    salvarCacheLocal();

    // Sincronizar também no seed caso exista no disco
    try {
        if (fs.existsSync(CACHE_SEED_FILE)) {
            const seedRaw = fs.readFileSync(CACHE_SEED_FILE, 'utf8');
            const seedObj = JSON.parse(seedRaw);
            seedObj.defaultRecipients = [...defaultRecipients.entries()];
            fs.writeFileSync(CACHE_SEED_FILE, JSON.stringify(seedObj, null, 2), 'utf8');
        }
    } catch (_) {}

    if (removidos === 0) {
        return {
            success: false,
            mensagem: 'ℹ️ Você não possui nenhum receptor padrão ativo vinculado a este contato no momento.\n\n' +
                      '💡 _Se configurou outro número M-Pesa/e-Mola, envie:_ *.desconfigurar <numero_pagador>*'
        };
    }

    console.log(`🗑️ [RECEPTOR PADRÃO] ${removidos} receptor(es) removido(s)`);
    return {
        success: true,
        removidos,
        mensagem: `✅ *RECEPTOR(ES) REMOVIDO(S) COM SUCESSO!*\n\n` +
                  `Foram desativadas as rotas automáticas (${removidos} pagador(es) desvinculado(s)).\n` +
                  `A partir de agora, o sistema voltará a aguardar o comprovativo e o número no WhatsApp normalmente.`
    };
}

// ── 5. SISTEMA DE BÔNUS ADMINISTRATIVO ─────────────────────────────────────────

function atribuirBonusAdmin(telefone, mbBonus, adminId = 'Master') {
    const phone = normalizarTelefone(telefone);
    const qtd = parseInt(mbBonus, 10);

    if (!phone || phone.length !== 9) {
        return { success: false, mensagem: '⚠️ Número de cliente inválido.' };
    }
    if (isNaN(qtd) || qtd <= 0) {
        return { success: false, mensagem: '⚠️ Quantidade de bônus inválida em MB.' };
    }

    const record = clientBonuses.get(phone) || {
        phone,
        bonusMb: 0,
        historico: []
    };

    record.bonusMb = (record.bonusMb || 0) + qtd;
    if (!Array.isArray(record.historico)) record.historico = [];
    record.historico.unshift({
        tipo: 'credito_admin',
        mb: qtd,
        adminId,
        data: new Date().toISOString()
    });

    clientBonuses.set(phone, record);
    salvarCacheLocal();
    salvarNoFirestore('client_bonuses', phone, record);

    const qtdF = qtd >= 1024 ? `${(qtd / 1024).toFixed(1)}GB (${qtd}MB)` : `${qtd}MB`;
    const totalF = record.bonusMb >= 1024 ? `${(record.bonusMb / 1024).toFixed(1)}GB (${record.bonusMb}MB)` : `${record.bonusMb}MB`;

    console.log(`🎁 [BÔNUS ADMIN] +${qtd}MB concedidos ao cliente ${phone} por ${adminId}. Saldo: ${record.bonusMb}MB`);
    return {
        success: true,
        phone,
        mbConcedido: qtd,
        saldoTotalMb: record.bonusMb,
        mensagemAdmin: `✅ *BÔNUS CONCEDIDO COM SUCESSO!*\n\n👤 *Cliente:* ${phone}\n🎁 *Bônus Adicionado:* ${qtdF}\n💾 *Saldo Total de Bônus:* ${totalF}`,
        mensagemCliente: `🎁 *PARABÉNS! VOCÊ RECEBEU UM BÔNUS!* 🎉\n━━━━━━━━━━━━━━━━━━\n` +
                         `O Administrador concedeu-lhe *${qtdF}* de bônus!\n` +
                         `💾 *O seu Saldo de Bônus Atual:* *${totalF}*\n\n` +
                         `💡 *Como usar:* Você pode sacar os seus megas quando quiser usando:\n` +
                         `👉 *.sacarbonus <quantidade> [número]*\n` +
                         `Ou consulte com: *.meubonus*`
    };
}

function consultarBonus(telefone) {
    const phone = normalizarTelefone(telefone);
    if (!phone) return 0;
    const record = clientBonuses.get(phone);
    return record ? (record.bonusMb || 0) : 0;
}

async function sacarBonus({ senderPhone, mbSolicitado, numDestino, jid }) {
    const phone = normalizarTelefone(senderPhone);
    const dest = numDestino ? normalizarTelefone(numDestino) : phone;
    const qtd = parseInt(mbSolicitado, 10);

    if (!phone) return { success: false, mensagem: '❌ Cliente não identificado.' };
    if (!dest || dest.length !== 9 || !/^8[2-7]\d{7}$/.test(dest)) {
        return { success: false, mensagem: '⚠️ Número de destino inválido.' };
    }

    const record = clientBonuses.get(phone);
    const saldoMb = record ? (record.bonusMb || 0) : 0;

    if (isNaN(qtd) || qtd <= 0) {
        return { success: false, mensagem: '⚠️ Quantidade de saque de bônus inválida.' };
    }
    if (qtd > saldoMb) {
        const saldoF = saldoMb >= 1024 ? `${(saldoMb / 1024).toFixed(1)}GB` : `${saldoMb}MB`;
        return {
            success: false,
            mensagem: `⚠️ *SALDO DE BÔNUS INSUFICIENTE*\n━━━━━━━━━━━━━━━━━━\n` +
                      `Você solicitou: *${qtd}MB*\n` +
                      `O seu saldo de bônus disponível é de: *${saldoF}*\n\n` +
                      `💡 Consulte o seu saldo com *.meubonus*.`
        };
    }

    // Debitar do bônus
    record.bonusMb = saldoMb - qtd;
    if (!Array.isArray(record.historico)) record.historico = [];
    const orderId = `BONUS-${Date.now()}`;
    record.historico.unshift({
        tipo: 'saque_cliente',
        mb: qtd,
        destino: dest,
        orderId,
        data: new Date().toISOString()
    });

    clientBonuses.set(phone, record);
    salvarCacheLocal();
    salvarNoFirestore('client_bonuses', phone, record);

    // Disparar ordem de recarga imediata
    if (orderDispatcher) {
        orderDispatcher({
            orderId,
            numero: dest,
            quantidade: qtd,
            modo: 'diario',
            jid: jid || `258${phone}@s.whatsapp.net`,
            sender: phone,
            senderPhone: phone,
            senderName: 'Saque Bônus Ka-Net',
            txn_id: orderId,
            valor: 0
        });
    }

    const qtdF = qtd >= 1024 ? `${(qtd / 1024).toFixed(1)}GB` : `${qtd}MB`;
    const saldoRestF = record.bonusMb >= 1024 ? `${(record.bonusMb / 1024).toFixed(1)}GB` : `${record.bonusMb}MB`;

    return {
        success: true,
        orderId,
        mbSacado: qtd,
        destino: dest,
        saldoRestanteMb: record.bonusMb,
        mensagem: `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n` +
                  `  🎉 *SAQUE DE BÔNUS CONCLUÍDO!* ⚡\n` +
                  `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                  `📦 *Volume Sacado:* *${qtdF}*\n` +
                  `📲 *Destino:* *${dest}*\n` +
                  `💾 *Saldo de Bônus Restante:* *${saldoRestF}*\n\n` +
                  `🚀 A sua recarga foi enviada para ativação imediata!`
    };
}

// ── 6. PARSER E DISTRIBUIÇÃO MULTI-DESTINO ────────────────────────────────────

const DEPOSIT_NUMBERS = new Set([
    '856268811', '879691565', '864882152', '850401416', '856116039',
    '258856268811', '258879691565', '258864882152', '258850401416', '258856116039'
]);

function isNumeroDepositoCS(num) {
    if (!num) return false;
    const clean = String(num).replace(/\D/g, '');
    const clean9 = clean.startsWith('258') && clean.length === 12 ? clean.slice(3) : clean;
    return DEPOSIT_NUMBERS.has(clean) || DEPOSIT_NUMBERS.has(clean9);
}

/**
 * Analisa instruções de multi-destino em um texto de pagamento.
 * Ex: "manda 2gb para 841111111 e dois para 841234567"
 * ou "2gb para 841111111 e 1gb para 852222222"
 */
function parseMultiDestino(texto, totalValorMT = 0, buscarPacoteFn = null) {
    if (!texto) return null;
    let clean = String(texto).trim();

    // Se o texto contiver linhas de comprovativo, isolar apenas linhas de instruções/números
    const lines = clean.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const nonReceiptLines = lines.filter(l => !/(?:confirmado|transferiste|recebeste|recebeu|transferiu|saldo|taxa foi|liga 100|m-pesa|e-mola|vodacom|movitel|em caso de duvida)/i.test(l));
    if (nonReceiptLines.length > 0 && lines.length > nonReceiptLines.length) {
        clean = nonReceiptLines.join('\n');
    }

    const wordToNum = {
        'meio': 0.5,
        'um': 1, 'uma': 1, '1': 1,
        'dois': 2, 'duas': 2, '2': 2,
        'tres': 3, 'três': 3, '3': 3,
        'quatro': 4, '4': 4,
        'cinco': 5, '5': 5
    };

    // Procurar todos os números Vodacom (84 ou 85), descartando números de depósito oficiais da empresa
    const phoneRegex = /(?:258)?(8[45]\d{7})/g;
    const phones = [];
    let pMatch;
    while ((pMatch = phoneRegex.exec(clean)) !== null) {
        const pNum = pMatch[1];
        if (isNumeroDepositoCS(pNum)) {
            continue;
        }
        // Evitar números repetidos no mesmo índice
        if (!phones.some(p => p.index === pMatch.index)) {
            phones.push({
                phone: pNum,
                index: pMatch.index
            });
        }
    }

    if (phones.length < 2) {
        return null; // Não é divisão multi-destino se tem menos de 2 telefones
    }

    const segments = [];
    for (let i = 0; i < phones.length; i++) {
        const cur = phones[i];
        const prevEnd = i === 0 ? 0 : phones[i - 1].index + phones[i - 1].phone.length;
        const textBefore = clean.substring(prevEnd, cur.index);
        const nextStart = i === phones.length - 1 ? clean.length : phones[i + 1].index;
        const textAfter = clean.substring(cur.index + cur.phone.length, nextStart);

        let mb = null;

        // 1. Procura formato explícito de volume (ex: 2gb, 1024mb, 2.5gb)
        const volRegex = /(?<![\d.,])(\d+(?:[.,]\d+)?)\s*(gb|mb|g|m)\b/i;
        const vMatch = textBefore.match(volRegex) || textAfter.match(volRegex);
        if (vMatch) {
            const val = parseFloat(vMatch[1].replace(',', '.'));
            const unit = vMatch[2].toLowerCase();
            mb = (unit === 'gb' || unit === 'g') ? Math.round(val * 1024) : Math.round(val);
        } else {
            // 2. Procura formato em palavras (ex: "dois para", "dois gb")
            const wordRegex = /\b(meio|um|uma|dois|duas|três|tres|quatro|cinco)\s*(?:gb|mb|gig|gigas?)?\b/i;
            const wMatch = textBefore.match(wordRegex) || textAfter.match(wordRegex);
            if (wMatch) {
                const w = wMatch[1].toLowerCase();
                const numVal = wordToNum[w] || 1;
                mb = Math.round(numVal * 1024);
            }
        }

        // 3. Procura valor em MT associado a este número (ex: 50mt para 84..., 50 para 85...)
        // Evitar pegar casas decimais como 3.90MT sendo lido como 90MT
        if (!mb) {
            const mtRegex = /(?<![\d.,])(\d+(?:[.,]\d+)?)\s*(?:mt|mzn|meticais)\b/i;
            const mtMatch = textBefore.match(mtRegex) || textAfter.match(mtRegex);
            if (mtMatch && buscarPacoteFn) {
                const subValor = Math.round(parseFloat(mtMatch[1].replace(',', '.')));
                const pac = buscarPacoteFn(subValor);
                if (pac && pac.mb) mb = pac.mb;
            }
        }

        segments.push({
            phone: cur.phone,
            mb: mb || 0
        });
    }

    const totalComMb = segments.filter(s => s.mb > 0);
    if (totalComMb.length === 0) {
        // Se nenhum tem MB especificado mas temos valor total, dividir o valor igualmente
        if (totalValorMT > 0 && buscarPacoteFn) {
            const valorPorNumero = Math.floor(totalValorMT / segments.length);
            const pac = buscarPacoteFn(valorPorNumero);
            if (pac && pac.mb) {
                segments.forEach(s => s.mb = pac.mb);
            }
        } else {
            return null;
        }
    } else if (totalComMb.length === 1 && segments.length > 1) {
        // Se apenas 1 especificou (ex: "2gb para 85... e 84..."), aplicar para todos
        const defMb = totalComMb[0].mb;
        segments.forEach(s => { if (s.mb === 0) s.mb = defMb; });
    }

    // Se ainda restou algum sem MB, dividir proporcionalmente
    const semMb = segments.filter(s => s.mb === 0);
    if (semMb.length > 0 && totalComMb.length > 0) {
        const defMb = totalComMb[0].mb;
        semMb.forEach(s => s.mb = defMb);
    }

    return segments;
}


// ── GESTÃO DE COBRANÇAS E LEMBRETES DE DÍVIDAS ───────────────────────────────

function obterDevedoresAtivos() {
    const devedores = [];
    for (const [phone, loan] of clientLoans.entries()) {
        if (loan.status === 'pendente' && (loan.restanteMt > 0 || (loan.activeDebtMb || 0) > 0)) {
            devedores.push(loan);
        }
    }
    return devedores;
}

function registrarLembreteEnviado(phone, slotId) {
    const tel = normalizarTelefone(phone);
    const loan = clientLoans.get(tel);
    if (loan) {
        loan.ultimoLembreteSlot = slotId;
        loan.ultimoLembreteData = new Date().toISOString();
        if (!Array.isArray(loan.lembretesEnviados)) loan.lembretesEnviados = [];
        loan.lembretesEnviados.push({ slotId, data: loan.ultimoLembreteData });
        if (loan.lembretesEnviados.length > 30) loan.lembretesEnviados.shift();
        salvarCacheLocal();
        salvarNoFirestore('client_loans', tel, loan);
    }
}


// ══════════════════════════════════════════════════════════════════════════════
// 6. GESTÃO DE PACOTES ILIMITADOS & LEMBRETES DE RENOVAÇÃO (30 DIAS)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Cadastra ou renova uma assinatura de pacote ilimitado / mensal
 */
function cadastrarOuRenovarAssinaturaIlimitada({
    phone,
    lid = null,
    jid = null,
    nomeCliente = null,
    planoNome = 'Pacote Ilimitado 30 Dias',
    tipoPlano = 'ilimitado',
    valor = 0,
    numeroDestino = null,
    dias = 30
}) {
    const telReal = resolverTelefoneDeIdentificador(phone) || normalizarTelefone(phone) || String(phone || '').replace(/\D/g, '');
    const numDest = normalizarTelefone(numeroDestino) || telReal;
    if (!telReal && !numDest) return null;

    const chaveTelefone = telReal || numDest;
    const lidClean = lid ? String(lid).split('@')[0].split(':')[0].replace(/\D/g, '') : null;

    // Buscar assinatura ativa existente deste cliente
    let existingSub = null;
    for (const sub of unlimitedSubscriptions.values()) {
        if ((sub.phone === chaveTelefone || sub.numeroDestino === numDest || (lidClean && sub.lid === lidClean)) && sub.status === 'ativo') {
            existingSub = sub;
            break;
        }
    }

    const agora = new Date();
    let dataInicio = agora.toISOString();
    let expiraEm = new Date(agora.getTime() + (dias * 24 * 60 * 60 * 1000));

    // Se já tinha assinatura ativa e ainda não venceu, soma os dias à data de expiração restante!
    if (existingSub && new Date(existingSub.dataExpiracao) > agora) {
        const expAtual = new Date(existingSub.dataExpiracao);
        expiraEm = new Date(expAtual.getTime() + (dias * 24 * 60 * 60 * 1000));
        dataInicio = existingSub.dataInicio || dataInicio;
    }

    const subId = existingSub ? existingSub.id : `SUB_${chaveTelefone}_${Date.now()}`;
    const jidFinal = jid || (chaveTelefone ? `258${chaveTelefone}@s.whatsapp.net` : null);

    const subscription = {
        id: subId,
        phone: chaveTelefone,
        lid: lidClean || (existingSub ? existingSub.lid : null),
        jid: jidFinal,
        nomeCliente: nomeCliente || (existingSub ? existingSub.nomeCliente : 'Cliente Ka-Net'),
        planoNome: planoNome || (existingSub ? existingSub.planoNome : 'Pacote Ilimitado'),
        tipoPlano: tipoPlano || 'ilimitado',
        valor: Number(valor) || (existingSub ? existingSub.valor : 0),
        numeroDestino: numDest,
        dataInicio,
        dataExpiracao: expiraEm.toISOString(),
        diasValidade: dias,
        status: 'ativo',
        intencaoRenovacao: null, // null | 'confirmou_sim' | 'recusou_nao'
        dataConfirmacao: null,
        notificado_3dias: false,
        notificado_12h: false,
        notificado_30min: false,
        historicoRenovacoes: [
            ...(existingSub && Array.isArray(existingSub.historicoRenovacoes) ? existingSub.historicoRenovacoes : []),
            { data: agora.toISOString(), valor: Number(valor) || 0, dias }
        ],
        updatedAt: agora.toISOString(),
        createdAt: existingSub ? existingSub.createdAt : agora.toISOString()
    };

    unlimitedSubscriptions.set(subId, subscription);
    salvarCacheLocal();
    salvarNoFirestore('unlimited_subscriptions', subId, subscription);

    console.log(`📡 [ASSINATURA ILIMITADA] ${subId} ativa para ${chaveTelefone} (${planoNome}) até ${expiraEm.toLocaleDateString('pt-PT')}`);
    return subscription;
}

/**
 * Retorna assinatura ativa pelo telefone ou LID
 */
function obterAssinaturaIlimitadaAtiva(identificador) {
    if (!identificador) return null;
    const phone = resolverTelefoneDeIdentificador(identificador) || normalizarTelefone(identificador);
    const rawClean = String(identificador).split('@')[0].split(':')[0].replace(/\D/g, '');
    const agora = Date.now();

    for (const sub of unlimitedSubscriptions.values()) {
        if (sub.status !== 'ativo') continue;
        if (new Date(sub.dataExpiracao).getTime() <= agora) continue;
        const bateTel = phone && (sub.phone === phone || sub.numeroDestino === phone);
        const bateLid = rawClean && (sub.lid === rawClean || sub.phone === rawClean);
        if (bateTel || bateLid) return sub;
    }
    return null;
}

/**
 * Retorna assinatura que está no período de 3 dias de vencimento aguardando confirmação do cliente
 */
function obterAssinaturaPendenteConfirmacao(identificador) {
    if (!identificador) return null;
    const phone = resolverTelefoneDeIdentificador(identificador) || normalizarTelefone(identificador);
    const rawClean = String(identificador).split('@')[0].split(':')[0].replace(/\D/g, '');

    for (const sub of unlimitedSubscriptions.values()) {
        if (sub.status !== 'ativo') continue;
        const bateTel = phone && (sub.phone === phone || sub.numeroDestino === phone);
        const bateLid = rawClean && (sub.lid === rawClean || sub.phone === rawClean);
        const bateJid = sub.jid && (sub.jid.includes(rawClean) || (phone && sub.jid.includes(phone)));

        if ((bateTel || bateLid || bateJid) && sub.notificado_3dias && sub.intencaoRenovacao === null) {
            return sub;
        }
    }
    return null;
}

/**
 * Registra a resposta do cliente à pergunta de renovação (SIM ou NÃO)
 */
function registrarRespostaRenovacao(identificador, querRenovar) {
    const sub = obterAssinaturaPendenteConfirmacao(identificador) || obterAssinaturaIlimitadaAtiva(identificador);
    if (!sub) return { success: false, mensagem: 'Nenhuma assinatura ilimitada elegível encontrada para confirmação.' };

    sub.intencaoRenovacao = querRenovar ? 'confirmou_sim' : 'recusou_nao';
    sub.dataConfirmacao = new Date().toISOString();
    sub.updatedAt = new Date().toISOString();

    unlimitedSubscriptions.set(sub.id, sub);
    salvarCacheLocal();
    salvarNoFirestore('unlimited_subscriptions', sub.id, sub);

    console.log(`📝 [RENOVAÇÃO ILIMITADO] Cliente ${sub.phone} respondeu: ${sub.intencaoRenovacao}`);
    return { success: true, intencao: sub.intencaoRenovacao, assinatura: sub };
}

/**
 * Salva atualizações diretas de uma assinatura (notificações enviadas, etc.)
 */
function salvarAssinatura(sub) {
    if (!sub || !sub.id) return;
    unlimitedSubscriptions.set(sub.id, sub);
    salvarCacheLocal();
    salvarNoFirestore('unlimited_subscriptions', sub.id, sub);
}

/**
 * Lista todas as assinaturas ilimitadas por filtro
 */
function listarAssinaturasIlimitadas(filtro = 'todas') {
    const list = Array.from(unlimitedSubscriptions.values());
    const agora = Date.now();

    if (filtro === 'ativas') {
        return list.filter(s => s.status === 'ativo' && new Date(s.dataExpiracao).getTime() > agora);
    }
    if (filtro === 'expiradas') {
        return list.filter(s => s.status === 'expirado' || new Date(s.dataExpiracao).getTime() <= agora);
    }
    if (filtro === 'confirmadas') {
        return list.filter(s => s.status === 'ativo' && s.intencaoRenovacao === 'confirmou_sim');
    }
    if (filtro === 'a_vencer_3dias') {
        return list.filter(s => {
            if (s.status !== 'ativo') return false;
            const diff = new Date(s.dataExpiracao).getTime() - agora;
            return diff > 0 && diff <= 3 * 24 * 3600 * 1000;
        });
    }
    return list;
}

/**
 * Cancela manualmente uma assinatura ilimitada
 */
function cancelarAssinaturaIlimitada(idOuTelefone) {
    if (!idOuTelefone) return false;
    let found = null;
    if (unlimitedSubscriptions.has(idOuTelefone)) {
        found = unlimitedSubscriptions.get(idOuTelefone);
    } else {
        const phone = normalizarTelefone(idOuTelefone) || String(idOuTelefone).replace(/\D/g, '');
        for (const sub of unlimitedSubscriptions.values()) {
            if (sub.phone === phone || sub.numeroDestino === phone) {
                found = sub;
                break;
            }
        }
    }
    if (!found) return false;

    found.status = 'cancelado';
    found.updatedAt = new Date().toISOString();
    salvarAssinatura(found);
    return true;
}

/**
 * Renova manualmente uma assinatura adicionando dias
 */
function renovarAssinaturaIlimitadaManual(idOuTelefone, dias = 30) {
    if (!idOuTelefone) return null;
    let sub = null;
    if (unlimitedSubscriptions.has(idOuTelefone)) {
        sub = unlimitedSubscriptions.get(idOuTelefone);
    } else {
        const phone = normalizarTelefone(idOuTelefone) || String(idOuTelefone).replace(/\D/g, '');
        for (const s of unlimitedSubscriptions.values()) {
            if (s.phone === phone || s.numeroDestino === phone) {
                sub = s;
                break;
            }
        }
    }
    if (!sub) return null;

    const agora = new Date();
    const expBase = (new Date(sub.dataExpiracao) > agora) ? new Date(sub.dataExpiracao) : agora;
    const novaExpira = new Date(expBase.getTime() + (dias * 24 * 3600 * 1000));

    sub.dataExpiracao = novaExpira.toISOString();
    sub.status = 'ativo';
    sub.notificado_3dias = false;
    sub.notificado_12h = false;
    sub.notificado_30min = false;
    sub.intencaoRenovacao = null;
    sub.dataConfirmacao = null;
    sub.updatedAt = agora.toISOString();

    if (!Array.isArray(sub.historicoRenovacoes)) sub.historicoRenovacoes = [];
    sub.historicoRenovacoes.push({
        data: agora.toISOString(),
        manual: true,
        dias
    });

    salvarAssinatura(sub);
    return sub;
}

module.exports = {
    initCustomerServices,
    normalizarTelefone,
    setWhatsAppNotifier,
    // Programa Indica e Ganha
    vincularLidTelefone,
    resolverTelefoneDeIdentificador,
    obterTodosLids,
    gerarCodigoConviteUnico,
    obterTelefonePorCodigo,
    vincularIndicacao,
    processarCompraIndicacao,
    obterStatusIndicacao,
    temAguardandoDestinoBonus,
    obterAguardandoDestinoBonus,
    removerAguardandoDestinoBonus,
    registrarAguardandoDestinoBonus,
    // Fidelidade
    registrarCompra,
    getComprasCount,
    obterComprasCliente,
    // Txeneco
    calcularTetoTxeneco,
    solicitarTxeneco,
    processarPagamentoDivida,
    getClienteDivida,
    obterDevedoresAtivos,
    registrarLembreteEnviado,
    // Receptor Padrão
    definirReceptorPadrao,
    obterReceptorPadrao,
    obterReceptoresPorOwner,
    listarTodosReceptores,
    removerReceptorPadrao,
    // Bônus
    atribuirBonusAdmin,
    consultarBonus,
    sacarBonus,
    // Multi-Destino
    parseMultiDestino,
    // Pacotes Ilimitados & Notificações de Renovação (30 dias)
    cadastrarOuRenovarAssinaturaIlimitada,
    obterAssinaturaIlimitadaAtiva,
    obterAssinaturaPendenteConfirmacao,
    registrarRespostaRenovacao,
    salvarAssinatura,
    listarAssinaturasIlimitadas,
    cancelarAssinaturaIlimitada,
    renovarAssinaturaIlimitadaManual,
    // Status
    getStats: () => ({
        totalFidelizados: clientLoyalty.size,
        totalEmprestimos: clientLoans.size,
        totalReceptores: defaultRecipients.size,
        totalBonus: clientBonuses.size
    })
};
