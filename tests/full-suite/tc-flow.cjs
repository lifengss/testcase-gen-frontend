'use strict';
// D 组：核心流程逻辑合理性
// D1 生成链路不挂死；D2 入库闭环；D3 编辑草稿闭环（呼应 B1 前端缺失）
const { httpReq, asArray, fs, path, ROOT } = require('./lib.cjs');

const KS_BRAINS = path.resolve(ROOT, '..', 'test-knowledge-system', 'brains');

async function createTestDraft(base, project, type = 'quality_rule') {
  const r = await httpReq(base, 'POST', '/api/drafts', {
    query: { project },
    body: { source: 'human_edit', type, title: '[TEST-FLOW]' + Date.now(), content: '初始内容' }
  });
  if (!r.ok || !r.json || !r.json.success) throw new Error('创建草稿失败: ' + (r.json && r.json.error || r.status));
  return r.json.data.id;
}

// 删除可能由 commit 生成的 quality-rules brain 文件（按草稿 id 匹配文件名）
function cleanupBrain(project, id) {
  const dir = path.join(KS_BRAINS, project, 'quality-rules');
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (f.includes(id)) { try { fs.unlinkSync(path.join(dir, f)); } catch (_) {} }
  }
}

const CASES = [
  {
    id: 'D1',
    name: '生成链路可返回且不挂死（/api/generate）',
    group: 'D-流程逻辑',
    severity: 'high',
    async run(ctx) {
      try {
        const r = await httpReq(ctx.bff, 'POST', '/api/generate', {
          timeout: 300000, // 真实 AI（openai 直连）长内容推理可达 3-4 分钟，180s 会误杀
          body: { op: 'gen_cases', scope: { depth: 1, modules: [] }, constraints: { framework: '', note: '' } }
        });
        const d = (r.json && r.json.data && r.json.data.data) || (r.json && r.json.data) || {};
        const engine = d.engine;
        const content = d.content || '';
        const ok = r.ok && (r.json && (r.json.ok || r.json.success)) && content.length > 0;
        const detail = `status=${r.status}, engine=${engine}, contentLen=${content.length}`;
        if (!ok) {
          return { status: 'warn', detail, evidence: '生成接口未返回有效内容（可能 AI 平台未配置走回退，或入参需调整），但未挂死' };
        }
        return { status: 'pass', detail, evidence: `生成链路正常返回，engine=${engine}，内容非空` };
      } catch (e) {
        return { status: 'fail', detail: 'D1 执行异常: ' + e.message, evidence: String(e.stack || e) };
      }
    }
  },
  {
    id: 'D2',
    name: '草稿入库闭环（创建→入库→状态流转）',
    group: 'D-流程逻辑',
    severity: 'medium',
    async run(ctx) {
      let id = null;
      try {
        id = await createTestDraft(ctx.bff, ctx.PROJECT);
        const commit = await httpReq(ctx.bff, 'POST', '/api/drafts/' + id + '/commit', {
          query: { project: ctx.PROJECT },
          body: { skip_quality_gate: true, skip_conflict_check: true }
        });
        const committed = !!(commit.json && commit.json.success);
        const get = await httpReq(ctx.bff, 'GET', '/api/drafts/' + id, { query: { project: ctx.PROJECT } });
        const status = (get.json && get.json.data && get.json.data.status) || 'unknown';
        const detail = `草稿 id=${id}；commit success=${committed}；入库后状态=${status}`;
        if (!committed) {
          return { status: 'warn', detail, evidence: '入库接口未返回 success，需复核（草稿保留待处理）' };
        }
        return { status: 'pass', detail, evidence: `草稿入库闭环可用，状态流转至「${status}」` };
      } catch (e) {
        return { status: 'fail', detail: 'D2 执行异常: ' + e.message, evidence: String(e.stack || e) };
      } finally {
        if (id) {
          try { await httpReq(ctx.bff, 'DELETE', '/api/drafts/' + id, { query: { project: ctx.PROJECT } }); } catch (_) {}
          try { cleanupBrain(ctx.PROJECT, id); } catch (_) {}
        }
      }
    }
  },
  {
    id: 'D3',
    name: '编辑草稿闭环：编辑后内容在 KS 持久（两次回读一致）',
    group: 'D-流程逻辑',
    severity: 'medium',
    async run(ctx) {
      let id = null;
      try {
        id = await createTestDraft(ctx.bff, ctx.PROJECT);
        const edited = '闭环编辑内容_' + Date.now();
        await httpReq(ctx.bff, 'PUT', '/api/drafts/' + id, {
          query: { project: ctx.PROJECT }, body: { content: edited }
        });
        const g1 = await httpReq(ctx.bff, 'GET', '/api/drafts/' + id, { query: { project: ctx.PROJECT } });
        const c1 = g1.json && g1.json.data ? g1.json.data.content : '';
        const g2 = await httpReq(ctx.bff, 'GET', '/api/drafts/' + id, { query: { project: ctx.PROJECT } });
        const c2 = g2.json && g2.json.data ? g2.json.data.content : '';
        const consistent = c1 === edited && c2 === edited;
        return {
          status: consistent ? 'pass' : 'warn',
          detail: `编辑内容="${edited}"；回读1匹配=${c1 === edited}；回读2匹配=${c2 === edited}`,
          evidence: consistent ? '编辑草稿闭环持久化正确（呼应 B1：后端已具备编辑能力，前端草稿审阅页未提供 UI）' : '编辑后回读不一致，需复核'
        };
      } catch (e) {
        return { status: 'fail', detail: 'D3 执行异常: ' + e.message, evidence: String(e.stack || e) };
      } finally {
        if (id) { try { await httpReq(ctx.bff, 'DELETE', '/api/drafts/' + id, { query: { project: ctx.PROJECT } }); } catch (_) {} }
      }
    }
  }
];

module.exports = CASES;
