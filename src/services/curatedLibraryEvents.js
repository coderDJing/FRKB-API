const logger = require('../utils/logger');

/** @type {Map<string, Set<import('http').ServerResponse>>} */
const clients = new Map();

const writeEvent = (res, event, data) => {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (error) {
    logger.warn('精选库 SSE 写入失败', { error: error?.message });
    return false;
  }
  return true;
};

function addClient(userKey, res) {
  const key = String(userKey || '').trim();
  if (!key) return;
  const set = clients.get(key) || new Set();
  set.add(res);
  clients.set(key, set);
}

function removeClient(userKey, res) {
  const key = String(userKey || '').trim();
  const set = clients.get(key);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) clients.delete(key);
}

function notifyCuratedLibraryRevision(userKey, payload) {
  const key = String(userKey || '').trim();
  const set = clients.get(key);
  if (!set || set.size === 0) return;
  for (const res of [...set]) {
    if (!writeEvent(res, 'revision', payload)) {
      set.delete(res);
    }
  }
  if (set.size === 0) clients.delete(key);
}

module.exports = {
  addClient,
  removeClient,
  notifyCuratedLibraryRevision,
  writeEvent
};
