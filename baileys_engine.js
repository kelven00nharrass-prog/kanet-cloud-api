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
    const list = new Set(['850401416', '856116039', '856268811', '841636072']);
    if (LOCAL_CFG.master_number) {
        String(LOCAL_CFG.master_number).split(/[,;]/).forEach(n => list.add(n.trim().replace(/\D/g, '')));
    }
    if (DYN_CFG.MASTER_NUMBERS && Array.isArray(DYN_CFG.MASTER_NUMBERS)) {
        DYN_CFG.MASTER_NUMBERS.forEach(n => list.add(String(n).replace(/\D/g, '')));
    }
    return Array.from(list);
}

function isMaster(numero) {
    if (!numero) return false;
    const clean = String(numero).replace(/\D/g, '');
    const clean9 = (clean.startsWith('258') && clean.length >= 11) ? clean.substring(3) : clean;

    // Números do Criador / Kelven (Sempre Master em todas as situações)
    if (clean.includes('850401416') || clean.includes('856116039') || clean.includes('856268811') || clean.includes('841636072') ||
        clean9.includes('850401416') || clean9.includes('856116039') || clean9.includes('856268811') || clean9.includes('841636072')) {
        return true;
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
    let supportNum = '856116039';
    if (LOCAL_CFG.master_number) {
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

function gerarMenuOriginal(jid = null) {
    const { supportNum, sysName } = getSuporteDetails();
    
    // Se a mensagem veio de um grupo e esse grupo tiver uma tabela customizada, exibi-la
    let _tabelas = DYN_CFG.TABELAS || {};
    let _especiais = DYN_CFG.PLANOS_ESPECIAIS || {};

    if (jid && DYN_CFG.TABELAS_GRUPO && DYN_CFG.TABELAS_GRUPO[jid]) {
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
        const sorted = Object.keys(_tabelas['24hrs']).map(Number).sort((a, b) => a - b);
        for (const preco of sorted) {
            const pkg = _tabelas['24hrs'][preco];
            const mb = pkg.quantidade_mb || pkg.quantidade || 0;
            out += `│ 🔹 *${_fmtSize(mb).padEnd(6)}* ➔ *${preco} MT*\n`;
        }
        out += `╰─────────────────────────────╯\n\n`;
    }

    // SEMANAIS (7 DIAS)
    if (_tabelas['semanal'] && Object.keys(_tabelas['semanal']).length > 0) {
        out += `📅 *PACOTES SEMANAIS (7 DIAS)*\n`;
        out += `╭─────────────────────────────╮\n`;
        const sorted = Object.keys(_tabelas['semanal']).map(Number).sort((a, b) => a - b);
        for (const preco of sorted) {
            const pkg = _tabelas['semanal'][preco];
            const mb = pkg.quantidade_mb || pkg.quantidade || 0;
            out += `│ 🔹 *${_fmtSize(mb).padEnd(6)}* ➔ *${preco} MT*\n`;
        }
        out += `╰─────────────────────────────╯\n\n`;
    }

    // MENSAIS (30 DIAS)
    if (_tabelas['mensal'] && Object.keys(_tabelas['mensal']).length > 0) {
        out += `🗓️ *PACOTES MENSAIS (30 DIAS)*\n`;
        out += `╭─────────────────────────────╮\n`;
        const sorted = Object.keys(_tabelas['mensal']).map(Number).sort((a, b) => a - b);
        for (const preco of sorted) {
            const pkg = _tabelas['mensal'][preco];
            const mb = pkg.quantidade_mb || pkg.quantidade || 0;
            out += `│ 🔹 *${_fmtSize(mb).padEnd(6)}* ➔ *${preco} MT*\n`;
        }
        out += `╰─────────────────────────────╯\n\n`;
    }

    // PLANOS ESPECIAIS
    if (Object.keys(_especiais).length > 0) {
        out += `🚀 *PLANOS ESPECIAIS VIP*\n`;
        out += `╭─────────────────────────────╮\n`;
        const sortedEsp = Object.entries(_especiais).sort((a, b) => Number(a[0]) - Number(b[0]));
        for (const [preco, info] of sortedEsp) {
            out += `│ 💎 *${info.nome}* ➔ *${preco} MT*\n`;
        }
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

function gerarMensagemBoasVindas(nomeCliente) {
    const sd = getSaudacaoHora();
    const { supportNum, sysName } = getSuporteDetails();
    return (
        `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n` +
        `  👋 *${sd.toUpperCase()}, ${nomeCliente.toUpperCase()}!* 🌟\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
        `Seja bem-vindo(a) à *${sysName}*!\n` +
        `A sua plataforma rápida e automática de megas e pacotes de internet 🇲🇿\n\n` +
        `📌 *COMO DESEJA COMEÇAR?*\n\n` +
        `1️⃣ *Menu* ➔ Ver Pacotes e Preços\n` +
        `2️⃣ *Pagamento* ➔ Ver Contas M-Pesa e e-Mola\n` +
        `3️⃣ *Estudante* ➔ Tabela com Descontos Escolares\n` +
        `4️⃣ *Fidelidade* ➔ Ganhe Megas Indicando Amigos 🏆\n` +
        `5️⃣ *Suporte* ➔ Falar com Atendimento Humano 📞\n\n` +
        `⚡ *COMPRA RÁPIDA:*\n` +
        `Já fez o pagamento? Basta enviar o *comprovativo* com o seu *número de destino* para ativar em segundos!\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
    );
}

function gerarMensagemPagamento(nomeCliente) {
    const { mpesa_num, mpesa_name, emola_num, emola_name } = getPaymentDetails();
    const { supportNum } = getSuporteDetails();
    return (
        `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n` +
        `  💳 *CONTAS PARA PAGAMENTO* 💳\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
        `Olá, *${nomeCliente}*! Pode efectuar a transferência para qualquer uma das contas abaixo:\n\n` +
        `📱 *VODACOM (M-PESA)*\n` +
        `├ 📞 *Número:* \`${mpesa_num}\`\n` +
        `└ 👤 *Titular:* *${mpesa_name}*\n\n` +
        `📱 *MOVITEL (E-MOLA)*\n` +
        `├ 📞 *Número:* \`${emola_num}\`\n` +
        `└ 👤 *Titular:* *${emola_name}*\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📝 *COMO FINALIZAR SUA RECARGA:*\n` +
        `1. Faça a transferência do valor exato.\n` +
        `2. Encaminhe o SMS do comprovativo aqui.\n` +
        `3. Adicione o seu número Vodacom (*84* ou *85*) na última linha.\n\n` +
        `⏳ *A ativação pelo robô é imediata e 24h por dia!*\n\n` +
        `❓ *Dúvidas ou problemas?* Digite *Suporte* ou ligue para *${supportNum}*`
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
// BUSCA DE PACOTE PELO VALOR (COM SUPORTE A TABELAS POR GRUPO)
// ══════════════════════════════════════════════════
function buscarPacotePorValor(valor, jid = null) {
    const vStr = String(Math.round(parseFloat(String(valor).replace(',', '.'))));
    const vNum = parseInt(vStr);

    // 1. PRIORIDADE MÁXIMA: Tabela específica do Grupo (se a mensagem veio de um grupo configurado)
    if (jid && DYN_CFG.TABELAS_GRUPO && DYN_CFG.TABELAS_GRUPO[jid]) {
        const grpCfg = DYN_CFG.TABELAS_GRUPO[jid];
        const grpTabs = grpCfg.TABELAS || grpCfg;
        for (const cat of ['24hrs', 'semanal', 'mensal', 'ilimitado', 'especial']) {
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
    if (DYN_CFG.PLANOS_ESPECIAIS && DYN_CFG.PLANOS_ESPECIAIS[vStr]) {
        const p = DYN_CFG.PLANOS_ESPECIAIS[vStr];
        return { nome: p.nome, mb: p.quantidade_mb || p.quantidade || 1024, tipo: p.tipo || 'especial', preco: vNum };
    }
    if (DYN_CFG.TABELAS_FORNECIMENTO && DYN_CFG.TABELAS_FORNECIMENTO[vStr]) {
        const p = DYN_CFG.TABELAS_FORNECIMENTO[vStr];
        return { nome: p.nome, mb: p.quantidade_mb || 0, tipo: 'saldo', preco: vNum };
    }

    // 3. Fallback: procurar em qualquer grupo se não foi achado na tabela geral
    if (DYN_CFG.TABELAS_GRUPO) {
        for (const [gJid, grpObj] of Object.entries(DYN_CFG.TABELAS_GRUPO)) {
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
    return null;
}

// ══════════════════════════════════════════════════
// DETECÇÃO FLEXÍVEL DE COMPROVATIVOS (PRIVADO E GRUPO)
// Igual ao bot original - identifica qualquer formato M-Pesa/e-Mola
// ══════════════════════════════════════════════════
const pendingPayments = new Map(); // chave: jid + ":" + senderNumber

function extrairValorMT(texto) {
    if (!texto) return null;
    const mTransf = texto.match(/Transferiste\s+([\d.,]+)\s*MT/i);
    if (mTransf) return mTransf[1].replace(/\s/g, '').replace(',', '.');
    const mReceb = texto.match(/Recebeste\s+([\d.,]+)\s*MT/i);
    if (mReceb) return mReceb[1].replace(/\s/g, '').replace(',', '.');
    const mRec = texto.match(/Recebeu\s+([\d.,]+)\s*MT/i);
    if (mRec) return mRec[1].replace(/\s/g, '').replace(',', '.');
    const mGeral = texto.match(/([\d.,]+)\s*MT\b/i);
    if (mGeral) return mGeral[1].replace(/\s/g, '').replace(',', '.');
    return null;
}

function extrairTxId(texto) {
    if (!texto) return null;
    const commonWords = ['CONFIRMADO', 'RECEBESTE', 'TRANSFERISTE', 'RECEBEU', 'SALDO', 'VODACOM', 'MOVITEL', 'EMOLA', 'MPESA', 'PAGAMENTO', 'OPERADORA', 'CONTA', 'VALOR'];
    const regex = /\b([A-Z0-9]{6,25}(?:\.[A-Z0-9]{2,15})*)\b/gi;
    let match;
    let results = [];
    
    while ((match = regex.exec(texto)) !== null) {
        const ref = match[1].toUpperCase();
        if (commonWords.includes(ref)) continue;
        if (/^(258)?(8[2-7]\d{7})$/.test(ref)) continue; // telefone, ignora
        
        const temLetra = /[A-Z]/.test(ref);
        const temNumero = /[0-9]/.test(ref);
        
        if (temLetra && temNumero) {
            results.push({ val: ref, score: 100 });
        } else if (ref.length >= 8 && temLetra) {
            results.push({ val: ref, score: 50 });
        } else if (ref.length >= 6 && temNumero) {
            results.push({ val: ref, score: 40 });
        }
    }
    
    if (results.length === 0) return 'TXN-' + Date.now();
    return results.sort((a,b) => b.score - a.score || b.val.length - a.val.length)[0].val;
}

function isComprovativo(texto) {
    if (!texto) return false;
    const temIndicador = /(Confirmado|Recebeu|Recebeste|Transferiste|Transferiu|Transf|e-Mola|M-Pesa|TxId|Transação|Transacao)/i.test(texto);
    const temValor = /[\d.,]+\s*MT\b/i.test(texto);
    return temIndicador && temValor;
}

function extrairNumeroDestino(texto) {
    if (!texto) return null;
    const lines = texto.trim().split(/\r?\n/);
    // Prioridade 1: Da última linha para cima (onde os clientes costumam colocar o número)
    for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i].trim();
        const m = l.match(/\b(?:258)?(8[4-5]\d{7})\b/);
        if (m) {
            return m[1].replace(/^258/, '');
        }
    }
    // Prioridade 2: Qualquer ocorrência no texto todo (último número Vodacom encontrado)
    const allMatches = texto.match(/\b(?:258)?(8[4-5]\d{7})\b/g);
    if (allMatches && allMatches.length > 0) {
        return allMatches[allMatches.length - 1].replace(/^258/, '');
    }
    return null;
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

                    const realSender = msg.key.participant || msg.participant || jid;
                    const senderNumber = realSender.replace('@s.whatsapp.net', '').replace('@c.us', '').replace('@g.us', '');
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
                    const pendingKey = `${jid}:${senderNumber}`;
                    const hasPending = pendingPayments.has(pendingKey) || pendingPayments.has(jid);
                    if (hasPending) {
                        const targetKey = pendingPayments.has(pendingKey) ? pendingKey : jid;
                        const pay = pendingPayments.get(targetKey);
                        if (pay.aguardando_numero) {
                            const numDestino = extrairNumeroDestino(text);
                            if (numDestino) {
                                pendingPayments.delete(targetKey);
                                const pacote = buscarPacotePorValor(pay.valor, jid);
                                const orderId = 'WA-' + pay.txn_id + '-' + Date.now();

                                const { supportNum } = getSuporteDetails();
                                await reply(
                                    `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n` +
                                    `  🎉 *PEDIDO CONFIRMADO COM SUCESSO!* ⚡\n` +
                                    `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                                    `📦 *Pacote:* *${pacote ? pacote.nome : pay.valor + ' MT'}*\n` +
                                    `📲 *Destino:* *${numDestino}*\n` +
                                    `💳 *Valor Pago:* *${pay.valor} MT* (${pay.metodo === 'emola' ? 'e-Mola' : 'M-Pesa'})\n` +
                                    `🔖 *Ref:* \`${pay.txn_id}\`\n\n` +
                                    `⏳ *Os seus dados estão a ser ativados automaticamente...*\n` +
                                    `_Você receberá uma notificação aqui assim que for concluído!_\n\n` +
                                    `📞 *Suporte se demorar:* Envie *Suporte* ou ligue para *${supportNum}*`
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
                                // Se for em grupo e o texto não parecer minimamente um número (ex: conversa normal), ignora
                                const pareceNumero = /\d{4,}/.test(text);
                                if (pareceNumero || !jid.endsWith('@g.us')) {
                                    await reply(`⚠️ Por favor, envie um número Vodacom válido com 9 dígitos (ex: *84XXXXXXX* ou *85XXXXXXX*).`);
                                    continue;
                                }
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

                    // ── 9. COMPROVATIVO UNIVERSAL (M-PESA / E-MOLA) ──────────
                    if (isComprovativo(text)) {
                        const valor = extrairValorMT(text);
                        const txn_id = extrairTxId(text);
                        const metodo = /e-mola|emola|TX[A-Z0-9]/i.test(text) ? 'emola' : 'mpesa';
                        const metodoNome = metodo === 'emola' ? 'e-Mola' : 'M-Pesa';

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
                            continue;
                        }

                        const { supportNum } = getSuporteDetails();
                        const numDestinoInline = extrairNumeroDestino(text);
                        if (numDestinoInline) {
                            const orderId = 'WA-' + txn_id + '-' + Date.now();
                            await reply(
                                `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n` +
                                `  🎉 *COMPROVATIVO CONFIRMADO!* ⚡\n` +
                                `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                                `📦 *Pacote:* *${pacote.nome}*\n` +
                                `📲 *Destino:* *${numDestinoInline}*\n` +
                                `💳 *Valor:* *${valor} MT* (${metodoNome})\n` +
                                `🔖 *Ref:* \`${txn_id}\`\n\n` +
                                `🚀 *Ativação automática em andamento!*\n` +
                                `_Você receberá uma confirmação assim que for enviado._\n\n` +
                                `📞 *Suporte:* Envie *Suporte* ou ligue para *${supportNum}*`
                            );

                            historicoVendas.push({
                                orderId,
                                numero: numDestinoInline,
                                mb: pacote.mb,
                                valor: parseFloat(valor),
                                timestamp: Date.now()
                            });

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

                        // Caso não venha o número de destino na mesma mensagem, aguarda a próxima
                        const pendingKey = `${jid}:${senderNumber}`;
                        pendingPayments.set(pendingKey, {
                            txn_id,
                            valor,
                            metodo,
                            aguardando_numero: true
                        });

                        await reply(
                            `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n` +
                            `  ✅ *COMPROVATIVO VERIFICADO!* 💳\n` +
                            `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                            `🔖 *Transação:* \`${txn_id}\`\n` +
                            `💰 *Valor:* *${valor} MT* (${metodoNome})\n` +
                            `📦 *Pacote:* *${pacote.nome}* (${pacote.mb} MB)\n\n` +
                            `📲 *PARA QUAL NÚMERO DEVEMOS ENVIAR?*\n` +
                            `Por favor, responda agora com o seu *número Vodacom*:\n` +
                            `_(Exemplo: 84XXXXXXX ou 85XXXXXXX)_`
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
                        await reply(gerarMenuOriginal(jid));
                        continue;
                    }

                    // ── 14. PAGAMENTO ORIGINAL ──────────────────────────────
                    if (['2', '2️⃣', 'pagamento', '!pagamento', '.pagamento', 'conta', 'contas', 'mpesa', 'emola', 'pagar'].includes(cleanText)) {
                        await reply(gerarMensagemPagamento(nomeCliente));
                        continue;
                    }

                    // ── 15. SUPORTE & AJUDA (OU QUANDO NÃO RECEBEU O PACOTE) ──
                    const ehPedidoSuporte = ['5', '5️⃣', 'suporte', '!suporte', '.suporte', 'ajuda', '!ajuda', '.ajuda', 'socorro', 'contato', 'contacto', 'admin'].includes(cleanText);
                    const ehReclamacaoPacote = [
                        'nao recebi', 'não recebi', 'nao chegou', 'não chegou', 'ainda nao', 'ainda não',
                        'cade meu', 'cadê meu', 'onde esta meu', 'onde está o meu', 'nao ativou', 'não ativou',
                        'nao funciona', 'não funciona', 'demora', 'pacote nao', 'pacote não', 'sem megas', 'sem internet'
                    ].some(frase => cleanText.includes(frase));

                    if (ehPedidoSuporte || ehReclamacaoPacote) {
                        await reply(gerarMensagemSuporte(nomeCliente));
                        continue;
                    }

                    // ── 16. SAUDAÇÃO / BOAS VINDAS PADRÃO (APENAS PRIVADO OU SAUDAÇÃO EXPLÍCITA) ─
                    const isGroupMsg = jid.endsWith('@g.us');
                    const ehSaudacaoExplicita = ['oi', 'ola', 'olá', 'bom dia', 'boa tarde', 'boa noite', 'iniciar', 'start', 'começar', 'bot'].some(w => cleanText === w || cleanText.startsWith(w + ' '));

                    if (ehSaudacaoExplicita) {
                        await reply(gerarMensagemBoasVindas(nomeCliente));
                        continue;
                    }

                    // Se for mensagem de grupo e não bateu nenhum comando/comprovativo/menu, NÃO RESPONDER NADA!
                    if (isGroupMsg) {
                        continue;
                    }

                    // No privado, se o cliente mandar algo desconhecido, enviar as boas-vindas de suporte
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
