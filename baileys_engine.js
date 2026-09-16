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
let modoManutencao = false;

const AUTH_DIR = path.join(__dirname, '..', 'auth_info_baileys');
if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
}

// ══════════════════════════════════════════════════
// CONFIGURAÇÕES E BANCO LOCAL
// ══════════════════════════════════════════════════
const BOT_CONFIG_PATH = path.join(__dirname, 'bot_config.js');
const LOCAL_CONFIG_PATH = path.join(__dirname, 'local_config.json');

let DYN_CFG = {};
let LOCAL_CFG = {};
const banidosSet = new Set();
const clientesLeads = new Set();
const historicoVendas = [];

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

    if (!DYN_CFG.TABELAS) DYN_CFG.TABELAS = { '24hrs': {}, 'semanal': {}, 'mensal': {}, 'ilimitado': {}, 'saldo': {} };
    if (!DYN_CFG.PLANOS_ESPECIAIS) DYN_CFG.PLANOS_ESPECIAIS = {};
}

carregarConfigs();

function salvarBotConfig() {
    try {
        const content = '// GERADO PELO SISTEMA KA-NET CLOUD\nmodule.exports = ' + JSON.stringify(DYN_CFG, null, 4) + ';\n';
        fs.writeFileSync(BOT_CONFIG_PATH, content, 'utf8');
    } catch (e) {
        console.error('❌ Erro ao salvar bot_config.js:', e.message);
    }
}

function salvarLocalConfig() {
    try {
        fs.writeFileSync(LOCAL_CONFIG_PATH, JSON.stringify(LOCAL_CFG, null, 2), 'utf8');
    } catch (e) {
        console.error('❌ Erro ao salvar local_config.json:', e.message);
    }
}

function getMasterNumbers() {
    const list = new Set(['856116039', '850401416']);
    if (LOCAL_CFG.master_number) {
        String(LOCAL_CFG.master_number).split(/[,;]/).forEach(n => list.add(n.trim().replace(/\D/g, '')));
    }
    if (DYN_CFG.MASTER_NUMBERS && Array.isArray(DYN_CFG.MASTER_NUMBERS)) {
        DYN_CFG.MASTER_NUMBERS.forEach(n => list.add(String(n).replace(/\D/g, '')));
    }
    return Array.from(list);
}

function isMaster(numero) {
    const clean = String(numero).replace(/\D/g, '');
    const masters = getMasterNumbers();
    return masters.some(m => clean.endsWith(m) || m.endsWith(clean));
}

function getPaymentDetails() {
    return {
        mpesa_num: LOCAL_CFG.mpesa_number || DYN_CFG.MPESA_NUMBER || '856268811',
        mpesa_name: LOCAL_CFG.mpesa_name || DYN_CFG.MPESA_NAME || 'Kelven Junior Anabela Nharrava',
        emola_num: LOCAL_CFG.emola_number || DYN_CFG.EMOLA_NUMBER || '864882152',
        emola_name: LOCAL_CFG.emola_name || DYN_CFG.EMOLA_NAME || 'Catia Anabela Nharrava'
    };
}

function getSaudacaoHora() {
    const hora = new Date().getUTCHours() + 2; // Maputo GMT+2
    const h = (hora >= 24) ? hora - 24 : hora;
    if (h >= 5 && h < 12) return 'Bom dia';
    if (h >= 12 && h < 18) return 'Boa tarde';
    return 'Boa noite';
}

// ══════════════════════════════════════════════════
// GERADOR DINÂMICO DE TABELA (ESTRUTURA ORIGINAL)
// ══════════════════════════════════════════════════
function _fmtSize(mb) {
    if (mb >= 1024) {
        const gb = mb / 1024;
        return (gb % 1 === 0 ? gb.toFixed(1) : gb.toFixed(1)) + ' GB';
    }
    return mb + ' MB';
}
function _padL(str, len) {
    str = String(str);
    while (str.length < len) str = ' ' + str;
    return str;
}

function gerarMenuOriginal() {
    const _sysName = (LOCAL_CFG.nome_sistema || DYN_CFG.NOME_SISTEMA || 'KA-NET 2.0').toUpperCase();
    const _tabelas = DYN_CFG.TABELAS || {};
    const _especiais = DYN_CFG.PLANOS_ESPECIAIS || {};

    let out = '';
    out += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    out += `*${_sysName} • LISTA DE PACOTES*\n`;
    out += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

    // DIÁRIOS
    if (_tabelas['24hrs'] && Object.keys(_tabelas['24hrs']).length > 0) {
        out += '⏰ *DIÁRIOS* [Validade: 24H]\n';
        out += '┌─────────────────────────┐\n';
        const sorted = Object.keys(_tabelas['24hrs']).map(Number).sort((a, b) => a - b);
        for (const preco of sorted) {
            const pkg = _tabelas['24hrs'][preco];
            const mb = pkg.quantidade_mb || pkg.quantidade || 0;
            out += `  ${_padL(_fmtSize(mb), 7)}   ➤ ${_padL(String(preco), 4)} MT\n`;
        }
        out += '└─────────────────────────┘\n\n';
    }

    // SEMANAIS
    if (_tabelas['semanal'] && Object.keys(_tabelas['semanal']).length > 0) {
        out += '📆 *SEMANAIS* [Validade: 7 Dias]\n';
        out += '┌─────────────────────────┐\n';
        const sorted = Object.keys(_tabelas['semanal']).map(Number).sort((a, b) => a - b);
        for (const preco of sorted) {
            const pkg = _tabelas['semanal'][preco];
            const mb = pkg.quantidade_mb || pkg.quantidade || 0;
            out += `  ${_padL(_fmtSize(mb), 7)}   ➤ ${_padL(String(preco), 4)} MT\n`;
        }
        out += '└─────────────────────────┘\n\n';
    }

    // MENSAIS
    if (_tabelas['mensal'] && Object.keys(_tabelas['mensal']).length > 0) {
        out += '🗓 *MENSAIS* [Validade: 30 Dias]\n';
        out += '┌─────────────────────────┐\n';
        const sorted = Object.keys(_tabelas['mensal']).map(Number).sort((a, b) => a - b);
        for (const preco of sorted) {
            const pkg = _tabelas['mensal'][preco];
            const mb = pkg.quantidade_mb || pkg.quantidade || 0;
            out += `  ${_padL(_fmtSize(mb), 7)}   ➤ ${_padL(String(preco), 4)} MT\n`;
        }
        out += '└─────────────────────────┘\n\n';
    }

    // PLANOS ESPECIAIS
    if (Object.keys(_especiais).length > 0) {
        out += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        out += '🚀 *PLANOS ESPECIAIS* [Assinatura]\n';
        out += '┌─────────────────────────┐\n';
        const renovs = [];
        const faseados = [];
        for (const [p, info] of Object.entries(_especiais)) {
            if (info.tipo === 'renovacao') renovs.push([p, info]);
            else if (info.tipo === 'faseado') faseados.push([p, info]);
        }
        renovs.sort((a, b) => Number(a[0]) - Number(b[0]));
        faseados.sort((a, b) => Number(a[0]) - Number(b[0]));
        for (const [p, info] of renovs) {
            out += `  ${info.nome}  ➤ ${_padL(String(p), 4)} MT\n`;
        }
        if (renovs.length > 0 && faseados.length > 0) out += '  \n';
        for (const [p, info] of faseados) {
            out += `  ${info.nome}  ➤ ${_padL(String(p), 4)} MT\n`;
        }
        out += '└─────────────────────────┘\n\n';
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

        out += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        out += '📞 *ILIMITADOS + LIGAÇÕES*\n';
        out += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

        if (voda.length > 0) {
            out += '🔴 *VODACOM* [30 Dias]\n';
            for (const [p, info] of voda) {
                const mb = info.ativacao_mb || info.quantidade_mb || info.quantidade || 0;
                const gb = Math.round(mb / 1024);
                out += `  ${_padL(String(gb), 3)} GB + Minutos  ➤ ${_padL(String(p), 4)} MT\n`;
            }
            out += '\n';
        }
        if (movi.length > 0) {
            out += '🟢 *MOVITEL* [30 Dias]\n';
            for (const [p, info] of movi) {
                const mb = info.ativacao_mb || info.quantidade_mb || info.quantidade || 0;
                const gb = Math.round(mb / 1024);
                out += `  ${_padL(String(gb), 3)} GB + Minutos  ➤ ${_padL(String(p), 4)} MT\n`;
            }
            out += '\n';
        }
    }

    out += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    out += '⚠️ *DIRETRIZES DO SISTEMA*\n';
    out += '• Diários: Aceitam Txuna ativo.\n';
    out += '• Semanais / Mensais / Ilimitados: Não usar Txuna.\n\n';
    out += '📩 *COMO ATIVAR (AUTOMÁTICO)*\n';
    out += '1. Envie o Valor M-Pesa ou E-Mola.\n';
    out += '2. Envie o Comprovativo.\n';
    out += '3. Coloque o número de destino na última linha.\n\n';
    out += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    out += `🤖 _[${_sysName} Automation System]_`;
    return out;
}

function gerarMensagemBoasVindas(nomeCliente) {
    const sd = getSaudacaoHora();
    const sN = LOCAL_CFG.nome_sistema || DYN_CFG.NOME_SISTEMA || 'Ka-Net System';
    return `${sd}, *${nomeCliente}*! 🌟\n\nBem-vindo(a) à *${sN}*!\n\n1️⃣ *Menu* — Ver Pacotes\n2️⃣ *Pagamento* — Contas\n3️⃣ *Fidelidade* — Bónus 🏆\n\nOu envie o *comprovativo M-Pesa* para comprar! ⚡`;
}

function gerarMensagemPagamento(nomeCliente) {
    const { mpesa_num, mpesa_name, emola_num, emola_name } = getPaymentDetails();
    return `Pode efectuar o seu pagamento nestas contas, *${nomeCliente}*: 💳\n\n📱 *M-Pesa:* ${mpesa_num} (${mpesa_name})\n📱 *E-Mola:* ${emola_num} (${emola_name})\n\nApós o pagamento, envie o recibo e o número!`;
}

function gerarMenuEstudante() {
    const itens = (DYN_CFG.TABELAS && DYN_CFG.TABELAS['estudantes']) || {
        "10": { nome: "500MB Estudante", quantidade_mb: 500 },
        "20": { nome: "1.2GB Estudante", quantidade_mb: 1229 },
        "35": { nome: "2.5GB Estudante", quantidade_mb: 2560 },
        "50": { nome: "4GB Estudante", quantidade_mb: 4096 }
    };
    const entries = Object.entries(itens).sort((a,b) => parseInt(a[0]) - parseInt(b[0]));
    const linhas = entries.map(([preco, p]) => `  🎓 *${p.nome}* 👉 *${preco} MT*`).join('\n');
    const { mpesa_num, mpesa_name } = getPaymentDetails();

    return `🎓 *TABELA ESPECIAL PARA ESTUDANTES* 🎓\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${linhas}\n\n💳 *M-Pesa:* ${mpesa_num} (${mpesa_name})\nEnvie o comprovativo aqui com seu número de destino para ativação imediata!`;
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
// BUSCA DE PACOTE PELO VALOR
// ══════════════════════════════════════════════════
function buscarPacotePorValor(valor) {
    const vStr = String(Math.round(parseFloat(String(valor).replace(',', '.'))));
    const vNum = parseInt(vStr);

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
    if (DYN_CFG.PLANOS_ESPECIAIS && DYN_CFG.PLANOS_ESPECIAIS[vStr]) {
        const p = DYN_CFG.PLANOS_ESPECIAIS[vStr];
        return { nome: p.nome, mb: p.quantidade_mb || p.quantidade || 1024, tipo: p.tipo || 'especial', preco: vNum };
    }
    if (DYN_CFG.TABELAS_FORNECIMENTO && DYN_CFG.TABELAS_FORNECIMENTO[vStr]) {
        const p = DYN_CFG.TABELAS_FORNECIMENTO[vStr];
        return { nome: p.nome, mb: p.quantidade_mb || 0, tipo: 'saldo', preco: vNum };
    }

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
    return null;
}

// ══════════════════════════════════════════════════
// REGEX E PARSER
// ══════════════════════════════════════════════════
const MPESA_REGEX = /([A-Z0-9.]+)\s+Confirmado[\s.]+Recebeu\s+([\d.,]+)\s*MT\s+de\s+(\d{9})/i;
const EMOLA_REGEX = /(TX[0-9A-Z.]+).*?([\d.,]+)\s*MT.*?(\d{9})/is;
const pendingPayments = new Map();

function extrairNumeroDestino(texto) {
    const lines = texto.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i].trim();
        const m = l.match(/\b(8[234567]\d{7})\b/);
        if (m) return m[1];
    }
    const anyM = texto.match(/\b(8[234567]\d{7})\b/);
    return anyM ? anyM[1] : null;
}

function processarAddTabelaCompleta(corpo) {
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
        for (const cat of Object.keys(newTabelas)) {
            if (Object.keys(newTabelas[cat]).length > 0) {
                DYN_CFG.TABELAS[cat] = { ...DYN_CFG.TABELAS[cat], ...newTabelas[cat] };
            }
        }
        salvarBotConfig();
        return `✅ *TABELA ATUALIZADA COM SUCESSO!*\n\nForam processados e integrados *${contador} pacotes* no sistema.`;
    }

    return `⚠️ Não foi possível identificar pacotes na tabela colada.\nUse o formato:\n*1GB 24h - 23 MT*`;
}

// ══════════════════════════════════════════════════
// MOTOR PRINCIPAL BAILEYS
// ══════════════════════════════════════════════════
async function startWhatsApp(orderCallback) {
    orderDispatchCallback = orderCallback;

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
                    console.log('📱 [BAILEYS] Novo QR Code gerado em /qr');
                } catch (e) {}
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                connectionStatus = 'disconnected';
                currentQrBase64 = null;
                console.log(`🔌 [BAILEYS] Conexão fechada (${statusCode}). Reconectar: ${shouldReconnect}`);
                if (shouldReconnect) {
                    setTimeout(() => startWhatsApp(orderDispatchCallback), 5000);
                }
            } else if (connection === 'open') {
                connectionStatus = 'connected';
                currentQrBase64 = null;
                connectedUser = sock.user?.id || 'KaNet Cloud Bot';
                console.log(`✅ [BAILEYS] WhatsApp Conectado com SUCESSO! Logado como: ${connectedUser}`);
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

                    const text = msg.message?.conversation ||
                                 msg.message?.extendedTextMessage?.text ||
                                 msg.message?.imageMessage?.caption || '';

                    if (!text.trim()) continue;

                    const senderNumber = jid.replace('@s.whatsapp.net', '').replace('@g.us', '');
                    const cleanText = text.trim().toLowerCase();
                    const senderIsMaster = isMaster(senderNumber);
                    const nomeCliente = msg.pushName || 'Cliente';

                    // Registar Lead
                    clientesLeads.add(senderNumber);

                    // Se estiver banido, ignorar
                    if (banidosSet.has(senderNumber) && !senderIsMaster) continue;

                    // Se estiver em manutenção e não for Master, avisar
                    if (modoManutencao && !senderIsMaster) {
                        await sock.sendMessage(jid, { text: '🛑 *SISTEMA EM MANUTENÇÃO*\n\nEstamos atualizando os nossos servidores para melhor atendê-lo. Por favor, tente novamente mais tarde!' });
                        continue;
                    }

                    console.log(`📩 [MSG] ${senderNumber} ${senderIsMaster ? '👑' : ''}: ${text.substring(0, 60)}`);

                    const reply = async (resposta) => {
                        await sock.sendMessage(jid, { text: resposta });
                    };

                    // ── 1. AGUARDANDO NÚMERO DE DESTINO APÓS COMPROVATIVO ──
                    if (pendingPayments.has(jid)) {
                        const pay = pendingPayments.get(jid);
                        if (pay.aguardando_numero) {
                            const numDestino = extrairNumeroDestino(text);
                            if (numDestino) {
                                pendingPayments.delete(jid);
                                const pacote = buscarPacotePorValor(pay.valor);
                                const orderId = 'WA-' + pay.txn_id + '-' + Date.now();

                                await reply(
                                    `✅ *PEDIDO CONFIRMADO!*\n━━━━━━━━━━━━━━━━━━━\n` +
                                    `📦 Pacote: *${pacote ? pacote.nome : pay.valor + ' MT'}*\n` +
                                    `📱 Destino: *${numDestino}*\n` +
                                    `💳 Pagamento: *${pay.valor} MT* via ${pay.metodo === 'emola' ? 'e-Mola' : 'M-Pesa'}\n` +
                                    `🆔 Transação: ${pay.txn_id}\n\n` +
                                    `⏳ *Ativação em andamento... aguarde a confirmação por SMS!*`
                                );

                                // Registar venda
                                historicoVendas.push({
                                    orderId,
                                    numero: numDestino,
                                    mb: pacote ? pacote.mb : 1024,
                                    valor: parseFloat(pay.valor),
                                    timestamp: Date.now()
                                });

                                if (orderDispatchCallback) {
                                    orderDispatchCallback({
                                        orderId,
                                        numero: numDestino,
                                        quantidade: pacote ? pacote.mb : 1024,
                                        modo: pacote ? pacote.tipo : 'diario',
                                        jid,
                                        sender: senderNumber,
                                        txn_id: pay.txn_id,
                                        valor: pay.valor
                                    });
                                }
                                continue;
                            } else {
                                await reply(`⚠️ Por favor, envie um número Vodacom válido com 9 dígitos (ex: *84XXXXXXX* ou *85XXXXXXX*).`);
                                continue;
                            }
                        }
                    }

                    // ── 2. COMANDO .addtabela (ADMIN MASTER) ────────────────
                    if (cleanText.startsWith('.addtabela') || cleanText.startsWith('!addtabela')) {
                        if (!senderIsMaster) {
                            await reply('🚫 *ACESSO NEGADO*\n━━━━━━━━━━━━━━━━━━━\n⚠️ Comando restrito ao Administrador Master.');
                            continue;
                        }

                        const body = text.replace(/^[.!]addtabela\s*/i, '').trim();

                        if (/DI[AÁ]R|SEMAN|MENS|ILIMIT|SALDO|GB|MB/i.test(body) && body.length > 30) {
                            const res = processarAddTabelaCompleta(body);
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

                            if (!DYN_CFG.TABELAS[cat]) DYN_CFG.TABELAS[cat] = {};
                            DYN_CFG.TABELAS[cat][preco] = {
                                quantidade: mb,
                                nome,
                                quantidade_mb: mb,
                                periodo: cat,
                                tipo: cat
                            };
                            salvarBotConfig();
                            await reply(`✅ *Pacote Adicionado!*\n\n📂 Categoria: *${cat}*\n💰 Preço: *${preco} MT*\n📦 Megas: *${mb} MB*\n🏷️ Nome: *${nome}*`);
                            continue;
                        }

                        await reply(
                            `💡 *USO DO COMANDO .addtabela*\n━━━━━━━━━━━━━━━━━━━\n\n` +
                            `*Modo 1 — Pacote Individual:*\n\`.addtabela [categoria] [preço] [megas] [nome]\`\n` +
                            `_Exemplo:_ \`.addtabela 24hrs 15 600 600MB 24h\`\n\n` +
                            `*Modo 2 — Tabela Completa:*\nCole a tabela inteira formatada após \`.addtabela\`\n\n` +
                            `*Categorias:* \`24hrs\`, \`semanal\`, \`mensal\`, \`ilimitado\`, \`estudantes\``
                        );
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
                            await reply('🚫 *ACESSO NEGADO*\n━━━━━━━━━━━━━━━━━━━\n⚠️ Comando restrito ao Administrador Master.');
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
                                await reply(
                                    `⚡ *ENVIO MANUAL DISPACHADO!*\n━━━━━━━━━━━━━━━━━━━\n` +
                                    `📱 Destino: *${numDest}*\n` +
                                    `📦 Quantidade: *${megas} MB*\n` +
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
                        await reply('🛑 *Modo de Manutenção ATIVADO.* Clientes normais receberão aviso de manutenção.');
                        continue;
                    }

                    if (cleanText === '.online') {
                        if (!senderIsMaster) { await reply('🚫 Restrito ao Admin.'); continue; }
                        modoManutencao = false;
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
                            `👥 *Leads Ativos:* ${clientesLeads.size}\n` +
                            `🕐 *Horário do Servidor:* ${new Date().toLocaleString('pt-PT', { timeZone: 'Africa/Maputo' })}`
                        );
                        continue;
                    }

                    if (cleanText === '/limpar' && senderIsMaster) {
                        pendingPayments.clear();
                        await reply('🧹 *Fila de pagamentos pendentes limpa com sucesso!*');
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

                    // ── 9. COMPROVATIVO M-PESA ──────────────────────────────
                    const mpesaMatch = text.match(MPESA_REGEX);
                    if (mpesaMatch) {
                        const txn_id = mpesaMatch[1];
                        const valor = mpesaMatch[2];
                        const remetente = mpesaMatch[3];
                        const pacote = buscarPacotePorValor(valor);

                        console.log(`💳 [COMPROVATIVO M-PESA] ${txn_id} | ${valor} MT`);

                        if (!pacote) {
                            await reply(
                                `⚠️ *Comprovativo M-Pesa recebido!*\n\n` +
                                `Transação: *${txn_id}*\nValor: *${valor} MT*\n\n` +
                                `Porém, não encontramos um pacote correspondente a este valor.\n` +
                                `Digite *Menu* para verificar os preços disponíveis.`
                            );
                            continue;
                        }

                        const numDestinoInline = extrairNumeroDestino(text.replace(remetente, ''));

                        if (numDestinoInline) {
                            const orderId = 'WA-' + txn_id + '-' + Date.now();
                            await reply(
                                `✅ *COMPROVATIVO CONFIRMADO!*\n━━━━━━━━━━━━━━━━━━━\n` +
                                `📦 Pacote: *${pacote.nome}*\n` +
                                `📱 Número de Destino: *${numDestinoInline}*\n` +
                                `💳 Valor: *${valor} MT* (M-Pesa)\n` +
                                `🆔 Ref: ${txn_id}\n\n` +
                                `🚀 *Ativação automática em andamento!*`
                            );

                            historicoVendas.push({ orderId, numero: numDestinoInline, mb: pacote.mb, valor: parseFloat(valor), timestamp: Date.now() });

                            if (orderDispatchCallback) {
                                orderDispatchCallback({
                                    orderId,
                                    numero: numDestinoInline,
                                    quantidade: pacote.mb,
                                    modo: pacote.tipo,
                                    jid,
                                    sender: senderNumber,
                                    txn_id,
                                    valor
                                });
                            }
                            continue;
                        }

                        pendingPayments.set(jid, {
                            txn_id, valor, remetente,
                            metodo: 'mpesa',
                            aguardando_numero: true
                        });

                        await reply(
                            `✅ *Comprovativo M-Pesa Verificado!*\n━━━━━━━━━━━━━━━━━━━\n` +
                            `🆔 Transação: *${txn_id}*\n` +
                            `💰 Valor: *${valor} MT*\n` +
                            `📦 Pacote: *${pacote.nome}* (${pacote.mb} MB)\n\n` +
                            `📱 *Envie agora o NÚMERO DE DESTINO dos dados:*\n_(Exemplo: 84XXXXXXX ou 85XXXXXXX)_`
                        );
                        continue;
                    }

                    // ── 10. COMPROVATIVO E-MOLA ─────────────────────────────
                    const emolaMatch = text.match(EMOLA_REGEX);
                    if (emolaMatch) {
                        const txn_id = emolaMatch[1];
                        const valor = emolaMatch[2];
                        const remetente = emolaMatch[3];
                        const pacote = buscarPacotePorValor(valor);

                        console.log(`💳 [COMPROVATIVO E-MOLA] ${txn_id} | ${valor} MT`);

                        if (!pacote) {
                            await reply(`⚠️ *Comprovativo e-Mola recebido!*\n\nValor *${valor} MT* não corresponde a nenhum pacote ativo.\nDigite *Menu* para consultar a tabela.`);
                            continue;
                        }

                        const numDestinoInline = extrairNumeroDestino(text.replace(remetente, ''));

                        if (numDestinoInline) {
                            const orderId = 'WA-' + txn_id + '-' + Date.now();
                            await reply(
                                `✅ *COMPROVATIVO E-MOLA CONFIRMADO!*\n━━━━━━━━━━━━━━━━━━━\n` +
                                `📦 Pacote: *${pacote.nome}*\n` +
                                `📱 Número de Destino: *${numDestinoInline}*\n` +
                                `💳 Valor: *${valor} MT*\n` +
                                `🆔 Ref: ${txn_id}\n\n` +
                                `🚀 *Ativação automática em andamento!*`
                            );

                            historicoVendas.push({ orderId, numero: numDestinoInline, mb: pacote.mb, valor: parseFloat(valor), timestamp: Date.now() });

                            if (orderDispatchCallback) {
                                orderDispatchCallback({
                                    orderId,
                                    numero: numDestinoInline,
                                    quantidade: pacote.mb,
                                    modo: pacote.tipo,
                                    jid,
                                    sender: senderNumber,
                                    txn_id,
                                    valor
                                });
                            }
                            continue;
                        }

                        pendingPayments.set(jid, {
                            txn_id, valor, remetente,
                            metodo: 'emola',
                            aguardando_numero: true
                        });

                        await reply(
                            `✅ *Comprovativo e-Mola Verificado!*\n━━━━━━━━━━━━━━━━━━━\n` +
                            `🆔 Transação: *${txn_id}*\n` +
                            `💰 Valor: *${valor} MT*\n` +
                            `📦 Pacote: *${pacote.nome}*\n\n` +
                            `📱 *Envie agora o NÚMERO DE DESTINO dos dados:*`
                        );
                        continue;
                    }

                    // ── 11. SISTEMA DE FIDELIDADE E INDICAÇÃO ───────────────
                    if (['!convite', 'convite', '!fidelidade', 'fidelidade', '3', '3️⃣'].includes(cleanText)) {
                        const meuCodigo = senderNumber;
                        await reply(
                            `🎁 *GANHE BÓNUS INDICANDO AMIGOS*\n\n` +
                            `Ganhe *200MB* em cada compra feita por amigos que usarem o seu código!\n\n` +
                            `🔗 *O Seu Código:* \`${meuCodigo}\`\n\n` +
                            `💡 *Como funciona?*\n` +
                            `1. Envie o seu código para um amigo.\n` +
                            `2. Peça para ele enviar: *!indicado ${meuCodigo}*\n` +
                            `3. Pronto! O bónus cai automaticamente.`
                        );
                        continue;
                    }

                    // ── 12. TABELA DE ESTUDANTES ────────────────────────────
                    if (cleanText.includes('estudante')) {
                        await reply(gerarMenuEstudante());
                        continue;
                    }

                    // ── 13. MENU / TABELA ORIGINAL ──────────────────────────
                    if (['1', '1️⃣', 'menu', 'tabela', 'pacotes', 'planos', 'precos', 'preço', 'preco'].includes(cleanText)) {
                        await reply(gerarMenuOriginal());
                        continue;
                    }

                    // ── 14. PAGAMENTO ORIGINAL ──────────────────────────────
                    if (['2', '2️⃣', 'pagamento', '!pagamento', '.pagamento', 'conta', 'contas', 'mpesa', 'emola', 'pagar'].includes(cleanText)) {
                        await reply(gerarMensagemPagamento(nomeCliente));
                        continue;
                    }

                    // ── 15. SAUDAÇÃO / BOAS VINDAS PADRÃO ───────────────────
                    if (['oi', 'ola', 'olá', 'bom dia', 'boa tarde', 'boa noite', 'iniciar', 'start', 'começar'].some(w => cleanText === w || cleanText.startsWith(w))) {
                        await reply(gerarMensagemBoasVindas(nomeCliente));
                        continue;
                    }

                    // Resposta padrão caso nenhuma palavra-chave bata
                    await reply(gerarMensagemBoasVindas(nomeCliente));
                }
            } catch (err) {
                console.error('❌ [BAILEYS MSG ERROR]:', err);
            }
        });

    } catch (e) {
        console.error('❌ [BAILEYS INIT ERROR]:', e);
        setTimeout(() => startWhatsApp(orderDispatchCallback), 10000);
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
