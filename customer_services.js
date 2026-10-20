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

let firestoreDb = null;
let orderDispatcher = null;
let valorFromMbHelper = null;

// Normalizador de telefone Moçambicano (retorna sempre 9 dígitos, ex: 841234567)
function normalizarTelefone(tel) {
    if (!tel) return '';
    const limpo = String(tel).replace(/\D/g, '');
    if (limpo.length === 12 && limpo.startsWith('258')) {
        return limpo.slice(3);
    }
    if (limpo.length >= 9) {
        return limpo.slice(-9);
    }
    return limpo;
}

// ── PERSISTÊNCIA: CACHE LOCAL EM JSON ─────────────────────────────────────────

function salvarCacheLocal() {
    try {
        const payload = {
            loyalty: [...clientLoyalty.entries()],
            loans: [...clientLoans.entries()],
            defaultRecipients: [...defaultRecipients.entries()],
            bonuses: [...clientBonuses.entries()],
            savedAt: new Date().toISOString()
        };
        fs.writeFileSync(CACHE_FILE, JSON.stringify(payload, null, 2), 'utf8');
    } catch (err) {
        console.warn('⚠️ [CUSTOMER-SERVICES] Erro ao salvar cache local:', err.message);
    }
}

function carregarCacheLocal() {
    try {
        if (!fs.existsSync(CACHE_FILE)) return;
        const raw = fs.readFileSync(CACHE_FILE, 'utf8');
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
        console.log(`📦 [CUSTOMER-SERVICES] Cache local carregado: ${clientLoyalty.size} clientes fidelidade, ${clientLoans.size} empréstimos, ${defaultRecipients.size} receptores, ${clientBonuses.size} bônus.`);
    } catch (err) {
        console.warn('⚠️ [CUSTOMER-SERVICES] Erro ao carregar cache local:', err.message);
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
                const key = normalizarTelefone(d.phone || doc.id);
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
            snap.docs.forEach(doc => {
                const d = doc.data();
                const key = normalizarTelefone(d.payerPhone || doc.id);
                if (key) defaultRecipients.set(key, { ...d, payerPhone: key });
            });
            console.log(`📲 [FIRESTORE] ${snap.size} configurações de receptor padrão carregadas.`);
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

    // 5. Inicialização automática do histórico a partir das ordens concluídas se clientLoyalty estiver vazio
    if (clientLoyalty.size === 0) {
        try {
            console.log('🔍 [FIRESTORE] Calculando histórico de compras a partir de pedidos concluídos...');
            const ordersSnap = await firestoreDb.collection('orders').where('status', '==', 'completed').limit(1000).get();
            if (!ordersSnap.empty) {
                ordersSnap.docs.forEach(d => {
                    const o = d.data();
                    const phone = normalizarTelefone(o.senderPhone || o.sender || o.cliente_solicitante || o.numero);
                    if (phone && phone.length === 9) {
                        const rec = clientLoyalty.get(phone) || { phone, totalCompras: 0, historico: [] };
                        rec.totalCompras += 1;
                        clientLoyalty.set(phone, rec);
                    }
                });
                console.log(`✨ [FIRESTORE] Histórico inicial calculado: ${clientLoyalty.size} clientes com compras passadas.`);
                // Salvar em lote
                for (const [phone, data] of clientLoyalty.entries()) {
                    salvarNoFirestore('client_loyalty', phone, data);
                }
                salvarCacheLocal();
            }
        } catch (e) {
            console.warn('⚠️ [FIRESTORE] Erro ao calcular compras históricas:', e.message);
        }
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

// ── 1. GESTÃO DE FIDELIDADE (CONTAGEM DE COMPRAS) ──────────────────────────────

function gerarMensagemDesbloqueioVip(totalCompras) {
    if (totalCompras === 101) {
        return (
            '╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n' +
            '  🎉 *PARABÉNS! VOCÊ É CLIENTE VIP!* 🌟\n' +
            '╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n' +
            'Incrível! Você acaba de completar a sua *101ª compra* na Ka-Net! 🏆✨\n\n' +
            '🔓 *NOVO BENEFÍCIO LIBERADO: TXENECO* ⚡\n' +
            'Pela sua fidelidade, você agora tem crédito de internet liberado sempre que precisar e estiver sem saldo!\n\n' +
            '📊 *O Seu Limite de Crédito:* até *2.0 GB*\n' +
            '📦 *Faixa por Pedido:* de *551 MB a 2047 MB*\n\n' +
            '💡 *Como pedir quando precisar:*\n' +
            '👉 *.txenecar 1gb 84XXXXXXX*\n\n' +
            '💳 *Como pagar a dívida (taxa 10%):*\n' +
            '👉 *.pagar <comprovativo>*\n\n' +
            '🙏 _Muito obrigado pela confiança e por fazer parte da família Ka-Net!_ 🌐✨'
        );
    }
    if (totalCompras === 500) {
        return (
            '╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n' +
            '  👑 *NÍVEL MESTRE VIP ATINGIDO!* 💎\n' +
            '╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n' +
            'Sensacional! Você atingiu a incrível marca de *500 compras* na Ka-Net! 🚀🔥\n\n' +
            '🔓 *O SEU LIMITE DE TXENECO SUBIU:* *4.0 GB!* ⚡\n' +
            'Agora você pode txenecar até *4 GB* no total sempre que precisar!\n\n' +
            '💡 *Como pedir:*\n' +
            '👉 *.txenecar <quantidade> <número>*\n\n' +
            '👑 _Você é um dos clientes mais especiais da Ka-Net. Parabéns e muito obrigado!_ 🌐✨'
        );
    }
    return null;
}


function registrarCompra(telefone, orderId, valor = 0, mb = 0) {
    const phone = normalizarTelefone(telefone);
    if (!phone || phone.length < 8) return;

    const record = clientLoyalty.get(phone) || {
        phone,
        totalCompras: 0,
        ultimaCompra: null,
        historico: []
    };

    record.totalCompras = (record.totalCompras || 0) + 1;
    record.ultimaCompra = new Date().toISOString();
    
    // Manter histórico das últimas 20 compras
    if (!Array.isArray(record.historico)) record.historico = [];
    record.historico.unshift({
        orderId,
        valor: Number(valor) || 0,
        mb: Number(mb) || 0,
        data: record.ultimaCompra
    });
    if (record.historico.length > 20) record.historico.pop();

    clientLoyalty.set(phone, record);
    salvarCacheLocal();
    salvarNoFirestore('client_loyalty', phone, record);

    console.log(`🌟 [FIDELIDADE] Compra registrada para ${phone}. Total de compras: ${record.totalCompras}`);
    const milestoneMsg = gerarMensagemDesbloqueioVip(record.totalCompras);
    return {
        totalCompras: record.totalCompras,
        milestone: record.totalCompras === 101 ? 'vip_101' : record.totalCompras === 500 ? 'vip_500' : null,
        mensagemVip: milestoneMsg
    };
}

function getComprasCount(telefone) {
    const phone = normalizarTelefone(telefone);
    if (!phone) return 0;
    const record = clientLoyalty.get(phone);
    return record ? (record.totalCompras || 0) : 0;
}

// ── 2. SISTEMA DE TXENECO (CRÉDITO DE INTERNET) ───────────────────────────────

/**
 * Calcula o limite máximo de MB que o cliente pode tomar emprestado com base nas compras
 */
function calcularTetoTxeneco(compras) {
    if (compras < 101) return 0;       // Exclusivo para mais de 100 compras
    if (compras >= 500) return 4096;   // 500+ compras -> até 4GB
    return 2048;                       // 101 a 499 compras -> até 2GB
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

    // 1. Validação da faixa: superior a 550MB e inferior a 2048MB por pedido
    if (isNaN(qtdMb) || qtdMb <= 550 || qtdMb >= 2048) {
        return {
            success: false,
            mensagem: `⚠️ *QUANTIDADE INVÁLIDA PARA TXENECO*\n━━━━━━━━━━━━━━━━━━\n` +
                      `A quantidade escolhida deve ser *superior a 550MB* e *inferior a 2048MB* por pedido.\n\n` +
                      `💡 _Exemplos válidos:_ *.txenecar 600 ${dest}* ou *.txenecar 1024 ${dest}* (1GB).`
        };
    }

    // 2. Validação da fidelidade (> 100 compras)
    const totalCompras = getComprasCount(phone);
    if (totalCompras <= 100) {
        return {
            success: false,
            mensagem: `🚫 *PRIVILÉGIO EXCLUSIVO DE CLIENTE FIEL*\n━━━━━━━━━━━━━━━━━━\n` +
                      `O serviço *Txeneco Ka-Net* é um benefício reservado exclusivamente para clientes com *mais de 100 compras* realizadas.\n\n` +
                      `📊 *O seu total de compras:* *${totalCompras}*\n` +
                      `Continue a comprar na Ka-Net para desbloquear o seu crédito de internet!`
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
        const dispF = limiteDisponivelMb >= 1024 ? `${(limiteDisponivelMb / 1024).toFixed(1)}GB` : `${limiteDisponivelMb}MB`;
        const tetoF = tetoMaximoMb >= 1024 ? `${(tetoMaximoMb / 1024).toFixed(1)}GB` : `${tetoMaximoMb}MB`;
        const divF = dividaAtualMb >= 1024 ? `${(dividaAtualMb / 1024).toFixed(1)}GB` : `${dividaAtualMb}MB`;
        
        return {
            success: false,
            mensagem: `⚠️ *LIMITE DE TXENECO INSUFICIENTE*\n━━━━━━━━━━━━━━━━━━\n` +
                      `Você solicitou: *${qtdMb}MB*\n` +
                      `Limite disponível restante: *${dispF}*\n\n` +
                      `📊 *Detalhes da sua Conta:*\n` +
                      `• Teto total (${totalCompras} compras): *${tetoF}*\n` +
                      `• Txeneco ativo em uso: *${divF}*\n` +
                      `• Dívida financeira pendente: *${loanRecord.restanteMt || 0} MT*\n\n` +
                      `💡 Pague a sua dívida atual com *.pagar <comprovativo>* para restaurar o seu teto total!`
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

    const payers = (Array.isArray(payerPhones) ? payerPhones : [payerPhones])
        .map(p => normalizarTelefone(p))
        .filter(p => p && p.length === 9);

    if (payers.length === 0) {
        return { success: false, mensagem: '⚠️ Nenhum número pagador válido informado (deve ter 9 dígitos, ex: M-Pesa 84/85 ou e-Mola 86/87).' };
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
    const pagador = normalizarTelefone(payerPhone);
    if (!pagador) return null;
    return defaultRecipients.get(pagador) || null;
}

function obterReceptoresPorOwner(ownerIdentifier) {
    const clean = normalizarTelefone(ownerIdentifier);
    const results = [];
    for (const [payer, rec] of defaultRecipients.entries()) {
        const ownerClean = normalizarTelefone(rec.ownerJid || '');
        if (payer === clean || ownerClean === clean || (rec.ownerJid && rec.ownerJid.includes(clean))) {
            results.push(rec);
        }
    }
    return results;
}

function removerReceptorPadrao(targetIdentifier, ownerIdentifier = null) {
    const cleanTarget = normalizarTelefone(targetIdentifier);
    const cleanOwner = normalizarTelefone(ownerIdentifier || targetIdentifier);

    let removidos = 0;
    // Se informou um pagador específico existente:
    if (cleanTarget && defaultRecipients.has(cleanTarget)) {
        defaultRecipients.delete(cleanTarget);
        deletarNoFirestore('client_default_recipients', cleanTarget);
        removidos++;
    } else {
        // Remover todos vinculados a este cliente/WhatsApp
        const paraRemover = [];
        for (const [payer, rec] of defaultRecipients.entries()) {
            const ownerClean = normalizarTelefone(rec.ownerJid || '');
            if (payer === cleanOwner || ownerClean === cleanOwner || (rec.ownerJid && rec.ownerJid.includes(cleanOwner))) {
                paraRemover.push(payer);
            }
        }
        paraRemover.forEach(payer => {
            defaultRecipients.delete(payer);
            deletarNoFirestore('client_default_recipients', payer);
            removidos++;
        });
    }

    salvarCacheLocal();

    if (removidos === 0) {
        return { success: false, mensagem: 'ℹ️ Você não possui nenhum receptor padrão ativo configurado no momento.' };
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
    '856268811', '864882152', '850401416', '856116039',
    '258856268811', '258864882152', '258850401416', '258856116039'
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

module.exports = {
    initCustomerServices,
    normalizarTelefone,
    // Fidelidade
    registrarCompra,
    getComprasCount,
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
    removerReceptorPadrao,
    // Bônus
    atribuirBonusAdmin,
    consultarBonus,
    sacarBonus,
    // Multi-Destino
    parseMultiDestino,
    // Status
    getStats: () => ({
        totalFidelizados: clientLoyalty.size,
        totalEmprestimos: clientLoans.size,
        totalReceptores: defaultRecipients.size,
        totalBonus: clientBonuses.size
    })
};
