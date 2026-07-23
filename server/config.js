'use strict';
// 运行时配置中心：以环境变量为初始种子，运行时修改持久化到 data/config.json。
// 支持热修改——所有读取均走 cfg.get()，无需重启服务。
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CFG_FILE = path.join(DATA_DIR, 'config.json');

function defaults() {
  return {
    ks: { apiBase: process.env.KS_API_BASE || 'http://localhost:3000' },
    ai: {
      provider: (process.env.AI_PROVIDER || 'openai').toLowerCase(),
      useCustomModel: false,
      endpoint: process.env.AI_ENDPOINT || '',
      apiKey: process.env.AI_API_KEY || '',
      model: process.env.AI_MODEL || 'gpt-4o-mini',
    },
  };
}

function load() {
  const base = defaults();
  try {
    if (fs.existsSync(CFG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
      if (raw && raw.ks) base.ks = Object.assign(base.ks, raw.ks);
      if (raw && raw.ai) base.ai = Object.assign(base.ai, raw.ai);
    }
  } catch (_) { /* 配置文件损坏时回落默认 */ }
  return base;
}

let current = load();

function persist() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CFG_FILE, JSON.stringify(current, null, 2), 'utf8');
}

function get() {
  return JSON.parse(JSON.stringify(current));
}

function set(partial) {
  if (partial && partial.ks) current.ks = Object.assign(current.ks, partial.ks);
  if (partial && partial.ai) current.ai = Object.assign(current.ai, partial.ai);
  persist();
  return get();
}

module.exports = { get, set };
