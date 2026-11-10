// Estado global del frontend (soporte simultáneo para Ciclo Banesco y Ciclo Banco de Venezuela)
const state = {
  authToken: null,
  userRole: null,
  userName: '',
  clientId: null,
  merchantId: null,
  hasCredentials: false,
  pingMs: 0,
  fundingBalance: null,
  selectedBank: 'Banesco', // 'Banesco' | 'Banco de Venezuela'
  merchants: [],
  clients: [],
  activeCycles: {
    'Banesco': null,
    'Banco de Venezuela': null
  },
  cyclesData: {
    'Banesco': null,
    'Banco de Venezuela': null
  },
  cycleHistory: [],
  viewingHistoryCycle: null, // Si no hay ciclo activo en la pestaña actual y el usuario inspecciona uno del historial
  isSyncing: false,
  timerInterval: null,
  autoRefreshInterval: null
};

// Formateadores numéricos (2 decimales para VES, USDT y Comisiones)
const fmtVes = new Intl.NumberFormat('es-VE', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

const fmtUsdt = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

const fmtCommUsdt = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

function formatVes(val) {
  return `Bs. ${fmtVes.format(Number(val || 0))}`;
}

function formatUsdt(val) {
  return `${fmtUsdt.format(Number(val || 0))} USDT`;
}

function formatDateTime(ms) {
  if (!ms) return '--';
  const d = new Date(Number(ms));
  return d.toLocaleString('es-VE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function formatElapsed(startMs) {
  const diffSec = Math.max(0, Math.floor((Date.now() - Number(startMs)) / 1000));
  const hrs = String(Math.floor(diffSec / 3600)).padStart(2, '0');
  const mins = String(Math.floor((diffSec % 3600) / 60)).padStart(2, '0');
  const secs = String(diffSec % 60).padStart(2, '0');
  return `${hrs}:${mins}:${secs}`;
}

function parseFlexibleVesAmount(rawStr) {
  if (!rawStr) return 0;
  let cleaned = String(rawStr).replace(/[^\d.,]/g, '').trim();
  if (!cleaned) return 0;

  const hasDot = cleaned.includes('.');
  const hasComma = cleaned.includes(',');

  if (hasDot && hasComma) {
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      cleaned = cleaned.replace(/,/g, '');
    }
  } else if (hasDot) {
    if (/^\d{1,3}(\.\d{3})+$/.test(cleaned)) {
      cleaned = cleaned.replace(/\./g, '');
    }
  } else if (hasComma) {
    if (/^\d{1,3}(,\d{3})+$/.test(cleaned)) {
      cleaned = cleaned.replace(/,/g, '');
    } else {
      cleaned = cleaned.replace(',', '.');
    }
  }

  const num = Number(cleaned);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

function showAlert(message, type = 'info', autoHideMs = 6000) {
  const box = document.getElementById('alertBox');
  box.className = `alert alert-${type}`;
  box.innerHTML = `
    <span>${message}</span>
    <button class="btn-icon" onclick="document.getElementById('alertBox').classList.add('hidden')">✕</button>
  `;
  box.classList.remove('hidden');

  if (autoHideMs > 0) {
    setTimeout(() => {
      box.classList.add('hidden');
    }, autoHideMs);
  }
}

async function apiFetch(url, options = {}) {
  const token = state.authToken || '';
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { 'x-auth-token': token } : {}),
    ...(options.headers || {})
  };

  const res = await fetch(url, {
    ...options,
    headers
  });
  const data = await res.json();

  if (res.status === 401 && data.unauthorized) {
    state.authToken = null;
    state.userRole = null;
    showLoginScreen();
    throw new Error('Sesión no iniciada');
  }

  if (!res.ok || data.ok === false) {
    throw new Error(data.error || data.message || `Error HTTP ${res.status}`);
  }
  return data;
}

// Bloquear zoom con los dedos (pinch-to-zoom) y doble toque en teléfonos (iOS Safari y Android)
document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
document.addEventListener('gesturechange', (e) => e.preventDefault(), { passive: false });
document.addEventListener('gestureend', (e) => e.preventDefault(), { passive: false });
document.addEventListener('touchmove', (e) => {
  if (e.touches && e.touches.length > 1) {
    e.preventDefault();
  }
}, { passive: false });

function showLoginScreen() {
  document.getElementById('loginOverlay').classList.remove('hidden');
  document.getElementById('appWrapper').classList.add('hidden');
  if (state.timerInterval) clearInterval(state.timerInterval);
  if (state.autoRefreshInterval) clearInterval(state.autoRefreshInterval);
  setTimeout(() => {
    const inp = document.getElementById('loginPasswordInput');
    if (inp) inp.focus();
  }, 50);
}

function isOperatorRole() {
  return state.userRole === 'ADMIN' || state.userRole === 'MERCHANT';
}

function unlockAppScreen() {
  document.getElementById('loginOverlay').classList.add('hidden');
  document.getElementById('appWrapper').classList.remove('hidden');

  const isSuperAdmin = state.userRole === 'ADMIN';
  const isOperator = isOperatorRole();
  const roleEl = document.getElementById('roleBadgeText');
  if (roleEl) {
    if (isSuperAdmin) {
      roleEl.textContent = '👑 ROL: ADMIN SUPREMO';
    } else if (state.userRole === 'MERCHANT') {
      roleEl.textContent = `🛡️ COMERCIANTE: ${state.userName || 'Comerciante'}`;
    } else {
      roleEl.textContent = `👤 CLIENTE: ${state.userName || 'Cliente'}`;
    }
  }

  document.querySelectorAll('.super-admin-only').forEach((el) => {
    el.classList.toggle('hidden', !isSuperAdmin);
  });

  document.querySelectorAll('.admin-only').forEach((el) => {
    el.classList.toggle('hidden', !isOperator);
  });

  if (!isSuperAdmin) {
    const mSec = document.getElementById('merchantsSection');
    if (mSec) mSec.classList.add('hidden');
  }
  if (!isOperator) {
    document.getElementById('clientsSection').classList.add('hidden');
    document.getElementById('apiConfigSection').classList.add('hidden');
  }
}

// Inicialización: pedir clave obligatoriamente siempre al abrir la página
document.addEventListener('DOMContentLoaded', () => {
  localStorage.removeItem('p2p_auth_token');
  sessionStorage.removeItem('p2p_auth_token');
  setupEventListeners();
  showLoginScreen();
});

function setupEventListeners() {
  // Login Form (Obligatorio - Rol ADMIN con clave 09009001009 o Clave de Cliente)
  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const passInput = document.getElementById('loginPasswordInput');
    const errBox = document.getElementById('loginErrorMsg');
    const btn = document.getElementById('btnLoginSubmit');
    const password = passInput.value.trim();

    errBox.classList.add('hidden');
    btn.disabled = true;
    btn.textContent = '⏳ Verificando clave...';

    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        errBox.textContent = data.error || 'Clave de acceso incorrecta.';
        errBox.classList.remove('hidden');
        passInput.select();
        return;
      }

      state.authToken = data.token;
      state.userRole = data.role || 'ADMIN';
      state.userName = data.userName || 'ADMIN';
      state.clientId = data.clientId || null;
      state.merchantId = data.merchantId || null;
      passInput.value = '';
      unlockAppScreen();
      await loadInitialState();
    } catch (err) {
      errBox.textContent = 'Error de conexión con el servidor.';
      errBox.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = '🔓 Acceder a Monitor USDT';
    }
  });

  // Botón Bloquear / Cerrar Sesión
  document.getElementById('btnLogout').addEventListener('click', async () => {
    try {
      await fetch('/api/logout', { method: 'POST' });
    } catch (e) {}
    state.authToken = null;
    state.userRole = null;
    state.userName = '';
    state.clientId = null;
    state.merchantId = null;
    showLoginScreen();
  });

  // Mostrar/ocultar panel de Gestión de Comerciantes (Exclusivo ADMIN SUPREMO)
  const merchantsSection = document.getElementById('merchantsSection');
  const btnToggleMerchants = document.getElementById('btnToggleMerchantsPanel');
  if (btnToggleMerchants && merchantsSection) {
    btnToggleMerchants.addEventListener('click', () => {
      merchantsSection.classList.toggle('hidden');
      if (!merchantsSection.classList.contains('hidden')) {
        document.getElementById('inputMerchantName').focus();
      }
    });
    document.getElementById('btnCloseMerchantsPanel').addEventListener('click', () => {
      merchantsSection.classList.add('hidden');
    });
  }

  // Crear nuevo usuario Comerciante (Exclusivo ADMIN SUPREMO)
  const createMerchantForm = document.getElementById('createMerchantForm');
  if (createMerchantForm) {
    createMerchantForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const nameInput = document.getElementById('inputMerchantName');
      const passInput = document.getElementById('inputMerchantPassword');
      const name = nameInput.value.trim();
      const password = passInput.value.trim();

      if (!name || !password) return;

      try {
        const res = await apiFetch('/api/merchants', {
          method: 'POST',
          body: JSON.stringify({ name, password })
        });
        state.merchants = res.merchants || [];
        nameInput.value = '';
        passInput.value = '';
        renderMerchantsSection();
        showAlert(`✅ ${res.message}`, 'success');
      } catch (err) {
        showAlert(`❌ ${err.message}`, 'error');
      }
    });
  }

  // Mostrar/ocultar panel de Gestión de Clientes (ADMIN y COMERCIANTES)
  const clientsSection = document.getElementById('clientsSection');
  document.getElementById('btnToggleClientsPanel').addEventListener('click', () => {
    clientsSection.classList.toggle('hidden');
    if (!clientsSection.classList.contains('hidden')) {
      document.getElementById('inputClientName').focus();
    }
  });
  document.getElementById('btnCloseClientsPanel').addEventListener('click', () => {
    clientsSection.classList.add('hidden');
  });
  document.getElementById('btnQuickOpenClients').addEventListener('click', () => {
    clientsSection.classList.remove('hidden');
    document.getElementById('inputClientName').focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // Crear nuevo usuario Cliente (Solo ADMIN)
  document.getElementById('createClientForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const nameInput = document.getElementById('inputClientName');
    const passInput = document.getElementById('inputClientPassword');
    const name = nameInput.value.trim();
    const password = passInput.value.trim();

    if (!name || !password) return;

    try {
      const res = await apiFetch('/api/clients', {
        method: 'POST',
        body: JSON.stringify({ name, password })
      });
      state.clients = res.clients || [];
      nameInput.value = '';
      passInput.value = '';
      renderClientsSection(state.clients[state.clients.length - 1]?.id);
      showAlert(`✅ ${res.message}`, 'success');
    } catch (err) {
      showAlert(`❌ ${err.message}`, 'error');
    }
  });

  // Mostrar/ocultar panel de configuración de API
  const apiSection = document.getElementById('apiConfigSection');
  document.getElementById('btnToggleApiPanel').addEventListener('click', () => {
    apiSection.classList.toggle('hidden');
  });
  document.getElementById('btnCloseApiPanel').addEventListener('click', () => {
    apiSection.classList.add('hidden');
  });

  // Botones de mostrar/ocultar contraseña
  document.querySelectorAll('.btn-eye').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target);
      if (input) {
        input.type = input.type === 'password' ? 'text' : 'password';
      }
    });
  });

  // Guardar API Config
  document.getElementById('apiConfigForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const apiKey = document.getElementById('inputApiKey').value.trim();
    const secretKey = document.getElementById('inputSecretKey').value.trim();

    try {
      const res = await apiFetch('/api/config', {
        method: 'POST',
        body: JSON.stringify({ apiKey, secretKey })
      });
      state.hasCredentials = res.config.hasCredentials;
      if (res.fundingBalance !== undefined) {
        state.fundingBalance = res.fundingBalance;
      }
      document.getElementById('inputApiKey').value = res.config.apiKey || '';
      document.getElementById('inputSecretKey').value = res.config.secretKey || '';
      updateApiBadge();
      showAlert('✅ Credenciales de API de Binance guardadas correctamente.', 'success');
      document.getElementById('apiConfigSection').classList.add('hidden');
      await syncActiveCycles();
    } catch (err) {
      showAlert(`❌ Error guardando API: ${err.message}`, 'error');
    }
  });

  // Probar conexión con Binance
  document.getElementById('btnTestConnection').addEventListener('click', async () => {
    const btn = document.getElementById('btnTestConnection');
    const apiKey = document.getElementById('inputApiKey').value.trim();
    const secretKey = document.getElementById('inputSecretKey').value.trim();

    btn.disabled = true;
    btn.textContent = '⏳ Probando conexión...';
    try {
      const res = await apiFetch('/api/test-connection', {
        method: 'POST',
        body: JSON.stringify({ apiKey, secretKey })
      });
      showAlert(`✅ ${res.message}`, 'success');
    } catch (err) {
      showAlert(`❌ Falló la prueba de conexión: ${err.message}`, 'error', 10000);
    } finally {
      btn.disabled = false;
      btn.textContent = '🔌 Probar Conexión con Binance';
    }
  });

  // Pestañas de Bancos (Banesco / Banco de Venezuela)
  document.getElementById('tabBtnBanesco').addEventListener('click', () => {
    switchBankTab('Banesco');
  });
  document.getElementById('tabBtnBDV').addEventListener('click', () => {
    switchBankTab('Banco de Venezuela');
  });

  // Iniciar Ciclo en la pestaña actual (Solo ADMIN)
  document.getElementById('btnStartCycle').addEventListener('click', async () => {
    if (!state.hasCredentials) {
      document.getElementById('apiConfigSection').classList.remove('hidden');
      showAlert('⚠️ Primero configura tu API Key y Secret Key de Binance para iniciar un ciclo.', 'info');
      return;
    }

    const selectEl = document.getElementById('cycleClientSelect');
    const clientId = selectEl ? selectEl.value.trim() : '';

    if (!clientId) {
      if ((state.clients || []).length === 0) {
        document.getElementById('clientsSection').classList.remove('hidden');
        document.getElementById('inputClientName').focus();
        showAlert('⚠️ Primero registra al menos un cliente (ej: Charles y su clave) para asignarle el ciclo.', 'info');
      } else {
        selectEl.focus();
        showAlert('⚠️ Selecciona el cliente al que corresponde este ciclo antes de iniciarlo.', 'info');
      }
      return;
    }

    const payMethod = state.selectedBank;
    const targetVesInput = document.getElementById('cycleTargetVesInput');
    const targetVes = targetVesInput ? parseFlexibleVesAmount(targetVesInput.value) : 0;
    const payload = { clientId, payMethod, offsetMinutes: 0, targetVes: targetVes > 0 ? targetVes : null };

    const btn = document.getElementById('btnStartCycle');
    btn.disabled = true;

    try {
      const res = await apiFetch('/api/cycle/start', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      if (targetVesInput) targetVesInput.value = '';
      state.activeCycles = res.activeCycles || state.activeCycles;
      state.viewingHistoryCycle = null;
      renderAll();
      showAlert(`▶️ ${res.message || `Ciclo de ${payMethod} iniciado correctamente.`}`, 'success');
      await syncActiveCycles();
    } catch (err) {
      showAlert(`❌ No se pudo iniciar el ciclo: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  // Finalizar y Guardar Ciclo de la pestaña actual
  document.getElementById('btnStopCycle').addEventListener('click', async () => {
    const bank = state.selectedBank;
    const activeCycle = state.activeCycles[bank];
    if (!activeCycle) return;

    const btn = document.getElementById('btnStopCycle');
    btn.disabled = true;
    btn.textContent = '⏳ Cerrando ciclo...';

    try {
      await syncActiveCycles(true);
      const bankData = state.cyclesData[bank] || { summary: {}, orders: [] };

      const res = await apiFetch('/api/cycle/stop', {
        method: 'POST',
        body: JSON.stringify({
          payMethod: bank,
          summary: bankData.summary,
          orders: bankData.orders
        })
      });

      state.activeCycles = res.activeCycles || { ...state.activeCycles, [bank]: null };
      state.cyclesData[bank] = null;
      state.cycleHistory = res.cycleHistory || [];
      renderAll();
      showAlert(`✅ Ciclo de ${bank} finalizado y guardado en el historial correctamente.`, 'success');
    } catch (err) {
      showAlert(`❌ Error al finalizar el ciclo: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '⏹ Finalizar y Guardar Ciclo';
    }
  });

  // Descartar ciclo activo de la pestaña actual (con doble confirmación de seguridad)
  document.getElementById('btnCancelCycle').addEventListener('click', async () => {
    const bank = state.selectedBank;
    const currentCycle = state.activeCycles[bank];
    if (!currentCycle) return;
    const clientLabel = currentCycle.clientName || 'General';

    if (!confirm(`⚠️ ¿Estás seguro de descartar el ciclo activo de ${bank} (${clientLabel}) sin guardarlo en el historial?`)) return;
    if (!confirm(`🚨 SEGUNDA CONFIRMACIÓN: Se descartará definitivamente el ciclo en curso de ${bank} para "${clientLabel}" y NO quedará guardado. ¿Confirmas descartarlo?`)) return;

    try {
      const res = await apiFetch('/api/cycle/cancel', {
        method: 'POST',
        body: JSON.stringify({ payMethod: bank })
      });
      state.activeCycles = res.activeCycles || { ...state.activeCycles, [bank]: null };
      state.cyclesData[bank] = null;
      renderAll();
      showAlert(`🗑️ Ciclo activo de ${bank} descartado.`, 'info');
    } catch (err) {
      showAlert(`❌ Error: ${err.message}`, 'error');
    }
  });

  // Buscador en tabla de órdenes
  document.getElementById('searchOrderInput').addEventListener('input', () => {
    renderOrdersTable();
  });

  // Exportar CSV
  document.getElementById('btnExportCsv').addEventListener('click', () => {
    exportCurrentOrdersToCsv();
  });
}

// Cambiar entre pestaña Banesco y pestaña Banco de Venezuela
function switchBankTab(bankName) {
  state.selectedBank = bankName;
  state.viewingHistoryCycle = null;
  renderAll();
}

// Cargar estado inicial desde el servidor
async function loadInitialState() {
  try {
    const res = await apiFetch('/api/state');
    if (res.role) state.userRole = res.role;
    if (res.userName) state.userName = res.userName;
    state.clientId = res.clientId || null;
    state.merchantId = res.merchantId || null;
    unlockAppScreen();

    state.hasCredentials = res.config.hasCredentials;
    if (res.pingMs) state.pingMs = res.pingMs;
    if (res.fundingBalance !== undefined) state.fundingBalance = res.fundingBalance;
    state.merchants = res.merchants || [];
    state.clients = res.clients || [];
    state.activeCycles = res.activeCycles || { 'Banesco': null, 'Banco de Venezuela': null };
    state.cycleHistory = res.cycleHistory || [];

    if (state.userRole === 'ADMIN') {
      renderMerchantsSection();
    }

    if (isOperatorRole()) {
      document.getElementById('inputApiKey').value = res.config.apiKey || '';
      document.getElementById('inputSecretKey').value = res.config.secretKey || '';
      renderClientsSection();
    }

    // Si Banesco no está activo pero Banco de Venezuela sí, abrir la pestaña activa
    if (!state.activeCycles['Banesco'] && state.activeCycles['Banco de Venezuela']) {
      state.selectedBank = 'Banco de Venezuela';
    } else if (
      state.userRole === 'CLIENT' &&
      !state.activeCycles['Banesco'] &&
      !state.activeCycles['Banco de Venezuela'] &&
      state.cycleHistory.length > 0
    ) {
      state.viewingHistoryCycle = state.cycleHistory[0];
      state.selectedBank = state.cycleHistory[0].payMethod || 'Banesco';
    }

    updateApiBadge();
    startGlobalTimers();
    renderAll();

    if (isOperatorRole() && !state.hasCredentials) {
      document.getElementById('apiConfigSection').classList.remove('hidden');
    } else {
      await syncActiveCycles(true);
    }
  } catch (err) {
    if (err.message !== 'Sesión no iniciada') {
      showAlert(`Error cargando el estado del sistema: ${err.message}`, 'error');
    }
  }
}

// Renderizar tabla de Comerciantes (Exclusivo ADMIN SUPREMO)
function renderMerchantsSection() {
  if (state.userRole !== 'ADMIN') return;
  const tbody = document.getElementById('merchantsTableBody');
  if (!tbody) return;

  const list = state.merchants || [];
  if (list.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="empty-row">No hay comerciantes registrados todavía. Crea uno arriba asignándole nombre y clave.</td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = list
    .map((m) => {
      const apiBadge = m.hasApi
        ? `<span class="badge badge-active">✅ Configurada</span>`
        : `<span class="badge badge-pending">⚠️ Sin API</span>`;

      return `
        <tr>
          <td><strong>🛡️ ${escapeHtml(m.name)}</strong></td>
          <td><code>${escapeHtml(m.password)}</code></td>
          <td>${apiBadge}</td>
          <td class="text-center"><strong>${m.clientCount || 0}</strong> clientes</td>
          <td class="text-center"><strong>${m.cycleCount || 0}</strong> ciclos</td>
          <td>${formatDateTime(m.createdAt)}</td>
          <td class="text-center" style="white-space: nowrap;">
            <button type="button" class="btn-chip" onclick="changeMerchantPassword('${escapeHtml(m.id)}')" title="Cambiar clave del comerciante">🔑 Cambiar Clave</button>
            <button type="button" class="btn-chip" onclick="deleteMerchantUser('${escapeHtml(m.id)}')" title="Eliminar comerciante">🗑️ Eliminar</button>
          </td>
        </tr>
      `;
    })
    .join('');
}

window.changeMerchantPassword = async function (merchantId) {
  const merchant = (state.merchants || []).find((m) => m.id === merchantId);
  if (!merchant) return;

  const newPass = prompt(`Ingresa la nueva clave de acceso para el comerciante "${merchant.name}":`, merchant.password);
  if (newPass === null) return;

  const trimmed = newPass.trim();
  if (!trimmed) {
    showAlert('⚠️ La clave no puede estar vacía.', 'info');
    return;
  }

  try {
    const res = await apiFetch(`/api/merchants/${encodeURIComponent(merchantId)}`, {
      method: 'PUT',
      body: JSON.stringify({ password: trimmed })
    });
    state.merchants = res.merchants || [];
    renderMerchantsSection();
    showAlert(`✅ ${res.message || 'Clave del comerciante actualizada correctamente.'}`, 'success');
  } catch (err) {
    showAlert(`❌ Error actualizando clave: ${err.message}`, 'error');
  }
};

window.deleteMerchantUser = async function (merchantId) {
  const merchant = (state.merchants || []).find((m) => m.id === merchantId);
  const name = merchant ? merchant.name : 'este comerciante';
  if (!confirm(`¿Estás seguro de eliminar al comerciante "${name}" y todo su espacio de trabajo?`)) return;
  try {
    const res = await apiFetch(`/api/merchants/${encodeURIComponent(merchantId)}`, {
      method: 'DELETE'
    });
    state.merchants = res.merchants || [];
    renderMerchantsSection();
    showAlert('🗑️ Comerciante eliminado correctamente.', 'info');
  } catch (err) {
    showAlert(`❌ Error eliminando comerciante: ${err.message}`, 'error');
  }
};

// Renderizar tabla de Clientes y selector al iniciar ciclo (ADMIN y COMERCIANTES)
function renderClientsSection(selectedClientId = null) {
  if (!isOperatorRole()) return;

  const list = state.clients || [];
  const tbody = document.getElementById('clientsTableBody');
  const selectEl = document.getElementById('cycleClientSelect');
  const currentSelected = selectedClientId || (selectEl ? selectEl.value : '');

  if (selectEl) {
    if (list.length === 0) {
      selectEl.innerHTML = `<option value="">-- Primero crea un cliente con el botón "➕ Nuevo Cliente" --</option>`;
    } else {
      selectEl.innerHTML = [
        `<option value="">-- Selecciona un cliente registrado --</option>`,
        ...list.map((c) => `<option value="${escapeHtml(c.id)}" ${c.id === currentSelected ? 'selected' : ''}>👤 ${escapeHtml(c.name)}</option>`)
      ].join('');
    }
  }

  if (!tbody) return;
  if (list.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" class="empty-row">No hay clientes registrados todavía. Crea uno arriba (Ej: Charles y su clave).</td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = list
    .map((c) => `
      <tr>
        <td><strong>👤 ${escapeHtml(c.name)}</strong></td>
        <td><code>${escapeHtml(c.password)}</code></td>
        <td>${formatDateTime(c.createdAt)}</td>
        <td class="text-center">
          <button type="button" class="btn-chip" onclick="changeClientPassword('${escapeHtml(c.id)}')" title="Cambiar clave de acceso">🔑 Cambiar Clave</button>
          <button type="button" class="btn-chip" onclick="deleteClientUser('${escapeHtml(c.id)}')" title="Eliminar cliente">🗑️ Eliminar</button>
        </td>
      </tr>
    `)
    .join('');
}

window.changeClientPassword = async function (clientId) {
  const client = (state.clients || []).find((c) => c.id === clientId);
  if (!client) return;

  const newPass = prompt(`Ingresa la nueva clave de acceso para "${client.name}":`, client.password);
  if (newPass === null) return;

  const trimmed = newPass.trim();
  if (!trimmed) {
    showAlert('⚠️ La clave no puede estar vacía.', 'info');
    return;
  }

  try {
    const res = await apiFetch(`/api/clients/${encodeURIComponent(clientId)}`, {
      method: 'PUT',
      body: JSON.stringify({ password: trimmed })
    });
    state.clients = res.clients || [];
    renderClientsSection();
    showAlert(`✅ ${res.message || 'Clave actualizada correctamente.'}`, 'success');
  } catch (err) {
    showAlert(`❌ Error actualizando clave: ${err.message}`, 'error');
  }
};

window.deleteClientUser = async function (clientId) {
  if (!confirm('¿Estás seguro de eliminar a este cliente?')) return;
  try {
    const res = await apiFetch(`/api/clients/${encodeURIComponent(clientId)}`, {
      method: 'DELETE'
    });
    state.clients = res.clients || [];
    renderClientsSection();
    showAlert('🗑️ Cliente eliminado correctamente.', 'info');
  } catch (err) {
    showAlert(`❌ Error eliminando cliente: ${err.message}`, 'error');
  }
};

function updateApiBadge() {
  const badge = document.getElementById('apiStatusBadge');
  const text = document.getElementById('apiStatusText');
  if (state.hasCredentials) {
    badge.className = 'status-badge status-ok';
    text.textContent = `Binance Ping: ${state.pingMs || '--'} ms`;
  } else {
    badge.className = 'status-badge status-warn';
    text.textContent = state.pingMs ? `Binance Ping: ${state.pingMs} ms (Sin API)` : 'API No Configurada';
  }

  const fundingBadge = document.getElementById('fundingBalanceBadge');
  const fundingText = document.getElementById('fundingBalanceText');
  if (fundingBadge && fundingText) {
    if (!isOperatorRole()) {
      fundingBadge.classList.add('hidden');
    } else {
      fundingBadge.classList.remove('hidden');
      if (state.hasCredentials && state.fundingBalance && state.fundingBalance.availableUsdt !== undefined) {
        fundingText.textContent = formatUsdt(state.fundingBalance.availableUsdt);
      } else {
        fundingText.textContent = '-- USDT';
      }
    }
  }
}

// Temporizador de 1s (cronómetros) y 4s (actualización continua en vivo de ciclos activos y Ping)
function startGlobalTimers() {
  if (state.timerInterval) clearInterval(state.timerInterval);
  if (state.autoRefreshInterval) clearInterval(state.autoRefreshInterval);

  state.timerInterval = setInterval(() => {
    const currentCycle = state.activeCycles[state.selectedBank];
    if (currentCycle) {
      const elapsedEl = document.getElementById('activeCycleElapsed');
      if (elapsedEl) {
        elapsedEl.textContent = formatElapsed(currentCycle.startTime);
      }
    }
    renderBankTabsBar();
  }, 1000);

  state.autoRefreshInterval = setInterval(async () => {
    const anyActive = Boolean(state.activeCycles['Banesco'] || state.activeCycles['Banco de Venezuela']);
    const isClient = state.userRole === 'CLIENT';
    if ((anyActive || isClient) && !state.isSyncing) {
      await syncActiveCycles(true);
    } else if (!state.isSyncing) {
      try {
        const pRes = await apiFetch('/api/ping');
        if (pRes.pingMs) {
          state.pingMs = pRes.pingMs;
        }
        if (pRes.fundingBalance !== undefined) {
          state.fundingBalance = pRes.fundingBalance;
        }
        updateApiBadge();
      } catch (e) {}
    }
  }, 4000);
}

// Sincronizar datos de todos los ciclos activos simultáneamente desde Binance
async function syncActiveCycles(silent = false) {
  const anyActive = Boolean(state.activeCycles['Banesco'] || state.activeCycles['Banco de Venezuela']);
  const isClient = state.userRole === 'CLIENT';
  if (!anyActive && !isClient) {
    renderAll();
    return;
  }
  if (state.isSyncing && silent) return;
  state.isSyncing = true;

  try {
    const prevActive = { ...state.activeCycles };
    const res = await apiFetch('/api/cycles/sync?includePaidPending=true');
    if (res.pingMs) {
      state.pingMs = res.pingMs;
    }
    if (res.fundingBalance !== undefined) {
      state.fundingBalance = res.fundingBalance;
    }
    updateApiBadge();
    if (res.activeCycles) {
      state.activeCycles = res.activeCycles;
    }
    if (res.cycleHistory) {
      state.cycleHistory = res.cycleHistory;
    }
    const cyclesData = res.cyclesData || {};

    state.cyclesData['Banesco'] = cyclesData['Banesco'] || null;
    state.cyclesData['Banco de Venezuela'] = cyclesData['Banco de Venezuela'] || null;

    // Detectar si un ciclo acaba de completarse automáticamente al llegar al 100% de los Bs. del cliente
    const autoList = Array.isArray(res.autoCompletedCycles) ? res.autoCompletedCycles : [];
    let newlyCompleted = autoList[0] || null;

    if (!newlyCompleted) {
      for (const bKey of ['Banesco', 'Banco de Venezuela']) {
        if (prevActive[bKey] && !state.activeCycles[bKey]) {
          const foundInHist = (state.cycleHistory || []).find((h) => h.id === prevActive[bKey].id);
          if (foundInHist) {
            newlyCompleted = foundInHist;
            break;
          }
        }
      }
    }

    if (newlyCompleted) {
      state.selectedBank = newlyCompleted.payMethod || state.selectedBank;
      state.viewingHistoryCycle = newlyCompleted;
      const totalVesDone = newlyCompleted.summary ? newlyCompleted.summary.totalVes : newlyCompleted.targetVes;
      showAlert(
        `✅ CICLO DE COMPRA COMPLETADO — Se compraron los ${formatVes(totalVesDone)} de ${newlyCompleted.clientName || 'Cliente'}. El ciclo se finalizó y guardó automáticamente.`,
        'success',
        12000
      );
    } else if (
      state.userRole === 'CLIENT' &&
      !state.activeCycles['Banesco'] &&
      !state.activeCycles['Banco de Venezuela'] &&
      !state.viewingHistoryCycle &&
      (state.cycleHistory || []).length > 0
    ) {
      state.viewingHistoryCycle = state.cycleHistory[0];
    }

    renderAll();
  } catch (err) {
    if (!silent) {
      showAlert(`❌ Error consultando órdenes de Binance: ${err.message}`, 'error');
    }
  } finally {
    state.isSyncing = false;
  }
}

// Renderizar todas las secciones según la pestaña seleccionada
function renderAll() {
  renderBankTabsBar();
  renderCycleControlCard();
  renderKpis();
  renderOrdersTable();
  renderHistoryTable();
}

// Renderizar las 2 pestañas superiores (Banesco y Banco de Venezuela)
function renderBankTabsBar() {
  const tabBanesco = document.getElementById('tabBtnBanesco');
  const tabBDV = document.getElementById('tabBtnBDV');

  tabBanesco.classList.toggle('active', state.selectedBank === 'Banesco');
  tabBDV.classList.toggle('active', state.selectedBank === 'Banco de Venezuela');

  // Estado Banesco
  const cBan = state.activeCycles['Banesco'];
  const dBan = state.cyclesData['Banesco'];
  const dotBan = document.getElementById('tabDotBanesco');
  const subBan = document.getElementById('tabSubBanesco');
  const statsBan = document.getElementById('tabStatsBanesco');

  if (cBan) {
    dotBan.className = 'bank-tab-dot running';
    const count = dBan && dBan.summary ? dBan.summary.orderCount : 0;
    subBan.textContent = `● En Curso (${formatElapsed(cBan.startTime)}) • ${count} órdenes`;
    statsBan.textContent = formatUsdt(dBan && dBan.summary ? dBan.summary.totalUsdtNet : 0);
  } else {
    dotBan.className = 'bank-tab-dot';
    subBan.textContent = 'Ciclo Inactivo';
    statsBan.textContent = '0.00 USDT';
  }

  // Estado Banco de Venezuela
  const cBdv = state.activeCycles['Banco de Venezuela'];
  const dBdv = state.cyclesData['Banco de Venezuela'];
  const dotBdv = document.getElementById('tabDotBDV');
  const subBdv = document.getElementById('tabSubBDV');
  const statsBdv = document.getElementById('tabStatsBDV');

  if (cBdv) {
    dotBdv.className = 'bank-tab-dot running';
    const count = dBdv && dBdv.summary ? dBdv.summary.orderCount : 0;
    subBdv.textContent = `● En Curso (${formatElapsed(cBdv.startTime)}) • ${count} órdenes`;
    statsBdv.textContent = formatUsdt(dBdv && dBdv.summary ? dBdv.summary.totalUsdtNet : 0);
  } else {
    dotBdv.className = 'bank-tab-dot';
    subBdv.textContent = 'Ciclo Inactivo';
    statsBdv.textContent = '0.00 USDT';
  }
}

// Renderizar tarjeta de control del ciclo de la pestaña activa
function renderCycleControlCard() {
  const bank = state.selectedBank;
  const activeCycle = state.activeCycles[bank];
  const isAdmin = isOperatorRole();

  document.getElementById('cycleCardTitle').textContent = isAdmin
    ? `⏱️ Control de Ciclo — ${bank}`
    : `⏱️ MIS COMPRAS EN CURSO — ${bank}`;
  document.getElementById('cycleCardDesc').innerHTML = isAdmin
    ? `Contabiliza todas tus compras de USDT pagadas por <strong>${bank}</strong> de forma independiente. Puedes tener Banesco y Banco de Venezuela activos al mismo tiempo.`
    : `Aquí puedes ver en tiempo real las compras de USDT procesadas a tu nombre por <strong>${bank}</strong>.`;
  document.getElementById('btnStartCycle').textContent = `▶ INICIAR CICLO (${bank.toUpperCase()})`;

  const inactiveView = document.getElementById('cycleInactiveView');
  const clientNoCycleView = document.getElementById('clientNoCycleView');
  const activeView = document.getElementById('cycleActiveView');
  const completedBanner = document.getElementById('cycleCompletedBanner');
  const adminActions = document.getElementById('adminCycleActions');
  const stateBadge = document.getElementById('cycleStateBadge');

  if (activeCycle) {
    inactiveView.classList.add('hidden');
    if (clientNoCycleView) clientNoCycleView.classList.add('hidden');
    if (completedBanner) completedBanner.classList.add('hidden');
    activeView.classList.remove('hidden');
    if (adminActions) adminActions.classList.toggle('hidden', !isAdmin);

    stateBadge.className = 'badge badge-active badge-live-blink';
    stateBadge.textContent = '● En Curso';

    document.getElementById('activeCycleName').textContent = isAdmin
      ? activeCycle.name
      : `Compra en Curso (${formatDateTime(activeCycle.startTime)})`;
    const clientWrapEl = document.getElementById('activeCycleClientWrap');
    if (clientWrapEl) {
      clientWrapEl.classList.toggle('hidden', !isAdmin);
    }
    const clientNameEl = document.getElementById('activeCycleClientName');
    if (clientNameEl) {
      clientNameEl.textContent = activeCycle.clientName || 'General';
    }

    const targetWrapEl = document.getElementById('activeCycleTargetWrap');
    const targetTextEl = document.getElementById('activeCycleTargetText');
    const targetProgEl = document.getElementById('activeCycleTargetProgress');
    if (targetWrapEl && targetTextEl && targetProgEl) {
      const targetVes = Number(activeCycle.targetVes || 0);
      if (targetVes > 0) {
        const bankData = state.cyclesData[bank] || {};
        const currentVes = Number((bankData.summary && bankData.summary.totalVes) || 0);
        const pct = Math.min(100, (currentVes / targetVes) * 100);
        const remVes = Math.max(0, targetVes - currentVes);
        targetWrapEl.classList.remove('hidden');
        targetTextEl.textContent = formatVes(targetVes);
        targetProgEl.textContent = remVes <= 0.01
          ? `✅ 100% Completado`
          : `${pct.toFixed(1)}% • Faltan ${formatVes(remVes)}`;
      } else {
        targetWrapEl.classList.add('hidden');
      }
    }

    document.getElementById('activeCycleStartText').textContent = formatDateTime(activeCycle.startTime);
    document.getElementById('activeCycleElapsed').textContent = formatElapsed(activeCycle.startTime);
  } else {
    activeView.classList.add('hidden');
    const histCycle = state.viewingHistoryCycle;

    if (histCycle && completedBanner) {
      completedBanner.classList.remove('hidden');
      const hs = histCycle.summary || {};
      const totalGross = Number(hs.totalUsdtGross || 0);
      const clientFee = hs.totalClientFeeUsdt !== undefined ? Number(hs.totalClientFeeUsdt) : totalGross * 0.00425;
      const clientUsdt = hs.totalClientUsdt !== undefined ? Number(hs.totalClientUsdt) : Math.max(0, totalGross - clientFee);

      const completedClientWrap = document.getElementById('completedCycleClientWrap');
      if (completedClientWrap) {
        completedClientWrap.classList.toggle('hidden', !isAdmin);
      }
      document.getElementById('completedCycleClientName').textContent = histCycle.clientName || 'General';
      document.getElementById('completedCycleVes').textContent = formatVes(hs.totalVes || 0);
      document.getElementById('completedCycleClientUsdt').textContent = formatUsdt(clientUsdt);
      document.getElementById('completedCycleEndText').textContent = formatDateTime(histCycle.endTime);

      stateBadge.className = 'badge badge-active';
      stateBadge.textContent = '✅ CICLO DE COMPRA COMPLETADO';
    } else {
      if (completedBanner) completedBanner.classList.add('hidden');
      stateBadge.className = 'badge badge-neutral';
      stateBadge.textContent = 'Inactivo';
    }

    if (isAdmin) {
      inactiveView.classList.remove('hidden');
      if (clientNoCycleView) clientNoCycleView.classList.add('hidden');
    } else {
      inactiveView.classList.add('hidden');
      if (clientNoCycleView) {
        clientNoCycleView.classList.toggle('hidden', Boolean(histCycle));
      }
    }
  }
}

// Obtener datos que deben mostrarse actualmente en los KPIs y Tabla
function getDisplayedData() {
  const bank = state.selectedBank;
  const activeCycle = state.activeCycles[bank];

  if (activeCycle) {
    const bankData = state.cyclesData[bank] || {};
    return {
      bankLabel: bank,
      isHistory: false,
      summary: bankData.summary || {},
      orders: bankData.orders || [],
      detectedMethods: bankData.detectedMethods || {}
    };
  }

  if (state.viewingHistoryCycle) {
    const h = state.viewingHistoryCycle;
    return {
      bankLabel: `${h.payMethod || bank} — Historial: ${h.name}`,
      isHistory: true,
      summary: h.summary || {},
      orders: h.orders || [],
      detectedMethods: {}
    };
  }

  return {
    bankLabel: bank,
    isHistory: false,
    summary: {},
    orders: [],
    detectedMethods: {}
  };
}

// Renderizar las 5 tarjetas de KPIs
function renderKpis() {
  const { bankLabel, summary } = getDisplayedData();
  const s = summary || {};
  const upperBank = state.selectedBank.toUpperCase();
  const isOperator = isOperatorRole();

  const totalVes = Number(s.totalVes || 0);
  const totalUsdtGross = Number(s.totalUsdtGross || 0);
  const totalUsdtNet = Number(s.totalUsdtNet || 0);
  const totalCommissionUsdt = Number(s.totalCommissionUsdt || 0);
  const totalCommissionVes = Number(s.totalCommissionVes || 0);

  // El servicio asume la comisión de Binance:
  // - Al cliente solo se le descuenta el 0.425% sobre los USDT Brutos comprados (totalUsdtGross).
  // - La ganancia neta del servicio (totalMyCommissionUsdt) es ese 0.425% menos la comisión de Binance.
  const avgRateGross = Number(s.avgRateGross || (totalUsdtGross > 0 ? totalVes / totalUsdtGross : 0));
  const avgRateNet = Number(s.avgRateNet || (totalUsdtNet > 0 ? totalVes / totalUsdtNet : 0));

  const totalClientFeeUsdt = s.totalClientFeeUsdt !== undefined
    ? Number(s.totalClientFeeUsdt)
    : totalUsdtGross * 0.00425;
  const totalClientFeeVes = s.totalClientFeeVes !== undefined
    ? Number(s.totalClientFeeVes)
    : totalClientFeeUsdt * avgRateGross;

  const totalMyCommissionUsdt = s.totalMyCommissionUsdt !== undefined
    ? Number(s.totalMyCommissionUsdt)
    : (totalClientFeeUsdt - totalCommissionUsdt);
  const totalMyCommissionVes = s.totalMyCommissionVes !== undefined
    ? Number(s.totalMyCommissionVes)
    : totalMyCommissionUsdt * avgRateGross;

  const totalClientUsdt = s.totalClientUsdt !== undefined
    ? Number(s.totalClientUsdt)
    : Math.max(0, totalUsdtGross - totalClientFeeUsdt);
  const avgRateClient = s.avgRateClient !== undefined
    ? Number(s.avgRateClient)
    : (totalClientUsdt > 0 ? totalVes / totalClientUsdt : 0);

  document.getElementById('kpiVesTitle').textContent = `TOTAL VES PAGADOS (${upperBank})`;
  document.getElementById('kpiUsdtTitle').textContent = isOperator
    ? `NETO COMPRADO (${upperBank})`
    : `TOTAL COMPRADO (${upperBank})`;

  document.getElementById('kpiTotalVes').textContent = formatVes(totalVes);

  const breakdownEl = document.getElementById('kpiOrdersBreakdown');
  const activeCycle = state.activeCycles[state.selectedBank];
  const cycleTargetVes = Number(s.targetVes || (activeCycle && activeCycle.targetVes) || 0);
  const targetSuffix = cycleTargetVes > 0
    ? ` • Cantidad total: <strong>${formatVes(cycleTargetVes)}</strong>`
    : '';

  if (s.paidPendingCount > 0) {
    breakdownEl.innerHTML = `En <strong>${s.orderCount || 0}</strong> órdenes (<strong>${s.completedCount || 0}</strong> completadas, <strong class="text-gold">${s.paidPendingCount} en liberación</strong>)${targetSuffix}`;
  } else {
    breakdownEl.innerHTML = `En <strong>${s.orderCount || 0}</strong> órdenes completadas (${escapeHtml(bankLabel)})${targetSuffix}`;
  }

  document.getElementById('kpiTotalUsdtNet').textContent = formatUsdt(isOperator ? totalUsdtNet : totalUsdtGross);
  document.getElementById('kpiTotalUsdtGross').textContent = formatUsdt(totalUsdtGross);
  document.getElementById('kpiTotalClientUsdt').textContent = formatUsdt(totalClientUsdt);

  if (isOperator) {
    document.getElementById('kpiTotalCommissionUsdt').textContent = `${fmtCommUsdt.format(totalCommissionUsdt)} USDT`;
    document.getElementById('kpiTotalCommissionVes').textContent = formatVes(totalCommissionVes);
    document.getElementById('kpiTotalMyCommissionUsdt').textContent = `${fmtCommUsdt.format(totalMyCommissionUsdt)} USDT`;
    document.getElementById('kpiTotalMyCommissionVes').textContent = formatVes(totalMyCommissionVes);
  } else {
    document.getElementById('kpiTotalCommissionUsdt').textContent = `0.00 USDT`;
    document.getElementById('kpiTotalCommissionVes').textContent = `Bs. 0,00 (Asumida)`;
    document.getElementById('kpiTotalMyCommissionUsdt').textContent = `${fmtCommUsdt.format(totalClientFeeUsdt)} USDT`;
    document.getElementById('kpiTotalMyCommissionVes').textContent = formatVes(totalClientFeeVes);
  }

  document.getElementById('kpiAvgRateGross').textContent = `${formatVes(avgRateGross)} / USDT`;
  document.getElementById('kpiAvgRateNet').textContent = formatVes(isOperator ? avgRateNet : avgRateGross);
  document.getElementById('kpiAvgRateClient').textContent = formatVes(avgRateClient);
}

// Renderizar tabla de órdenes de la pestaña actual
function renderOrdersTable() {
  const { bankLabel, orders: rawOrders } = getDisplayedData();
  const bank = state.selectedBank;
  const activeCycle = state.activeCycles[bank];

  document.getElementById('ordersTableTitle').textContent = `📋 Detalle de Compras USDT — ${bankLabel}`;
  const infoEl = document.getElementById('detectedMethodsInfo');

  if (activeCycle) {
    infoEl.textContent = `Contabilizando compras de ${bank} desde ${formatDateTime(activeCycle.startTime)}.`;
  } else if (state.viewingHistoryCycle) {
    const h = state.viewingHistoryCycle;
    infoEl.textContent = `Viendo ciclo guardado "${h.name}" (${formatDateTime(h.startTime)} — ${formatDateTime(h.endTime)}).`;
  } else {
    infoEl.textContent = `El ciclo de ${bank} está inactivo. Pulsa "Iniciar Ciclo" arriba para comenzar a contar.`;
  }

  const tbody = document.getElementById('ordersTableBody');
  const query = (document.getElementById('searchOrderInput').value || '').trim().toLowerCase();

  const orders = (rawOrders || []).filter((o) => {
    if (!query) return true;
    return (
      String(o.orderNumber).toLowerCase().includes(query) ||
      String(o.counterPartNickName).toLowerCase().includes(query) ||
      String(o.payMethodName).toLowerCase().includes(query)
    );
  });

  if (orders.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="10" class="empty-row">
          ${activeCycle ? `Aún no hay compras de USDT por ${bank} en este ciclo.` : `Inicia el ciclo de ${bank} para contabilizar tus compras de Binance P2P.`}
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = orders
    .map((o) => {
      const statusBadge = o.isCompleted
        ? `<span class="badge badge-active">✅ COMPLETADA</span>`
        : `<span class="badge badge-pending">⏳ PAGADA (Liberando)</span>`;

      return `
        <tr>
          <td>${formatDateTime(o.createTime)}</td>
          <td><code>${o.orderNumber}</code></td>
          <td><strong>${escapeHtml(o.counterPartNickName)}</strong></td>
          <td><span class="badge badge-banesco">${escapeHtml(o.payMethodName)}</span></td>
          <td>${statusBadge}</td>
          <td class="text-right">${fmtVes.format(o.unitPrice)}</td>
          <td class="text-right text-gold">
            <strong>${formatVes(o.totalVes)}</strong>
            ${o.isCappedToTarget ? `<br/><small class="text-muted" title="Ajustado al monto exacto del cliente">(De ${formatVes(o.originalTotalVes)})</small>` : ''}
          </td>
          <td class="text-right">${fmtUsdt.format(o.amountUsdt)} USDT</td>
          <td class="text-right text-danger">
            ${fmtCommUsdt.format(o.commissionUsdt)} USDT
            <br/><small class="text-muted">(${formatVes(o.commissionVes)})</small>
          </td>
          <td class="text-right text-success"><strong>${fmtUsdt.format(o.netUsdt)} USDT</strong></td>
        </tr>
      `;
    })
    .join('');
}

// Renderizar tabla de historial de ciclos cerrados
function renderHistoryTable() {
  const tbody = document.getElementById('historyTableBody');
  const list = state.cycleHistory || [];
  const isAdmin = isOperatorRole();

  if (list.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="13" class="empty-row">${isAdmin ? 'No hay ciclos guardados todavía.' : 'Aún no tienes ciclos finalizados registrados a tu nombre.'}</td>
      </tr>
    `;
    return;
  }

  const anyActiveCycle = Boolean(state.activeCycles['Banesco'] || state.activeCycles['Banco de Venezuela']);

  tbody.innerHTML = list
    .map((c) => {
      const s = c.summary || {};
      const grossUsdt = Number(s.totalUsdtGross || 0);
      const binanceComm = Number(s.totalCommissionUsdt || 0);
      const avgRate = Number(s.avgRateGross || 0);
      const clientFeeUsdt = s.totalClientFeeUsdt !== undefined ? Number(s.totalClientFeeUsdt) : grossUsdt * 0.00425;
      const myCommUsdt = isAdmin
        ? (s.totalMyCommissionUsdt !== undefined ? Number(s.totalMyCommissionUsdt) : (clientFeeUsdt - binanceComm))
        : clientFeeUsdt;
      const myCommVes = isAdmin
        ? (s.totalMyCommissionVes !== undefined ? Number(s.totalMyCommissionVes) : myCommUsdt * avgRate)
        : (s.totalClientFeeVes !== undefined ? Number(s.totalClientFeeVes) : clientFeeUsdt * avgRate);

      const verBtn = anyActiveCycle
        ? `<button class="btn-chip btn-chip-disabled" disabled title="Hay un ciclo en curso. Finalízalo antes de ver ciclos anteriores en pantalla">🔒 En ciclo</button>`
        : `<button class="btn-chip" onclick="viewSavedCycle('${c.id}')">👁️ Ver</button>`;

      const delBtn = isAdmin
        ? `<button class="btn-chip" onclick="deleteSavedCycle('${c.id}')" title="Eliminar ciclo">🗑️</button>`
        : '';

      return `
        <tr>
          <td><strong>${escapeHtml(c.name)}</strong></td>
          <td><span class="badge badge-neutral">👤 ${escapeHtml(c.clientName || 'General')}</span></td>
          <td>${formatDateTime(c.startTime)}</td>
          <td>${formatDateTime(c.endTime)}</td>
          <td><span class="badge badge-banesco">${escapeHtml(c.payMethod || 'Banesco')}</span></td>
          <td class="text-center">${s.orderCount || 0}</td>
          <td class="text-right text-gold"><strong>${formatVes(s.totalVes)}</strong></td>
          <td class="text-right">${formatUsdt(s.totalUsdtGross)}</td>
          <td class="text-right text-danger">${fmtCommUsdt.format(s.totalCommissionUsdt || 0)} USDT</td>
          <td class="text-right text-success"><strong>${formatUsdt(s.totalUsdtNet)}</strong></td>
          <td class="text-right text-profit">
            <strong>+${fmtCommUsdt.format(myCommUsdt)} USDT</strong>
            <br/><small class="text-muted">(${formatVes(myCommVes)})</small>
          </td>
          <td class="text-right">${formatVes(s.avgRateGross)}</td>
          <td class="text-center" style="white-space: nowrap;">
            ${verBtn}
            <button class="btn-chip" onclick="exportSavedCycleExcel('${c.id}')" title="Descargar Excel de este ciclo">📊 Excel</button>
            ${delBtn}
          </td>
        </tr>
      `;
    })
    .join('');
}

// Ver el detalle de un ciclo guardado en el historial (solo permitido cuando no hay ciclos corriendo)
window.viewSavedCycle = function (cycleId) {
  if (state.activeCycles['Banesco'] || state.activeCycles['Banco de Venezuela']) {
    showAlert('⚠️ No puedes abrir un ciclo antiguo mientras hay un ciclo en curso para no borrar de pantalla los datos actuales.', 'info');
    return;
  }

  const found = (state.cycleHistory || []).find((c) => c.id === cycleId);
  if (!found) return;

  if (found.payMethod === 'Banco de Venezuela') {
    state.selectedBank = 'Banco de Venezuela';
  } else {
    state.selectedBank = 'Banesco';
  }

  state.viewingHistoryCycle = found;
  renderAll();
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

// Eliminar un ciclo del historial
window.deleteSavedCycle = async function (cycleId) {
  if (!confirm('¿Deseas eliminar este ciclo del historial?')) return;
  try {
    const res = await apiFetch(`/api/cycle/${encodeURIComponent(cycleId)}`, {
      method: 'DELETE'
    });
    state.cycleHistory = res.cycleHistory || [];
    if (state.viewingHistoryCycle && state.viewingHistoryCycle.id === cycleId) {
      state.viewingHistoryCycle = null;
    }
    renderAll();
    showAlert('🗑️ Ciclo eliminado del historial.', 'info');
  } catch (err) {
    showAlert(`❌ Error eliminando ciclo: ${err.message}`, 'error');
  }
};

// Exportar un ciclo específico del historial a Excel organizado
window.exportSavedCycleExcel = function (cycleId) {
  const found = (state.cycleHistory || []).find((c) => c.id === cycleId);
  if (!found) return;
  generateDetailedExcelReport({
    cycleName: found.name,
    bankLabel: found.payMethod || 'Banesco',
    startTime: found.startTime,
    endTime: found.endTime,
    summary: found.summary || {},
    orders: found.orders || []
  });
};

// Exportar órdenes de la pestaña actual a un libro de Excel (.xls) súper organizado y detallado
function exportCurrentOrdersToCsv() {
  const { bankLabel, summary: s, orders } = getDisplayedData();
  if (!orders || orders.length === 0) {
    showAlert('⚠️ No hay órdenes en la pestaña actual para exportar.', 'info');
    return;
  }

  const activeCycle = state.activeCycles[state.selectedBank];
  const histCycle = state.viewingHistoryCycle;
  const cycleName = activeCycle
    ? activeCycle.name
    : (histCycle ? histCycle.name : `Ciclo ${state.selectedBank}`);
  const startTime = activeCycle
    ? activeCycle.startTime
    : (histCycle ? histCycle.startTime : s.startTime);
  const endTime = activeCycle
    ? Date.now()
    : (histCycle ? histCycle.endTime : s.endTime);

  generateDetailedExcelReport({
    cycleName,
    bankLabel: state.selectedBank,
    startTime,
    endTime,
    summary: s,
    orders
  });
}

function generateDetailedExcelReport({ cycleName, bankLabel, startTime, endTime, summary: s, orders }) {
  const isOperator = isOperatorRole();
  const totalVes = Number(s.totalVes || 0);
  const totalUsdtGross = Number(s.totalUsdtGross || 0);
  const totalUsdtNet = Number(s.totalUsdtNet || 0);
  const totalCommissionUsdt = Number(s.totalCommissionUsdt || 0);
  const totalCommissionVes = Number(s.totalCommissionVes || 0);

  const avgRateGross = Number(s.avgRateGross || (totalUsdtGross > 0 ? totalVes / totalUsdtGross : 0));
  const avgRateNet = Number(s.avgRateNet || (totalUsdtNet > 0 ? totalVes / totalUsdtNet : 0));
  const totalClientFeeUsdt = s.totalClientFeeUsdt !== undefined
    ? Number(s.totalClientFeeUsdt)
    : totalUsdtGross * 0.00425;
  const totalMyCommissionUsdt = isOperator
    ? (s.totalMyCommissionUsdt !== undefined ? Number(s.totalMyCommissionUsdt) : (totalClientFeeUsdt - totalCommissionUsdt))
    : totalClientFeeUsdt;
  const totalMyCommissionVes = isOperator
    ? (s.totalMyCommissionVes !== undefined ? Number(s.totalMyCommissionVes) : totalMyCommissionUsdt * avgRateGross)
    : (s.totalClientFeeVes !== undefined ? Number(s.totalClientFeeVes) : totalClientFeeUsdt * avgRateGross);
  const totalClientUsdt = s.totalClientUsdt !== undefined
    ? Number(s.totalClientUsdt)
    : Math.max(0, totalUsdtGross - totalClientFeeUsdt);
  const avgRateClient = s.avgRateClient !== undefined
    ? Number(s.avgRateClient)
    : (totalClientUsdt > 0 ? totalVes / totalClientUsdt : 0);

  const ordersRowsHtml = orders
    .map((o, idx) => {
      const bgRow = idx % 2 === 0 ? '#ffffff' : '#f8fafc';
      const statusColor = o.isCompleted ? '#065f46' : '#92400e';
      return `
        <tr style="background-color:${bgRow}; font-size:8.5pt;">
          <td style="border:1px solid #cbd5e1; padding:4px 5px; text-align:center;">${idx + 1}</td>
          <td style="border:1px solid #cbd5e1; padding:4px 5px; text-align:center;">${escapeHtml(formatDateTime(o.createTime))}</td>
          <td style="border:1px solid #cbd5e1; padding:4px 5px; text-align:center; mso-number-format:'\\@'; font-family:Consolas,monospace;">${escapeHtml(o.orderNumber)}</td>
          <td style="border:1px solid #cbd5e1; padding:4px 5px; font-weight:bold;">${escapeHtml(o.counterPartNickName)}</td>
          <td style="border:1px solid #cbd5e1; padding:4px 5px; text-align:center; color:#0f766e; font-weight:bold;">${escapeHtml(o.payMethodName)}</td>
          <td style="border:1px solid #cbd5e1; padding:4px 5px; text-align:center; color:${statusColor}; font-weight:bold;">${escapeHtml(o.statusLabel || o.orderStatus)}</td>
          <td style="border:1px solid #cbd5e1; padding:4px 5px; text-align:right; mso-number-format:'#,##0.00';">${Number(o.unitPrice || 0).toFixed(2)}</td>
          <td style="border:1px solid #cbd5e1; padding:4px 5px; text-align:right; font-weight:bold; color:#b45309; mso-number-format:'#,##0.00';">${Number(o.totalVes || 0).toFixed(2)}</td>
          <td style="border:1px solid #cbd5e1; padding:4px 5px; text-align:right; mso-number-format:'#,##0.00';">${Number(o.amountUsdt || 0).toFixed(2)}</td>
          <td style="border:1px solid #cbd5e1; padding:4px 5px; text-align:right; color:#dc2626; mso-number-format:'#,##0.00';">${Number(o.commissionUsdt || 0).toFixed(2)}</td>
          <td style="border:1px solid #cbd5e1; padding:4px 5px; text-align:right; color:#dc2626; mso-number-format:'#,##0.00';">${Number(o.commissionVes || 0).toFixed(2)}</td>
          <td style="border:1px solid #cbd5e1; padding:4px 5px; text-align:right; font-weight:bold; color:#047857; mso-number-format:'#,##0.00';">${Number(o.netUsdt || 0).toFixed(2)}</td>
        </tr>
      `;
    })
    .join('');

  const excelHtml = `
    <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
    <head>
      <meta charset="UTF-8" />
      <!--[if gte mso 9]>
      <xml>
        <x:ExcelWorkbook>
          <x:ExcelWorksheets>
            <x:ExcelWorksheet>
              <x:Name>Reporte Contable P2P</x:Name>
              <x:WorksheetOptions>
                <x:DisplayGridlines/>
                <x:Zoom>85</x:Zoom>
              </x:WorksheetOptions>
            </x:ExcelWorksheet>
          </x:ExcelWorksheets>
        </x:ExcelWorkbook>
      </xml>
      <![endif]-->
    </head>
    <body style="font-family:Segoe UI, Arial, sans-serif; font-size:9pt; color:#0f172a;">
      <table border="0" cellpadding="0" cellspacing="0" style="border-collapse:collapse; width:980px; max-width:980px;">
        <colgroup>
          <col width="28" />
          <col width="115" />
          <col width="128" />
          <col width="80" />
          <col width="75" />
          <col width="85" />
          <col width="72" />
          <col width="88" />
          <col width="78" />
          <col width="78" />
          <col width="78" />
          <col width="75" />
        </colgroup>
        <!-- ENCABEZADO PRINCIPAL -->
        <tr>
          <td colspan="12" style="background-color:#0f172a; color:#38bdf8; font-size:12pt; font-weight:bold; padding:8px 12px; text-align:left; border:1px solid #0f172a;">
            MONITOR USDT — REPORTE DETALLADO DE COMPRAS USDT
          </td>
        </tr>
        <tr>
          <td colspan="12" style="background-color:#1e293b; color:#e2e8f0; font-size:8.5pt; padding:5px 12px; border:1px solid #1e293b;">
            <strong>Ciclo:</strong> ${escapeHtml(cycleName)} &nbsp;|&nbsp;
            <strong>Banco:</strong> ${escapeHtml(bankLabel)} &nbsp;|&nbsp;
            <strong>Inicio:</strong> ${escapeHtml(formatDateTime(startTime))} &nbsp;|&nbsp;
            <strong>Cierre:</strong> ${escapeHtml(formatDateTime(endTime))} &nbsp;|&nbsp;
            <strong>Rol:</strong> ${escapeHtml(state.userRole || 'ADMIN')}
          </td>
        </tr>
        <tr><td colspan="12" style="height:8px;"></td></tr>

        <!-- SECCIÓN 1: RESUMEN EJECUTIVO DEL CICLO (COMPACTO PARA LAPTOP) -->
        <tr>
          <td colspan="12" style="background-color:#0f172a; color:#ffffff; font-size:9.5pt; font-weight:bold; padding:5px 10px; border:1px solid #0f172a;">
            1. RESUMEN GENERAL Y LIQUIDACIÓN DEL CICLO (${escapeHtml(bankLabel.toUpperCase())})
          </td>
        </tr>
        <tr style="background-color:#f1f5f9; font-weight:bold; text-align:center; font-size:8pt;">
          <td colspan="2" style="border:1px solid #94a3b8; padding:5px; color:#334155;">TOTAL VES PAGADOS</td>
          <td colspan="2" style="border:1px solid #94a3b8; padding:5px; color:#334155;">TASA PROMEDIO</td>
          <td colspan="2" style="border:1px solid #94a3b8; padding:5px; color:#334155;">NETO COMPRADO</td>
          <td colspan="2" style="border:1px solid #94a3b8; padding:5px; color:#0e7490;">ENVIAR AL CLIENTE (-0.425%)</td>
          <td colspan="2" style="border:1px solid #94a3b8; padding:5px; color:#b91c1c;">COMISIÓN BINANCE</td>
          <td colspan="2" style="border:1px solid #94a3b8; padding:5px; color:#7e22ce;">COMISIÓN X SERVICIO (0.425%)</td>
        </tr>
        <tr style="background-color:#ffffff; text-align:center; font-size:10.5pt; font-weight:bold;">
          <td colspan="2" style="border:1px solid #94a3b8; padding:7px; color:#b45309;">${formatVes(totalVes)}</td>
          <td colspan="2" style="border:1px solid #94a3b8; padding:7px; color:#0f172a;">${formatVes(avgRateGross)} / USDT</td>
          <td colspan="2" style="border:1px solid #94a3b8; padding:7px; color:#047857;">${fmtUsdt.format(totalUsdtNet)} USDT</td>
          <td colspan="2" style="border:1px solid #94a3b8; padding:7px; background-color:#ecfeff; color:#0369a1;">${fmtUsdt.format(totalClientUsdt)} USDT</td>
          <td colspan="2" style="border:1px solid #94a3b8; padding:7px; color:#dc2626;">${fmtCommUsdt.format(totalCommissionUsdt)} USDT</td>
          <td colspan="2" style="border:1px solid #94a3b8; padding:7px; background-color:#faf5ff; color:#7e22ce;">${fmtCommUsdt.format(totalMyCommissionUsdt)} USDT</td>
        </tr>
        <tr style="background-color:#f8fafc; text-align:center; font-size:8pt; color:#475569;">
          <td colspan="2" style="border:1px solid #cbd5e1; padding:4px;">En <strong>${orders.length}</strong> órdenes</td>
          <td colspan="2" style="border:1px solid #cbd5e1; padding:4px;">Neta: ${formatVes(avgRateNet)} | Serv: ${formatVes(avgRateClient)}</td>
          <td colspan="2" style="border:1px solid #cbd5e1; padding:4px;">Brutos: ${fmtUsdt.format(totalUsdtGross)} USDT</td>
          <td colspan="2" style="border:1px solid #cbd5e1; padding:4px;">Monto líquido al cliente</td>
          <td colspan="2" style="border:1px solid #cbd5e1; padding:4px;">Eq: <strong>${formatVes(totalCommissionVes)}</strong></td>
          <td colspan="2" style="border:1px solid #cbd5e1; padding:4px;">Eq: <strong>${formatVes(totalMyCommissionVes)}</strong></td>
        </tr>

        <tr><td colspan="12" style="height:10px;"></td></tr>

        <!-- SECCIÓN 2: DETALLE DE ÓRDENES COMPRADAS -->
        <tr>
          <td colspan="12" style="background-color:#0f172a; color:#ffffff; font-size:9.5pt; font-weight:bold; padding:5px 10px; border:1px solid #0f172a;">
            2. DETALLE DE ÓRDENES CONTABILIZADAS (${orders.length} ÓRDENES)
          </td>
        </tr>
        <tr style="background-color:#1e293b; color:#fcd535; font-weight:bold; text-align:center; font-size:8pt;">
          <td style="border:1px solid #334155; padding:5px;">#</td>
          <td style="border:1px solid #334155; padding:5px;">FECHA / HORA</td>
          <td style="border:1px solid #334155; padding:5px;">N° ORDEN</td>
          <td style="border:1px solid #334155; padding:5px;">USUARIO</td>
          <td style="border:1px solid #334155; padding:5px;">BANCO</td>
          <td style="border:1px solid #334155; padding:5px;">ESTADO</td>
          <td style="border:1px solid #334155; padding:5px;">TASA</td>
          <td style="border:1px solid #334155; padding:5px;">VES PAGADOS</td>
          <td style="border:1px solid #334155; padding:5px;">USDT BRUTO</td>
          <td style="border:1px solid #334155; padding:5px;">COM. USDT</td>
          <td style="border:1px solid #334155; padding:5px;">COM. Bs.</td>
          <td style="border:1px solid #334155; padding:5px;">USDT NETO</td>
        </tr>
        ${ordersRowsHtml}
        <!-- FILA DE TOTALES DE LA TABLA -->
        <tr style="background-color:#fef9c3; font-weight:bold; font-size:9pt;">
          <td colspan="6" style="border:2px solid #94a3b8; padding:6px; text-align:right;">TOTALES DEL CICLO (${orders.length} ÓRDENES):</td>
          <td style="border:2px solid #94a3b8; padding:6px; text-align:right; mso-number-format:'#,##0.00';">${avgRateGross.toFixed(2)}</td>
          <td style="border:2px solid #94a3b8; padding:6px; text-align:right; color:#b45309; mso-number-format:'#,##0.00';">${totalVes.toFixed(2)}</td>
          <td style="border:2px solid #94a3b8; padding:6px; text-align:right; mso-number-format:'#,##0.00';">${totalUsdtGross.toFixed(2)}</td>
          <td style="border:2px solid #94a3b8; padding:6px; text-align:right; color:#dc2626; mso-number-format:'#,##0.00';">${totalCommissionUsdt.toFixed(2)}</td>
          <td style="border:2px solid #94a3b8; padding:6px; text-align:right; color:#dc2626; mso-number-format:'#,##0.00';">${totalCommissionVes.toFixed(2)}</td>
          <td style="border:2px solid #94a3b8; padding:6px; text-align:right; color:#047857; mso-number-format:'#,##0.00';">${totalUsdtNet.toFixed(2)}</td>
        </tr>
      </table>
    </body>
    </html>
  `;

  const blob = new Blob(['\uFEFF' + excelHtml], { type: 'application/vnd.ms-excel;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  const cleanName = String(cycleName || bankLabel).replace(/[^a-zA-Z0-9_-]/g, '_');
  link.download = `Reporte_P2P_${cleanName}_${new Date().toISOString().slice(0, 10)}.xls`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
