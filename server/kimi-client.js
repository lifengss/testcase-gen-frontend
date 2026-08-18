'use strict';
// Kimi 通道：直接调用全局 `kimi` CLI（Moonshot 官方 Kimi Code CLI，兼容 Windows / Linux / macOS）。
// 与 codebuddy-client.js 同构：以 `node <kimi 入口脚本>` 方式启动（node 是真正的 .exe，
// 不绕 cmd.exe，且 argv 中的换行会被原样保留，避免多行 prompt 被命令行解析截断），
// 再解析其 --output-format stream-json 输出抽取 assistant 文本。
// 关键差异（vs codebuddy）：
//   - 免登录：项目自有 KIMI_CODE_HOME/config.toml 声明 type=openai + base_url 指向
//     自有/内网 OpenAI 兼容端点即可直连，无需 codebuddy login 登录态。
//   - 配置化共存：kimi/codebuddy/openai 由 config.json 的 ai.provider 切换。
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

// 项目自有 kimi 配置目录（不污染全局 ~/.kimi-code）
const KIMI_HOME = path.join(__dirname, '..', 'data', 'kimi-home');
const CONFIG_FILE = path.join(KIMI_HOME, 'config.toml');
const MAX_CONTEXT = 131072; // kimi-k2.7-code 上下文窗口（Kimi CLI 配置必需字段）

// ---------------------------------------------------------------------------
// 并发保护：kimi CLI 会在 KIMI_CODE_HOME 下维护 minidb（workspaces.json /
// query-store / search-index / session_index）。多个 kimi 进程并发读写同一
// KIMI_CODE_HOME 时，minidb 会报 "database is locked by another process"，
// 偶发导致 stream-json 输出中缺失 assistant 行（退出码 0 但内容为空）。
// 因此这里用进程内互斥队列把所有 kimi 调用串行化（同一时刻只跑一个 kimi
// 子进程），并在每次调用前清理上次异常退出残留的 workspaces.json.tmp.* 锁。
// ---------------------------------------------------------------------------
let kimiChain = Promise.resolve();

// kimi CLI（@moonshot-ai/kimi-code）每次运行会在三处残留锁文件且不清理（Windows 实测）：
//   1. KIMI_HOME/workspaces.json.tmp.<pid>.<hash>
//   2. KIMI_HOME/cache/query-store/cluster.meta.json.tmp-<pid>（minidb 锁，pid 命名，每次必残留）
//   3. KIMI_HOME/search-index/db.lock*（search-index 锁，含 db.lock / db.lock.tmp-<pid>-<n> / db.lock.bid-<pid>-<n>）
// 残留锁累积（尤其 cluster.meta.json.tmp-* 达上百个）后，后续启动会卡死（仅输出 meta 行）
// 或报 storage write failed: unrecognized I/O error。残留即视为孤儿锁（持有者进程必然已退出）。
// BFF 内所有 kimi 调用经 kimiChain 串行队列，同一时刻仅一个 kimi 子进程，清空全部锁无并发风险。
function kimiLockDirs() {
  return [
    KIMI_HOME,
    path.join(KIMI_HOME, 'cache', 'query-store'),
    path.join(KIMI_HOME, 'search-index'),
  ];
}

function isKimiLockName(name) {
  return /^(workspaces\.json\.tmp\..+|cluster\.meta\.json\.tmp-\d+|db\.lock(\.(tmp|bid)-\d+-\d+)?)$/.test(name);
}

function staleLockFiles() {
  let cleaned = 0;
  for (const dir of kimiLockDirs()) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { continue; }
    for (const name of names) {
      if (!isKimiLockName(name)) continue;
      const full = path.join(dir, name);
      try { if (fs.statSync(full).isFile()) { fs.unlinkSync(full); cleaned++; } } catch (_) {}
    }
  }
  return cleaned;
}

// 删除指定 pid 产生的锁文件（超时 SIGKILL 后调用）：
//   workspaces.json.tmp.<pid>.<hash> / cluster.meta.json.tmp-<pid> / db.lock.{tmp,bid}-<pid>-<n>
function cleanupLocksForPid(pid) {
  if (pid == null) return 0;
  const wsRe = new RegExp('^workspaces\\.json\\.tmp\\.' + pid + '\\..+$');
  const qsRe = new RegExp('^cluster\\.meta\\.json\\.tmp-' + pid + '$');
  const dbRe = new RegExp('^db\\.lock\\.(tmp|bid)-' + pid + '-\\d+$');
  let cleaned = 0;
  for (const dir of kimiLockDirs()) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { continue; }
    for (const name of names) {
      if (!wsRe.test(name) && !qsRe.test(name) && !dbRe.test(name)) continue;
      const full = path.join(dir, name);
      try { if (fs.statSync(full).isFile()) { fs.unlinkSync(full); cleaned++; } } catch (_) {}
    }
  }
  return cleaned;
}

// 串行化包装：返回 promise，实际调用在队列尾部排队执行
function serialized(fn) {
  const run = kimiChain.then(() => fn());
  // 无论成功失败，队列都要继续推进；错误由调用方自行处理
  kimiChain = run.then(() => undefined, () => undefined);
  return run;
}

function resolveCliScript() {
  if (process.env.KIMI_CODE_PATH) return process.env.KIMI_CODE_PATH;
  try {
    const gRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const p = path.join(gRoot, '@moonshot-ai', 'kimi-code', 'dist', 'main.mjs');
    if (fs.existsSync(p)) return p;
  } catch (_) { /* ignore */ }
  // 由 PATH 上的 kimi.cmd 反推全局 node_modules 前缀
  try {
    const which = execSync(process.platform === 'win32' ? 'where kimi' : 'command -v kimi',
      { encoding: 'utf8' }).toString().trim().split(/\r?\n/)[0];
    if (which) {
      const npmDir = path.dirname(which);
      const p = path.join(npmDir, 'node_modules', '@moonshot-ai', 'kimi-code', 'dist', 'main.mjs');
      if (fs.existsSync(p)) return p;
    }
  } catch (_) { /* ignore */ }
  return 'kimi'; // 回退：依赖 PATH 上的 kimi
}

// 按 config.json 的 ai 段动态生成项目自有 config.toml（幂等，仅变化时重写）
function ensureConfig(cfg) {
  const ai = (cfg && cfg.ai) || {};
  const endpoint = String(ai.endpoint || '').replace(/\/+$/, '');
  if (!endpoint) return false;
  const model = ai.model || 'kimi-k2.7-code';
  // 与 callOpenAI 相同的归一化：兼容填了 /v1 或裸 base 的写法
  let base = endpoint;
  if (!base.endsWith('/v1') && !base.endsWith('/chat/completions')) base = base + '/v1';
  const apiKey = ai.apiKey || 'local'; // 内网端点一般无需鉴权，但 openai provider 要求 api_key 非空

  const toml = [
    'default_model = "' + model + '"',
    '',
    '[providers.local]',
    'type = "openai"',
    'base_url = "' + base + '"',
    'api_key = "' + apiKey + '"',
    '',
    '[models."' + model + '"]',
    'provider = "local"',
    'model = "' + model + '"',
    'max_context_size = ' + MAX_CONTEXT,
    '',
  ].join('\n');

  try {
    fs.mkdirSync(KIMI_HOME, { recursive: true });
    if (fs.existsSync(CONFIG_FILE)) {
      if (fs.readFileSync(CONFIG_FILE, 'utf8') === toml) return true;
    }
    fs.writeFileSync(CONFIG_FILE, toml, 'utf8');
    return true;
  } catch (_) { return false; }
}

async function callKimiOnce(prompt, opts = {}) {
  const t0 = Date.now();
  // 串行执行到真正调用前再清理残留锁文件（避免多个排队调用互相竞争清理）
  staleLockFiles();
  const cliScript = resolveCliScript();
  if (!ensureConfig(opts.config || {})) {
    const e = new Error('kimi config missing (ai.endpoint not set)');
    logger.llm({
      provider: 'kimi', model: opts.model, durationMs: Date.now() - t0,
      promptLen: (prompt || '').length, success: false, error: e.message, prompt,
    });
    throw e;
  }
  const model = opts.model || ((opts.config && opts.config.ai && opts.config.ai.model) || 'kimi-k2.7-code');
  const args = [
    cliScript,
    '--output-format', 'stream-json',
  ];
  if (model) args.push('-m', model);
  args.push('-p', prompt);
  const env = { ...process.env, KIMI_CODE_HOME: KIMI_HOME, CI: '1' };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { shell: false, env });
    let out = '';
    let err = '';
    let settled = false; // 超时 SIGKILL 后 close 仍会触发，避免重复结算
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch (_) {}
      cleanupLocksForPid(child.pid); // 删除本进程产生的 workspaces.json.tmp.<child.pid>.*
      logger.llm({
        provider: 'kimi', model: model, durationMs: Date.now() - t0,
        promptLen: (prompt || '').length, success: false, error: 'kimi 生成超时',
        prompt: prompt, outSummary: out.slice(0, 400), errSummary: err.slice(0, 400),
      });
      reject(new Error('kimi 生成超时'));
    }, opts.timeout || 120000);
    child.on('error', (e) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      logger.llm({
        provider: 'kimi', model: model, durationMs: Date.now() - t0,
        promptLen: (prompt || '').length, success: false, error: String(e && e.message || e),
        prompt: prompt, outSummary: out.slice(0, 400), errSummary: err.slice(0, 400),
      });
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      // kimi stream-json：assistant 文本在 {"role":"assistant","content":"..."}（content 为字符串）
      let text = '';
      for (const line of out.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        try {
          const m = JSON.parse(s);
          if (m.role === 'assistant' && typeof m.content === 'string') text += m.content;
        } catch (_) { /* 跳过非 JSON 行（进度/日志） */ }
      }
      const result = text.trim() || null;
      if (result === null) {
        // 无有效回复：暴露真实错误（stderr 优先；无 stderr 时带 stdout 摘要），
        // 不再静默 resolve(null) 让上层只看到"端点无响应"。
        const errMsg = (err || '').trim()
          ? err.slice(0, 600)
          : ('kimi 无有效回复（code=' + code + '）stdout: ' + out.slice(0, 400));
        logger.llm({
          provider: 'kimi', model: model, durationMs: Date.now() - t0,
          promptLen: (prompt || '').length, success: false, error: errMsg,
          prompt: prompt, outSummary: out.slice(0, 400), errSummary: err.slice(0, 400),
        });
        reject(new Error(errMsg));
        return;
      }
      logger.llm({
        provider: 'kimi', model: model, durationMs: Date.now() - t0,
        promptLen: (prompt || '').length, responseLen: result.length,
        success: true, prompt: prompt, response: result,
      });
      resolve(result);
    });
  });
}

// 判断是否为「可重试」的瞬态失败（CLI 写盘/锁竞态，清锁后重试可能成功）
function isRetryable(e) {
  const m = (e && e.message) || '';
  return /storage write failed|unrecognized I\/O|database is locked|workspaces\.json\.tmp|生成超时/.test(m);
}

// 对外入口：所有 kimi 调用经串行化队列，避免并发进程共享 KIMI_CODE_HOME 锁冲突。
// 叠加一键重试：kimi CLI 在 Windows 下偶发 storage write failed（写 workspaces.json I/O 固有失败，
// 与锁残留/外部持锁/鉴权均无关），重试前强制清三类锁 + 删 tmp，多数情况下第二次能成功。
function callKimi(prompt, opts = {}) {
  const maxAttempt = opts.maxAttempt || 2;
  const attemptOnce = (n) => serialized(() => callKimiOnce(prompt, opts))
    .catch((e) => {
      if (n < maxAttempt && isRetryable(e)) {
        logger.app('warn', 'kimi 瞬态失败，准备重试', { attempt: n, error: String(e && e.message || e).slice(0, 200) });
        staleLockFiles();               // 重试前兜底清三类锁
        return attemptOnce(n + 1);
      }
      throw e;
    });
  return attemptOnce(1);
}

// 进程启动时兜底清锁：BFF 重启即清理历史残留（含 1 小时内的新鲜锁）
try { staleLockFiles(); } catch (_) {}

module.exports = { callKimi, resolveCliScript, ensureConfig, staleLockFiles, cleanupLocksForPid };
