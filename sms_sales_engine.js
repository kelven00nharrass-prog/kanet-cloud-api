/**
 * ==============================================================================
 * KA-NET SMS SALES ENGINE (BOT DE ATENDIMENTO E VENDAS AUTOMÁTICAS POR SMS)
 * ==============================================================================
 * Funciona de forma equivalente ao bot do WhatsApp, porém otimizado para SMS GSM:
 * 1. Pedido de Comprovativo: Detecta transações M-Pesa / e-Mola primeiro
 * 2. Pedido de Formas de Pagamento: Envia números M-Pesa e e-Mola + instruções
 * 3. Pedido de Tabela: Envia tabela formatada e compacta de Diários, Semanais e Mensais
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
const smsAguardandoOperadora = new Map();
// Histórico de transações processadas por SMS para evitar duplicações
const smsTransacoesProcessadas = new Set();
// Cache de deduplicação de mensagens de entrada recentes (remetente_texto -> timestamp)
const recentIncomingSmsCache = new Map();

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
    let supportNum = '850401416';
    if (LOCAL_CFG.support_number) {
        supportNum = String(LOCAL_CFG.support_number).split(',')[0].trim();
    } else if (LOCAL_CFG.master_number) {
        supportNum = String(LOCAL_CFG.master_number).split(',')[0].trim();
    }
    const sysName = LOCAL_CFG.nome_sistema || 'Ka-Net';
    return { supportNum, sysName };
}

// Fila em memória de SMS pendentes para o Gateway Android coletar e enviar
const pendingOutgoingSms = [];

/**
 * Retorna o próximo SMS pendente para envio pelo Gateway Android
 * Dá prioridade a mensagens destinadas à porta que solicitou (forPort)
 * Se for mensagem genérica, entrega APENAS a portas com capacidade de SMS (isSmsCapable)
 */
function getNextPendingSms(forPort = null, isSmsCapable = true) {
    const now = Date.now();
    // Limpar mensagens com mais de 10 minutos
    for (let i = pendingOutgoingSms.length - 1; i >= 0; i--) {
        if (now - pendingOutgoingSms[i].createdAt > 10 * 60 * 1000) {
            pendingOutgoingSms.splice(i, 1);
        }
    }
    
    if (pendingOutgoingSms.length === 0) return null;

    const p = forPort ? Number(forPort) : null;
    let idx = -1;

    if (p) {
        // Procurar por SMS especificamente destinado a esta porta
        idx = pendingOutgoingSms.findIndex(item => item.targetPort && Number(item.targetPort) === p);
        // Se não houver específico, pegar um genérico APENAS se esta porta puder enviar SMS!
        if (idx === -1 && isSmsCapable) {
            idx = pendingOutgoingSms.findIndex(item => !item.targetPort);
        }
    } else if (isSmsCapable) {
        idx = 0;
    }

    if (idx !== -1) {
        const item = pendingOutgoingSms.splice(idx, 1)[0];
        console.log(`📤 [SMS ENGINE DISPATCHED] SMS ${item.id} entregue ao celular Porta ${p || 'qualquer'} para ${item.numero}`);
        return {
            id: item.id,
            numero: item.numero,
            mensagem: item.mensagem,
            sim_slot: item.sim_slot !== undefined ? item.sim_slot : 0
        };
    }
    return null;
}

/**
 * Confirmação de envio recebida do Gateway Android (Mantida para compatibilidade/logs)
 */
function confirmSmsSent(smsId, success = true, error = null) {
    console.log(`✉️ [SMS ENGINE CONFIRMADO] Status do SMS ${smsId}: ${success ? 'SUCESSO' : 'FALHA (' + error + ')'}`);
    return true;
}

/**
 * Envia SMS para o cliente usando a Porta do Gateway Android
 * Tenta disparo direto via HTTP local se a porta for informada
 */
async function sendSms(destinatario, mensagem, simSlot = 0, targetPort = null) {
    const cleanNum = String(destinatario).trim();
    const cleanMsg = String(mensagem).trim();
    const smsId = 'SMS-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7);

    const smsItem = {
        id: smsId,
        numero: cleanNum,
        mensagem: cleanMsg,
        sim_slot: simSlot !== undefined ? Number(simSlot) : 0,
        targetPort: targetPort ? Number(targetPort) : null,
        createdAt: Date.now()
    };

    // 1. Tentar envio direto HTTP se a porta estiver disponível localmente
    const directPort = targetPort || process.env.SMS_GATEWAY_PORT;
    const directHost = process.env.SMS_GATEWAY_HOST || '127.0.0.1';
    if (directPort) {
        try {
            const response = await axios.post(`http://${directHost}:${directPort}/sms/send`, {
                numero: cleanNum,
                mensagem: cleanMsg,
                sim_slot: smsItem.sim_slot
            }, { timeout: 3500 });
            console.log(`📱 [SMS ENGINE ENVIADO DIRETO] Porta ${directPort} -> ${cleanNum}`);
            return response.data;
        } catch (err) {
            console.log(`ℹ️ [SMS ENGINE] Envio direto HTTP falhou na porta ${directPort} (${err.message}). Adicionando à fila para coleta pelo celular.`);
        }
    }

    // 2. Colocar na fila em Nuvem para o Gateway Android coletar via /api/devices/:port/health
    pendingOutgoingSms.push(smsItem);
    console.log(`📥 [SMS ENGINE FILA] SMS ${smsId} enfileirado para ${cleanNum} (Porta Alvo: ${targetPort || 'Qualquer'}, ${pendingOutgoingSms.length} na fila)`);
    return { success: true, queued: true, id: smsId };
}

/**
 * Gera Tabela formatada em texto puro GSM para SMS (Sem emojis para evitar UCS-2 e falhas na rede)
 */
function gerarTabelaCompactaSms() {
    carregarConfigs();
    const tabelas = DYN_CFG.TABELAS || {};
    let msg = "Ka-Net - TABELA DE PACOTES:\n\n";

    // DIÁRIOS
    if (tabelas['24hrs'] && Object.keys(tabelas['24hrs']).length > 0) {
        msg += "DIARIOS (24H):\n";
        const entries = Object.entries(tabelas['24hrs']).sort((a, b) => Number(a[0]) - Number(b[0]));
        for (const [preco, item] of entries) {
            const nome = item.nome ? item.nome.replace('24h', '').trim() : `${item.quantidade_mb || item.quantidade}MB`;
            msg += `- ${nome}: ${preco} MT\n`;
        }
        msg += "\n";
    }

    // SEMANAIS
    if (tabelas['semanal'] && Object.keys(tabelas['semanal']).length > 0) {
        msg += "SEMANAIS (7 Dias):\n";
        const entries = Object.entries(tabelas['semanal']).sort((a, b) => Number(a[0]) - Number(b[0]));
        for (const [preco, item] of entries) {
            const nome = item.nome ? item.nome.replace('7 Dias', '').trim() : `${item.quantidade_mb || item.quantidade}MB`;
            msg += `- ${nome}: ${preco} MT\n`;
        }
        msg += "\n";
    }

    // MENSAIS
    if (tabelas['mensal'] && Object.keys(tabelas['mensal']).length > 0) {
        msg += "MENSAIS (30 Dias):\n";
        const entries = Object.entries(tabelas['mensal']).sort((a, b) => Number(a[0]) - Number(b[0]));
        for (const [preco, item] of entries) {
            const nome = item.nome ? item.nome.replace('Mensal', '').trim() : `${item.quantidade_mb || item.quantidade}MB`;
            msg += `- ${nome}: ${preco} MT\n`;
        }
        msg += "\n";
    }

    msg += "Pague via M-Pesa ou e-Mola e reenvie aqui o comprovativo com o seu numero Vodacom para ativar!";
    return msg;
}

/**
 * Gera Mensagem de Formas de Pagamento em texto puro GSM
 */
function gerarPagamentoCompactaSms() {
    const { mpesa_num, mpesa_name, emola_num, emola_name } = getPaymentDetails();
    return `Ka-Net - FORMAS DE PAGAMENTO:

- M-PESA: ${mpesa_num} (${mpesa_name})
- E-MOLA: ${emola_num} (${emola_name})

Como comprar:
1. Envie o valor do pacote para uma das contas acima.
2. Encaminhe o SMS do comprovativo para este numero.
3. Se o numero for diferente, escreva o numero no SMS.
Ativacao imediata 24h!`;
}

/**
 * Gera Mensagem de Suporte para SMS em texto puro GSM
 */
function gerarSuporteCompactaSms() {
    const { supportNum, sysName } = getSuporteDetails();
    return `${sysName} - SUPORTE E ATENDIMENTO:

Para assistencia ou duvidas sobre recargas, ligue ou envie WhatsApp para:
Tel: ${supportNum}
Atendimento: 24h / 7 dias por semana.`;
}

/**
 * Gera Mensagem de Boas-Vindas em texto puro GSM (compatível com todos celulares)
 */
function gerarBoasVindasSms() {
    const { sysName } = getSuporteDetails();
    return `Ola! Bem-vindo ao atendimento automatico da ${sysName}.

Responda com uma opcao:
1 - Formas de Pagamento
2 - Tabela de Precos e Pacotes
3 - Suporte

Se ja pagou, reenvie o comprovativo da operadora para ativar!`;
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
 * NÚMEROS DE SISTEMA / CONTA QUE NUNCA DEVEM SER CONSIDERADOS COMO DESTINO DOS MEGAS
 */
const SYSTEM_PAYMENT_NUMBERS = new Set([
    '856268811', '864882152', '856116039', '84100', '86100', '82100', '87100', '4004',
    '258856268811', '258864882152', '258856116039'
]);

/**
/**
 * Extrai número de destino Vodacom (84/85) do texto do cliente.
 * ⚠️ NÃO extrai números do miolo do comprovativo M-Pesa/e-Mola (como "de 25884...")
 * ⚠️ NÃO faz fallback automático para o remetente, forçando o bot a perguntar o número ao cliente.
 */
function extrairNumeroDestino(texto, remetenteOrigem) {
    if (!texto) return null;
    const cleanText = String(texto).trim();

    // 1. Se a mensagem for exatamente um número de telefone Vodacom
    const digitsOnly = cleanText.replace(/\D/g, '');
    if (/^(?:258)?(8[45]\d{7})$/.test(digitsOnly)) {
        const candidate = digitsOnly.slice(-9);
        if (!SYSTEM_PAYMENT_NUMBERS.has(candidate)) {
            return candidate;
        }
        return null;
    }

    // 2. Verificar se há um comando explícito: "para 84...", "numero: 84...", "recarga para 84..."
    const explicitMatch = cleanText.match(/(?:para|numero|número|destinatario|destinatário|enviar\s+para|recarga\s+para|destino)\s*[:.]?\s*(?:258)?(8[45]\s*\d[\d\s-]{6,8}\d)/i);
    if (explicitMatch && explicitMatch[1]) {
        const candidate = explicitMatch[1].replace(/\D/g, '').slice(-9);
        if (candidate.length === 9 && (candidate.startsWith('84') || candidate.startsWith('85')) && !SYSTEM_PAYMENT_NUMBERS.has(candidate)) {
            return candidate;
        }
    }

    // 3. Se for mensagem com comprovativo, procurar por linha separada com o número
    const lines = cleanText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length >= 2) {
        for (let i = lines.length - 1; i >= 1; i--) {
            const l = lines[i];
            // Ignorar linhas típicas de recibo
            if (/(?:confirmado|transferiste|recebeste|recebeu|transferiu|saldo|taxa foi|liga 100|m-pesa|e-mola|vodacom|movitel|em caso de duvida)/i.test(l)) {
                continue;
            }
            const lDigits = l.replace(/\D/g, '');
            if (/^(?:258)?(8[45]\d{7})$/.test(lDigits)) {
                const candidate = lDigits.slice(-9);
                if (!SYSTEM_PAYMENT_NUMBERS.has(candidate)) {
                    return candidate;
                }
            }
        }
    }

    // 4. NUNCA assumir o remetente automaticamente — retornar null para forçar o bot a pedir o número
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
async function processIncomingCustomerSms({ sender, body, inMemoryPayments, port = null, simSlot = 0 }) {
    if (!sender || !body) return;
    const cleanSender = String(sender).replace(/\D/g, '').slice(-9);
    
    // Ignorar remetentes que não sejam números de celulares moçambicanos de clientes (82, 83, 84, 85, 86, 87)
    if (!cleanSender || cleanSender.length !== 9 || !/^8[2-7]\d{7}$/.test(cleanSender)) {
        console.log(`ℹ️ [SMS BOT] Mensagem de operadora/sistema ignorada pelo bot de clientes: "${sender}"`);
        return;
    }

    const text = String(body).trim();
    const cleanText = text.toLowerCase();

    // Deduplicação anti-loop
    const dedupKey = `${cleanSender}_${cleanText.slice(0, 35)}`;
    const now = Date.now();
    if (recentIncomingSmsCache.has(dedupKey) && (now - recentIncomingSmsCache.get(dedupKey)) < 8000) {
        console.log(`🛡️ [SMS BOT DEDUP] Ignorando SMS duplicado recente de ${cleanSender}`);
        return;
    }
    recentIncomingSmsCache.set(dedupKey, now);

    console.log(`📩 [SMS BOT] Mensagem de ${cleanSender} (Porta ${port || 'Auto'}, SIM ${simSlot + 1}): "${text.slice(0, 80)}"`);

    // ── 1. DETECTAR SE É UM COMPROVATIVO ENCAMINHADO PELO CLIENTE (PRIMEIRA PRIORIDADE!) ──
    const isComprovativo = (
        cleanText.includes('confirmado') ||
        cleanText.includes('transferiste') ||
        cleanText.includes('recebeste') ||
        cleanText.includes('recebeu') ||
        cleanText.includes('transacao') ||
        cleanText.includes('transação') ||
        cleanText.includes('id da transacao') ||
        cleanText.includes('id trans') ||
        cleanText.includes('pp2') ||
        (cleanText.includes('m-pesa') && (cleanText.includes('mzn') || cleanText.includes('mt'))) ||
        (cleanText.includes('emola') && (cleanText.includes('mzn') || cleanText.includes('mt')))
    );

    if (isComprovativo) {
        const txnId = extrairTxnId(text);
        const valor = extrairValor(text);
        const numDestino = extrairNumeroDestino(text, cleanSender);

        if (!txnId || !valor) {
            await sendSms(cleanSender, "Ka-Net: Nao conseguimos ler o codigo da transacao ou o valor do comprovativo. Por favor, reenvie o SMS original completo da operadora.", simSlot, port);
            return;
        }

        console.log(`💳 [SMS COMPROVATIVO DETECTADO] Ref=${txnId} | ${valor} MT | Destino=${numDestino || 'Aguardando Vodacom'}`);

        // Anti-duplicação
        if (smsTransacoesProcessadas.has(txnId)) {
            await sendSms(cleanSender, `Ka-Net: O comprovativo ${txnId} ja foi utilizado anteriormente no sistema.`, simSlot, port);
            return;
        }

        const pacote = buscarPacotePorValor(valor);

        // Se o número de destino não for Vodacom (84/85) e não conseguimos extrair no texto:
        if (!numDestino) {
            await sendSms(cleanSender, `Ka-Net: Identificamos o seu comprovativo ${txnId} (${valor} MT - ${pacote.nome})! Por favor, responda com o seu numero Vodacom (84 ou 85) que recebera os megas.`, simSlot, port);
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
                    await sendSms(cleanSender, `Ka-Net: O comprovativo ${txnId} (${valor} MT) ainda nao foi confirmado pela operadora apos 2 minutos. Se o valor ja saiu da conta, envie o extrato ao suporte: ${supportNum}.`, simSlot, port);
                }
            }, 120000);

            // Avisar o cliente que estamos aguardando a rede
            await sendSms(cleanSender, `Ka-Net: Comprovativo ${txnId} (${valor} MT) recebido! A verificar com a rede para ativar ${pacote.nome} no numero ${numDestino}.`, simSlot, port);
        }
        return;
    }

    // ── 2. VERIFICAR SE É PEDIDO DE FORMAS DE PAGAMENTO ──
    const ehPagamento = [
        '1', 'pagamento', 'pagamentos', 'pagar', 'como pagar', 'formas de pagamento',
        'mpesa', 'm-pesa', 'emola', 'e-mola', 'conta', 'contas', 'dados de pagamento'
    ].some(w => cleanText === w || cleanText.startsWith(w + ' ') || cleanText.includes('pagamento') || cleanText.includes('como pagar') || cleanText.includes('formas de pagamento'));

    if (ehPagamento) {
        console.log(`💳 [SMS BOT] Enviando formas de pagamento para ${cleanSender} via Porta ${port || 'Auto'}`);
        await sendSms(cleanSender, gerarPagamentoCompactaSms(), simSlot, port);
        return;
    }

    // ── 3. VERIFICAR SE É PEDIDO DE TABELA ──
    const ehTabela = [
        '2', 'tabela', 'tabelas', 'preco', 'precos', 'preço', 'preços', 'pacote', 'pacotes',
        'valores', 'megas', 'gigas', 'comprar', 'planos'
    ].some(w => cleanText === w || cleanText.startsWith(w + ' ') || cleanText.includes('manda tabela') || cleanText.includes('quero megas') || cleanText.includes('ver tabela')) && !cleanText.includes('pagam');

    if (ehTabela) {
        console.log(`📋 [SMS BOT] Enviando tabela para ${cleanSender} via Porta ${port || 'Auto'}`);
        await sendSms(cleanSender, gerarTabelaCompactaSms(), simSlot, port);
        return;
    }

    // ── 4. VERIFICAR SE É PEDIDO DE SUPORTE ──
    const ehSuporte = [
        '3', 'suporte', 'ajuda', 'socorro', 'contato', 'contacto', 'admin', 'humano'
    ].some(w => cleanText === w || cleanText.startsWith(w + ' ') || cleanText.includes('falar com'));

    if (ehSuporte) {
        console.log(`📞 [SMS BOT] Enviando suporte para ${cleanSender} via Porta ${port || 'Auto'}`);
        await sendSms(cleanSender, gerarSuporteCompactaSms(), simSlot, port);
        return;
    }

    // ── 5. SE ESTIVER AGUARDANDO NÚMERO DE UM COMPROVATIVO ANTERIOR ──
    for (const [txnId, item] of smsAguardandoOperadora.entries()) {
        if (item.senderPhone === cleanSender && !item.numDestino) {
            const numDetectado = extrairNumeroDestino(text, cleanSender);
            if (numDetectado) {
                item.numDestino = numDetectado;
                console.log(`📲 [SMS BOT] Número ${numDetectado} vinculado ao comprovativo ${txnId}`);
                await sendSms(cleanSender, `Ka-Net: Numero ${numDetectado} registado! Assim que a operadora confirmar os ${item.valor} MT, o pacote ${item.pacote.nome} sera ativado.`, simSlot, port);
                
                // Se a operadora já tiver confirmado enquanto aguardava número
                if (inMemoryPayments && inMemoryPayments.has(txnId)) {
                    smsAguardandoOperadora.delete(txnId);
                    await ativarPedidoSms({
                        txnId,
                        valor: item.valor,
                        numDestino: item.numDestino,
                        senderPhone: cleanSender,
                        pacote: item.pacote
                    });
                }
                return;
            }
        }
    }

    // ── 6. MENSAGEM PADRÃO / SAUDAÇÃO ──
    console.log(`👋 [SMS BOT] Enviando boas-vindas padrão para ${cleanSender} via Porta ${port || 'Auto'}`);
    await sendSms(cleanSender, gerarBoasVindasSms(), simSlot, port);
}

/**
 * Ativa o pedido e despacha para a fila USSD
 */
async function ativarPedidoSms({ txnId, valor, numDestino, senderPhone, pacote }) {
    smsTransacoesProcessadas.add(txnId);
    const orderId = `SMS-${txnId}-${Date.now()}`;

    console.log(`⚡ [SMS ATIVAÇÃO] Despachando ordem ${orderId}: ${pacote.mb}MB para ${numDestino}`);

    // Avisar o cliente que a ativação iniciou (usando porta 8077 dedicada de SMS)
    await sendSms(senderPhone, `🎉 Ka-Net: Comprovativo validado! A ativar ${pacote.nome} para o número ${numDestino}. Aguarde alguns segundos.`, 0, 8077);

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
    const targetPort = order.targetPort || order.assignedToPort || 8077;

    const msg = `✅ Ka-Net: O seu pacote de ${mb >= 1024 ? (mb/1024).toFixed(1) + 'GB' : mb + 'MB'} foi ativado com SUCESSO no número ${num}!\nRef: ${ref}.\nObrigado pela preferência! Volte sempre!`;
    await sendSms(targetPhone, msg, 0, targetPort);
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
