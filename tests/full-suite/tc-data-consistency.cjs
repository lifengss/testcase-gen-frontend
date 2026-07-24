'use strict';
// C 组：前后端 / 知识系统数据一致性
// C1 多项目隔离（默认 project 不统一隐患）；C2 知识库规模统计一致性（回归）；C3 源上传中文乱码回归（核心修复点）
const { httpReq, asArray, fs, path, ROOT } = require('./lib.cjs');

const KS_BRAINS = path.resolve(ROOT, '..', 'test-knowledge-system', 'brains');

async function uploadPrdViaBff(ctx, buf, origName) {
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'text/markdown' }), origName); // 中文名触发 BFF 还原逻辑
  form.append('type', 'prd');
  form.append('project', ctx.PROJECT);
  const resp = await fetch(ctx.bff + '/api/source-upload', { method: 'POST', body: form });
  return resp;
}

const CASES = [
  {
    id: 'C1',
    name: '多项目隔离：BFF 默认 project 不统一隐患',
    group: 'C-数据一致性',
    severity: 'medium',
    async run(ctx) {
      try {
        // 动态：不带 project 的 GET /api/drafts，检查返回草稿实际归属的 projectId
        const none = await httpReq(ctx.bff, 'GET', '/api/drafts', { query: { limit: 10 } });
        const arr = asArray(none.json && none.json.data);
        const pids = [...new Set(arr.map((d) => d.projectId).filter(Boolean))];
        // 静态：读取 server/index.js 确认各路由默认 project 是否统一
        const srv = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf-8');
        const genDefault = /project\s*=\s*'testCaseGenerator'/.test(srv);
        const uploadDefault = /req\.body\.project\s*\|\|\s*'default'/.test(srv);
        const detail = `不带project草稿 projectId 分布=${JSON.stringify(pids)}；generate默认testCaseGenerator=${genDefault}；source-upload默认default=${uploadDefault}`;
        const issues = [];
        if (genDefault && uploadDefault) issues.push('BFF 默认 project 不统一：generate=testCaseGenerator，source-upload=default');
        if (pids.length && !pids.every((p) => p === ctx.PROJECT)) {
          issues.push(`不带project请求落到非主项目 projectId=${pids.join(',')}（proxy GET 未注入默认project，依赖 KS 默认）`);
        }
        if (issues.length) {
          return { status: 'warn', detail, evidence: issues.join('；') + '。前端因始终显式带project暂未触发故障，但属数据一致性隐患' };
        }
        return { status: 'pass', detail, evidence: '默认 project 行为一致，多项目隔离链路正确' };
      } catch (e) {
        return { status: 'fail', detail: 'C1 执行异常: ' + e.message, evidence: String(e.stack || e) };
      }
    }
  },
  {
    id: 'C2',
    name: '知识库规模统计 BFF 与 KS 一致（回归 E2E）',
    group: 'C-数据一致性',
    severity: 'medium',
    async run(ctx) {
      try {
        const sb = await httpReq(ctx.bff, 'GET', '/api/stats', { query: { project: ctx.PROJECT } });
        const sk = await httpReq(ctx.ks, 'GET', '/api/stats', { query: { project: ctx.PROJECT } });
        const b = (sb.json && sb.json.data) || sb.json || {};
        const k = (sk.json && sk.json.data) || sk.json || {};
        const getNum = (o, keys) => { for (const key of keys) if (typeof o[key] === 'number') return o[key]; return undefined; };
        const bp = getNum(b, ['totalPages', 'pages', 'pageCount', 'wiki', 'brainPages']);
        const kp = getNum(k, ['totalPages', 'pages', 'pageCount', 'wiki', 'brainPages']);
        const detail = `BFF stats=${JSON.stringify(b).slice(0, 200)}；KS stats=${JSON.stringify(k).slice(0, 200)}`;
        if (bp === undefined || kp === undefined) {
          return { status: 'warn', detail, evidence: 'stats 结构不含可比对 pages 字段，需人工核对' };
        }
        if (bp !== kp) {
          return { status: 'fail', detail, evidence: `BFF pages=${bp} 与 KS pages=${kp} 不一致` };
        }
        // 关键规模字段逐项比对（BFF 代理统计应与 KS 直连一致）
        const fields = ['totalDrafts', 'mergedDrafts', 'pendingDrafts', 'rejectedDrafts', 'conflictDrafts', 'totalPages', 'totalRules'];
        const diffs = fields.filter((f) => typeof b[f] === 'number' && typeof k[f] === 'number' && b[f] !== k[f]);
        if (diffs.length) {
          return { status: 'fail', detail, evidence: '规模字段不一致: ' + diffs.map((f) => `${f}(BFF=${b[f]},KS=${k[f]})`).join('；') };
        }
        return { status: 'pass', detail, evidence: 'BFF 与 KS 知识库规模统计一致（pages 与关键字段全部匹配）' };
      } catch (e) {
        return { status: 'fail', detail: 'C2 执行异常: ' + e.message, evidence: String(e.stack || e) };
      }
    }
  },
  {
    id: 'C3',
    name: '源上传中文 PRD 经 BFF 入库无乱码（回归 undici 修复）',
    group: 'C-数据一致性',
    severity: 'high',
    async run(ctx) {
      const srcFile = path.join(ROOT, 'docs', '架构设计与技术方案.md');
      const origName = '架构设计与技术方案__TEST__.md';
      const slug = 'prd-架构设计与技术方案__TEST__';
      const diskPath = path.join(KS_BRAINS, ctx.PROJECT, 'project-wiki', slug + '.md');
      let created = false;
      try {
        if (!fs.existsSync(srcFile)) throw new Error('源 PRD 不存在: ' + srcFile);
        const buf = fs.readFileSync(srcFile); // 干净 UTF-8
        const resp = await uploadPrdViaBff(ctx, buf, origName);
        const rt = await resp.text();
        let rj = null; try { rj = JSON.parse(rt); } catch (_) {}
        created = !!(rj && rj.success);
        const pages = await httpReq(ctx.bff, 'GET', '/api/brain/pages', { query: { category: 'project-wiki', project: ctx.PROJECT } });
        const arr = asArray(pages.json && pages.json.data);
        const page = arr.find((p) => (p.slug || p.id || '').includes('__TEST__')) || arr.find((p) => (p.title || '').includes('__TEST__'));
        let content = '';
        if (page && page.content) content = page.content;
        else if (fs.existsSync(diskPath)) content = fs.readFileSync(diskPath, 'utf-8');
        const mojibake = /Ã/.test(content) || content.includes('�');
        const hasCn = /[一-龥]/.test(content);
        const detail = `上传返回 success=${created}；落盘含中文=${hasCn}；含乱码(Ã/U+FFFD)=${mojibake}；pageFound=${!!page}`;
        if (mojibake) {
          return { status: 'fail', detail, evidence: '中文 PRD 经 BFF 上传后仍出现 Latin-1 双层乱码，undici 修复回归！' };
        }
        if (!hasCn) {
          return { status: 'warn', detail, evidence: '落盘内容未含中文，可能上传/读取路径不对，需人工核对' };
        }
        return { status: 'pass', detail, evidence: '中文 PRD 经 BFF 入库无乱码，回归修复有效' };
      } catch (e) {
        return { status: 'fail', detail: 'C3 执行异常: ' + e.message, evidence: String(e.stack || e) };
      } finally {
        if (fs.existsSync(diskPath)) { try { fs.unlinkSync(diskPath); } catch (_) {} }
      }
    }
  }
];

module.exports = CASES;
