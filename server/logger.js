// 统一日志模块（测试用例前端 BFF / Node 层）
// 两类日志，按天轮转（文件名带日期），启动时按 mtime 精确清理：
//   - 应用/操作日志：logs/app-YYYY-MM-DD.log，保留 7 天。
//   - 大模型请求/响应日志：logs/llm/app-llm-YYYY-MM-DD.log，保留 1 天（含完整 prompt+response）。
// 格式：每行一条 JSON（JSON Lines），便于 grep / jq / 脚本分析。纯后台，无前端展示。

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const LLM_DIR = path.join(LOG_DIR, 'llm');

const APP_RETENTION_DAYS = 7;
const LLM_RETENTION_DAYS = 1;

function dateStamp(d) {
  return (d || new Date()).toISOString().slice(0, 10); // YYYY-MM-DD
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}

function makeLogger(dir, retentionDays) {
  ensureDir(dir);
  function fileFor(name) {
    return path.join(dir, `${name}-${dateStamp()}.log`);
  }
  function sweep() {
    try {
      const now = Date.now();
      const maxAge = retentionDays * 24 * 3600 * 1000;
      for (const f of fs.readdirSync(dir)) {
        const fp = path.join(dir, f);
        try {
          if (now - fs.statSync(fp).mtimeMs > maxAge) fs.unlinkSync(fp);
        } catch (_) {}
      }
    } catch (_) {}
  }
  sweep();
  try { setInterval(sweep, 6 * 3600 * 1000); } catch (_) {}
  return function write(name, obj) {
    try {
      fs.appendFileSync(fileFor(name), JSON.stringify(obj) + '\n', 'utf8');
    } catch (_) {}
  };
}

const appWrite = makeLogger(LOG_DIR, APP_RETENTION_DAYS);
const llmWrite = makeLogger(LLM_DIR, LLM_RETENTION_DAYS);

function nowISO() { return new Date().toISOString(); }

function app(level, msg, meta) {
  appWrite('app', Object.assign({ ts: nowISO(), level: level, msg: msg }, meta || {}));
}

function llm(rec) {
  llmWrite('app-llm', Object.assign({ ts: nowISO() }, rec));
}

function http(req, res, durationMs, meta) {
  appWrite('app', Object.assign({
    ts: nowISO(), level: 'info', msg: 'http',
    method: req.method, path: req.path || req.url,
    status: res.statusCode, durationMs: Math.round(durationMs),
  }, meta || {}));
}

function error(err, meta) {
  appWrite('app', Object.assign({
    ts: nowISO(), level: 'error', msg: 'exception',
    error: err && err.message, stack: err && err.stack,
  }, meta || {}));
}

module.exports = { app, llm, http, error, LOG_DIR, LLM_DIR };
