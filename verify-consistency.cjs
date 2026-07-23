'use strict';
// 聚焦验证：针对已提交的草稿，确认「前端读取内容 == 知识系统落盘 .md」且 AI 用例正文完整保留。
const fs = require('fs');
const path = require('path');
const BFF = 'http://localhost:4123';
const KS_DIR = path.resolve(__dirname, '..', 'test-knowledge-system');
const PROJECT = 'testCaseGenerator';
const CATEGORY = 'test-cases';
const DRAFT_ID = '3655f6ab-0b8e-46b3-9be1-5e3d89cec83f';

async function api(m, p, b) {
  const o = { method: m, headers: {} };
  if (b) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(b); }
  const r = await fetch(BFF + p, o);
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = t; }
  return { status: r.status, data: d };
}

(async () => {
  // 1) KS 草稿缓冲层中的用例正文
  const draft = await api('GET', `/api/drafts/${DRAFT_ID}`);
  const draftContent = draft.data && draft.data.data && draft.data.data.content;
  const draftStatus = draft.data && draft.data.data && draft.data.data.status;

  // 2) 知识系统磁盘 .md
  const diskPath = path.join(KS_DIR, 'brains', PROJECT, CATEGORY, DRAFT_ID + '.md');
  const disk = fs.readFileSync(diskPath, 'utf-8');

  // 归一化换行符后比较（KS 在 Windows 上以 CRLF 落盘，草稿缓冲层为 LF）
  const diskLF = disk.replace(/\r\n/g, '\n');
  const closeIdx = diskLF.indexOf('---\n', 3);
  const contentInDisk = diskLF.slice(closeIdx + 4);

  console.log('草稿状态            :', draftStatus);
  console.log('草稿正文长度(LF)     :', draftContent ? draftContent.length : 'null');
  console.log('磁盘抽离正文长度(LF)  :', contentInDisk.length);
  console.log('A) 草稿正文===磁盘正文(归一化):', draftContent === contentInDisk);
  console.log('B) 磁盘以 --- 开头   :', disk.startsWith('---'));

  // 3) 前端(BFF)读取知识库页面 == 磁盘（二者同为 CRLF 落盘文件，应逐字节一致）
  const bff = await api('GET', `/api/brain/pages/${CATEGORY}/${DRAFT_ID}?project=${PROJECT}`);
  const bffContent = bff.data && bff.data.data && bff.data.data.content;
  console.log('C) 前端读取==磁盘落盘 :', bffContent === disk, `(bff=${bffContent ? bffContent.length : 'null'}, disk=${disk.length})`);

  // 4) 审计日志是否记录了本次 commit
  const audit = await api('GET', `/api/audit-log?action=commit&limit=20&project=${PROJECT}`);
  const ad = audit.data && audit.data.data;
  let items = Array.isArray(ad) ? ad : (ad && ad.items) || [];
  const found = items.some(a => String(a.target) === String(DRAFT_ID));
  console.log('D) 审计含本次 commit :', found, `(rows=${items.length})`);
  console.log('   审计原始结构:', JSON.stringify(audit.data).slice(0, 300));

  const allPass = (draftContent === contentInDisk) && disk.startsWith('---') && (bffContent === disk) && found;
  const summary = [
    '草稿状态            : ' + draftStatus,
    '草稿正文长度        : ' + (draftContent ? draftContent.length : 'null'),
    '磁盘 .md 总长度     : ' + disk.length,
    '磁盘抽离正文长度    : ' + contentInDisk.length,
    'A) 草稿正文===磁盘正文: ' + (draftContent === contentInDisk),
    'B) 磁盘以 --- 开头   : ' + disk.startsWith('---'),
    'C) 前端读取==磁盘落盘 : ' + (bffContent === disk) + ' (bff=' + (bffContent ? bffContent.length : 'null') + ', disk=' + disk.length + ')',
    'D) 审计含本次 commit : ' + found + ' (rows=' + items.length + ')',
    '',
    '=== 聚焦验证结果: ' + (allPass ? '✅ 内容一致' : '❌ 存在不一致') + ' ===',
  ].join('\n');
  fs.writeFileSync(path.join(__dirname, 'verify-out.txt'), summary, 'utf-8');
  console.log(summary);
  process.exitCode = allPass ? 0 : 1;
})();
