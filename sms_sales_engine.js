/**
 * ==============================================================================
 * KA-NET SMS SALES ENGINE (BOT DE ATENDIMENTO E VENDAS AUTOMÁTICAS POR SMS)
 * ==============================================================================
 * Funciona de forma equivalente ao bot do WhatsApp, porém otimizado para SMS GSM:
 * 1. Pedido de Tabela: Envia tabela formatada e compacta de Diários, Semanais e Mensais
 * 2. Pedido de Formas de Pagamento: Envia números M-Pesa e e-Mola + instruções
 * 3. Envio de Comprovativo pelo Cliente:
 *    - Detecta Código de Transação (TXN), Valor e Número de Destino
 *    - Confirma com a operadora (verificação anti-fraude)
 *    - Se confirmado: Notifica cliente -> Despacha transferência USSD -> Notifica conclusão
 *    - Se aguardando operadora: Notifica cliente e ativa assim que o SMS da rede chegar
 * 4. Suporte e Menu de Boas-Vindas
 */

const axios = require('axios');
const path = require('path');
const fs = require('fs');

const BOT_CONFIG_PATH = path.join(__dirname, 'bot_config.js');
const LOCAL_CONFIG_PATH = path.join(__dirname, 'local_config.json');

let DYN_CFG = {};
let LOCAL_CFG = {};

function carregarConfigs() {
    try {
        if (fs.existsSync(LOCAL_CONFIG_PATH)) {
            LOCAL_CFG = JSON.parse(fs.readFileSync(LOCAL_CONFIG_PATH, 'utf8'));
        }
    } catch (e) {}

    try {
        if (fs.existsSync(BOT_CONFIG_PATH)) {
            delete require.cache[require.resolve(BOT_CONFIG_PATH)];
            DYN_CFG = require(BOT_CONFIG_PATH);
        }
    } catch (e) {}
}
carregarConfigs();

// Fila de pedidos de SMS aguardando confirmação da operadora
// txn_id -> { txn_id, valor, senderPhone, numDestino, pacote, timestamp, timer }
const smsAguardandoOperadora = new Map();
// Histórico de transações processadas por SMS para evitar duplicações
const smsTransacoesProcessadas = new Set();

let dispatchOrderCallback = null;

function setOrderDispatcher(fn) {
    dispatchOrderCallback = fn;
}

function getPaymentDetails() {
    carregarConfigs();
    return {
        mpesa_num: LOCAL_CFG.mpesa_number || DYN_CFG.MPESA_NUMBER || '856268811',
        mpesa_name: LOCAL_CFG.mpesa_name || DYN_CFG.MPESA_NAME || 'Kelven Junior Anabela Nharrava',
        emola_num: LOCAL_CFG.emola_number || DYN_CFG.EMOLA_NUMBER || '864882152',
        emola_name: LOCAL_CFG.emola_name || DYN_CFG.EMOLA_NAME || 'Catia Anabela Nharrava'
    };
}

function getSuporteDetails() {
    carregarConfigs();
    let supportNum = '856116039';
    if (LOCAL_CFG.master_number) {
        supportNum = String(LOCAL_CFG.master_number).split(',')[0].trim();
    }
    const sysName = LOCAL_CFG.nome_sistema || 'Ka-Net';
    return { supportNum, sysName };
}

// Fila em memória de SMS pendentes para o Gateway Android coletar e enviar
const pendingOutgoingSms = [];

/**
 * Retorna o próximo SMS pendente para envio pelo Gateway Android (Porta 8090)
 */
function getNextPendingSms() {
    const now = Date.now();
    // Limpar mensagens com mais de 10 minutos
    for (let i = pendingOutgoingSms.length - 1; i >= 0; i--) {
        if (now - pendingOutgoingSms[i].createdAt > 10 * 60 * 1000) {
            pendingOutgoingSms.splice(i, 1);
        }
    }
    // Procurar a primeira mensagem não atribuída ou cujo lease expirou (>30s)
    const item = pendingOutgoingSms.find(s => !s.assignedAt || (now - s.assignedAt > 30000));
    if (item) {
        item.assignedAt = now;
        return {
            id: item.id,
            numero: item.numero,
            mensagem: item.mensagem,
            sim_slot: item.sim_slot || 0
        };
    }
    return null;
}

/**
 * Confirmação de envio recebida do Gateway Android
 */
function confirmSmsSent(smsId, success = true, error = null) {
    const idx = pendingOutgoingSms.findIndex(s => s.id === smsId);
    if (idx !== -1) {
        const item = pendingOutgoingSms[idx];
        pendingOutgoingSms.splice(idx, 1);
        console.log(`✉️ [SMS ENGINE CONFIRMADO] SMS ${smsId} para ${item.numero}: ${success ? 'SUCESSO' : 'FALHA (' + error + ')'}`);
        return true;
    }
    return false;
}

/**
 * Envia SMS para o cliente usando a Porta 8090 do Gateway Android
 * (Suporta envio direto HTTP local e fila em nuvem para o Gateway Android)
 */
async function sendSms(destinatario, mensagem, simSlot = 0) {
    const cleanNum = String(destinatario).trim();
    const cleanMsg = String(mensagem).trim();
    const smsId = 'SMS-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7);

    const smsItem = {
        id: smsId,
        numero: cleanNum,
        mensagem: cleanMsg,
        sim_slot: simSlot,
        createdAt: Date.now(),
        assignedAt: null
    };

    // 1. Tentar envio direto se o Gateway estiver rodando localmente (ex: localhost com adb forward ou IP local)
    const gatewayPort = process.env.SMS_GATEWAY_PORT || 8077;
    const gatewayHost = process.env.SMS_GATEWAY_HOST;
    if (gatewayHost && gatewayHost !== '127.0.0.1') {
        try {
            const response = await axios.post(`http://${gatewayHost}:${gatewayPort}/sms/send`, {
                numero: cleanNum,
                mensagem: cleanMsg,
                sim_slot: simSlot
            }, { timeout: 4000 });
            console.log(`📱 [SMS ENGINE ENVIADO DIRETO] Porta ${gatewayPort} -> ${cleanNum}`);
            return response.data;
        } catch (err) {
            console.log(`ℹ️ [SMS ENGINE] Envio direto HTTP falhou (${err.message}). Adicionando à fila da Nuvem para coleta pelo celular.`);
        }
    }

    // 2. Colocar na fila em Nuvem para o Gateway Android coletar a cada 3s via /api/devices/8077/health
    pendingOutgoingSms.push(smsItem);
    console.log(`📥 [SMS ENGINE FILA] SMS ${smsId} enfileirado para ${cleanNum} (${pendingOutgoingSms.length} na fila da Nuvem)`);
    return { success: true, queued: true, id: smsId };
}

/**
 * Gera Tabela formatada especificamente para envio via SMS
 */
function gerarTabelaCompactaSms() {
    carregarConfigs();
    const tabelas = DYN_CFG.TABELAS || {};
    let msg = "Ka-Net • TABELA DE PACOTES\n\n";

    // DIÁRIOS
    if (tabelas['24hrs'] && Object.keys(tabelas['24hrs']).length > 0) {
        msg += "⚡ DIÁRIOS (24H):\n";
        const entries = Object.entries(tabelas['24hrs']).sort((a, b) => Number(a[0]) - Number(b[0]));
        for (const [preco, item] of entries) {
            const nome = item.nome ? item.nome.replace('24h', '').trim() : `${item.quantidade_mb || item.quantidade}MB`;
            msg += `• ${nome}: ${preco} MT\n`;
        }
        msg += "\n";
    }

    // SEMANAIS
    if (tabelas['semanal'] && Object.keys(tabelas['semanal']).length > 0) {
        msg += "📅 SEMANAIS (7 Dias):\n";
        const entries = Object.entries(tabelas['semanal']).sort((a, b) => Number(a[0]) - Number(b[0]));
        for (const [preco, item] of entries) {
            const nome = item.nome ? item.nome.replace('7 Dias', '').trim() : `${item.quantidade_mb || item.quantidade}MB`;
            msg += `• ${nome}: ${preco} MT\n`;
        }
        msg += "\n";
    }

    // MENSAIS
    if (tabelas['mensal'] && Object.keys(tabelas['mensal']).length > 0) {
        msg += "🗓️ MENSAIS (30 Dias):\n";
        const entries = Object.entries(tabelas['mensal']).sort((a, b) => Number(a[0]) - Number(b[0]));
        for (const [preco, item] of entries) {
            const nome = item.nome ? item.nome.replace('Mensal', '').trim() : `${item.quantidade_mb || item.quantidade}MB`;
            msg += `• ${nome}: ${preco} MT\n`;
        }
        msg += "\n";
    }

    msg += "Pague via M-Pesa ou e-Mola e envie aqui o comprovativo com seu número Vodacom para ativar!";
    return msg;
}

/**
 * Gera Mensagem de Formas de Pagamento para SMS
 */
function gerarPagamentoCompactaSms() {
    const { mpesa_num, mpesa_name, emola_num, emola_name } = getPaymentDetails();
    return `Ka-Net • FORMAS DE PAGAMENTO:

▫️ M-PESA: ${mpesa_num} (${mpesa_name})
▫️ E-MOLA: ${emola_num} (${emola_name})

Como comprar:
1. Faça a transferência do valor do pacote.
2. Encaminhe o SMS do comprovativo para este número.
3. Se o número que vai receber os megas for diferente, escreva o número na mensagem.
Ativação imediata 24 horas!`;
}

/**
 * Gera Mensagem de Suporte para SMS
 */
function gerarSuporteCompactaSms() {
    const { supportNum, sysName } = getSuporteDetails();
    return `${sysName} • SUPORTE E ATENDIMENTO:

Para assistência ou dúvidas sobre recargas, ligue ou envie WhatsApp para:
📞 ${supportNum}
Horário de atendimento: 24h / 7 dias por semana.`;
}

/**
 * Gera Mensagem de Boas-Vindas
 */
function gerarBoasVindasSms() {
    const { sysName } = getSuporteDetails();
    return `Olá! Bem-vindo ao atendimento automático da ${sysName} 🇲🇿

Responda com uma opção:
1 - Tabela de Preços e Pacotes
2 - Formas de Pagamento
3 - Suporte

⚡ Se já pagou, basta reenviar o comprovativo da operadora para ativar seus megas!`;
}

/**
 * Busca pacote pelo valor pago
 */
function buscarPacotePorValor(valorPago) {
    carregarConfigs();
    const tabelas = DYN_CFG.TABELAS || {};
    const vStr = String(Math.round(Number(valorPago)));

    for (const modo of ['24hrs', 'semanal', 'mensal', 'ilimitado']) {
        if (tabelas[modo] && tabelas[modo][vStr]) {
            const item = tabelas[modo][vStr];
            return {
                nome: item.nome || `${item.quantidade_mb || item.quantidade}MB`,
                mb: item.quantidade_mb || item.quantidade,
                tipo: modo === '24hrs' ? 'diario' : modo
            };
        }
    }

    // Fallback aproximado
    const val = Number(valorPago);
    if (val >= 9 && val <= 10) return { nome: '350 MB 24h', mb: 350, tipo: 'diario' };
    if (val >= 14 && val <= 15) return { nome: '550 MB 24h', mb: 550, tipo: 'diario' };
    if (val >= 17 && val <= 18) return { nome: '696 MB 24h', mb: 696, tipo: 'diario' };
    if (val >= 19 && val <= 20) return { nome: '800 MB 24h', mb: 800, tipo: 'diario' };
    if (val >= 25 && val <= 26) return { nome: '1.0 GB 24h', mb: 1024, tipo: 'diario' };
    if (val >= 36 && val <= 37) return { nome: '1.6 GB 24h', mb: 1638, tipo: 'diario' };
    if (val >= 50 && val <= 51) return { nome: '2.0 GB 24h', mb: 2048, tipo: 'diario' };
    if (val >= 75 && val <= 76) return { nome: '3.0 GB 24h', mb: 3072, tipo: 'diario' };
    if (val >= 100 && val <= 101) return { nome: '4.0 GB 24h', mb: 4096, tipo: 'diario' };

    return { nome: `${val} MT em Megas`, mb: Math.round(val * 40), tipo: 'diario' };
}

/**
 * Extrai número de destino Vodacom (84/85) do texto
 */
function extrairNumeroDestino(texto, remetenteOrigem) {
    if (!texto) return remetenteOrigem;
    const clean = String(texto).replace(/[\r\n]+/g, ' ');

    // Procurar 84 ou 85 com 7 dígitos após
    const match = clean.match(/\b(?:258)?(8[45]\d{7})\b/);
    if (match && match[1]) {
        return match[1];
    }

    // Se o próprio remetente for Vodacom (84/85), usa ele
    const cleanRemetente = String(remetenteOrigem).replace(/\D/g, '').slice(-9);
    if (/^8[45]\d{7}$/.test(cleanRemetente)) {
        return cleanRemetente;
    }

    return null;
}

/**
 * Extrai ID de transação (TXN) do comprovativo
 */
function extrairTxnId(body) {
    if (!body) return null;
    const patterns = [
        /Confirmado\s+([A-Z0-9]{8,15})\b/i,
        /(?:Ref|TxId|Transacao|Transação)\s*[:.]?\s*([A-Z0-9]+(?:\.[A-Z0-9]+)*)/i,
        /\b(PP[0-9]{6}\.[0-9]{4}\.[A-Z0-9]{4,8})\b/i,
        /\b((?:PP|N|T)[A-Z0-9]{6,}(?:\.[A-Z0-9]{2,15}){1,4})\b/i,
        /\b([A-Z][A-Z0-9]{9,12})\b/,
        /\b(TXN?[0-9]{6,15})\b/i
    ];

    for (const p of patterns) {
        const m = body.match(p);
        if (m && m[1]) return m[1].toUpperCase().trim();
    }
    return null;
}

/**
 * Extrai valor em MT do comprovativo
 */
function extrairValor(body) {
    if (!body) return null;
    const patterns = [
        /(?:recebeu|recebeste|depositou|creditou|transferiu|pagou|valor)\s+(?:de\s+)?([0-9]+(?:[.,][0-9]{1,2})?)\s*(?:MT|MZN|Mts?)/i,
        /([0-9]+(?:[.,][0-9]{1,2})?)\s*(?:MT|MZN|Mts?)\b/i
    ];

    for (const p of patterns) {
        const m = body.match(p);
        if (m && m[1]) {
            const v = parseFloat(m[1].replace(',', '.'));
            if (!isNaN(v) && v > 0) return v;
        }
    }
    return null;
}

/**
 * PROCESSADOR PRINCIPAL DE MENSAGENS RECEBIDAS POR SMS
 * Chamado pelo webhook quando qualquer cliente envia um SMS para o celular Gateway
 */
async function processIncomingCustomerSms({ sender, body, inMemoryPayments }) {
    if (!sender || !body) return;
    const cleanSender = String(sender).replace(/\D/g, '').slice(-9);
    const text = String(body).trim();
    const cleanText = text.toLowerCase();

    console.log(`📩 [SMS BOT] Mensagem de ${cleanSender}: "${text.slice(0, 80)}"`);

    // ── 1. VERIFICAR SE É PEDIDO DE TABELA ──
    const ehTabela = [
        '1', 'tabela', 'tabelas', 'preco', 'precos', 'preço', 'preços', 'pacote', 'pacotes',
        'valores', 'megas', 'gigas', 'comprar', 'planos'
    ].some(w => cleanText === w || cleanText.startsWith(w + ' ') || cleanText.includes('manda tabela') || cleanText.includes('quero megas'));

    if (ehTabela) {
        console.log(`📋 [SMS BOT] Enviando tabela para ${cleanSender}`);
        await sendSms(cleanSender, gerarTabelaCompactaSms());
        return;
    }

    // ── 2. VERIFICAR SE É PEDIDO DE PAGAMENTO ──
    const ehPagamento = [
        '2', 'pagamento', 'pagamentos', 'pagar', 'como pagar', 'formas de pagamento',
        'mpesa', 'm-pesa', 'emola', 'e-mola', 'conta', 'contas', 'dados de pagamento'
    ].some(w => cleanText === w || cleanText.startsWith(w + ' ') || cleanText.includes('como pagar') || cleanText.includes('formas de pagamento'));

    if (ehPagamento) {
        console.log(`💳 [SMS BOT] Enviando formas de pagamento para ${cleanSender}`);
        await sendSms(cleanSender, gerarPagamentoCompactaSms());
        return;
    }

    // ── 3. VERIFICAR SE É PEDIDO DE SUPORTE ──
    const ehSuporte = [
        '3', 'suporte', 'ajuda', 'socorro', 'contato', 'contacto', 'admin', 'humano'
    ].some(w => cleanText === w || cleanText.startsWith(w + ' ') || cleanText.includes('falar com'));

    if (ehSuporte) {
        console.log(`📞 [SMS BOT] Enviando suporte para ${cleanSender}`);
        await sendSms(cleanSender, gerarSuporteCompactaSms());
        return;
    }

    // ── 4. DETECTAR SE É UM COMPROVATIVO ENCAMINHADO PELO CLIENTE ──
    const isComprovativo = (
        cleanText.includes('confirmado') ||
        cleanText.includes('transferiste') ||
        cleanText.includes('recebeste') ||
        cleanText.includes('recebeu') ||
        cleanText.includes('transacao') ||
        cleanText.includes('transação') ||
        cleanText.includes('id da transacao') ||
        cleanText.includes('id trans') ||
        cleanText.includes('m-pesa') ||
        cleanText.includes('emola')
    );

    if (isComprovativo) {
        const txnId = extrairTxnId(text);
        const valor = extrairValor(text);
        const numDestino = extrairNumeroDestino(text, cleanSender);

        if (!txnId || !valor) {
            await sendSms(cleanSender, "Ka-Net: Não conseguimos ler o código da transação ou o valor do comprovativo. Por favor, reenvie o SMS original completo da operadora.");
            return;
        }

        console.log(`💳 [SMS COMPROVATIVO DETECTADO] Ref=${txnId} | ${valor} MT | Destino=${numDestino || cleanSender}`);

        // Anti-duplicação
        if (smsTransacoesProcessadas.has(txnId)) {
            await sendSms(cleanSender, `Ka-Net: O comprovativo ${txnId} já foi utilizado anteriormente no sistema.`);
            return;
        }

        const pacote = buscarPacotePorValor(valor);

        // Se o número de destino não for Vodacom (84/85) e não conseguimos inferir:
        if (!numDestino) {
            await sendSms(cleanSender, `Ka-Net: Identificamos o seu comprovativo ${txnId} (${valor} MT - ${pacote.nome})! Por favor, responda com o seu número Vodacom (84 ou 85) que receberá os megas.`);
            // Salva na fila aguardando número
            smsAguardandoOperadora.set(txnId, {
                txn_id: txnId,
                valor,
                senderPhone: cleanSender,
                numDestino: null,
                pacote,
                timestamp: Date.now()
            });
            return;
        }

        // VERIFICAR SE O SMS OFICIAL DA OPERADORA JÁ FOI RECEBIDO
        const operadoraJaConfirmou = inMemoryPayments && inMemoryPayments.has(txnId);

        if (operadoraJaConfirmou) {
            // OPERADORA JÁ CONFIRMOU! Ativar imediatamente!
            await ativarPedidoSms({ txnId, valor, numDestino, senderPhone: cleanSender, pacote });
        } else {
            // AGUARDANDO CONFIRMAÇÃO DA OPERADORA
            console.log(`⏳ [SMS BOT] Comprovativo ${txnId} aguardando SMS da operadora...`);
            smsAguardandoOperadora.set(txnId, {
                txn_id: txnId,
                valor,
                senderPhone: cleanSender,
                numDestino,
                pacote,
                timestamp: Date.now()
            });

            // Timer de expiração de 2 minutos
            setTimeout(async () => {
                if (smsAguardandoOperadora.has(txnId)) {
                    smsAguardandoOperadora.delete(txnId);
                    const { supportNum } = getSuporteDetails();
                    await sendSms(cleanSender, `⚠️ Ka-Net: O comprovativo ${txnId} (${valor} MT) ainda não foi confirmado pela operadora após 2 minutos. Se o valor já saiu da conta, envie o extrato ao suporte: ${supportNum}.`);
                }
            }, 120000);

            // Avisar o cliente que estamos aguardando a rede
            await sendSms(cleanSender, `⏳ Ka-Net: Comprovativo ${txnId} (${valor} MT) recebido! A verificar com a rede para ativar ${pacote.nome} no número ${numDestino}.`);
        }
        return;
    }

    // ── 5. SE ESTIVER AGUARDANDO NÚMERO DE UM COMPROVATIVO ANTERIOR ──
    for (const [txnId, item] of smsAguardandoOperadora.entries()) {
        if (item.senderPhone === cleanSender && !item.numDestino) {
            const numDetectado = extrairNumeroDestino(text, cleanSender);
            if (numDetectado) {
                item.numDestino = numDetectado;
                console.log(`📲 [SMS BOT] Número ${numDetectado} vinculado ao comprovativo ${txnId}`);
                await sendSms(cleanSender, `Ka-Net: Número ${numDetectado} registado! Assim que a operadora confirmar os ${item.valor} MT, o pacote ${item.pacote.nome} será ativado.`);
                return;
            }
        }
    }

    // ── 6. MENSAGEM PADRÃO / SAUDAÇÃO ──
    console.log(`👋 [SMS BOT] Enviando boas-vindas padrão para ${cleanSender}`);
    await sendSms(cleanSender, gerarBoasVindasSms());
}

/**
 * Ativa o pedido e despacha para a fila USSD
 */
async function ativarPedidoSms({ txnId, valor, numDestino, senderPhone, pacote }) {
    smsTransacoesProcessadas.add(txnId);
    const orderId = `SMS-${txnId}-${Date.now()}`;

    console.log(`⚡ [SMS ATIVAÇÃO] Despachando ordem ${orderId}: ${pacote.mb}MB para ${numDestino}`);

    // Avisar o cliente que a ativação iniciou
    await sendSms(senderPhone, `🎉 Ka-Net: Comprovativo validado! A ativar ${pacote.nome} para o número ${numDestino}. Aguarde alguns segundos.`);

    // Se temos dispatcher configurado, enfileirar ordem
    if (dispatchOrderCallback) {
        dispatchOrderCallback({
            orderId,
            id: orderId,
            numero: numDestino,
            quantidade: pacote.mb,
            valor: Number(valor),
            valor_pago: Number(valor),
            modo: pacote.tipo || 'diario',
            remetente: `SMS Bot (${senderPhone})`,
            canalOrigem: 'sms',
            clientPhone: senderPhone,
            txn_id: txnId,
            status: 'pending',
            createdAt: new Date().toISOString()
        });
    }
}

/**
 * Chamado quando a operadora envia o SMS de confirmação (M-Pesa / e-Mola)
 * Verifica se algum cliente de SMS estava aguardando
 */
async function onOperadoraSmsPaymentReceived({ txn_id, valor }) {
    if (!txn_id) return;
    const cleanTxnId = String(txn_id).trim().toUpperCase();

    if (smsAguardandoOperadora.has(cleanTxnId)) {
        const item = smsAguardandoOperadora.get(cleanTxnId);
        smsAguardandoOperadora.delete(cleanTxnId);

        console.log(`🎉 [SMS OPERADORA VALIDOU] Pedido SMS com ref ${cleanTxnId} confirmado pela rede!`);
        if (item.numDestino) {
            await ativarPedidoSms({
                txnId: cleanTxnId,
                valor: item.valor,
                numDestino: item.numDestino,
                senderPhone: item.senderPhone,
                pacote: item.pacote
            });
        }
    }
}

/**
 * Notifica o cliente via SMS quando a recarga for concluída com sucesso
 */
async function notifyOrderCompleted(order) {
    if (!order || order.canalOrigem !== 'sms') return;
    const targetPhone = order.clientPhone || order.numero;
    if (!targetPhone) return;

    const mb = order.quantidade || 0;
    const num = order.numero;
    const ref = order.txn_id || order.orderId;

    const msg = `✅ Ka-Net: O seu pacote de ${mb >= 1024 ? (mb/1024).toFixed(1) + 'GB' : mb + 'MB'} foi ativado com SUCESSO no número ${num}!\nRef: ${ref}.\nObrigado pela preferência! Volte sempre!`;
    await sendSms(targetPhone, msg);
}

module.exports = {
    processIncomingCustomerSms,
    onOperadoraSmsPaymentReceived,
    notifyOrderCompleted,
    setOrderDispatcher,
    sendSms,
    getNextPendingSms,
    confirmSmsSent,
    pendingOutgoingSms,
    gerarTabelaCompactaSms,
    gerarPagamentoCompactaSms,
    gerarSuporteCompactaSms
};
