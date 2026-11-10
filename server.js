const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '09009001009';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update(`p2p_secret_${ADMIN_PASSWORD}_monitor_usdt_v1`).digest('hex');
const DATA_FILE = process.env.DATA_FILE ? path.resolve(process.env.DATA_FILE) : path.join(__dirname, 'data.json');
const SEED_ENC_FILE = path.join(__dirname, 'seed.enc');
const PUBLIC_DIR = path.join(__dirname, 'public');
const BINANCE_BASE_URL = process.env.BINANCE_BASE_URL || 'https://api.binance.com';

// Cifrado AES-256-GCM para respaldar configuración/clientes en seed.enc sin exponer texto plano en GitHub
function getEncryptionKey() {
  return crypto.scryptSync(ADMIN_PASSWORD, 'monitor_usdt_salt_v1', 32);
}

function encryptSeedData(dataObj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const jsonStr = JSON.stringify(dataObj);
  const encrypted = Buffer.concat([cipher.update(jsonStr, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;
}

function decryptSeedData(payloadStr) {
  const parts = String(payloadStr || '').trim().split('.');
  if (parts.length !== 3) return null;
  const iv = Buffer.from(parts[0], 'base64');
  const tag = Buffer.from(parts[1], 'base64');
  const encrypted = Buffer.from(parts[2], 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  return JSON.parse(decrypted);
}

// Crear token firmado con rol (ADMIN o CLIENT)
function createAuthToken(sessionPayload) {
  const payload = Buffer.from(JSON.stringify({ ...sessionPayload, iat: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

// Verificar token y devolver datos de sesión ({ role: 'ADMIN' }) o null
function getAuthSession(req) {
  const token = req.headers['x-auth-token'];
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  try {
    const valid = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    if (!valid) return null;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return decoded && decoded.role ? decoded : null;
  } catch (e) {
    return null;
  }
}

// Offset entre reloj de Binance y reloj local de Windows + latencia Ping en ms
let binanceTimeOffsetMs = 0;
let lastTimeSync = 0;
let lastBinancePingMs = 0;

async function measureBinancePing() {
  const t0 = Date.now();
  try {
    const res = await fetch(`${BINANCE_BASE_URL}/api/v3/time`);
    lastBinancePingMs = Math.max(1, Date.now() - t0);
    if (res.ok) {
      const json = await res.json();
      if (json && json.serverTime) {
        binanceTimeOffsetMs = Number(json.serverTime) - Date.now();
        lastTimeSync = Date.now();
      }
    }
  } catch (err) {
    // Mantener último ping conocido si hay error puntual
  }
  return lastBinancePingMs;
}

async function getSyncedTimestamp() {
  const now = Date.now();
  if (now - lastTimeSync > 60000 || lastBinancePingMs === 0) {
    await measureBinancePing();
  }
  return Date.now() + binanceTimeOffsetMs;
}

// Inicializar o cargar base de datos local JSON (con soporte multi-ciclo por banco, clientes y comerciantes)
function loadData() {
  const defaultData = {
    config: {
      apiKey: process.env.BINANCE_API_KEY || '',
      secretKey: process.env.BINANCE_SECRET_KEY || '',
      defaultPayMethod: 'Banesco',
      serviceFeePercent: 0.425
    },
    merchants: [],
    clients: [],
    activeCycles: {
      'Banesco': null,
      'Banco de Venezuela': null
    },
    cycleHistory: [],
    orderPayMethodCache: {}
  };

  const dataDir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  if (!fs.existsSync(DATA_FILE)) {
    if (fs.existsSync(SEED_ENC_FILE)) {
      try {
        const encRaw = fs.readFileSync(SEED_ENC_FILE, 'utf8');
        const restored = decryptSeedData(encRaw);
        if (restored && typeof restored === 'object') {
          fs.writeFileSync(DATA_FILE, JSON.stringify(restored, null, 2), 'utf8');
        }
      } catch (e) {
        console.warn('No se pudo restaurar seed.enc:', e.message);
      }
    }
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(DATA_FILE, JSON.stringify(defaultData, null, 2), 'utf8');
      return defaultData;
    }
  }

  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);

    const activeCycles = {
      'Banesco': null,
      'Banco de Venezuela': null,
      ...(parsed.activeCycles || {})
    };

    // Migrar ciclo único anterior si existía
    if (parsed.activeCycle && !parsed.activeCycles) {
      const methodKey = parsed.activeCycle.payMethod === 'Banco de Venezuela' ? 'Banco de Venezuela' : 'Banesco';
      activeCycles[methodKey] = parsed.activeCycle;
    }

    // Recalcular ciclos guardados para que reflejen el esquema donde el servicio asume la comisión de Binance
    const upgradeSavedCycles = (historyList) => {
      if (!Array.isArray(historyList)) return [];
      return historyList.map((cycle) => {
        if (!cycle || !cycle.summary) return cycle;
        const s = cycle.summary;
        const totalVes = Number(s.totalVes || 0);
        const totalUsdtGross = Number(s.totalUsdtGross || 0);
        const totalUsdtNet = Number(s.totalUsdtNet || 0);
        const totalCommissionUsdt = Number(s.totalCommissionUsdt || 0);
        const totalCommissionVes = Number(s.totalCommissionVes || 0);
        const avgRateGross = totalUsdtGross > 0 ? totalVes / totalUsdtGross : Number(s.avgRateGross || 0);
        const avgRateNet = totalUsdtNet > 0 ? totalVes / totalUsdtNet : Number(s.avgRateNet || 0);

        const totalClientFeeUsdt = totalUsdtGross * 0.00425;
        const totalClientFeeVes = totalClientFeeUsdt * avgRateGross;
        const totalClientUsdt = Math.max(0, totalUsdtGross - totalClientFeeUsdt);
        const totalMyCommissionUsdt = totalClientFeeUsdt - totalCommissionUsdt;
        const totalMyCommissionVes = totalMyCommissionUsdt * avgRateGross;
        const avgRateClient = totalClientUsdt > 0 ? totalVes / totalClientUsdt : 0;

        const updatedOrders = Array.isArray(cycle.orders)
          ? cycle.orders.map((o) => {
              const amt = Number(o.amountUsdt || 0);
              const comm = Number(o.commissionUsdt || 0);
              const uPrice = Number(o.unitPrice || avgRateGross || 0);
              const cFeeUsdt = amt * 0.00425;
              const myCommUsdt = cFeeUsdt - comm;
              return {
                ...o,
                clientFeeUsdt: cFeeUsdt,
                clientFeeVes: cFeeUsdt * uPrice,
                myCommissionUsdt: myCommUsdt,
                myCommissionVes: myCommUsdt * uPrice,
                clientUsdt: Math.max(0, amt - cFeeUsdt)
              };
            })
          : [];

        return {
          ...cycle,
          summary: {
            ...s,
            totalClientFeeUsdt,
            totalClientFeeVes,
            totalMyCommissionUsdt,
            totalMyCommissionVes,
            totalClientUsdt,
            avgRateGross,
            avgRateNet,
            avgRateClient
          },
          orders: updatedOrders
        };
      });
    };

    const merchants = Array.isArray(parsed.merchants)
      ? parsed.merchants.map((m) => ({
          id: m.id,
          name: m.name,
          password: m.password,
          createdAt: m.createdAt || Date.now(),
          config: { ...defaultData.config, ...(m.config || {}) },
          clients: Array.isArray(m.clients) ? m.clients : [],
          activeCycles: {
            'Banesco': null,
            'Banco de Venezuela': null,
            ...(m.activeCycles || {})
          },
          cycleHistory: upgradeSavedCycles(m.cycleHistory)
        }))
      : [];

    return {
      config: {
        ...defaultData.config,
        ...(parsed.config || {}),
        apiKey: (parsed.config && parsed.config.apiKey) || defaultData.config.apiKey,
        secretKey: (parsed.config && parsed.config.secretKey) || defaultData.config.secretKey
      },
      merchants,
      clients: Array.isArray(parsed.clients) ? parsed.clients : [],
      activeCycles,
      cycleHistory: upgradeSavedCycles(parsed.cycleHistory),
      deletedIds: Array.isArray(parsed.deletedIds) ? parsed.deletedIds : [],
      orderPayMethodCache: parsed.orderPayMethodCache || {}
    };
  } catch (err) {
    console.error('Error leyendo data.json, usando valores por defecto:', err.message);
    return defaultData;
  }
}

// Obtener el espacio de trabajo (workspace) correspondiente al Admin Supremo o a un Comerciante específico
function getWorkspace(data, authSession) {
  if (authSession && authSession.merchantId) {
    const found = (data.merchants || []).find((m) => m.id === authSession.merchantId);
    if (found) return found;
  }
  return data; // Workspace principal del ADMIN Supremo
}

// Verificar que una clave no esté repetida en ningún rol (Admin, Comerciantes ni Clientes)
function findPasswordConflict(data, candidatePassword, excludeId = null) {
  const pass = String(candidatePassword || '').trim();
  if (pass === ADMIN_PASSWORD) {
    return 'el Administrador Supremo';
  }
  for (const m of data.merchants || []) {
    if (m.id !== excludeId && String(m.password) === pass) {
      return `el comerciante "${m.name}"`;
    }
    for (const c of m.clients || []) {
      if (c.id !== excludeId && String(c.password) === pass) {
        return `el cliente "${c.name}" (de ${m.name})`;
      }
    }
  }
  for (const c of data.clients || []) {
    if (c.id !== excludeId && String(c.password) === pass) {
      return `el cliente "${c.name}"`;
    }
  }
  return null;
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  try {
    fs.writeFileSync(SEED_ENC_FILE, encryptSeedData(data), 'utf8');
  } catch (e) {
    console.warn('No se pudo actualizar seed.enc:', e.message);
  }
}

// Firma HMAC-SHA256 según documentación oficial Binance C2C SAPI
function createSignature(queryString, secretKey) {
  return crypto
    .createHmac('sha256', secretKey)
    .update(queryString)
    .digest('hex');
}

// Petición firmada a Binance SAPI
async function binanceSignedRequest({ method = 'GET', endpoint, queryParams = {}, body = null, apiKey, secretKey }) {
  if (!apiKey || !secretKey) {
    throw new Error('Faltan las credenciales de API de Binance. Configúralas en el apartado de Configuración API.');
  }

  const timestamp = await getSyncedTimestamp();
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(queryParams)) {
    if (v !== undefined && v !== null && v !== '') {
      params.append(k, String(v));
    }
  }
  params.append('recvWindow', '60000');
  params.append('timestamp', String(timestamp));

  const queryString = params.toString();
  const signature = createSignature(queryString, secretKey);
  const fullUrl = `${BINANCE_BASE_URL}${endpoint}?${queryString}&signature=${signature}`;

  const headers = {
    'X-MBX-APIKEY': apiKey.trim(),
    'clientType': 'WEB',
    'Content-Type': 'application/json;charset=utf-8'
  };

  const fetchOptions = {
    method,
    headers
  };

  if (body && (method === 'POST' || method === 'PUT')) {
    fetchOptions.body = JSON.stringify(body);
  }

  const reqStart = Date.now();
  const response = await fetch(fullUrl, fetchOptions);
  lastBinancePingMs = Math.max(1, Date.now() - reqStart);
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`Respuesta inválida de Binance (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }

  if (!response.ok || (json.code && json.code !== '000000' && Number(json.code) < 0)) {
    const errMsg = json.msg || json.message || `Error HTTP ${response.status}`;
    const errCode = json.code || response.status;
    throw new Error(`Error de Binance (${errCode}): ${errMsg}`);
  }

  return json;
}

// Consultar saldo disponible de USDT en la Billetera de Fondos (Funding Wallet) de Binance
async function fetchFundingUsdtBalance(apiKey, secretKey) {
  if (!apiKey || !secretKey) return null;
  try {
    const res = await binanceSignedRequest({
      method: 'POST',
      endpoint: '/sapi/v1/asset/get-funding-asset',
      queryParams: { asset: 'USDT' },
      apiKey,
      secretKey
    });
    if (Array.isArray(res)) {
      const usdtItem = res.find((item) => String(item.asset || '').toUpperCase() === 'USDT');
      if (usdtItem) {
        return {
          availableUsdt: Number(usdtItem.free || 0),
          frozenUsdt: Number(usdtItem.freeze || 0) + Number(usdtItem.locked || 0)
        };
      }
      return { availableUsdt: 0, frozenUsdt: 0 };
    }
    return null;
  } catch (err) {
    return null;
  }
}

// Obtener detalle de una orden en caso de que payMethodName no venga en el listado
async function fetchOrderPayMethodDetail(orderNumber, apiKey, secretKey, cache) {
  if (cache[orderNumber]) {
    return cache[orderNumber];
  }
  try {
    const detailRes = await binanceSignedRequest({
      method: 'POST',
      endpoint: '/sapi/v1/c2c/orderMatch/getUserOrderDetail',
      body: { adOrderNo: orderNumber },
      apiKey,
      secretKey
    });

    const data = detailRes.data || {};
    const methods = [];

    if (data.payMethodName) methods.push(data.payMethodName);
    if (data.payType) methods.push(data.payType);
    if (data.payBank) methods.push(data.payBank);
    if (Array.isArray(data.payMethods)) {
      for (const pm of data.payMethods) {
        if (pm.tradeMethodName) methods.push(pm.tradeMethodName);
        if (pm.identifier) methods.push(pm.identifier);
        if (pm.bankName) methods.push(pm.bankName);
      }
    }

    const resolved = methods.filter(Boolean).join(' / ') || 'Desconocido';
    cache[orderNumber] = resolved;
    return resolved;
  } catch (err) {
    console.warn(`No se pudo obtener detalle de pago para orden ${orderNumber}:`, err.message);
    return '';
  }
}

// Obtener historial de órdenes C2C en un rango de tiempo (maneja ventanas de 30 días y paginación)
async function fetchC2CBuyOrders({ startTime, endTime, apiKey, secretKey }) {
  const MAX_WINDOW_MS = 29 * 24 * 60 * 60 * 1000;
  const allRawOrders = new Map();

  const syncedNow = await getSyncedTimestamp();
  let currentStart = Number(startTime);
  const finalEnd = Math.max(Number(endTime || syncedNow), syncedNow + 60000);

  if (isNaN(currentStart) || currentStart <= 0) {
    currentStart = syncedNow - 24 * 60 * 60 * 1000;
  }

  while (currentStart < finalEnd) {
    const currentEnd = Math.min(currentStart + MAX_WINDOW_MS, finalEnd);
    let page = 1;
    // IMPORTANTE: La API C2C de Binance devuelve máximo 50 órdenes por página aunque se pida rows=100.
    // Si rows=100, list.length (50) < rows (100) detenía la paginación en la página 1 (solo las últimas 50 órdenes).
    const rows = 50;
    const MAX_PAGES = 50; // Hasta 2.500 órdenes por ventana
    let keepPaging = true;

    while (keepPaging) {
      const response = await binanceSignedRequest({
        method: 'GET',
        endpoint: '/sapi/v1/c2c/orderMatch/listUserOrderHistory',
        queryParams: {
          tradeType: 'BUY',
          startTimestamp: currentStart,
          endTimestamp: currentEnd,
          page,
          rows
        },
        apiKey,
        secretKey
      });

      const list = Array.isArray(response.data) ? response.data : [];
      let oldestCreateTimeOnPage = Infinity;
      for (const item of list) {
        if (item && item.orderNumber) {
          allRawOrders.set(String(item.orderNumber), item);
        }
        const ct = Number(item && item.createTime ? item.createTime : 0);
        if (ct > 0 && ct < oldestCreateTimeOnPage) {
          oldestCreateTimeOnPage = ct;
        }
      }

      const totalReported = Number(response && response.total ? response.total : 0);
      const reachedTotal = totalReported > 0 && (page * rows) >= totalReported;
      const reachedBeforeStart = oldestCreateTimeOnPage < currentStart;

      if (list.length < rows || reachedTotal || reachedBeforeStart || page >= MAX_PAGES) {
        keepPaging = false;
      } else {
        page++;
      }
    }

    currentStart = currentEnd + 1;
  }

  return Array.from(allRawOrders.values());
}

// Normalizar orden y calcular métricas exactas de VES, USDT, Comisión Binance y Comisión Propia (0.425%)
function normalizeOrder(rawOrder, serviceFeePercent = 0.425) {
  const createTime = Number(rawOrder.createTime || 0);
  const amountUsdt = parseFloat(rawOrder.amount || '0') || 0;
  const totalVes = parseFloat(rawOrder.totalPrice || '0') || 0;
  const unitPrice = parseFloat(rawOrder.unitPrice || '0') || (amountUsdt > 0 ? totalVes / amountUsdt : 0);

  const makerCommission = parseFloat(rawOrder.commission || '0') || 0;
  const takerCommission = parseFloat(rawOrder.takerCommission || '0') || 0;
  const role = String(rawOrder.advertisementRole || '').toUpperCase();

  let commissionUsdt = 0;
  if (role === 'MAKER') {
    commissionUsdt = makerCommission || takerCommission;
  } else if (role === 'TAKER') {
    commissionUsdt = takerCommission || makerCommission;
  } else {
    commissionUsdt = Math.max(makerCommission, takerCommission);
  }

  const netUsdt = Math.max(0, amountUsdt - commissionUsdt);
  const commissionVes = commissionUsdt * unitPrice;

  // El servicio asume la comisión de Binance:
  // - Al cliente solo se le descuenta el 0.425% sobre los USDT Brutos comprados (amountUsdt).
  // - La ganancia neta del servicio (myCommissionUsdt) es ese 0.425% menos la comisión retenida por Binance.
  const feeRate = Number(serviceFeePercent) / 100;
  const clientFeeUsdt = amountUsdt * feeRate;
  const clientFeeVes = clientFeeUsdt * unitPrice;
  const clientUsdt = Math.max(0, amountUsdt - clientFeeUsdt);
  const myCommissionUsdt = clientFeeUsdt - commissionUsdt;
  const myCommissionVes = myCommissionUsdt * unitPrice;

  const statusRaw = String(rawOrder.orderStatus || '').toUpperCase();
  const isCompleted = statusRaw === 'COMPLETED' || statusRaw === '4';
  const isBuyerPayed = statusRaw === 'BUYER_PAYED' || statusRaw === '2' || statusRaw === 'TRADING' || statusRaw === '1';

  let statusLabel = statusRaw;
  if (isCompleted) statusLabel = 'COMPLETADA';
  else if (statusRaw === 'BUYER_PAYED' || statusRaw === '2') statusLabel = 'PAGADA (Liberando)';
  else if (statusRaw === 'TRADING' || statusRaw === '1') statusLabel = 'EN CURSO';
  else if (statusRaw.includes('CANCEL')) statusLabel = 'CANCELADA';

  const payMethodName = String(rawOrder.payMethodName || '').trim();

  return {
    orderNumber: String(rawOrder.orderNumber || ''),
    advNo: String(rawOrder.advNo || ''),
    tradeType: String(rawOrder.tradeType || 'BUY').toUpperCase(),
    asset: String(rawOrder.asset || 'USDT').toUpperCase(),
    fiat: String(rawOrder.fiat || 'VES').toUpperCase(),
    fiatSymbol: String(rawOrder.fiatSymbol || 'Bs.'),
    amountUsdt,
    netUsdt,
    clientFeeUsdt,
    clientFeeVes,
    myCommissionUsdt,
    myCommissionVes,
    clientUsdt,
    totalVes,
    unitPrice,
    commissionUsdt,
    commissionVes,
    makerCommission,
    takerCommission,
    advertisementRole: role || 'TAKER',
    orderStatus: statusRaw,
    statusLabel,
    isCompleted,
    isBuyerPayed,
    createTime,
    createTimeIso: createTime ? new Date(createTime).toISOString() : '',
    payMethodName: payMethodName || 'No especificado',
    counterPartNickName: String(rawOrder.counterPartNickName || 'Usuario P2P')
  };
}

// Evaluar si el método de pago de una orden coincide con el filtro seleccionado
function matchesPayMethod(orderPayMethod, filterValue) {
  const rawFilter = String(filterValue || '').trim().toLowerCase();
  if (!rawFilter || rawFilter === 'all' || rawFilter === 'todos') {
    return true;
  }

  const orderMethod = String(orderPayMethod || '').trim().toLowerCase();
  const parts = rawFilter.split(',').map((p) => p.trim()).filter(Boolean);

  return parts.some((part) => {
    if (part === 'banesco') {
      return orderMethod.includes('banesco');
    }
    if (part === 'banco de venezuela' || part === 'venezuela' || part === 'bdv') {
      return (
        orderMethod.includes('venezuela') ||
        orderMethod.includes('bankvenezuela') ||
        orderMethod.includes('bdv')
      );
    }
    return orderMethod.includes(part);
  });
}

// Filtrar y calcular totales del conjunto de órdenes (con soporte de tope exacto en Bs. targetVes por cliente)
function buildOrderSummary(orders, {
  startTime,
  endTime,
  payMethodFilter = 'Banesco',
  assetFilter = 'USDT',
  fiatFilter = 'VES',
  includePaidPending = true,
  preExistingCompletedIds = [],
  targetVes = null
}) {
  const startMs = Number(startTime || 0);
  const endMs = Number(endTime || Date.now()) + 120000;
  const excludedSet = new Set(Array.isArray(preExistingCompletedIds) ? preExistingCompletedIds : []);
  const numericTargetVes = Number(targetVes) > 0 ? Number(targetVes) : 0;

  const validInPeriod = orders.filter((o) => {
    if (o.tradeType !== 'BUY') return false;
    if (assetFilter && o.asset !== assetFilter.toUpperCase()) return false;
    if (fiatFilter && fiatFilter !== 'ALL' && o.fiat !== fiatFilter.toUpperCase()) return false;

    const statusAllowed = o.isCompleted || (includePaidPending && (o.orderStatus === 'BUYER_PAYED' || o.orderStatus === '2'));
    if (!statusAllowed) return false;

    if (excludedSet.size > 0 && excludedSet.has(o.orderNumber)) {
      return false;
    }

    const effectiveStart = excludedSet.size > 0 ? startMs - 45 * 60 * 1000 : startMs;
    if (effectiveStart > 0 && o.createTime < effectiveStart) return false;
    if (endMs > 0 && o.createTime > endMs) return false;
    return true;
  });

  const detectedMethods = {};
  for (const o of validInPeriod) {
    const key = o.payMethodName || 'No especificado';
    detectedMethods[key] = (detectedMethods[key] || 0) + 1;
  }

  let matchedByBank = validInPeriod.filter((o) => matchesPayMethod(o.payMethodName, payMethodFilter));

  // Si el ciclo tiene una meta específica de Bs. (targetVes) enviada por el cliente,
  // contabilizar cronológicamente hasta cubrir exactamente los Bs. del cliente.
  if (numericTargetVes > 0) {
    const chronological = [...matchedByBank].sort((a, b) => a.createTime - b.createTime);
    const cappedList = [];
    let remainingVes = numericTargetVes;

    for (const o of chronological) {
      if (remainingVes <= 0.005) break;

      if (o.totalVes <= remainingVes + 0.005) {
        cappedList.push(o);
        remainingVes = Math.max(0, remainingVes - o.totalVes);
      } else {
        const ratio = remainingVes / o.totalVes;
        const cappedAmountUsdt = o.amountUsdt * ratio;
        const cappedCommissionUsdt = o.commissionUsdt * ratio;
        const cappedCommissionVes = o.commissionVes * ratio;
        const cappedNetUsdt = o.netUsdt * ratio;
        const cappedClientFeeUsdt = cappedAmountUsdt * 0.00425;
        const cappedMyCommUsdt = cappedClientFeeUsdt - cappedCommissionUsdt;
        cappedList.push({
          ...o,
          totalVes: remainingVes,
          amountUsdt: cappedAmountUsdt,
          commissionUsdt: cappedCommissionUsdt,
          commissionVes: cappedCommissionVes,
          netUsdt: cappedNetUsdt,
          clientFeeUsdt: cappedClientFeeUsdt,
          clientFeeVes: cappedClientFeeUsdt * o.unitPrice,
          myCommissionUsdt: cappedMyCommUsdt,
          myCommissionVes: cappedMyCommUsdt * o.unitPrice,
          clientUsdt: Math.max(0, cappedAmountUsdt - cappedClientFeeUsdt),
          originalTotalVes: o.totalVes,
          isCappedToTarget: true
        });
        remainingVes = 0;
      }
    }
    matchedByBank = cappedList;
  }

  const filteredOrders = matchedByBank.sort((a, b) => b.createTime - a.createTime);

  let totalVes = 0;
  let totalUsdtGross = 0;
  let totalUsdtNet = 0;
  let totalCommissionUsdt = 0;
  let totalCommissionVes = 0;
  let completedCount = 0;
  let paidPendingCount = 0;

  for (const o of filteredOrders) {
    totalVes += o.totalVes;
    totalUsdtGross += o.amountUsdt;
    totalUsdtNet += o.netUsdt;
    totalCommissionUsdt += o.commissionUsdt;
    totalCommissionVes += o.commissionVes;
    if (o.isCompleted) completedCount++;
    else paidPendingCount++;
  }

  const avgRateGross = totalUsdtGross > 0 ? totalVes / totalUsdtGross : 0;
  const avgRateNet = totalUsdtNet > 0 ? totalVes / totalUsdtNet : 0;

  // Esquema donde el servicio asume la comisión de Binance:
  // - Al cliente solo se le descuenta el 0.425% sobre los USDT Brutos comprados (totalUsdtGross).
  // - La ganancia neta real del servicio (totalMyCommissionUsdt) es ese 0.425% menos la comisión de Binance.
  const totalClientFeeUsdt = totalUsdtGross * 0.00425;
  const totalClientFeeVes = totalClientFeeUsdt * avgRateGross;
  const totalClientUsdt = Math.max(0, totalUsdtGross - totalClientFeeUsdt);
  const totalMyCommissionUsdt = totalClientFeeUsdt - totalCommissionUsdt;
  const totalMyCommissionVes = totalMyCommissionUsdt * avgRateGross;
  const avgRateClient = totalClientUsdt > 0 ? totalVes / totalClientUsdt : 0;

  return {
    summary: {
      orderCount: filteredOrders.length,
      completedCount,
      paidPendingCount,
      totalCompletedAllMethods: validInPeriod.length,
      totalVes,
      totalUsdtGross,
      totalUsdtNet,
      totalCommissionUsdt,
      totalCommissionVes,
      totalClientFeeUsdt,
      totalClientFeeVes,
      totalMyCommissionUsdt,
      totalMyCommissionVes,
      totalClientUsdt,
      avgRateGross,
      avgRateNet,
      avgRateClient,
      targetVes: numericTargetVes > 0 ? numericTargetVes : null,
      remainingVes: numericTargetVes > 0 ? Math.max(0, numericTargetVes - totalVes) : null,
      payMethodFilter: payMethodFilter || 'Todos',
      startTime: startMs,
      endTime: Number(endTime || Date.now())
    },
    detectedMethods,
    orders: filteredOrders
  };
}

// Utilidad para leer body JSON
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
      if (body.length > 5 * 1024 * 1024) {
        reject(new Error('Payload demasiado grande'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error('JSON inválido en la petición'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function maskKey(key) {
  if (!key || key.length < 10) return key ? '****' : '';
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

// Verificar si un ciclo pertenece al operador actual (ADMIN/MERCHANT) o a un cliente específico
function cycleBelongsToClient(cycle, authSession) {
  if (!cycle || !authSession) return false;
  if (authSession.role === 'ADMIN' || authSession.role === 'MERCHANT') return true;
  if (cycle.clientId && authSession.clientId && cycle.clientId === authSession.clientId) {
    return true;
  }
  if (cycle.clientName && authSession.userName && cycle.clientName.toLowerCase() === authSession.userName.toLowerCase()) {
    return true;
  }
  return false;
}

// Servidor HTTP
const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // Health check para Render y servicios en la nube
    if (req.method === 'GET' && pathname === '/healthz') {
      return sendJson(res, 200, { ok: true, status: 'healthy', service: 'monitor-usdt' });
    }

    // Exportar estado cifrado actual (protegido por clave maestra) para sincronizar antes de git push
    if (req.method === 'GET' && pathname === '/api/admin/seed') {
      const keyHeader = String(req.headers['x-admin-key'] || '').trim();
      if (keyHeader !== ADMIN_PASSWORD) {
        return sendJson(res, 403, { ok: false, error: 'No autorizado' });
      }
      const data = loadData();
      return sendJson(res, 200, { ok: true, seedEnc: encryptSeedData(data) });
    }

    // Login obligatorio de acceso al panel (Admin Supremo: 09009001009 | Comerciantes | Clientes)
    if (req.method === 'POST' && pathname === '/api/login') {
      const body = await readJsonBody(req);
      const inputPass = String(body.password || '').trim();
      const data = loadData();

      // 1) Admin Supremo
      if (inputPass === ADMIN_PASSWORD) {
        const sessionPayload = { role: 'ADMIN', userName: 'ADMIN', clientId: null, merchantId: null };
        const token = createAuthToken(sessionPayload);
        return sendJson(res, 200, {
          ok: true,
          ...sessionPayload,
          token
        });
      }

      // 2) Comerciante registrado por el Admin Supremo
      const matchedMerchant = (data.merchants || []).find((m) => String(m.password) === inputPass);
      if (matchedMerchant) {
        const sessionPayload = {
          role: 'MERCHANT',
          userName: matchedMerchant.name,
          clientId: null,
          merchantId: matchedMerchant.id
        };
        const token = createAuthToken(sessionPayload);
        return sendJson(res, 200, {
          ok: true,
          ...sessionPayload,
          token
        });
      }

      // 3) Cliente directo del Admin Supremo
      const matchedAdminClient = (data.clients || []).find((c) => String(c.password) === inputPass);
      if (matchedAdminClient) {
        const sessionPayload = {
          role: 'CLIENT',
          userName: matchedAdminClient.name,
          clientId: matchedAdminClient.id,
          merchantId: null
        };
        const token = createAuthToken(sessionPayload);
        return sendJson(res, 200, {
          ok: true,
          ...sessionPayload,
          token
        });
      }

      // 4) Cliente perteneciente a alguno de los Comerciantes
      for (const m of data.merchants || []) {
        const matchedSubClient = (m.clients || []).find((c) => String(c.password) === inputPass);
        if (matchedSubClient) {
          const sessionPayload = {
            role: 'CLIENT',
            userName: matchedSubClient.name,
            clientId: matchedSubClient.id,
            merchantId: m.id
          };
          const token = createAuthToken(sessionPayload);
          return sendJson(res, 200, {
            ok: true,
            ...sessionPayload,
            token
          });
        }
      }

      return sendJson(res, 401, {
        ok: false,
        error: 'Clave de acceso incorrecta.'
      });
    }

    // Cerrar sesión
    if (req.method === 'POST' && pathname === '/api/logout') {
      return sendJson(res, 200, { ok: true });
    }

    // Proteger absolutamente todas las rutas /api/* exigiendo token válido con rol
    let authSession = null;
    if (pathname.startsWith('/api/')) {
      authSession = getAuthSession(req);
      if (!authSession) {
        return sendJson(res, 401, {
          ok: false,
          unauthorized: true,
          error: 'Acceso bloqueado. Ingresa tu clave de acceso.'
        });
      }
    }

    // 0. Endpoint rápido de Ping a Binance + Saldo en Fondos para Operadores (ADMIN / MERCHANT)
    if (req.method === 'GET' && pathname === '/api/ping') {
      const pingMs = await measureBinancePing();
      let fundingBalance = null;
      if (authSession.role === 'ADMIN' || authSession.role === 'MERCHANT') {
        const data = loadData();
        const ws = getWorkspace(data, authSession);
        fundingBalance = await fetchFundingUsdtBalance(ws.config.apiKey, ws.config.secretKey);
      }
      return sendJson(res, 200, { ok: true, pingMs, fundingBalance, role: authSession.role, userName: authSession.userName });
    }

    // 1. Obtener estado general (diferenciado entre ADMIN, MERCHANT y CLIENTE)
    if (req.method === 'GET' && pathname === '/api/state') {
      const data = loadData();
      saveData(data);
      const pingMs = await measureBinancePing();
      const ws = getWorkspace(data, authSession);

      if (authSession.role === 'ADMIN' || authSession.role === 'MERCHANT') {
        const fundingBalance = await fetchFundingUsdtBalance(ws.config.apiKey, ws.config.secretKey);
        const merchantsSummary = authSession.role === 'ADMIN'
          ? (data.merchants || []).map((m) => ({
              id: m.id,
              name: m.name,
              password: m.password,
              createdAt: m.createdAt,
              clientCount: (m.clients || []).length,
              cycleCount: (m.cycleHistory || []).length,
              hasApi: Boolean(m.config && m.config.apiKey && m.config.secretKey)
            }))
          : [];

        return sendJson(res, 200, {
          ok: true,
          role: authSession.role,
          userName: authSession.userName,
          clientId: null,
          merchantId: authSession.merchantId || null,
          pingMs,
          fundingBalance,
          config: {
            hasCredentials: Boolean(ws.config.apiKey && ws.config.secretKey),
            apiKeyMasked: maskKey(ws.config.apiKey),
            apiKey: ws.config.apiKey || '',
            secretKey: ws.config.secretKey || '',
            defaultPayMethod: ws.config.defaultPayMethod || 'Banesco'
          },
          merchants: merchantsSummary,
          clients: ws.clients || [],
          activeCycles: ws.activeCycles,
          cycleHistory: ws.cycleHistory
        });
      } else {
        // Vista exclusiva del Cliente: solo ve los ciclos activos y cerrados a su nombre dentro del workspace de su operador
        const clientActiveCycles = {
          'Banesco': cycleBelongsToClient(ws.activeCycles['Banesco'], authSession) ? ws.activeCycles['Banesco'] : null,
          'Banco de Venezuela': cycleBelongsToClient(ws.activeCycles['Banco de Venezuela'], authSession) ? ws.activeCycles['Banco de Venezuela'] : null
        };
        const clientHistory = (ws.cycleHistory || []).filter((c) => cycleBelongsToClient(c, authSession));

        return sendJson(res, 200, {
          ok: true,
          role: 'CLIENT',
          userName: authSession.userName,
          clientId: authSession.clientId,
          merchantId: authSession.merchantId || null,
          pingMs,
          config: {
            hasCredentials: Boolean(ws.config.apiKey && ws.config.secretKey),
            defaultPayMethod: 'Banesco'
          },
          merchants: [],
          clients: [],
          activeCycles: clientActiveCycles,
          cycleHistory: clientHistory
        });
      }
    }

    // Rutas exclusivas de ADMIN SUPREMO (/api/merchants)
    if ((pathname === '/api/merchants' || pathname.startsWith('/api/merchants/')) && authSession.role !== 'ADMIN') {
      return sendJson(res, 403, {
        ok: false,
        error: 'Acción exclusiva del Administrador Supremo.'
      });
    }

    // 1a-I. Crear nuevo Comerciante (Solo ADMIN Supremo)
    if (req.method === 'POST' && pathname === '/api/merchants') {
      const body = await readJsonBody(req);
      const name = String(body.name || '').trim();
      const password = String(body.password || '').trim();

      if (!name || !password) {
        return sendJson(res, 400, { ok: false, error: 'Debes ingresar el nombre y la clave del comerciante.' });
      }

      const data = loadData();
      const conflict = findPasswordConflict(data, password);
      if (conflict) {
        return sendJson(res, 400, { ok: false, error: `Esa clave ya está en uso por ${conflict}. Usa una clave única.` });
      }

      const newMerchant = {
        id: `mer_${Date.now()}`,
        name,
        password,
        createdAt: Date.now(),
        config: {
          apiKey: '',
          secretKey: '',
          defaultPayMethod: 'Banesco',
          serviceFeePercent: 0.425
        },
        clients: [],
        activeCycles: {
          'Banesco': null,
          'Banco de Venezuela': null
        },
        cycleHistory: []
      };

      data.merchants.push(newMerchant);
      saveData(data);

      return sendJson(res, 200, {
        ok: true,
        message: `Comerciante "${name}" registrado correctamente.`,
        merchants: data.merchants.map((m) => ({
          id: m.id,
          name: m.name,
          password: m.password,
          createdAt: m.createdAt,
          clientCount: (m.clients || []).length,
          cycleCount: (m.cycleHistory || []).length,
          hasApi: Boolean(m.config && m.config.apiKey && m.config.secretKey)
        }))
      });
    }

    // 1a-II. Cambiar clave de un Comerciante (Solo ADMIN Supremo)
    if (req.method === 'PUT' && pathname.startsWith('/api/merchants/')) {
      const merchantId = decodeURIComponent(pathname.replace('/api/merchants/', ''));
      const body = await readJsonBody(req);
      const newPassword = String(body.password || '').trim();

      if (!newPassword) {
        return sendJson(res, 400, { ok: false, error: 'La nueva clave no puede estar vacía.' });
      }

      const data = loadData();
      const targetMerchant = (data.merchants || []).find((m) => m.id === merchantId);
      if (!targetMerchant) {
        return sendJson(res, 404, { ok: false, error: 'Comerciante no encontrado.' });
      }

      const conflict = findPasswordConflict(data, newPassword, merchantId);
      if (conflict) {
        return sendJson(res, 400, { ok: false, error: `Esa clave ya está en uso por ${conflict}. Usa una clave única.` });
      }

      targetMerchant.password = newPassword;
      targetMerchant.updatedAt = Date.now();
      saveData(data);

      return sendJson(res, 200, {
        ok: true,
        message: `Clave del comerciante "${targetMerchant.name}" actualizada correctamente.`,
        merchants: data.merchants.map((m) => ({
          id: m.id,
          name: m.name,
          password: m.password,
          createdAt: m.createdAt,
          clientCount: (m.clients || []).length,
          cycleCount: (m.cycleHistory || []).length,
          hasApi: Boolean(m.config && m.config.apiKey && m.config.secretKey)
        }))
      });
    }

    // 1a-III. Eliminar un Comerciante (Solo ADMIN Supremo)
    if (req.method === 'DELETE' && pathname.startsWith('/api/merchants/')) {
      const merchantId = decodeURIComponent(pathname.replace('/api/merchants/', ''));
      const data = loadData();
      data.merchants = (data.merchants || []).filter((m) => m.id !== merchantId);
      data.deletedIds = Array.from(new Set([...(data.deletedIds || []), merchantId]));
      saveData(data);

      return sendJson(res, 200, {
        ok: true,
        merchants: data.merchants.map((m) => ({
          id: m.id,
          name: m.name,
          password: m.password,
          createdAt: m.createdAt,
          clientCount: (m.clients || []).length,
          cycleCount: (m.cycleHistory || []).length,
          hasApi: Boolean(m.config && m.config.apiKey && m.config.secretKey)
        }))
      });
    }

    // Rutas de Operador (permitidas tanto a ADMIN Supremo como a MERCHANT, bloqueadas para CLIENT)
    const operatorPaths = ['/api/config', '/api/test-connection', '/api/clients', '/api/cycle/start', '/api/cycle/stop', '/api/cycle/cancel'];
    if (
      (operatorPaths.includes(pathname) || pathname.startsWith('/api/cycle/') || pathname.startsWith('/api/clients/')) &&
      authSession.role !== 'ADMIN' &&
      authSession.role !== 'MERCHANT'
    ) {
      return sendJson(res, 403, {
        ok: false,
        error: 'Acción permitida únicamente para Administradores y Comerciantes.'
      });
    }

    // 1b. Crear nuevo Cliente en el workspace actual (ADMIN o MERCHANT)
    if (req.method === 'POST' && pathname === '/api/clients') {
      const body = await readJsonBody(req);
      const name = String(body.name || '').trim();
      const password = String(body.password || '').trim();

      if (!name || !password) {
        return sendJson(res, 400, { ok: false, error: 'Debes ingresar el nombre y la clave del cliente.' });
      }

      const data = loadData();
      const conflict = findPasswordConflict(data, password);
      if (conflict) {
        return sendJson(res, 400, { ok: false, error: `Esa clave ya está en uso por ${conflict}. Usa una clave única.` });
      }

      const ws = getWorkspace(data, authSession);
      const newClient = {
        id: `cli_${Date.now()}`,
        name,
        password,
        createdAt: Date.now()
      };

      ws.clients.push(newClient);
      saveData(data);

      return sendJson(res, 200, {
        ok: true,
        message: `Cliente "${name}" registrado correctamente.`,
        clients: ws.clients
      });
    }

    // 1c. Actualizar clave (o nombre) de un Cliente registrado (ADMIN o MERCHANT)
    if (req.method === 'PUT' && pathname.startsWith('/api/clients/')) {
      const clientId = decodeURIComponent(pathname.replace('/api/clients/', ''));
      const body = await readJsonBody(req);
      const newPassword = String(body.password || '').trim();
      const newName = body.name !== undefined ? String(body.name || '').trim() : undefined;

      if (!newPassword) {
        return sendJson(res, 400, { ok: false, error: 'La nueva clave no puede estar vacía.' });
      }

      const data = loadData();
      const ws = getWorkspace(data, authSession);
      const targetClient = (ws.clients || []).find((c) => c.id === clientId);
      if (!targetClient) {
        return sendJson(res, 404, { ok: false, error: 'Cliente no encontrado.' });
      }

      const conflict = findPasswordConflict(data, newPassword, clientId);
      if (conflict) {
        return sendJson(res, 400, { ok: false, error: `Esa clave ya está en uso por ${conflict}. Usa una clave única.` });
      }

      targetClient.password = newPassword;
      targetClient.updatedAt = Date.now();
      if (newName) {
        targetClient.name = newName;
      }
      saveData(data);

      return sendJson(res, 200, {
        ok: true,
        message: `Clave de "${targetClient.name}" actualizada correctamente.`,
        clients: ws.clients
      });
    }

    // 1d. Eliminar un Cliente (ADMIN o MERCHANT)
    if (req.method === 'DELETE' && pathname.startsWith('/api/clients/')) {
      const clientId = decodeURIComponent(pathname.replace('/api/clients/', ''));
      const data = loadData();
      const ws = getWorkspace(data, authSession);
      ws.clients = (ws.clients || []).filter((c) => c.id !== clientId);
      data.deletedIds = Array.from(new Set([...(data.deletedIds || []), clientId]));
      saveData(data);
      return sendJson(res, 200, {
        ok: true,
        clients: ws.clients
      });
    }

    // 2. Guardar configuración de APIs de Binance en el workspace actual
    if (req.method === 'POST' && pathname === '/api/config') {
      const body = await readJsonBody(req);
      const data = loadData();
      const ws = getWorkspace(data, authSession);

      if (typeof body.apiKey === 'string') {
        ws.config.apiKey = body.apiKey.trim();
      }
      if (typeof body.secretKey === 'string' && body.secretKey.trim() !== '') {
        ws.config.secretKey = body.secretKey.trim();
      }
      if (typeof body.defaultPayMethod === 'string' && body.defaultPayMethod.trim() !== '') {
        ws.config.defaultPayMethod = body.defaultPayMethod.trim();
      }
      ws.config.updatedAt = Date.now();
      if (ws !== data) {
        ws.updatedAt = Date.now();
      }

      saveData(data);
      const fundingBalance = await fetchFundingUsdtBalance(ws.config.apiKey, ws.config.secretKey);
      return sendJson(res, 200, {
        ok: true,
        message: 'Configuración de API de Binance guardada correctamente.',
        fundingBalance,
        config: {
          hasCredentials: Boolean(ws.config.apiKey && ws.config.secretKey),
          apiKeyMasked: maskKey(ws.config.apiKey),
          apiKey: ws.config.apiKey,
          secretKey: ws.config.secretKey,
          defaultPayMethod: ws.config.defaultPayMethod
        }
      });
    }

    // 3. Probar conexión con Binance C2C SAPI
    if (req.method === 'POST' && pathname === '/api/test-connection') {
      const body = await readJsonBody(req);
      const data = loadData();
      const ws = getWorkspace(data, authSession);

      const apiKey = (body.apiKey || ws.config.apiKey || '').trim();
      const secretKey = (body.secretKey || ws.config.secretKey || '').trim();

      const result = await binanceSignedRequest({
        method: 'GET',
        endpoint: '/sapi/v1/c2c/orderMatch/listUserOrderHistory',
        queryParams: {
          tradeType: 'BUY',
          page: 1,
          rows: 5
        },
        apiKey,
        secretKey
      });

      const sampleCount = Array.isArray(result.data) ? result.data.length : 0;
      return sendJson(res, 200, {
        ok: true,
        message: `Conexión exitosa con Binance P2P SAPI. (${sampleCount} órdenes recientes verificadas).`
      });
    }

    // 4. Iniciar un Ciclo para un banco específico y asignarlo al cliente seleccionado
    if (req.method === 'POST' && pathname === '/api/cycle/start') {
      const body = await readJsonBody(req);
      const data = loadData();
      const ws = getWorkspace(data, authSession);

      const syncedNow = await getSyncedTimestamp();
      const offsetMinutes = Number(body.offsetMinutes || 0);
      let startTime = body.startTime ? Number(body.startTime) : (syncedNow - offsetMinutes * 60 * 1000);

      const payMethod = (body.payMethod || 'Banesco').trim();
      const clientId = String(body.clientId || '').trim();
      const targetVes = Math.max(0, Number(body.targetVes) || 0);
      const foundClient = (ws.clients || []).find((c) => c.id === clientId);
      const clientName = foundClient ? foundClient.name : 'General';

      const datePart = `${new Date(startTime).toLocaleDateString('es-VE')} ${new Date(startTime).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' })}`;
      const name = foundClient ? `${foundClient.name} (${datePart})` : `Ciclo ${datePart}`;

      let preExistingCompletedIds = [];
      if (offsetMinutes === 0 && !body.startTime && ws.config.apiKey && ws.config.secretKey) {
        try {
          const recentRaw = await fetchC2CBuyOrders({
            startTime: syncedNow - 60 * 60 * 1000,
            endTime: syncedNow,
            apiKey: ws.config.apiKey,
            secretKey: ws.config.secretKey
          });
          preExistingCompletedIds = recentRaw
            .filter((r) => {
              const st = String(r.orderStatus || '').toUpperCase();
              return st === 'COMPLETED' || st === '4';
            })
            .map((r) => String(r.orderNumber));
        } catch (e) {
          console.warn('No se pudo tomar snapshot inicial de órdenes:', e.message);
        }
      }

      const newCycle = {
        id: `ciclo_${payMethod.replace(/\s+/g, '_')}_${syncedNow}`,
        name,
        clientId: foundClient ? foundClient.id : null,
        clientName,
        targetVes: targetVes > 0 ? targetVes : null,
        startTime,
        payMethod,
        preExistingCompletedIds,
        createdAt: syncedNow
      };

      ws.activeCycles[payMethod] = newCycle;
      saveData(data);

      return sendJson(res, 200, {
        ok: true,
        message: `Ciclo de ${payMethod} iniciado para ${clientName}.`,
        activeCycle: newCycle,
        activeCycles: ws.activeCycles
      });
    }

    // 5. Finalizar y guardar el Ciclo de un banco específico en el historial
    if (req.method === 'POST' && pathname === '/api/cycle/stop') {
      const body = await readJsonBody(req);
      const data = loadData();
      const ws = getWorkspace(data, authSession);
      const payMethod = (body.payMethod || 'Banesco').trim();
      const targetCycle = ws.activeCycles[payMethod];

      if (!targetCycle) {
        return sendJson(res, 400, { ok: false, error: `No hay ningún ciclo activo para ${payMethod}.` });
      }

      const endTime = await getSyncedTimestamp();
      const finishedCycle = {
        ...targetCycle,
        endTime,
        summary: body.summary || {
          orderCount: 0,
          totalVes: 0,
          totalUsdtGross: 0,
          totalUsdtNet: 0,
          totalCommissionUsdt: 0,
          totalCommissionVes: 0,
          avgRateGross: 0,
          avgRateNet: 0
        },
        orders: Array.isArray(body.orders) ? body.orders : []
      };

      ws.cycleHistory.unshift(finishedCycle);
      ws.activeCycles[payMethod] = null;
      saveData(data);

      return sendJson(res, 200, {
        ok: true,
        message: `Ciclo de ${payMethod} finalizado y guardado en el historial.`,
        finishedCycle,
        activeCycles: ws.activeCycles,
        cycleHistory: ws.cycleHistory
      });
    }

    // 6. Cancelar el Ciclo activo de un banco específico sin guardar
    if (req.method === 'POST' && pathname === '/api/cycle/cancel') {
      const body = await readJsonBody(req);
      const data = loadData();
      const ws = getWorkspace(data, authSession);
      const payMethod = (body.payMethod || 'Banesco').trim();
      ws.activeCycles[payMethod] = null;
      saveData(data);
      return sendJson(res, 200, {
        ok: true,
        message: `Ciclo activo de ${payMethod} descartado.`,
        activeCycles: ws.activeCycles
      });
    }

    // 7. Eliminar un ciclo del historial
    if (req.method === 'DELETE' && pathname.startsWith('/api/cycle/')) {
      const cycleId = decodeURIComponent(pathname.replace('/api/cycle/', ''));
      const data = loadData();
      const ws = getWorkspace(data, authSession);
      ws.cycleHistory = ws.cycleHistory.filter((c) => c.id !== cycleId);
      data.deletedIds = Array.from(new Set([...(data.deletedIds || []), cycleId]));
      saveData(data);
      return sendJson(res, 200, {
        ok: true,
        cycleHistory: ws.cycleHistory
      });
    }

    // 8. Sincronizar todos los ciclos activos al mismo tiempo (Banesco y Banco de Venezuela)
    if (req.method === 'GET' && pathname === '/api/cycles/sync') {
      const data = loadData();
      const ws = getWorkspace(data, authSession);
      const { apiKey, secretKey } = ws.config;
      const includePaidPending = parsedUrl.searchParams.get('includePaidPending') !== 'false';
      const syncedNow = await getSyncedTimestamp();

      const activeEntries = Object.entries(ws.activeCycles || {}).filter(([, c]) => {
        if (!c) return false;
        return cycleBelongsToClient(c, authSession);
      });

      const isOperator = authSession.role === 'ADMIN' || authSession.role === 'MERCHANT';
      const fundingBalance = isOperator ? await fetchFundingUsdtBalance(apiKey, secretKey) : null;
      const activeCyclesPayload = isOperator
        ? ws.activeCycles
        : {
            'Banesco': cycleBelongsToClient(ws.activeCycles['Banesco'], authSession) ? ws.activeCycles['Banesco'] : null,
            'Banco de Venezuela': cycleBelongsToClient(ws.activeCycles['Banco de Venezuela'], authSession) ? ws.activeCycles['Banco de Venezuela'] : null
          };
      const cycleHistoryPayload = isOperator
        ? ws.cycleHistory
        : (ws.cycleHistory || []).filter((c) => cycleBelongsToClient(c, authSession));

      if (activeEntries.length === 0) {
        return sendJson(res, 200, {
          ok: true,
          pingMs: lastBinancePingMs,
          fundingBalance,
          activeCycles: activeCyclesPayload,
          cycleHistory: cycleHistoryPayload,
          cyclesData: {}
        });
      }

      // Calcular el inicio más antiguo entre los ciclos activos para hacer una sola consulta a Binance
      let minFetchStart = syncedNow;
      for (const [, cycle] of activeEntries) {
        const hasPre = Array.isArray(cycle.preExistingCompletedIds) && cycle.preExistingCompletedIds.length > 0;
        const cStart = hasPre ? cycle.startTime - 45 * 60 * 1000 : cycle.startTime;
        if (cStart < minFetchStart) {
          minFetchStart = cStart;
        }
      }

      const rawOrders = await fetchC2CBuyOrders({
        startTime: minFetchStart,
        endTime: syncedNow,
        apiKey,
        secretKey
      });

      let cacheUpdated = false;
      const normalizedOrders = [];

      for (const raw of rawOrders) {
        const norm = normalizeOrder(raw);
        if (
          (norm.isCompleted || norm.isBuyerPayed) &&
          norm.createTime >= minFetchStart &&
          norm.createTime <= syncedNow + 120000 &&
          (!raw.payMethodName || String(raw.payMethodName).trim() === '')
        ) {
          const resolvedMethod = await fetchOrderPayMethodDetail(norm.orderNumber, apiKey, secretKey, data.orderPayMethodCache);
          if (resolvedMethod) {
            norm.payMethodName = resolvedMethod;
            cacheUpdated = true;
          }
        }
        normalizedOrders.push(norm);
      }

      const cyclesData = {};
      const autoCompletedCycles = [];

      for (const [bankKey, cycle] of activeEntries) {
        const built = buildOrderSummary(normalizedOrders, {
          startTime: cycle.startTime,
          endTime: syncedNow,
          payMethodFilter: cycle.payMethod || bankKey,
          assetFilter: 'USDT',
          fiatFilter: 'VES',
          includePaidPending,
          preExistingCompletedIds: cycle.preExistingCompletedIds || [],
          targetVes: cycle.targetVes || null
        });
        cyclesData[bankKey] = built;

        // Si ya se compró el 100% de los Bs. asignados al cliente con órdenes completadas,
        // finalizar y guardar el ciclo automáticamente tanto para el cliente como para el comerciante.
        const targetVesNum = Number(cycle.targetVes || 0);
        if (
          targetVesNum > 0 &&
          built.summary.totalVes >= targetVesNum - 0.01 &&
          built.summary.paidPendingCount === 0 &&
          built.summary.orderCount > 0
        ) {
          const finishedCycle = {
            ...cycle,
            endTime: syncedNow,
            autoCompleted: true,
            summary: built.summary,
            orders: built.orders
          };
          ws.cycleHistory.unshift(finishedCycle);
          ws.activeCycles[bankKey] = null;
          autoCompletedCycles.push(finishedCycle);
          cacheUpdated = true;
        }
      }

      if (cacheUpdated) {
        saveData(data);
      }

      const finalActiveCyclesPayload = isOperator
        ? ws.activeCycles
        : {
            'Banesco': cycleBelongsToClient(ws.activeCycles['Banesco'], authSession) ? ws.activeCycles['Banesco'] : null,
            'Banco de Venezuela': cycleBelongsToClient(ws.activeCycles['Banco de Venezuela'], authSession) ? ws.activeCycles['Banco de Venezuela'] : null
          };
      const finalCycleHistoryPayload = isOperator
        ? ws.cycleHistory
        : (ws.cycleHistory || []).filter((c) => cycleBelongsToClient(c, authSession));

      return sendJson(res, 200, {
        ok: true,
        pingMs: lastBinancePingMs,
        fundingBalance,
        activeCycles: finalActiveCyclesPayload,
        cycleHistory: finalCycleHistoryPayload,
        autoCompletedCycles,
        cyclesData
      });
    }

    // 9. Consultar órdenes de Binance P2P para un periodo específico
    if (req.method === 'GET' && pathname === '/api/orders') {
      const data = loadData();
      const ws = getWorkspace(data, authSession);
      const { apiKey, secretKey } = ws.config;

      const syncedNow = await getSyncedTimestamp();
      const startTime = Number(parsedUrl.searchParams.get('startTime') || (syncedNow - 24 * 60 * 60 * 1000));
      const endTime = Number(parsedUrl.searchParams.get('endTime') || syncedNow);
      const payMethod = parsedUrl.searchParams.get('payMethod') || ws.config.defaultPayMethod || 'Banesco';
      const fiat = parsedUrl.searchParams.get('fiat') || 'VES';
      const includePaidPending = parsedUrl.searchParams.get('includePaidPending') !== 'false';

      const rawOrders = await fetchC2CBuyOrders({
        startTime,
        endTime,
        apiKey,
        secretKey
      });

      let cacheUpdated = false;
      const normalizedOrders = [];

      for (const raw of rawOrders) {
        const norm = normalizeOrder(raw);
        if (
          (norm.isCompleted || norm.isBuyerPayed) &&
          norm.createTime >= startTime &&
          norm.createTime <= endTime + 120000 &&
          (!raw.payMethodName || String(raw.payMethodName).trim() === '')
        ) {
          const resolvedMethod = await fetchOrderPayMethodDetail(norm.orderNumber, apiKey, secretKey, data.orderPayMethodCache);
          if (resolvedMethod) {
            norm.payMethodName = resolvedMethod;
            cacheUpdated = true;
          }
        }
        normalizedOrders.push(norm);
      }

      if (cacheUpdated) {
        saveData(data);
      }

      const result = buildOrderSummary(normalizedOrders, {
        startTime,
        endTime,
        payMethodFilter: payMethod,
        assetFilter: 'USDT',
        fiatFilter: fiat,
        includePaidPending,
        preExistingCompletedIds: []
      });

      return sendJson(res, 200, {
        ok: true,
        ...result
      });
    }

    // 10. Servir archivos estáticos del frontend
    let filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end('Acceso denegado');
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.ico': 'image/x-icon'
      };
      res.writeHead(200, {
        'Content-Type': mimeTypes[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Ruta no encontrada');
    }
  } catch (err) {
    console.error('Error en el servidor:', err);
    sendJson(res, 500, {
      ok: false,
      error: err.message || 'Error interno del servidor'
    });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`  MONITOR USDT - BINANCE P2P (BANESCO / BDV)        `);
  console.log(`  Servidor activo en: http://localhost:${PORT}      `);
  console.log(`====================================================`);
});
