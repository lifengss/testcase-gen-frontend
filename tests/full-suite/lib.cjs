'use strict';
// 全量测试套件 - 公共库
// 提供：HTTP 请求助手（含超时/异常兜底）、数组归一化、报告累积器、文件读取
const fs = require('fs');
const path = require('path');

// 指向 testcase-gen-frontend 根目录（lib.cjs 位于 tests/full-suite/ 下两级）
const ROOT = path.resolve(__dirname, '..', '..');
const WEB_DIR = path.join(ROOT, 'web');

// 简易超时 fetch 封装；任何网络错误都会被抛到上层 TC 的 try/catch 处理
async function httpReq(base, method, p, { query, body, headers, timeout = 20000 } = {}) {
  let url = base + p;
  if (query) {
    const qs = Object.entries(query)
      .filter(([k, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
      .join('&');
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }
  const opts = { method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) };
  if (body !== undefined) opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const resp = await fetch(url, Object.assign(opts, { signal: ctrl.signal }));
    const text = await resp.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { /* 非 JSON 也接受 */ }
    return { ok: resp.ok, status: resp.status, text, json, url };
  } finally {
    clearTimeout(t);
  }
}

// 兼容多种返回结构：data:[...] / data.data:[...] / data.data.drafts / data.data.items
function asArray(d) {
  if (Array.isArray(d)) return d;
  if (d && Array.isArray(d.data)) return d.data;
  if (d && d.data && Array.isArray(d.data.drafts)) return d.data.drafts;
  if (d && d.data && Array.isArray(d.data.items)) return d.data.items;
  return [];
}

// 读取前端源文件（用于静态/展示层一致性断言）
function readWeb(file) {
  return fs.readFileSync(path.join(WEB_DIR, file), 'utf-8');
}

// 报告累积器
class Report {
  constructor() {
    this.cases = [];
    this.started = new Date().toISOString();
    this.env = {};
  }
  add(r) {
    this.cases.push(Object.assign({ status: 'info', severity: 'low', evidence: '', detail: '' }, r));
  }
  summary() {
    const s = { pass: 0, fail: 0, warn: 0, info: 0, total: this.cases.length };
    for (const c of this.cases) s[c.status] = (s[c.status] || 0) + 1;
    return s;
  }
}

const MARK = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', info: 'INFO' };
function logResult(r) {
  const m = MARK[r.status] || 'INFO';
  console.log(`[${m}] ${r.id}  ${r.name}  (severity=${r.severity})`);
  if (r.detail) console.log('       ' + String(r.detail).split('\n').join('\n       '));
}

module.exports = { httpReq, asArray, readWeb, Report, logResult, fs, path, ROOT, WEB_DIR };
