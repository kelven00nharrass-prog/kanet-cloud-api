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
    return (process.env.GEMINI_API_KEY || '').trim();
}

const GEMINI_BASE    = 'https://generativelanguage.googleapis.com/v1beta';
const VISION_MODEL   = 'gemini-flash-latest';
const AUDIO_MODEL    = 'gemini-flash-latest';
const CHAT_MODEL     = 'gemini-flash-latest';

// ── Cache de conversas por número (Cérebro Gemini) ──────────────
const conversationHistory = new Map(); // numero → [{role, parts}]
const MAX_HISTORY = 20; // Máximo de turnos por conversa

// ────────────────────────────────────────────────────────────────
// UTILITÁRIOS
// ────────────────────────────────────────────────────────────────
function isConfigured() {
    return getApiKey().length > 15;
}

async function callGemini(model, payload, timeout = 30000) {
    const key = getApiKey();
    if (!key) {
        throw new Error('GEMINI_API_KEY não configurada');
    }
    const url = `${GEMINI_BASE}/models/${model}:generateContent?key=${key}`;
    const res = await axios.post(url, payload, {
        timeout,
        headers: { 'Content-Type': 'application/json' }
    });
    return res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
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

    const prompt = `Analisa esta imagem de SMS ou screenshot de M-Pesa ou e-Mola de Moçambique.

Extrai os seguintes dados SE existirem (responde APENAS com JSON válido, sem markdown):
{
  "valido": true/false,
  "servico": "M-Pesa" ou "e-Mola" ou "outro",
  "txnId": "ID da transação (ex: ABC12345678)",
  "valor": número em meticais (ex: 150),
  "remetente": "nome ou número de quem enviou",
  "para": "nome ou número de quem recebeu",
  "data": "data/hora da transação se visível",
  "tipo": "Envio de dinheiro" ou "Recarga" ou "Pagamento" ou "outro",
  "raw_text": "todo o texto que consegues ler na imagem",
  "confianca": "alta" ou "media" ou "baixa"
}

Se não for uma imagem de pagamento, retorna: {"valido": false, "motivo": "não é comprovativo de pagamento"}`;

    try {
        const payload = {
            contents: [{
                role: 'user',
                parts: [
                    { inlineData: { mimeType, data: base64 } },
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
                    { inlineData: { mimeType, data: base64 } },
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
- Pacotes: Diário (24h), Semanal (7 dias), Mensal (30 dias)
- Para comprar: cliente envia dinheiro por M-Pesa/e-Mola e manda o comprovativo
- Podes calcular pacotes para qualquer valor enviado
- Horário de atendimento: 24h/7 dias

REGRAS:
- Quando o cliente quiser comprar: explica que deve transferir o valor por M-Pesa/e-Mola e enviar o comprovativo aqui
- Nunca inventas preços — só mencionas preços se conheceres a tabela atual
- Se não souberes a resposta, dizes honestamente
- Máximo 3 linhas por resposta, a não ser que seja necessário mais detalhe
- NÃO usas listas com bullet points — falas de forma natural`;

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
    transcreverAudio,
    cerebroGemini,
    limparHistoricoConversa,
    isMensagemConversacional
};
