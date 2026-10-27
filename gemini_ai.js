/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  Ka-Net Gemini AI Module                                     ║
 * ║  - Feature 2: Vision — leitura de prints M-Pesa / e-Mola    ║
 * ║  - Feature 3: Audio  — transcrição de mensagens de voz      ║
 * ║  - Feature 4: Brain  — chat em linguagem moçambicana         ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

require('dotenv').config();
const axios = require('axios');

function getApiKey() {
    return (process.env.GEMINI_API_KEY || process.env.Geminiai || process.env.geminiai || process.env.GEMINI_KEY || process.env.GEMINI_AI || '').trim();
}
 
const GEMINI_BASE    = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL  = 'gemini-3.8-flash';
const FALLBACK_MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-flash-latest'];

const VISION_MODEL   = DEFAULT_MODEL;
const AUDIO_MODEL    = DEFAULT_MODEL;
const CHAT_MODEL     = DEFAULT_MODEL;

// ── Cache de conversas por número (Cérebro Gemini) ──────────────
const conversationHistory = new Map(); // numero → [{role, parts}]
const MAX_HISTORY = 20; // Máximo de turnos por conversa

// ────────────────────────────────────────────────────────────────
// UTILITÁRIOS
// ────────────────────────────────────────────────────────────────
function isConfigured() {
    return getApiKey().length > 15;
}

function sanitizeMimeType(mime, defaultType = 'audio/ogg') {
    if (!mime) return defaultType;
    const clean = String(mime).split(';')[0].trim().toLowerCase();
    if (clean === 'audio/ogg' || clean === 'audio/opus') return 'audio/ogg';
    if (clean.includes('mp4') || clean.includes('m4a')) return 'audio/mp4';
    if (clean.includes('mpeg') || clean.includes('mp3')) return 'audio/mp3';
    if (clean.includes('wav')) return 'audio/wav';
    if (clean.includes('jpeg') || clean.includes('jpg')) return 'image/jpeg';
    if (clean.includes('png')) return 'image/png';
    if (clean.includes('webp')) return 'image/webp';
    if (clean.includes('pdf')) return 'application/pdf';
    return clean || defaultType;
}

async function callGemini(model, payload, timeout = 30000) {
    const key = getApiKey();
    if (!key) {
        throw new Error('GEMINI_API_KEY não configurada');
    }

    const candidateModels = [model, ...FALLBACK_MODELS.filter(m => m !== model)];
    let lastErr = null;

    for (const m of candidateModels) {
        try {
            const url = `${GEMINI_BASE}/models/${m}:generateContent?key=${key}`;
            const res = await axios.post(url, payload, {
                timeout,
                headers: { 'Content-Type': 'application/json' }
            });
            const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) return text;
        } catch (err) {
            lastErr = err;
            const status = err.response?.status;
            // Se for 404 (modelo não existe) ou 503 (sobrecarregado) ou 429, tenta o próximo modelo
            if (status === 404 || status === 503 || status === 429) {
                console.warn(`⚠️ [GEMINI] Modelo ${m} retornou ${status}. Tentando modelo alternativo...`);
                continue;
            }
            throw err;
        }
    }
    throw lastErr || new Error('Nenhum modelo Gemini respondeu');
}

// ────────────────────────────────────────────────────────────────
// FEATURE 2: VISÃO — Leitura de Prints de Pagamento
// ────────────────────────────────────────────────────────────────
/**
 * Analisa um print de M-Pesa ou e-Mola e extrai os dados de pagamento.
 * @param {Buffer} imageBuffer - Buffer da imagem
 * @param {string} mimeType - MIME type (image/jpeg, image/png, etc.)
 * @returns {Object|null} - { valido, txnId, valor, remetente, para, servico, data } ou null
 */
async function analisarPrintPagamento(imageBuffer, mimeType = 'image/jpeg') {
    if (!isConfigured()) return null;

    const base64 = imageBuffer.toString('base64');

    const prompt = `Analisa esta imagem. Pode ser um SMS, screenshot de conversa WhatsApp ou print de ecra de Mocambique.

OBJETIVO: Identificar se contem um comprovativo legitimo de transferencia de dinheiro (meticais) via M-Pesa (Vodacom) ou e-Mola (Movitel).

VALIDO - aceitar (valido: true):
- SMS da M-Pesa com texto como: "Confirmado XXXXX. Transferiste X.00MT e a taxa foi de X.00MT para XXXXXXXX"
- SMS da e-Mola com texto de transferencia de meticais
- Screenshot de conversa WhatsApp onde o cliente encaminhou (forward) o SMS da operadora (o SMS aparece dentro de uma bolha de mensagem)
- Qualquer valor e valido (1MT, 29MT, 500MT, etc.)
- DICA CHAVE: Se o texto contiver "Confirmado" + codigo alfanumerico + "Transferiste" + valor MT, e SEMPRE M-Pesa valida!

NAO VALIDO - rejeitar (valido: false):
- Transferencias de saldo de voz/credito telefonico (nao meticais)
- Comprovantes bancarios (BIM, BCI, Standard Bank, etc.)
- Txuna, Mkesh ou outros sistemas que nao sejam M-Pesa/e-Mola
- Imagens sem texto de pagamento

Responde APENAS com JSON valido, sem markdown:
{
  "valido": true ou false,
  "servico": "M-Pesa" ou "e-Mola",
  "txnId": "codigo da transacao (ex: DJL0M0XM8GO, ABC12345678)",
  "valor": numero em meticais sem unidade (ex: 29 ou 150),
  "remetente": "nome ou numero de quem enviou",
  "para": "nome ou numero de quem recebeu",
  "data": "data/hora se visivel",
  "tipo": "Transferencia M-Pesa" ou "Transferencia e-Mola",
  "raw_text": "todo o texto legivel na imagem",
  "confianca": "alta" ou "media" ou "baixa"
}

Se nao for pagamento M-Pesa/e-Mola valido, retorna: {"valido": false, "motivo": "descricao breve"}`;

    const cleanMime = sanitizeMimeType(mimeType, 'image/jpeg');

    try {
        const payload = {
            contents: [{
                role: 'user',
                parts: [
                    { inlineData: { mimeType: cleanMime, data: base64 } },
                    { text: prompt }
                ]
            }],
            generationConfig: {
                temperature: 0.1,
                maxOutputTokens: 1024
            }
        };

        const text = await callGemini(VISION_MODEL, payload, 45000);

        // Extrai JSON da resposta
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return { valido: false, motivo: 'resposta inválida da IA' };

        const result = JSON.parse(jsonMatch[0]);
        return result;
    } catch (err) {
        console.error('❌ [GEMINI VISION] Erro:', err.message);
        return null;
    }
}

// ────────────────────────────────────────────────────────────────
// FEATURE 2b: PDF — Leitura de Documentos de Pagamento
// ────────────────────────────────────────────────────────────────
/**
 * Analisa um documento PDF enviado pelo cliente e tenta extrair dados de pagamento.
 * Suporta comprovativos de M-Pesa, e-Mola e recibos bancários.
 * @param {Buffer} pdfBuffer - Buffer do ficheiro PDF
 * @returns {Object|null} - { valido, txnId, valor, remetente, para, servico, data, raw_text } ou null
 */
async function analisarDocumentoPDF(pdfBuffer) {
    if (!isConfigured()) return null;

    const base64 = pdfBuffer.toString('base64');

    const prompt = `Analisa este documento PDF de Moçambique.
REGRA OBRIGATÓRIA: APENAS comprovativos legítimos de M-Pesa (Vodacom) ou e-Mola (Movitel) são válidos!
Bancos (BIM, BCI, etc.), faturas, transferências de saldo ou outros documentos NÃO SÃO VÁLIDOS (devem ter "valido": false).

Extrai os seguintes dados SE for M-Pesa ou e-Mola (responde APENAS com JSON válido, sem markdown):
{
  "valido": true/false,
  "servico": "M-Pesa" ou "e-Mola",
  "txnId": "ID da transação (ex: ABC12345678 ou PP...)",
  "valor": número em meticais (ex: 150),
  "remetente": "nome ou número de quem enviou",
  "para": "nome ou número de quem recebeu",
  "data": "data/hora da transação se visível",
  "tipo": "Transferência M-Pesa" ou "Transferência e-Mola",
  "raw_text": "todo o texto relevante do documento",
  "confianca": "alta" ou "media" ou "baixa"
}

Se não for M-Pesa ou e-Mola, retorna: {"valido": false, "motivo": "apenas comprovativos M-Pesa e e-Mola são aceitos"}`;

    try {
        const payload = {
            contents: [{
                role: 'user',
                parts: [
                    { inlineData: { mimeType: 'application/pdf', data: base64 } },
                    { text: prompt }
                ]
            }],
            generationConfig: {
                temperature: 0.1,
                maxOutputTokens: 1024
            }
        };

        const text = await callGemini(VISION_MODEL, payload, 60000);

        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return { valido: false, motivo: 'resposta inválida da IA' };

        const result = JSON.parse(jsonMatch[0]);
        return result;
    } catch (err) {
        console.error('❌ [GEMINI PDF] Erro:', err.message);
        return null;
    }
}

// ────────────────────────────────────────────────────────────────
// FEATURE 3: ÁUDIO — Transcrição de Mensagens de Voz
// ────────────────────────────────────────────────────────────────
/**
 * Transcreve uma mensagem de áudio e extrai intenção (compra, número, etc).
 * @param {Buffer} audioBuffer - Buffer do áudio
 * @param {string} mimeType - MIME type (audio/ogg; codecs=opus, audio/mp4, etc.)
 * @returns {Object} - { transcricao, intencao, numero, valor, idioma }
 */
async function transcreverAudio(audioBuffer, mimeType = 'audio/ogg; codecs=opus') {
    if (!isConfigured()) return null;

    const base64 = audioBuffer.toString('base64');
    const cleanMime = sanitizeMimeType(mimeType, 'audio/ogg');

    const prompt = `Transcreve esta mensagem de voz em português moçambicano.

Depois de transcrever, identifica:
1. O que o cliente quer? (comprar pacote / verificar saldo / suporte / outro)
2. O número de destino mencionado (se dito)
3. O valor ou tipo de pacote mencionado (se dito)

Responde APENAS em JSON (sem markdown):
{
  "transcricao": "texto completo do que foi dito",
  "intencao": "compra" ou "saldo" ou "suporte" ou "outro",
  "numero_destino": "número mencionado ou null",
  "valor_pedido": número em MT ou null,
  "tipo_pacote": "diario" ou "semanal" ou "mensal" ou null,
  "idioma": "pt" ou "changana" ou "macua" ou "misto",
  "confianca": "alta" ou "media" ou "baixa"
}`;

    try {
        const payload = {
            contents: [{
                role: 'user',
                parts: [
                    { inlineData: { mimeType: cleanMime, data: base64 } },
                    { text: prompt }
                ]
            }],
            generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 1024
            }
        };

        const text = await callGemini(AUDIO_MODEL, payload, 45000);

        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return { transcricao: text, intencao: 'outro' };

        return JSON.parse(jsonMatch[0]);
    } catch (err) {
        console.error('❌ [GEMINI AUDIO] Erro:', err.message);
        return null;
    }
}

// ────────────────────────────────────────────────────────────────
// FEATURE 4: CÉREBRO — Chat em Linguagem Moçambicana
// ────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT_KANET = `És o assistente inteligente do Ka-Net Internet de Moçambique.

PERSONALIDADE:
- Falas português moçambicano informal, caloroso e direto
- Usas emojis de forma moderada
- Entendes gírias: "manda megas", "carrega aí", "tô sem net", "faz o envio", "quanto tá"
- NUNCA respondes como robô. Tens personalidade e simpatia

CONHECIMENTO:
- Vendes dados Vodacom por M-Pesa e e-Mola
- Contas Oficiais de Pagamento:
  * M-Pesa: 856268811 (Kelven Junior)
  * e-Mola: 864882152 (Catia Anabela)
- Status do Sistema: 100% ONLINE e ATIVO 24/7 (nunca digas que estás fechado ou offline a não ser em manutenção expressa)
- Pacotes: Diário (24h), Semanal (7 dias), Mensal (30 dias)
- Para comprar: cliente transfere o valor para o M-Pesa/e-Mola e manda o comprovativo com o número de destino
- Podes calcular pacotes para qualquer valor enviado
- Ativação instantânea em segundos assim que enviar o comprovativo

REGRAS:
- Quando o cliente quiser comprar, recarregar ou pedir megas (seja por voz ou texto): explica o processo e pede SEMPRE que transfira para o M-Pesa/e-Mola e envie a mensagem de confirmação (SMS ou print comprovativo) aqui para ativar.
- Lembra com simpatia: "O robô ativa no mesmo segundo assim que enviares a confirmação da operadora!"
- Nunca inventas preços — só mencionas preços se conheceres a tabela atual
- Se não souberes a resposta, dizes honestamente
- Máximo 3 a 4 linhas por resposta, de forma calorosa e natural
- NÃO usas listas longas — falas de forma direta e moçambicana`;

/**
 * Gera uma resposta inteligente do Cérebro Gemini para o cliente.
 * @param {string} numero - Número do cliente
 * @param {string} mensagem - Mensagem recebida
 * @param {Object} contexto - { tabelaAtual, modoManutencao, nomeCliente }
 * @returns {string} Resposta gerada
 */
async function cerebroGemini(numero, mensagem, contexto = {}) {
    if (!isConfigured()) return null;

    // Gerir histórico
    if (!conversationHistory.has(numero)) {
        conversationHistory.set(numero, []);
    }
    const history = conversationHistory.get(numero);

    // Adiciona mensagem do cliente
    history.push({ role: 'user', parts: [{ text: mensagem }] });

    // Limita histórico
    if (history.length > MAX_HISTORY) {
        history.splice(0, history.length - MAX_HISTORY);
    }

    // Contexto dinâmico
    let systemExtra = SYSTEM_PROMPT_KANET;
    if (contexto.nomeCliente) {
        systemExtra += `\nNome do cliente: ${contexto.nomeCliente}`;
    }
    if (contexto.modoManutencao) {
        systemExtra += `\nIMPORTANTE: Sistema em manutenção — não processa pedidos agora`;
    }

    try {
        const payload = {
            system_instruction: { parts: [{ text: systemExtra }] },
            contents: history,
            generationConfig: {
                temperature: 0.75,
                maxOutputTokens: 512,
                stopSequences: []
            },
            safetySettings: [
                { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' }
            ]
        };

        const resposta = await callGemini(CHAT_MODEL, payload, 30000);

        // Adiciona resposta ao histórico
        history.push({ role: 'model', parts: [{ text: resposta }] });

        return resposta.trim();
    } catch (err) {
        console.error('❌ [GEMINI BRAIN] Erro:', err.message);
        return null;
    }
}

/**
 * Limpa o histórico de conversa de um número (útil após compra concluída)
 */
function limparHistoricoConversa(numero) {
    conversationHistory.delete(numero);
}

/**
 * Verifica se a mensagem parece ser uma pergunta/conversa que não é um comando
 * @param {string} text - Texto limpo da mensagem
 * @returns {boolean}
 */
function isMensagemConversacional(text) {
    const t = text.toLowerCase().trim();

    // Ignorar mensagens muito curtas (números, confirmações)
    if (t.length < 4) return false;

    // Ignorar se parece comprovativo de transação
    if (/^[A-Z]{2,3}\d{6,}/.test(text)) return false;

    // Ignorar comandos do bot
    if (/^\d+$/.test(t)) return false; // só número = input de menu
    if (/^[.!/#]/.test(t)) return false; // começa por . ! / # = comando

    // É conversacional se contiver:
    const gatilhos = [
        /\b(ola|olá|bom dia|boa tarde|boa noite|hi|hello)\b/,
        /\b(quanto|como|quando|qual|onde|porque|porquê|preciso|quero|pode|podes)\b/,
        /\b(megas?|dados?|net|internet|pacote|plano|recarga|gb|mb)\b/,
        /\b(manda|envia|carrega|ativa|recarrega)\b/,
        /\b(tô|tou|estou|tá|está|sem)\b/,
        /\b(ajuda|ajude|me|sim|não|nao)\b/
    ];

    return gatilhos.some(r => r.test(t));
}

module.exports = {
    isConfigured,
    analisarPrintPagamento,
    analisarDocumentoPDF,
    transcreverAudio,
    cerebroGemini,
    limparHistoricoConversa,
    isMensagemConversacional
};
