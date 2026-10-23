/**
 * Ka-Net Portal — Lógica do Licenciado (Client App)
 * -------------------------------------------------
 * Comunica com /licensing/me, /licensing/me/masters, etc.
 */

'use strict';

const API_BASE = '/licensing';
let currentToken = localStorage.getItem('kanet_client_token') || '';
let currentLicense = null;

// ─── INICIALIZAÇÃO ───────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const tokenFromUrl = urlParams.get('token');

  if (tokenFromUrl) {
    document.getElementById('tokenInput').value = tokenFromUrl;
    validateAndEnter(tokenFromUrl);
  } else if (currentToken) {
    validateAndEnter(currentToken);
  } else {
    showLogin();
  }
});

// ─── LOGIN & SESSÃO ──────────────────────────────────────────────────────────
async function doLogin() {
  const input = document.getElementById('tokenInput');
  const errBox = document.getElementById('loginError');
  const token = (input.value || '').trim();

  if (!token) {
    showLoginError('Por favor insira a sua chave de licença.');
    return;
  }

  errBox.classList.add('hidden');
  const btn = document.getElementById('loginBtn');
  btn.disabled = true;
  btn.textContent = 'A verificar...';

  try {
    const res = await fetch(`${API_BASE}/me`, {
      headers: { 'X-License-Token': token }
    });
    const data = await res.json();

    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Chave de licença inválida ou inexistente.');
    }

    // Salvar e entrar
    currentToken = token;
    localStorage.setItem('kanet_client_token', token);
    currentLicense = data.license;

    showApp();
    renderLicense(currentLicense);
    loadMasters();
  } catch (err) {
    showLoginError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Aceder ao Painel';
  }
}

async function validateAndEnter(token) {
  try {
    const res = await fetch(`${API_BASE}/me`, {
      headers: { 'X-License-Token': token }
    });
    const data = await res.json();

    if (res.ok && data.success) {
      currentLicense = data.license;
      showApp();
      renderLicense(currentLicense);
      loadMasters();
      return;
    }
  } catch (e) {
    // Falha de rede ou token inválido
  }
  // Se falhar validação:
  doLogout();
}

function doLogout() {
  currentToken = '';
  currentLicense = null;
  localStorage.removeItem('kanet_client_token');
  showLogin();
}

function showLogin() {
  document.getElementById('loginScreen').classList.remove('hidden');
  document.getElementById('mainApp').classList.add('hidden');
}

function showApp() {
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('mainApp').classList.remove('hidden');
}

function showLoginError(msg) {
  const errBox = document.getElementById('loginError');
  errBox.textContent = msg;
  errBox.classList.remove('hidden');
}

// ─── NAVEGAÇÃO POR ABAS ───────────────────────────────────────────────────────
function showTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));

  const navBtn = document.getElementById(`nav-${tabId}`);
  const content = document.getElementById(`tab-${tabId}`);
  if (navBtn) navBtn.classList.add('active');
  if (content) content.classList.add('active');

  if (tabId === 'masters') {
    loadMasters();
  }
}

// ─── CARREGAR DADOS DA LICENÇA ───────────────────────────────────────────────
async function loadLicenseData() {
  if (!currentToken) return;
  try {
    const res = await fetch(`${API_BASE}/me`, {
      headers: { 'X-License-Token': currentToken }
    });
    const data = await res.json();
    if (data.success) {
      currentLicense = data.license;
      renderLicense(currentLicense);
      showToast('Dados atualizados com sucesso!', 'success');
    }
  } catch (err) {
    showToast('Erro ao atualizar: ' + err.message, 'error');
  }
}

function renderLicense(lic) {
  if (!lic) return;

  // Header
  document.getElementById('headerOwnerName').textContent = lic.ownerName || 'Ka-Net Licenciado';
  document.getElementById('headerLicenseId').textContent = `Licença: ${lic.licenseId}`;

  // Status Badge
  const badge = document.getElementById('statusBadge');
  const alertBox = document.getElementById('expiryAlert');

  const now = new Date();
  const expiry = new Date(lic.expiryDate);
  const msLeft = expiry - now;
  const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));

  if (lic.status === 'suspended') {
    badge.className = 'badge badge-suspended';
    badge.textContent = '🟡 Suspensa';
    alertBox.className = 'alert-box alert-warning';
    alertBox.innerHTML = `⚠️ <strong>Licença Suspensa:</strong> ${lic.suspendReason || 'Contacte o suporte para reativar.'}`;
    alertBox.classList.remove('hidden');
  } else if (daysLeft <= 0 || lic.status === 'expired') {
    badge.className = 'badge badge-expired';
    badge.textContent = '🔴 Expirada';
    alertBox.className = 'alert-box alert-danger';
    alertBox.innerHTML = `❌ <strong>Licença Expirada:</strong> O seu período terminou em ${formatDate(lic.expiryDate)}. Solicite a renovação para continuar a usar o sistema.`;
    alertBox.classList.remove('hidden');
  } else {
    badge.className = 'badge badge-active';
    badge.textContent = '🟢 Ativa';
    if (daysLeft <= 3) {
      alertBox.className = 'alert-box alert-warning';
      alertBox.innerHTML = `⏳ <strong>Atenção:</strong> A sua licença expira em apenas <strong>${daysLeft} dia(s)</strong> (${formatDate(lic.expiryDate)}). Renove antecipadamente para evitar interrupções.`;
      alertBox.classList.remove('hidden');
    } else {
      alertBox.classList.add('hidden');
    }
  }

  // Cards de Métricas
  const pkgLimits = lic.limits || {};
  document.getElementById('cardPackageName').textContent = formatPackageName(lic.packageId);
  document.getElementById('cardPackagePrice').textContent = getPackagePrice(lic.packageId);

  const daysElem = document.getElementById('cardDaysLeft');
  daysElem.textContent = daysLeft > 0 ? `${daysLeft} dias` : 'Expirada';
  daysElem.className = daysLeft > 3 ? 'metric-val text-green' : (daysLeft > 0 ? 'metric-val text-yellow' : 'metric-val text-red');
  document.getElementById('cardExpiryDate').textContent = `Até ${formatDate(lic.expiryDate)}`;

  const phonesLimit = pkgLimits.maxPhones === 'unlimited' ? 'Ilimitado' : (pkgLimits.maxPhones || 2);
  const phonesUsed = (lic.whatsappSessions || []).length;
  document.getElementById('cardPhonesLimit').textContent = phonesLimit;
  document.getElementById('cardPhonesUsed').textContent = `${phonesUsed} conectado(s)`;

  const normalPorts = pkgLimits.maxNormalPorts === 'unlimited' ? 'Ilimitadas' : `${pkgLimits.maxNormalPorts || 1} normal`;
  document.getElementById('cardPortsLimit').textContent = normalPorts;
  document.getElementById('cardVipPort').textContent = pkgLimits.max8777Ports ? `+ 1 Porta VIP (8777)` : (pkgLimits.hasSaldoPort ? `+ Porta Saldo` : 'Padrão');

  // Detalhes da Tabela
  document.getElementById('detOwnerName').textContent = lic.ownerName || '—';
  document.getElementById('detOwnerPhone').textContent = lic.ownerPhone || '—';
  document.getElementById('detLicenseId').textContent = lic.licenseId || '—';
  document.getElementById('detStartDate').textContent = formatDate(lic.startDate);
  document.getElementById('detExpiryDate').textContent = formatDate(lic.expiryDate);
  document.getElementById('detLastHeartbeat').textContent = lic.lastHeartbeat ? formatDateTime(lic.lastHeartbeat) : 'Aguardando primeiro envio';

  // Botão WhatsApp com mensagem pronta
  const renewBtn = document.getElementById('btnWhatsAppRenew');
  const msgWpp = encodeURIComponent(`Olá Kelven, gostaria de solicitar a renovação da minha licença Ka-Net (${lic.licenseId} - ${lic.ownerName}).`);
  renewBtn.href = `https://wa.me/258850401416?text=${msgWpp}`;

  // Renderizar Portas Info
  renderPortsTab(lic);
}

// ─── NÚMEROS MASTER (ADMINISTRADORES) ─────────────────────────────────────────
async function loadMasters() {
  if (!currentToken) return;
  const container = document.getElementById('mastersListContainer');
  container.innerHTML = '<p class="text-muted">A carregar mestres...</p>';

  try {
    const res = await fetch(`${API_BASE}/me/masters`, {
      headers: { 'X-License-Token': currentToken }
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error);

    renderMastersList(data.masterNumbers || []);
  } catch (err) {
    container.innerHTML = `<p class="error-msg">Erro ao carregar mestres: ${err.message}</p>`;
  }
}

function renderMastersList(masters) {
  const container = document.getElementById('mastersListContainer');
  if (!masters || masters.length === 0) {
    container.innerHTML = '<p class="text-muted">Nenhum administrador cadastrado. Adicione um número acima para autorizar comandos no WhatsApp.</p>';
    return;
  }

  let html = `
    <table class="masters-table">
      <thead>
        <tr>
          <th>Número</th>
          <th>Permissões</th>
          <th style="text-align: right;">Ações</th>
        </tr>
      </thead>
      <tbody>
  `;

  masters.forEach(m => {
    const pills = (m.permissions || []).map(p => `<span class="perm-pill">${p}</span>`).join(' ') || '<span class="text-muted">Nenhuma</span>';
    html += `
      <tr>
        <td><strong class="mono">${m.number}</strong></td>
        <td>${pills}</td>
        <td style="text-align: right;">
          <button class="btn-danger-sm" onclick="handleDeleteMaster('${m.number}')">Remover</button>
        </td>
      </tr>
    `;
  });

  html += '</tbody></table>';
  container.innerHTML = html;
}

async function handleAddMaster(e) {
  e.preventDefault();
  const input = document.getElementById('masterPhoneInput');
  const rawNum = input.value.trim().replace(/\D/g, '');

  if (!rawNum || rawNum.length < 9) {
    showToast('Por favor digite um número válido com pelo menos 9 dígitos.', 'error');
    return;
  }

  // Normalizar número para 258 se for 9 dígitos
  const cleanNum = rawNum.length === 9 ? `258${rawNum}` : rawNum;

  const permissions = [];
  if (document.getElementById('permAdmin').checked) permissions.push('admin');
  if (document.getElementById('permRelatorios').checked) permissions.push('relatorios');
  if (document.getElementById('permConfigurar').checked) permissions.push('configurar');
  if (document.getElementById('permTxeneco').checked) permissions.push('txeneco');

  const btn = document.getElementById('btnAddMaster');
  btn.disabled = true;
  btn.textContent = 'A adicionar...';

  try {
    const res = await fetch(`${API_BASE}/me/masters`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-License-Token': currentToken
      },
      body: JSON.stringify({ number: cleanNum, permissions })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error);

    input.value = '';
    showToast(`Número ${cleanNum} registado como Master!`, 'success');
    renderMastersList(data.masterNumbers || []);
  } catch (err) {
    showToast('Erro: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Adicionar Master';
  }
}

async function handleDeleteMaster(num) {
  if (!confirm(`Tem a certeza que deseja remover ${num} dos administradores?`)) return;

  try {
    const res = await fetch(`${API_BASE}/me/masters/${encodeURIComponent(num)}`, {
      method: 'DELETE',
      headers: { 'X-License-Token': currentToken }
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error);

    showToast(`Número ${num} removido com sucesso.`, 'success');
    renderMastersList(data.masterNumbers || []);
  } catch (err) {
    showToast('Erro ao remover: ' + err.message, 'error');
  }
}

// ─── PORTAS & SESSÕES ─────────────────────────────────────────────────────────
function renderPortsTab(lic) {
  const grid = document.getElementById('portsInfoGrid');
  const limits = lic.limits || {};

  grid.innerHTML = `
    <div class="port-box">
      <h4>Portas Celulares Normais</h4>
      <p><strong>${limits.maxNormalPorts === 'unlimited' ? 'Ilimitadas' : (limits.maxNormalPorts || 1)} porta(s)</strong> de envio de transferências.</p>
    </div>
    <div class="port-box">
      <h4>Porta VIP (8777)</h4>
      <p><strong>${limits.max8777Ports ? '1 Porta Ativa' : 'Não Incluída'}</strong> para processamento prioritário.</p>
    </div>
    <div class="port-box">
      <h4>Porta de Saldo</h4>
      <p><strong>${limits.hasSaldoPort ? 'Disponível' : 'Não Incluída'}</strong> para operações de fornecimento.</p>
    </div>
    <div class="port-box">
      <h4>Sessões WhatsApp</h4>
      <p><strong>${limits.maxPhones === 'unlimited' ? 'Ilimitadas' : (limits.maxPhones || 2)} sessão(ões)</strong> ativas simultaneamente.</p>
    </div>
  `;

  // Se for pacote Full, exibir mapeamento
  const fullCard = document.getElementById('fullPortMappingCard');
  if (lic.packageId === 'full') {
    fullCard.style.display = 'block';
    renderFullPortMapping(lic.portMapping || {});
  } else {
    fullCard.style.display = 'none';
  }
}

function renderFullPortMapping(mapping) {
  const container = document.getElementById('portMappingFormContainer');
  const ports = ['8021', '8022', '8023', '8024', '8025', '8026'];

  let html = '<div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap:12px; margin-top:12px;">';
  ports.forEach(p => {
    const val = mapping[p] || 'revenda';
    html += `
      <div class="port-box">
        <h4>Porta ${p}</h4>
        <select onchange="updatePortRole('${p}', this.value)" style="width:100%; padding:8px; background:var(--bg-card); color:var(--text); border:1px solid var(--border); border-radius:6px; margin-top:6px;">
          <option value="revenda" ${val === 'revenda' ? 'selected' : ''}>Revenda</option>
          <option value="fornecimento" ${val === 'fornecimento' ? 'selected' : ''}>Fornecimento</option>
          <option value="ambos" ${val === 'ambos' ? 'selected' : ''}>Ambos</option>
        </select>
      </div>
    `;
  });
  html += '</div>';
  container.innerHTML = html;
}

async function updatePortRole(port, role) {
  try {
    const currentMap = currentLicense.portMapping || {};
    currentMap[port] = role;

    const res = await fetch(`${API_BASE}/me/port-mapping`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-License-Token': currentToken
      },
      body: JSON.stringify({ portMapping: currentMap })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error);

    currentLicense.portMapping = data.portMapping;
    showToast(`Porta ${port} atualizada para ${role.toUpperCase()}`, 'success');
  } catch (err) {
    showToast('Erro ao atualizar porta: ' + err.message, 'error');
  }
}

// ─── HELPERS DE FORMATAÇÃO ────────────────────────────────────────────────────
function formatDate(dStr) {
  if (!dStr) return '—';
  const d = new Date(dStr);
  return d.toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatDateTime(dStr) {
  if (!dStr) return '—';
  const d = new Date(dStr);
  return d.toLocaleString('pt-PT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatPackageName(pkgId) {
  const map = {
    revendedor_basico: 'Revendedor Básico',
    revendedor_pro: 'Revendedor Pro',
    fornecedor: 'Fornecedor',
    full: 'Pacote Full (Revenda + Fornec.)'
  };
  return map[pkgId] || pkgId || '—';
}

function getPackagePrice(pkgId) {
  const map = {
    revendedor_basico: '500 MT / mês',
    revendedor_pro: '1.200 MT / mês',
    fornecedor: '1.500 MT / mês',
    full: '2.000 MT / mês'
  };
  return map[pkgId] || '—';
}

function showToast(msg, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = `toast toast-${type}`;
  toast.classList.remove('hidden');

  setTimeout(() => {
    toast.classList.add('hidden');
  }, 4000);
}
