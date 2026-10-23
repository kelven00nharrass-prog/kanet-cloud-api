/* Ka-Net Licensing Admin — JavaScript */

const API_BASE = window.location.origin + '/licensing';
let masterToken = localStorage.getItem('kn_token') || '';
let allLicenses = [];

// ─── AUTH ─────────────────────────────────────────────────────────────────────

async function doLogin() {
  const token = document.getElementById('tokenInput').value.trim();
  if (!token) return showLoginError('Introduza o token de acesso');

  try {
    const res = await apiGet('/stats', token);
    if (res.success) {
      masterToken = token;
      localStorage.setItem('kn_token', token);
      document.getElementById('loginScreen').classList.add('hidden');
      document.getElementById('mainApp').classList.remove('hidden');
      loadDashboard();
      loadLicenses();
    } else {
      showLoginError('Token inválido ou sem permissões');
    }
  } catch (e) {
    showLoginError('Erro a ligar ao servidor: ' + e.message);
  }
}

function doLogout() {
  masterToken = '';
  localStorage.removeItem('kn_token');
  document.getElementById('mainApp').classList.add('hidden');
  document.getElementById('loginScreen').classList.remove('hidden');
  document.getElementById('tokenInput').value = '';
}

function showLoginError(msg) {
  const el = document.getElementById('loginError');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

// Verificar token guardado ao carregar
window.addEventListener('load', () => {
  if (masterToken) {
    document.getElementById('tokenInput').value = masterToken;
    doLogin();
  }

  // Enter no input de login
  document.getElementById('tokenInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') doLogin();
  });
});

// ─── TABS ─────────────────────────────────────────────────────────────────────

function showTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  document.getElementById('nav-' + name).classList.add('active');

  if (name === 'dashboard') loadDashboard();
  if (name === 'licenses')  loadLicenses();
  if (name === 'packages')  loadPackages();
}

// ─── API HELPERS ──────────────────────────────────────────────────────────────

async function apiGet(path, token) {
  const res = await fetch(API_BASE + path, {
    headers: { 'Authorization': 'Bearer ' + (token || masterToken) }
  });
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(API_BASE + path, {
    method:  'POST',
    headers: { 'Authorization': 'Bearer ' + masterToken, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body)
  });
  return res.json();
}

async function apiDelete(path) {
  const res = await fetch(API_BASE + path, {
    method:  'DELETE',
    headers: { 'Authorization': 'Bearer ' + masterToken }
  });
  return res.json();
}

async function apiPatch(path, body) {
  const res = await fetch(API_BASE + path, {
    method:  'PATCH',
    headers: { 'Authorization': 'Bearer ' + masterToken, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body)
  });
  return res.json();
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────

async function loadDashboard() {
  try {
    const data = await apiGet('/stats');
    if (!data.success) return;
    const s = data.stats;

    document.getElementById('stat-total').querySelector('.stat-value').textContent   = s.total;
    document.getElementById('stat-active').querySelector('.stat-value').textContent  = s.active;
    document.getElementById('stat-expired').querySelector('.stat-value').textContent = s.expired;
    document.getElementById('stat-revenue').querySelector('.stat-value').textContent =
      s.revenueMonthly.toLocaleString('pt-MZ') + ' MT';

    // Package breakdown
    const pkgLabels = {
      revendedor_basico: '🔵 Revendedor Básico',
      revendedor_pro:    '🟡 Revendedor Pro',
      fornecedor:        '🟠 Fornecedor',
      full:              '🔴 FULL'
    };
    const pkgEl = document.getElementById('packageBreakdown');
    pkgEl.innerHTML = Object.entries(s.byPackage).map(([id, count]) => `
      <div class="pkg-row">
        <span>${pkgLabels[id] || id}</span>
        <span class="pkg-count">${count}</span>
      </div>
    `).join('');

    // Expiring soon (carrega das licenças)
    const licsData = await apiGet('/licenses');
    if (licsData.success) {
      const now = new Date();
      const soon = licsData.licenses
        .filter(l => l.status === 'active')
        .map(l => ({ ...l, msLeft: new Date(l.expiryDate) - now }))
        .filter(l => l.msLeft > 0 && l.msLeft <= 3 * 24 * 60 * 60 * 1000)
        .sort((a, b) => a.msLeft - b.msLeft);

      const expiringEl = document.getElementById('expiringSoon');
      if (soon.length === 0) {
        expiringEl.innerHTML = '<div style="color:var(--text2);font-size:13px">Nenhuma licença a expirar em breve 👍</div>';
      } else {
        expiringEl.innerHTML = soon.map(l => {
          const days = Math.ceil(l.msLeft / (1000 * 60 * 60 * 24));
          return `
            <div class="expiring-item">
              <div>
                <div style="font-weight:600">${l.ownerName}</div>
                <div style="font-size:11px;color:var(--text2)">${l.licenseId}</div>
              </div>
              <span class="days-badge">${days}d</span>
            </div>
          `;
        }).join('');
      }
    }
  } catch (e) {
    console.error('Dashboard error:', e);
  }
}

// ─── LICENÇAS ─────────────────────────────────────────────────────────────────

async function loadLicenses() {
  try {
    const data = await apiGet('/licenses');
    if (!data.success) return;
    allLicenses = data.licenses;
    renderLicenses(allLicenses);
  } catch (e) {
    document.getElementById('licensesBody').innerHTML =
      `<tr><td colspan="8" class="loading-row" style="color:var(--red)">Erro: ${e.message}</td></tr>`;
  }
}

function filterLicenses() {
  const q = document.getElementById('searchInput').value.toLowerCase();
  const filtered = allLicenses.filter(l =>
    l.ownerName.toLowerCase().includes(q) ||
    l.ownerPhone.includes(q) ||
    l.licenseId.toLowerCase().includes(q)
  );
  renderLicenses(filtered);
}

function renderLicenses(licenses) {
  const body = document.getElementById('licensesBody');
  if (licenses.length === 0) {
    body.innerHTML = '<tr><td colspan="8" class="loading-row">Nenhuma licença encontrada</td></tr>';
    return;
  }

  const now = new Date();
  body.innerHTML = licenses.map(l => {
    const expiry = new Date(l.expiryDate);
    const msLeft = expiry - now;
    const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));
    const isExpired = msLeft <= 0 || l.status === 'expired';
    const statusBadge = {
      active:    '<span class="badge badge-active">🟢 Activa</span>',
      expired:   '<span class="badge badge-expired">🔴 Expirada</span>',
      suspended: '<span class="badge badge-suspended">🟡 Suspensa</span>',
      trial:     '<span class="badge badge-trial">🟣 Trial</span>'
    }[l.status] || l.status;

    const pkgLabels = {
      revendedor_basico: '🔵 Básico',
      revendedor_pro:    '🟡 Pro',
      fornecedor:        '🟠 Fornecedor',
      full:              '🔴 FULL'
    };

    const daysText = isExpired
      ? '<span style="color:var(--red)">Expirada</span>'
      : daysLeft <= 3
        ? `<span style="color:var(--orange)">${daysLeft}d ⚠️</span>`
        : `<span style="color:var(--text2)">${daysLeft}d</span>`;

    const sessions = l.whatsappSessions?.length || 0;

    return `
      <tr>
        <td class="license-id">${l.licenseId}</td>
        <td>${l.ownerName}</td>
        <td class="phone-cell">${l.ownerPhone}</td>
        <td>${pkgLabels[l.packageId] || l.packageId}</td>
        <td>${statusBadge}</td>
        <td>${daysText}</td>
        <td style="font-family:var(--mono)">${sessions}</td>
        <td>
          <button class="action-btn" style="background:rgba(59,130,246,0.15);color:var(--accent2);border-color:rgba(59,130,246,0.3)" title="Abrir Portal deste Licenciado" onclick="openClientPortal('${l.masterToken}')">👤 Portal</button>
          <button class="action-btn view"    onclick="viewLicense('${l.licenseId}')">👁 Ver</button>
          <button class="action-btn renew"   onclick="renewLicense('${l.licenseId}')">↻ Renovar</button>
          ${l.status === 'suspended'
            ? `<button class="action-btn" onclick="activateLicense('${l.licenseId}')">✅ Activar</button>`
            : `<button class="action-btn suspend" onclick="suspendLicense('${l.licenseId}')">⏸ Suspender</button>`
          }
          <button class="action-btn delete" onclick="deleteLicense('${l.licenseId}')">🗑</button>
        </td>
      </tr>
    `;
  }).join('');
}

// ─── ACÇÕES DE LICENÇA ────────────────────────────────────────────────────────

async function renewLicense(id) {
  const days = prompt(`Renovar ${id} por quantos dias?`, '30');
  if (!days) return;
  const res = await apiPost(`/licenses/${id}/renew`, { durationDays: parseInt(days) });
  if (res.success) {
    showToast(`✅ ${id} renovada por ${days} dias!`);
    loadLicenses(); loadDashboard();
  } else {
    showToast('❌ Erro: ' + res.error, true);
  }
}

async function suspendLicense(id) {
  const reason = prompt(`Motivo da suspensão de ${id}:`, 'Pagamento em falta');
  if (reason === null) return;
  const res = await apiPost(`/licenses/${id}/suspend`, { reason });
  if (res.success) {
    showToast(`⏸ ${id} suspensa`);
    loadLicenses(); loadDashboard();
  } else {
    showToast('❌ Erro: ' + res.error, true);
  }
}

async function activateLicense(id) {
  const res = await apiPost(`/licenses/${id}/activate`, {});
  if (res.success) {
    showToast(`✅ ${id} activada`);
    loadLicenses();
  } else {
    showToast('❌ Erro: ' + res.error, true);
  }
}

async function deleteLicense(id) {
  if (!confirm(`Eliminar definitivamente a licença ${id}?\nEsta acção não pode ser revertida.`)) return;
  const res = await apiDelete(`/licenses/${id}`);
  if (res.success) {
    showToast(`🗑 ${id} eliminada`);
    loadLicenses(); loadDashboard();
  } else {
    showToast('❌ Erro: ' + res.error, true);
  }
}

// ─── VER DETALHES ─────────────────────────────────────────────────────────────

async function viewLicense(id) {
  const data = await apiGet(`/licenses/${id}`);
  if (!data.success) return showToast('❌ ' + data.error, true);
  const l = data.license;

  const expiry = new Date(l.expiryDate);
  const daysLeft = Math.ceil((expiry - new Date()) / (1000 * 60 * 60 * 24));

  const mastersHtml = (l.masterNumbers || []).map(m => `
    <div style="background:var(--bg3);border-radius:6px;padding:8px 12px;margin-bottom:6px;font-size:12px">
      <span style="font-family:var(--mono)">${m.number}</span>
      <span style="color:var(--text2);margin-left:8px">${m.permissions.join(', ')}</span>
    </div>
  `).join('') || '<div style="color:var(--text2);font-size:12px">Nenhum número master</div>';

  const sessionsHtml = (l.whatsappSessions || []).map(s => `
    <div style="background:var(--bg3);border-radius:6px;padding:8px 12px;margin-bottom:6px;font-size:12px">
      <span style="font-family:var(--mono)">${s.phone}</span>
      <span class="badge badge-active" style="margin-left:8px;font-size:10px">🟢 Conectado</span>
    </div>
  `).join('') || '<div style="color:var(--text2);font-size:12px">Nenhuma sessão WhatsApp</div>';

  document.getElementById('modalContent').innerHTML = `
    <h3>🔐 ${l.licenseId} — ${l.ownerName}</h3>

    <div class="detail-row"><span class="detail-label">ID</span><span class="detail-value">${l.licenseId}</span></div>
    <div class="detail-row"><span class="detail-label">Nome</span><span class="detail-value">${l.ownerName}</span></div>
    <div class="detail-row"><span class="detail-label">Telefone</span><span class="detail-value">${l.ownerPhone}</span></div>
    <div class="detail-row"><span class="detail-label">Pacote</span><span class="detail-value">${l.packageName}</span></div>
    <div class="detail-row"><span class="detail-label">Estado</span><span class="detail-value">${l.status.toUpperCase()}</span></div>
    <div class="detail-row"><span class="detail-label">Início</span><span class="detail-value">${new Date(l.startDate).toLocaleDateString('pt')}</span></div>
    <div class="detail-row"><span class="detail-label">Expira</span><span class="detail-value">${expiry.toLocaleDateString('pt')} (${daysLeft}d)</span></div>
    <div class="detail-row"><span class="detail-label">Token</span><span class="detail-value" style="font-size:11px">${l.masterToken}</span></div>
    <div class="detail-row"><span class="detail-label">Criado</span><span class="detail-value">${new Date(l.createdAt).toLocaleString('pt')}</span></div>

    <h4>📱 Sessões WhatsApp</h4>
    ${sessionsHtml}

    <h4>👑 Números Master</h4>
    ${mastersHtml}

    <div class="modal-actions" style="flex-wrap:wrap;gap:8px;">
      <button class="btn-primary" onclick="renewLicense('${l.licenseId}');closeModal()">↻ Renovar</button>
      <button class="btn-secondary" style="border-color:var(--accent);color:var(--accent2)" onclick="openClientPortal('${l.masterToken}')">👤 Aceder ao Portal</button>
      <button class="btn-secondary" onclick="copyClientMessage('${l.licenseId}', '${l.ownerName}', '${l.masterToken}', '${l.expiryDate}')">📋 Copiar Mensagem WhatsApp</button>
      ${l.status === 'suspended'
        ? `<button class="btn-secondary" onclick="activateLicense('${l.licenseId}');closeModal()">✅ Activar</button>`
        : `<button class="btn-secondary" onclick="suspendLicense('${l.licenseId}');closeModal()">⏸ Suspender</button>`
      }
      <button class="btn-secondary" style="border-color:var(--red);color:var(--red)" onclick="deleteLicense('${l.licenseId}');closeModal()">🗑 Eliminar</button>
    </div>
  `;
  openModal();
}

function openClientPortal(token) {
  window.open(`/licensing/portal/?token=${encodeURIComponent(token)}`, '_blank');
}

function copyClientMessage(id, name, token, expiry) {
  const url = `${window.location.origin}/licensing/portal/?token=${token}`;
  const text = `✅ *SUA LICENÇA KA-NET FOI ATIVADA!*\n━━━━━━━━━━━━━━━━━━━\n👤 *Titular:* ${name}\n🔑 *Código:* ${id}\n📅 *Expiração:* ${new Date(expiry).toLocaleDateString('pt')}\n\n🌐 *Portal de Gestão do Licenciado:*\n${url}\n\n🔐 *Sua Chave de Acesso:* \`${token}\`\n\n_Guarde esta mensagem para acessar ao seu painel e configurar seus números master._`;
  navigator.clipboard.writeText(text).then(() => {
    alert('✅ Mensagem copiada com sucesso! Pode colar e enviar ao cliente via WhatsApp.');
  }).catch(() => {
    prompt('Copie a mensagem abaixo:', text);
  });
}

// ─── CRIAR LICENÇA ────────────────────────────────────────────────────────────

function onPackageChange() {
  const pkg = document.getElementById('newPackage').value;
  const section = document.getElementById('portMappingSection');
  const grid = document.getElementById('portMappingGrid');

  if (pkg === 'full') {
    section.style.display = 'block';
    const ports = ['Porta 1 (Normal)', 'Porta 2 (Normal)', 'Porta 3 (Normal)', 'Porta 4 (Normal)', 'Porta 8777', 'Porta Saldo'];
    grid.innerHTML = ports.map((name, i) => `
      <div class="port-row">
        <label>🔌 ${name}</label>
        <select id="portMap_${i}">
          <option value="revenda">Revenda</option>
          <option value="fornecimento">Fornecimento</option>
          <option value="ambos">Ambos</option>
        </select>
      </div>
    `).join('');
  } else {
    section.style.display = 'none';
  }
}

let masterRowCount = 1;
function addMasterRow() {
  const div = document.createElement('div');
  div.className = 'master-entry';
  div.id = 'masterEntry' + masterRowCount;
  div.innerHTML = `
    <input type="text" placeholder="258841234567" class="master-number-input"/>
    <div class="permissions-check">
      <label><input type="checkbox" value="admin" checked/> Admin</label>
      <label><input type="checkbox" value="relatorios"/> Relatórios</label>
      <label><input type="checkbox" value="configurar"/> Config</label>
      <label><input type="checkbox" value="txeneco"/> Txeneco</label>
      <label><input type="checkbox" value="grupos"/> Grupos</label>
      <label><input type="checkbox" value="clientes"/> Clientes</label>
    </div>
    <button class="btn-secondary" style="margin-top:8px;font-size:12px" onclick="this.parentElement.remove()">✕ Remover</button>
  `;
  document.getElementById('masterNumbersList').appendChild(div);
  masterRowCount++;
}

async function createLicense() {
  const name       = document.getElementById('newName').value.trim();
  const phone      = document.getElementById('newPhone').value.trim();
  const packageId  = document.getElementById('newPackage').value;
  const duration   = parseInt(document.getElementById('newDuration').value) || 30;

  const errEl = document.getElementById('createError');
  const okEl  = document.getElementById('createSuccess');
  errEl.classList.add('hidden');
  okEl.classList.add('hidden');

  if (!name || !phone || !packageId) {
    errEl.textContent = 'Preencha todos os campos obrigatórios (*)';
    errEl.classList.remove('hidden');
    return;
  }

  // Recolher números master
  const masterNumbers = [];
  document.querySelectorAll('.master-entry').forEach(entry => {
    const number = entry.querySelector('.master-number-input')?.value.trim();
    if (!number) return;
    const perms = Array.from(entry.querySelectorAll('.permissions-check input:checked')).map(c => c.value);
    masterNumbers.push({ number, permissions: perms });
  });

  // Recolher port mapping (pacote FULL)
  const portMapping = {};
  if (packageId === 'full') {
    const portNames = ['porta1', 'porta2', 'porta3', 'porta4', 'porta8777', 'portaSaldo'];
    portNames.forEach((key, i) => {
      const sel = document.getElementById('portMap_' + i);
      if (sel) portMapping[key] = sel.value;
    });
  }

  const res = await apiPost('/licenses', { ownerName: name, ownerPhone: phone, packageId, durationDays: duration, masterNumbers, portMapping });

  if (res.success) {
    okEl.textContent = `✅ Licença ${res.license.licenseId} criada! Token: ${res.license.masterToken}`;
    okEl.classList.remove('hidden');
    clearForm();
    loadDashboard();
    loadLicenses();
  } else {
    errEl.textContent = '❌ Erro: ' + res.error;
    errEl.classList.remove('hidden');
  }
}

function clearForm() {
  document.getElementById('newName').value = '';
  document.getElementById('newPhone').value = '';
  document.getElementById('newPackage').value = '';
  document.getElementById('newDuration').value = '30';
  document.getElementById('portMappingSection').style.display = 'none';
  document.getElementById('masterNumbersList').innerHTML = `
    <div class="master-entry" id="masterEntry0">
      <input type="text" placeholder="258841234567" class="master-number-input"/>
      <div class="permissions-check">
        <label><input type="checkbox" value="admin" checked/> Admin</label>
        <label><input type="checkbox" value="relatorios"/> Relatórios</label>
        <label><input type="checkbox" value="configurar"/> Config</label>
        <label><input type="checkbox" value="txeneco"/> Txeneco</label>
        <label><input type="checkbox" value="grupos"/> Grupos</label>
        <label><input type="checkbox" value="clientes"/> Clientes</label>
      </div>
    </div>
  `;
}

// ─── PACOTES ──────────────────────────────────────────────────────────────────

async function loadPackages() {
  const data = await apiGet('/packages');
  if (!data.success) return;

  document.getElementById('packagesGrid').innerHTML = data.packages.map(pkg => {
    const maxWA = pkg.maxWhatsapps === -1 ? 'Ilimitado' : `Até ${pkg.maxWhatsapps}`;
    return `
      <div class="pkg-card">
        <h3>${pkg.name}</h3>
        <div class="price">${pkg.price.toLocaleString('pt-MZ')} MT<span>/mês</span></div>
        <div class="pkg-feature yes">📱 WhatsApp: ${maxWA}</div>
        <div class="pkg-feature ${pkg.ports.normalCount !== 0 ? 'yes' : 'no'}">
          🔌 Portas normais: ${pkg.ports.normalCount === -1 ? 'Todas' : pkg.ports.normalCount}
        </div>
        <div class="pkg-feature ${pkg.ports.port8777 ? 'yes' : 'no'}">
          🔵 Porta 8777: ${pkg.ports.port8777 ? 'Sim' : 'Não'}
        </div>
        <div class="pkg-feature ${pkg.ports.saldo ? 'yes' : 'no'}">
          💰 Porta Saldo: ${pkg.ports.saldo ? 'Sim' : 'Não'}
        </div>
        <div class="pkg-feature ${pkg.portMapping ? 'yes' : 'no'}">
          🗺 Mapeamento por tipo: ${pkg.portMapping ? 'Sim' : 'Não'}
        </div>
        <div class="pkg-feature yes">👑 Números Master: Sim</div>
      </div>
    `;
  }).join('');
}

// ─── MODAL ────────────────────────────────────────────────────────────────────

function openModal()  { document.getElementById('modalOverlay').classList.remove('hidden'); }
function closeModal() { document.getElementById('modalOverlay').classList.add('hidden'); }

// ─── TOAST ────────────────────────────────────────────────────────────────────

function showToast(msg, isError = false) {
  const toast = document.createElement('div');
  toast.style.cssText = `
    position:fixed; bottom:24px; right:24px; z-index:9999;
    background:${isError ? '#450a0a' : '#14532d'};
    border:1px solid ${isError ? '#7f1d1d' : '#166534'};
    color:${isError ? '#f87171' : '#4ade80'};
    padding:12px 20px; border-radius:10px;
    font-family:'Inter',sans-serif; font-size:14px; font-weight:600;
    box-shadow:0 8px 32px rgba(0,0,0,0.5);
    animation: fadeUp 0.3s ease;
    max-width: 360px;
  `;
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}
