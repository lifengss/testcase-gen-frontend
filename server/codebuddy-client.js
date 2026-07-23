'use strict';
// CodeBuddy 通道：直接调用全局 `codebuddy` CLI（兼容 Windows / Linux / macOS）。
// 说明：@tencent-ai/agent-sdk 的 stdio 传输在 Windows 上无法自启 CLI（捆绑的是 Unix 脚本、
// 且无 Windows 二进制；SDK 用 spawn(shell:false) 又拉不起 .cmd），因此改由本模块直接以
// `node <codebuddy 入口脚本>` 方式启动（node 是真正的 .exe，不绕 cmd.exe，且 argv 中的换行
// 会被原样保留，避免多行 prompt 被命令行解析截断），再解析其 --output-format stream-json 输出。
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function resolveCliScript() {
  if (process.env.CODEBUDDY_CODE_PATH) return process.env.CODEBUDDY_CODE_PATH;
  try {
    const gRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const p = path.join(gRoot, '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy');
    if (fs.existsSync(p)) return p;
  } catch (_) { /* ignore */ }
  return 'codebuddy'; // 回退：依赖 PATH 上的 codebuddy（Linux/macOS 常见）
}

function modelsFileExists() {
  const candidates = [
    path.join(process.cwd(), '.codebuddy', 'models.json'),
    path.join(os.homedir(), '.codebuddy', 'models.json'),
  ];
  return candidates.some((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
}

async function callCodeBuddy(prompt, opts = {}) {
  const cliScript = resolveCliScript();
  // 是否加载用户/项目设置源：仅在显式要求(opts.loadSettings)或本地存在 .codebuddy/models.json 时开启，
  // 以便 CodeBuddy 解析其中注册的自定义模型（含自有 endpoint/apiKey）。
  // 默认仍为 none，保持 BFF 行为纯净（不加载项目 MCP/Rules）。
  const loadSettings = !!opts.loadSettings || modelsFileExists();
  const settingSources = loadSettings ? 'project,local' : 'none';
  // 未显式给定模型且已加载设置时，交由 CodeBuddy 使用 settings.local.json 的默认模型；
  // 否则回落到内置模型或 AI_MODEL 环境变量。
  const model = opts.model || (loadSettings ? undefined : (process.env.AI_MODEL || 'claude-sonnet-4'));
  const args = [
    cliScript,
    '--output-format', 'stream-json',
  ];
  if (model) args.push('--model', model);
  args.push(
    '--permission-mode', 'bypassPermissions',
    '--setting-sources', settingSources,
    '--max-turns', String(opts.maxTurns || 4),
    '-p', prompt,
  );
  // 统一用 node 直接跑入口脚本：绕开 cmd.exe，保留多行 prompt
  const env = { ...process.env };
  if (process.env.CODEBUDDY_INTERNET_ENVIRONMENT) {
    env.CODEBUDDY_INTERNET_ENVIRONMENT = process.env.CODEBUDDY_INTERNET_ENVIRONMENT;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { shell: false, env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      reject(new Error('codebuddy 生成超时'));
    }, opts.timeout || 120000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out.trim()) {
        reject(new Error('codebuddy 退出码 ' + code + ': ' + err.slice(0, 600)));
        return;
      }
      let text = '';
      for (const line of out.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        try {
          const m = JSON.parse(s);
          if (m.type === 'assistant' && Array.isArray(m.message && m.message.content)) {
            for (const b of m.message.content) if (b.type === 'text') text += b.text;
          }
        } catch (_) { /* 跳过非 JSON 行（进度/日志） */ }
      }
      resolve(text.trim() || null);
    });
  });
}

module.exports = { callCodeBuddy };
