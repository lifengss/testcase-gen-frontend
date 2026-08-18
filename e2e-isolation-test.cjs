// 项目隔离不变式测试（独立、可无人值守运行）
// 核心不变式：对【任意】项目 P，在 P 下产生的测试用例 / 测试脚本 / 测试大纲，
// 保存后应当「且仅应当」在 P 的对应存储（草稿箱 / 项目 Wiki）中多出这些条目，
// 而【所有其他项目】的草稿箱与 Wiki 内容保持完全不变（集合逐条相等）。
//
// 用法：
//   node e2e-isolation-test.cjs            # 用前端当前项目作为目标 P，覆盖全部已知项目
//   node e2e-isolation-test.cjs <project>  # 指定目标项目 P
'use strict';
const { execFileSync } = require('child_process');
const AB = 'C:/Users/lif_lc/AppData/Roaming/npm/node_modules/agent-browser/bin/agent-browser.js';
const BFF = 'http://localhost:4123/';
const KS = 'http://127.0.0.1:3000';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let PASS = 0, FAIL = 0, FAILS = [];
function check(name, cond, detail = '') {
  if (cond) { PASS++; console.log(`  ✔ ${name}`); }
  else { FAIL++; FAILS.push(name); console.log(`  ✘ ${name} ${detail}`); }
}
const g = (path, qs = '') => fetch(`${KS}${path}${qs ? '?' + qs : ''}`).then(r => r.json());
const p = (path, body) => fetch(`${KS}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());

// 取某项目草稿箱：{ titles:Set(去重标题), count:实际条数 }
async function draftTitles(project) {
  const r = await g('/api/drafts', `project=${encodeURIComponent(project)}&limit=2000`);
  const items = (r.data && Array.isArray(r.data)) ? r.data : [];
  return { titles: new Set(items.map(d => d.title).filter(Boolean)), count: items.length };
}
// 取某项目 Wiki 页面 slug 集合（project-wiki 分类）
async function wikiSlugs(project) {
  const r = await g('/api/brain/pages', `project=${encodeURIComponent(project)}&category=project-wiki&limit=2000`);
  const items = (r.data && Array.isArray(r.data)) ? r.data : [];
  return new Set(items.map(d => d.slug || d.id || d.title).filter(Boolean));
}

// 在浏览器 UI 中以当前项目保存：一条测试用例 + 一条测试脚本 + 一个大纲
// 走真实链路：切项目 → 切生成中心 → 选模式 → 点生成（AI 不可用自动回退模板，仍填充 state.lastGenerated）→ 点保存
async function saveViaUI(P) {
  const ab = (args, timeout = 120000) => execFileSync('node', [AB, ...args], { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const evalJs = js => { try { return JSON.parse(ab(['eval', js])); } catch (e) { return null; } };

  evalJs(`(() => { try { localStorage.setItem('tg_currentProject', ${JSON.stringify(P)}); } catch(e){} return 'ok'; })()`);
  await sleep(400);
  evalJs(`(() => { const n = document.querySelector('.nav-item[data-view="generator"]'); if (n) { n.click(); return 'generator'; } return 'no-nav'; })()`);
  await sleep(2200);

  const modes = ['gen_cases', 'gen_scripts', 'gen_outline'];
  for (const m of modes) {
    // 选模式
    evalJs(`(() => { const b = document.querySelector('#genSeg button[data-t="${m}"]'); if (b) { b.click(); return '${m}'; } return 'no-btn'; })()`);
    await sleep(500);
    // 点生成（真实调用 /api/generate，AI 不可用回退模板）
    evalJs(`(() => { const g = document.querySelector('#genBtn'); if (g) { g.click(); return 'gen'; } return 'no-gen'; })()`);
    // 等生成完成（streamBody 出现 .md 且无"生成失败"）
    let okGen = false, lastSt = '';
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      const st = evalJs(`(() => {
        const b = document.querySelector('#streamBody');
        const meta = document.querySelector('#streamMeta');
        if (!b) return 'no-body';
        if (/生成失败/.test(b.innerText)) return 'fail';
        if (b.querySelector('.md') && meta && /引擎/.test(meta.textContent)) return 'done';
        return 'wait';
      })()`);
      lastSt = st;
      if (st === 'done') { okGen = true; break; }
      if (st === 'fail') break;
    }
    if (!okGen) { console.warn(`  [${m}] 生成未完成(状态=${lastSt})，跳过保存`); continue; }
    // 点保存
    evalJs(`(() => { const sd = document.querySelector('#saveDraft'); if (sd) { sd.click(); return 'saved'; } return 'no-save'; })()`);
    await sleep(2000);
  }
}

async function main() {
  const target = process.argv[2] || '';
  // 取全部真实项目
  const pr = await g('/api/projects');
  const projects = (pr.projects || []).map(x => x.id);
  if (!projects.includes('default')) projects.unshift('default');
  console.log(`\n[项目列表] ${projects.join(', ')}`);

  const P = target || (pr.defaultProject === 'default' ? 'default' : (pr.defaultProject || 'default'));
  if (!projects.includes(P)) projects.push(P);
  console.log(`[目标项目] ${P}（在其下保存内容）`);

  // ---- 快照（保存前）----
  console.log('\n[快照] 保存前');
  const beforeDrafts = {}, beforeWiki = {};
  for (const pj of projects) {
    beforeDrafts[pj] = await draftTitles(pj);
    beforeWiki[pj] = await wikiSlugs(pj);
    console.log(`  ${pj}: 草稿 ${beforeDrafts[pj].count} / Wiki ${beforeWiki[pj].size}`);
  }

  // ---- 通过 UI 在 P 下保存 ----
  console.log(`\n[操作] 在 ${P} 下经 UI 保存 1 用例 + 1 脚本 + 1 大纲`);
  const openOut = execFileSync('node', [AB, 'open', BFF], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  console.log(`  ${openOut.split('\n')[0]}`);
  await sleep(2500);
  // 确保 UI 当前项目 = P
  if (target) {
    execFileSync('node', [AB, 'eval', `(() => { try { localStorage.setItem('tg_currentProject', ${JSON.stringify(P)}); } catch(e){} return 'ok'; })()`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    await sleep(500);
  }
  await saveViaUI();

  // ---- 快照（保存后）----
  console.log('\n[快照] 保存后');
  const afterDrafts = {}, afterWiki = {};
  for (const pj of projects) {
    afterDrafts[pj] = await draftTitles(pj);
    afterWiki[pj] = await wikiSlugs(pj);
    console.log(`  ${pj}: 草稿 ${afterDrafts[pj].count} / Wiki ${afterWiki[pj].size}`);
  }

  // ---- 不变式断言 ----
  console.log('\n[断言] 项目隔离不变式');

  // A. 目标项目 P 草稿箱精确 +2 条（1 用例 + 1 脚本）；用条数差，避免同名标题去重干扰
  const pAddedCount = afterDrafts[P].count - beforeDrafts[P].count;
  check(`P(${P}) 草稿箱恰好新增 2 条(test_case+test_script)`, pAddedCount === 2, `新增=${pAddedCount}`);
  check(`P(${P}) 草稿箱未丢失原条目`, [...beforeDrafts[P].titles].every(x => afterDrafts[P].titles.has(x)),
    `缺失=${[...beforeDrafts[P].titles].filter(x => !afterDrafts[P].titles.has(x)).join(' | ')}`);

  // B. 目标项目 P Wiki 精确 +1（大纲沉淀）
  const pWikiAdded = [...afterWiki[P]].filter(x => !beforeWiki[P].has(x));
  check(`P(${P}) Wiki 恰好新增 1 个页面(大纲)`, pWikiAdded.length === 1, `新增=${pWikiAdded.length} → ${pWikiAdded.join(' | ')}`);
  check(`P(${P}) Wiki 未丢失原页面`, [...beforeWiki[P]].every(x => afterWiki[P].has(x)),
    `缺失=${[...beforeWiki[P]].filter(x => !afterWiki[P].has(x)).join(' | ')}`);

  // C. 其余所有项目：草稿箱与 Wiki 完全不变（集合逐条相等）
  const others = projects.filter(x => x !== P);
  let otherOk = true;
  const viol = [];
  for (const o of others) {
    const dSame = setEqual(beforeDrafts[o].titles, afterDrafts[o].titles) && beforeDrafts[o].count === afterDrafts[o].count;
    const wSame = setEqual(beforeWiki[o], afterWiki[o]);
    if (!dSame || !wSame) {
      otherOk = false;
      viol.push(`${o}(草稿${beforeDrafts[o].count}→${afterDrafts[o].count}, Wiki${beforeWiki[o].size}→${afterWiki[o].size})`);
    }
  }
  check(`其余 ${others.length} 个项目存储完全不变`, otherOk, viol.length ? '污染:' + viol.join('; ') : '');

  // ---- 汇总 ----
  console.log(`\n========== 汇总 ==========`);
  console.log(`PASS=${PASS} FAIL=${FAIL}`);
  if (FAILS.length) console.log('失败项:\n  - ' + FAILS.join('\n  - '));
  setTimeout(() => process.exit(FAIL ? 1 : 0), 800);
}

function setEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

main().catch(e => { console.error('FATAL', e.message); setTimeout(() => process.exit(2), 800); });
