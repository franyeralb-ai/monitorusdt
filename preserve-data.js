const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '09009001009';
const DATA_FILE = process.env.DATA_FILE ? path.resolve(process.env.DATA_FILE) : path.join(__dirname, 'data.json');
const SEED_ENC_FILE = path.join(__dirname, 'seed.enc');

const LIVE_URLS = [
  'https://monitorusdt.com/api/admin/seed',
  'https://www.monitorusdt.com/api/admin/seed',
  'https://monitorusdt.onrender.com/api/admin/seed',
  'https://monitor-usdt.onrender.com/api/admin/seed'
];

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

function mergeArrayById(localArr = [], liveArr = [], deletedSet = new Set()) {
  const map = new Map();
  for (const item of [...localArr, ...liveArr]) {
    if (!item || !item.id || deletedSet.has(item.id)) continue;
    const existing = map.get(item.id);
    if (!existing) {
      map.set(item.id, item);
    } else {
      const existingTime = Number(existing.updatedAt || existing.createdAt || 0);
      const itemTime = Number(item.updatedAt || item.createdAt || 0);
      map.set(item.id, itemTime >= existingTime ? item : existing);
    }
  }
  return Array.from(map.values());
}

function mergeConfig(localCfg = {}, liveCfg = {}) {
  const localTime = Number(localCfg.updatedAt || 0);
  const liveTime = Number(liveCfg.updatedAt || 0);
  const newer = liveTime >= localTime ? liveCfg : localCfg;
  const older = liveTime >= localTime ? localCfg : liveCfg;
  return {
    defaultPayMethod: newer.defaultPayMethod || older.defaultPayMethod || 'Banesco',
    serviceFeePercent: newer.serviceFeePercent !== undefined ? newer.serviceFeePercent : 0.425,
    apiKey: newer.apiKey || older.apiKey || '',
    secretKey: newer.secretKey || older.secretKey || '',
    updatedAt: Math.max(localTime, liveTime)
  };
}

function mergeDataStates(localSeed, liveCloud) {
  if (!liveCloud) return localSeed;
  if (!localSeed) return liveCloud;

  const deletedIds = Array.from(new Set([
    ...(Array.isArray(localSeed.deletedIds) ? localSeed.deletedIds : []),
    ...(Array.isArray(liveCloud.deletedIds) ? liveCloud.deletedIds : [])
  ]));
  const deletedSet = new Set(deletedIds);

  const mergedConfig = mergeConfig(localSeed.config, liveCloud.config);

  // Fusionar comerciantes sin perder ninguno ni sus APIs, clientes o ciclos
  const merchantMap = new Map();
  for (const m of [...(localSeed.merchants || []), ...(liveCloud.merchants || [])]) {
    if (!m || !m.id || deletedSet.has(m.id)) continue;
    const prev = merchantMap.get(m.id);
    if (!prev) {
      merchantMap.set(m.id, {
        ...m,
        config: mergeConfig({}, m.config),
        clients: mergeArrayById([], m.clients, deletedSet),
        cycleHistory: mergeArrayById([], m.cycleHistory, deletedSet)
      });
    } else {
      const prevTime = Number(prev.updatedAt || prev.createdAt || 0);
      const currTime = Number(m.updatedAt || m.createdAt || 0);
      const base = currTime >= prevTime ? m : prev;
      merchantMap.set(m.id, {
        ...base,
        config: mergeConfig(prev.config, m.config),
        clients: mergeArrayById(prev.clients, m.clients, deletedSet),
        activeCycles: {
          'Banesco': (m.activeCycles && m.activeCycles['Banesco']) || (prev.activeCycles && prev.activeCycles['Banesco']) || null,
          'Banco de Venezuela': (m.activeCycles && m.activeCycles['Banco de Venezuela']) || (prev.activeCycles && prev.activeCycles['Banco de Venezuela']) || null
        },
        cycleHistory: mergeArrayById(prev.cycleHistory, m.cycleHistory, deletedSet)
      });
    }
  }

  const clients = mergeArrayById(localSeed.clients, liveCloud.clients, deletedSet);
  const cycleHistory = mergeArrayById(localSeed.cycleHistory, liveCloud.cycleHistory, deletedSet);

  const liveActive = liveCloud.activeCycles || {};
  const localActive = localSeed.activeCycles || {};

  return {
    config: mergedConfig,
    merchants: Array.from(merchantMap.values()),
    clients,
    activeCycles: {
      'Banesco': liveActive['Banesco'] !== undefined ? liveActive['Banesco'] : (localActive['Banesco'] || null),
      'Banco de Venezuela': liveActive['Banco de Venezuela'] !== undefined ? liveActive['Banco de Venezuela'] : (localActive['Banco de Venezuela'] || null)
    },
    cycleHistory,
    deletedIds,
    orderPayMethodCache: {
      ...(localSeed.orderPayMethodCache || {}),
      ...(liveCloud.orderPayMethodCache || {})
    }
  };
}

async function fetchLiveCloudState() {
  for (const url of LIVE_URLS) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'x-admin-key': ADMIN_PASSWORD },
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (res.ok) {
        const json = await res.json();
        if (json && json.ok && json.seedEnc) {
          const decoded = decryptSeedData(json.seedEnc);
          if (decoded && typeof decoded === 'object') {
            console.log(`[preserve-data] Estado en vivo recuperado desde ${url}`);
            return decoded;
          }
        }
      }
    } catch (e) {
      // Siguiente URL
    }
  }
  return null;
}

async function main() {
  let localState = null;

  if (fs.existsSync(SEED_ENC_FILE)) {
    try {
      localState = decryptSeedData(fs.readFileSync(SEED_ENC_FILE, 'utf8'));
    } catch (e) {}
  }

  if (fs.existsSync(DATA_FILE)) {
    try {
      const fileState = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      localState = mergeDataStates(localState, fileState);
    } catch (e) {}
  }

  const liveState = await fetchLiveCloudState();
  const finalState = mergeDataStates(localState, liveState);

  if (finalState) {
    const dataDir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(finalState, null, 2), 'utf8');
    fs.writeFileSync(SEED_ENC_FILE, encryptSeedData(finalState), 'utf8');
    console.log('[preserve-data] Todos los usuarios, comerciantes, APIs y ciclos están sincronizados y protegidos.');
  }
}

main().catch((err) => {
  console.warn('[preserve-data] Aviso:', err.message);
});
