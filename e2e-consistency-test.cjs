'use strict';
/**
 * E2E 一致性测试：前端系统(BFF) --[AI平台 CodeBuddy]--> 知识管理系统(KS)
 * 验证：生成的测试用例经前端入库后，前端读取到的内容与知识系统落盘的 .md 完全一致。
 */
const fs = require('fs');
const path = require('path');

const BFF = 'http://localhost:4123';
const KS_PROJECT_DIR = path.resolve(__dirname, '..', 'test-knowledge-system');
const PROJECT = 'testCaseGenerator';
const CATEGORY = 'test-cases';

function api(method, p, body) {
  const opts = { method, headers: {} };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  return fetch(BFF + p, opts).then(async (r) => {
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
  });
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`);
}

(async () => {
  try {
    // 0) 健康检查
    const hBFF = await api('GET', '/api/health');
    const hKS = await fetch('http://localhost:3000/api/health').then(r => r.json()).catch(e => ({ error: e.message }));
    check('BFF 健康检查', hBFF.data && hBFF.data.status === 'ok', JSON.stringify(hBFF.data));
    check('KS 健康检查', hKS && hKS.status === 'ok', JSON.stringify(hKS));

    // 1) 经 AI 平台生成测试用例（路径 A），带重试以应对 AI 偶发短响应
    let gen, genData, engine, content;
    for (let attempt = 1; attempt <= 4; attempt++) {
      gen = await api('POST', '/api/generate', {
        op: 'gen_cases',
        project: PROJECT,
        sourceRefs: { project: PROJECT },
        scope: { modules: ['add', 'login', 'search'], depth: 'full' },
        constraints: { framework: 'pytest', note: '覆盖主流程、异常分支与边界；使用 Markdown 标题/列表/代码块组织' },
      });
      genData = gen.data && gen.data.data;
      engine = genData && genData.engine;
      content = genData && genData.content;
      if (content && content.length >= 800) break;
      console.log(`  注: 第${attempt}次生成内容过短(len=${content ? content.length : 0})，重试...`);
    }
    check('AI 平台调用成功(真实 AI 通道，engine=ai-*)',
      typeof engine === 'string' && engine.startsWith('ai-'), `engine=${engine}`);
    check('生成内容非空且有结构(含#与列表)',
      typeof content === 'string' && content.length > 800 && content.includes('#'),
      `len=${content ? content.length : 0}`);

    const TITLE = 'E2E一致性测试-AI生成用例-' + Date.now();

    // 2) 前端创建草稿（路径 B：经 BFF 代理写入 KS 草稿缓冲层）
    const draft = await api('POST', '/api/drafts', {
      source: 'ai_generated', type: 'test_case', title: TITLE,
      content, project: PROJECT, metadata: { engine },
    });
    const draftId = draft.data && draft.data.data && draft.data.data.id;
    check('前端创建草稿成功', !!draftId, `draftId=${draftId}`);

    // 3) 校验 KS 草稿缓冲层内容 == 前端提交内容
    const dget = await api('GET', `/api/drafts/${draftId}`);
    const d = dget.data && dget.data.data;
    check('KS 草稿内容 == 前端提交内容',
      d && d.content === content, d ? `title=${d.title} type=${d.type} status=${d.status}` : 'no draft');
    check('KS 草稿类型为 test_case', d && d.type === 'test_case', `type=${d && d.type}`);

    // 4) 前端提交入库（路径 B：single_commit -> 写入 Brain .md）
    let commit = await api('POST', `/api/drafts/${draftId}/commit`, { project: PROJECT });
    let commitData = commit.data && commit.data.data;
    let writePath = 'realistic(质量门控)';
    if (!commitData || commitData.success === false) {
      console.log('  注: 真实质量门控未通过 ->', JSON.stringify(commitData), '；重置状态后跳过质量门控重试验证写入通路');
      await api('PUT', `/api/drafts/${draftId}/status`, { project: PROJECT, status: 'pending' });
      commit = await api('POST', `/api/drafts/${draftId}/commit`, { project: PROJECT, skip_quality_gate: true });
      commitData = commit.data && commit.data.data;
      writePath = 'skip_quality_gate(写入通路验证)';
    }
    check('提交入库成功(写入 Brain)', commitData && commitData.success === true,
      `committedPage=${(commitData && commitData.committedPage) || ''} score=${commitData && commitData.score} reason=${commitData && commitData.reason} [${writePath}]`);
    const pageSlug = commitData && commitData.committedPage; // e.g. test-cases/<id>

    // 5) 直接读磁盘 .md（知识系统落盘）
    const diskPath = path.join(KS_PROJECT_DIR, 'brains', PROJECT, CATEGORY, draftId + '.md');
    const diskExists = fs.existsSync(diskPath);
    const diskContent = diskExists ? fs.readFileSync(diskPath, 'utf-8') : null;
    check('知识系统磁盘 .md 已落盘', diskExists, diskPath);

    // 6) 经前端(BFF 代理)读取知识库页面
    const bff = await api('GET', `/api/brain/pages/${CATEGORY}/${draftId}?project=${PROJECT}`);
    const bffContent = bff.data && bff.data.data && bff.data.data.content;
    check('前端读取到的页面内容 == 知识系统磁盘 .md',
      diskExists && bffContent !== null && bffContent === diskContent,
      `bffLen=${bffContent ? bffContent.length : 'null'} diskLen=${diskContent ? diskContent.length : 'null'}`);

    // 7) 前端提交的测试用例正文应当完整保留在入库页面中
    check('生成的测试用例正文完整保留于知识库页面',
      diskContent && diskContent.replace(/\r\n/g, '\n').includes(content.replace(/\r\n/g, '\n')), 'frontmatter 包裹检测(归一化CRLF)');

    // 8) 草稿状态应已流转为 merged（且不悬挂）
    const dget2 = await api('GET', `/api/drafts/${draftId}`);
    const d2 = dget2.data && dget2.data.data;
    check('草稿状态已流转为 merged(终态,不悬挂)', d2 && d2.status === 'merged', `status=${d2 && d2.status}`);

    // 9) 审计日志应包含本次 commit
    const audit = await api('GET', `/api/audit-log?action=commit&limit=20&project=${PROJECT}`);
    const auditData = audit.data && audit.data.data;
    const auditItems = Array.isArray(auditData) ? auditData : (auditData && auditData.items) || [];
    const hasCommit = auditItems.some(a => String(a.target) === String(draftId) || (a.detail && a.detail.committedPage === pageSlug));
    check('审计日志记录了本次 commit', hasCommit, `rows=${auditItems.length}`);

    // 汇总
    const passed = results.filter(r => r.pass).length;
    const total = results.length;
    console.log('\n======== E2E 一致性测试汇总 ========');
    console.log(`通过 ${passed}/${total}`);
    console.log(`AI 引擎: ${engine}`);
    console.log(`草稿ID: ${draftId}`);
    console.log(`入库页面: ${pageSlug}`);
    console.log(`磁盘路径: ${diskPath}`);
    console.log(`写入通路: ${writePath}`);
    console.log(passed === total ? '\n✅ 全部通过：前端系统与知识管理系统内容一致' : '\n❌ 存在失败项，见上');
    process.exit(passed === total ? 0 : 1);
  } catch (e) {
    console.error('测试执行异常:', e);
    process.exit(2);
  }
})();
