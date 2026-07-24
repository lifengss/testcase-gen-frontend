'use strict';
// B 组：草稿审阅页流程逻辑 / 与知识管理系统一致性
// B1 静态对比前端功能缺失；B2/B3/B4 为可运行的接口一致性验证（自带异常兜底与数据清理）
const { readWeb, httpReq, asArray, fs, path, ROOT } = require('./lib.cjs');

const KS_APP = path.resolve(ROOT, '..', 'test-knowledge-system', 'web', 'src', 'app.js');
function readKsFront() { return fs.readFileSync(KS_APP, 'utf-8'); }

async function createTestDraft(base, project) {
  const r = await httpReq(base, 'POST', '/api/drafts', {
    query: { project },
    body: { source: 'human_edit', type: 'quality_rule', title: '[TEST-DRAFT]' + Date.now(), content: '原始内容' }
  });
  if (!r.ok || !r.json || !r.json.success) throw new Error('创建草稿失败: ' + (r.json && r.json.error || r.status));
  return r.json.data.id;
}

const CASES = [
  {
    id: 'B1',
    name: '草稿审阅页缺少编辑/批量删除/可勾选选择（与 KS 不一致）',
    group: 'B-草稿审阅一致性',
    severity: 'high',
    async run() {
      try {
        const v2 = readWeb('app.v2.js');
        const ks = readKsFront();
        const hasEditBtn = /draftCard[\s\S]{0,1500}?(编辑|edit|btn-edit|data-act="edit")/.test(v2)
          || /loadReview[\s\S]{0,1500}?data-act="edit"/.test(v2);
        const hasCheckbox = /type="checkbox"/.test(v2);
        const hasBatchDelete = /批量删除|batchDelete|batch-delete|data-act="batch-delete"/.test(v2);
        const ksHasEdit = /function editDraft|editDraft\(/.test(ks);
        const ksHasCheckbox = /type="checkbox"/.test(ks);
        const ksHasBatchDelete = /batchDeleteDrafts|批量删除/.test(ks);
        const detail =
          `业务前端: 编辑按钮=${hasEditBtn}, 复选框=${hasCheckbox}, 批量删除=${hasBatchDelete}；` +
          `KS: 编辑=${ksHasEdit}, 复选框=${ksHasCheckbox}, 批量删除=${ksHasBatchDelete}`;
        const missing = [];
        if (!hasEditBtn && ksHasEdit) missing.push('编辑');
        if (!hasCheckbox && ksHasCheckbox) missing.push('可勾选批量选择');
        if (!hasBatchDelete && ksHasBatchDelete) missing.push('批量删除');
        if (missing.length) {
          return {
            status: 'fail',
            detail,
            evidence: `草稿审阅页(loadReview/draftCard)仅为卡片式+「删除/入库」按钮，缺少 KS 草稿审核页已有的功能: ${missing.join('、')}。`
              + `draftCard 关键片段见 web/app.v2.js（仅渲染 .del/.commit 两类按钮，无编辑/复选框）`
          };
        }
        return { status: 'info', detail, evidence: '功能集一致' };
      } catch (e) {
        return { status: 'fail', detail: 'B1 执行异常: ' + e.message, evidence: String(e.stack || e) };
      }
    }
  },
  {
    id: 'B2',
    name: '后端草稿编辑能力经 BFF 可用（凸显前端未提供编辑 UI）',
    group: 'B-草稿审阅一致性',
    severity: 'medium',
    async run(ctx) {
      let id = null;
      try {
        id = await createTestDraft(ctx.bff, ctx.PROJECT);
        const edited = '已编辑内容_' + Date.now();
        const up = await httpReq(ctx.bff, 'PUT', '/api/drafts/' + id, {
          query: { project: ctx.PROJECT },
          body: { content: edited, title: '[TEST-DRAFT-EDITED]' }
        });
        if (!up.ok || !up.json || !up.json.success) throw new Error('编辑失败: ' + (up.json && up.json.error || up.status));
        const get = await httpReq(ctx.bff, 'GET', '/api/drafts/' + id, { query: { project: ctx.PROJECT } });
        const got = get.json && get.json.data ? get.json.data.content : '';
        const ok = got === edited;
        return {
          status: ok ? 'pass' : 'warn',
          detail: `创建草稿 id=${id}；PUT 编辑后回读 content 匹配=${ok}`,
          evidence: ok
            ? 'BFF 通配代理 PUT /api/drafts/:id 成功编辑草稿内容（KS 支持 editDraft 对应接口），能力可用 → 草稿审阅页“无编辑”属前端缺失而非后端不支持'
            : '编辑接口返回成功但回读内容不符，需复核透传'
        };
      } catch (e) {
        return { status: 'fail', detail: 'B2 执行异常: ' + e.message, evidence: String(e.stack || e) };
      } finally {
        if (id) { try { await httpReq(ctx.bff, 'DELETE', '/api/drafts/' + id, { query: { project: ctx.PROJECT } }); } catch (_) {} }
      }
    }
  },
  {
    id: 'B3',
    name: 'BFF 草稿列表透传与 KS 一致（数量+字段）',
    group: 'B-草稿审阅一致性',
    severity: 'medium',
    async run(ctx) {
      try {
        const rb = await httpReq(ctx.bff, 'GET', '/api/drafts', { query: { project: ctx.PROJECT, limit: 200 } });
        const rk = await httpReq(ctx.ks, 'GET', '/api/drafts', { query: { project: ctx.PROJECT, limit: 200 } });
        const b = asArray(rb.json && rb.json.data);
        const k = asArray(rk.json && rk.json.data);
        if (b.length !== k.length) {
          return { status: 'fail', detail: `BFF 返回 ${b.length} 条, KS 返回 ${k.length} 条`, evidence: 'BFF 草稿透传数量与 KS 不一致（可能不是同一 project 或透传丢数据）' };
        }
        const keysB = b[0] ? Object.keys(b[0]).sort().join(',') : '';
        const expected = ['id', 'source', 'type', 'title', 'status', 'content'];
        const lack = expected.filter((f) => !keysB.includes(f));
        return {
          status: lack.length ? 'warn' : 'pass',
          detail: `BFF=${b.length} 条, KS=${k.length} 条；首条字段=[${keysB}]`,
          evidence: lack.length ? `草稿字段缺: ${lack.join(',')}` : '数量与字段一致，透传无丢失'
        };
      } catch (e) {
        return { status: 'fail', detail: 'B3 执行异常: ' + e.message, evidence: String(e.stack || e) };
      }
    }
  },
  {
    id: 'B4',
    name: 'loadReview 的 source=human_edit 过滤真实生效',
    group: 'B-草稿审阅一致性',
    severity: 'medium',
    async run(ctx) {
      try {
        const all = await httpReq(ctx.bff, 'GET', '/api/drafts', { query: { project: ctx.PROJECT, limit: 200 } });
        const he = await httpReq(ctx.bff, 'GET', '/api/drafts', { query: { project: ctx.PROJECT, source: 'human_edit', limit: 200 } });
        const allArr = asArray(all.json && all.json.data);
        const heArr = asArray(he.json && he.json.data);
        const allHuman = heArr.every((d) => d.source === 'human_edit');
        const detail = `全部=${allArr.length} 条；source=human_edit=${heArr.length} 条；过滤后全部为 human_edit=${allHuman}`;
        const issues = [];
        if (!allHuman) issues.push('source 过滤未严格生效（混入了非 human_edit）');
        if (heArr.length === 0) issues.push('当前项目无 human_edit 草稿 → loadReview 页将恒空');
        if (issues.length) return { status: 'warn', detail, evidence: issues.join('；') };
        return { status: 'pass', detail, evidence: 'source=human_edit 过滤生效且与 loadReview 语义一致' };
      } catch (e) {
        return { status: 'fail', detail: 'B4 执行异常: ' + e.message, evidence: String(e.stack || e) };
      }
    }
  }
];

module.exports = CASES;
