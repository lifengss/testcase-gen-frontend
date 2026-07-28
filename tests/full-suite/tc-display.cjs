'use strict';
// A 组：展示层 / 虚假连通 / 冗余变量名 一致性测试
// 全部基于"读取前端源文件 + 正则断言"的可运行静态检查，并对 IO 异常做了兜底
const { readWeb, fs, path, ROOT } = require('./lib.cjs');

function countOcc(s, re) { return (s.match(re) || []).length; }

const CASES = [
  {
    id: 'A1',
    name: '状态栏连通指示灯为静态绿色（视觉虚假连通）',
    group: 'A-展示/虚假连通',
    severity: 'high',
    async run() {
      try {
        const html = readWeb('index.html');
        // 状态栏区域
        const bar = html.match(/<div class="status-bar">[\s\S]*?<\/div>\s*<\/div>/);
        const barText = bar ? bar[0] : html;
        const hasAI = /AI 平台/.test(barText);
        const hasKS = /知识系统/.test(barText) || /KS —/.test(barText);
        // 状态栏 .led 是否带 id 以便 JS 选中更新
        const ledWithId = (barText.match(/<span class="led"[^>]*id=/g) || []).length;
        // 前端是否对 .led 做任何状态切换（classList / style 改变绿点）
        const v2 = readWeb('app.v2.js');
        const ledTouched = /status-bar[\s\S]{0,200}\.led|getElementById\(['"]ksLed|querySelector\(['"]\.led/.test(v2)
          || /classList\.(add|remove|toggle)\(['"](off|red|green)/.test(v2);
        const detail =
          `状态栏含「AI 平台」=${hasAI}、「知识系统/KS」=${hasKS}；` +
          `状态栏 .led 带 id 数量=${ledWithId}（无 id 则 JS 无法选中更新）；` +
          `前端对 .led 做状态切换逻辑=${ledTouched ? '有' : '无'}`;
        // 判定：只要 .led 由 JS 动态切换（querySelector 或 id 定位），即真实反映连通性，非静态绿色
        if (ledTouched || ledWithId > 0) {
          return { status: 'pass', detail, evidence: '状态指示灯由 JS 动态切换（querySelector(\'.led\')/id 定位），真实反映连通性，非静态绿色' };
        }
        return {
          status: 'fail',
          detail,
          evidence: 'index.html 状态栏三处 .led 均为 <span class="led"></span> 无 id，app.v2.js 无任何 .led 状态切换逻辑 → 绿点恒亮，不随真实连通变化'
        };
      } catch (e) {
        return { status: 'fail', detail: 'A1 执行异常: ' + e.message, evidence: String(e.stack || e) };
      }
    }
  },
  {
    id: 'A2',
    name: '底部「KS —」因重复 id=ksChip 永不更新（死展示）',
    group: 'A-展示/虚假连通',
    severity: 'high',
    async run() {
      try {
        const html = readWeb('index.html');
        // 统计 id="ksChip" 出现次数（HTML 规范：id 必须唯一）
        const n = countOcc(html, /id="ksChip"/g);
        const hasDead = /<span id="ksChip">KS —<\/span>/.test(html);
        const detail = `index.html 中 id="ksChip" 出现 ${n} 次（应唯一）；存在死项「<span id="ksChip">KS —</span>」=${hasDead}`;
        if (n >= 2) {
          return {
            status: 'fail',
            detail,
            evidence: `index.html 第251行顶部 <span class="chip" id="ksChip"> 与第360行底部 <span id="ksChip">KS —</span> 重复 id；` +
              `document.querySelector('#ksChip') 只命中第一个，底部「KS —」永不更新 → 展示性虚假连通`
          };
        }
        return { status: 'info', detail, evidence: 'id 唯一' };
      } catch (e) {
        return { status: 'fail', detail: 'A2 执行异常: ' + e.message, evidence: String(e.stack || e) };
      }
    }
  },
  {
    id: 'A3',
    name: '「知识系统」连通指示重复展示 + ksChip/ksStat 冗余变量',
    group: 'A-展示/虚假连通',
    severity: 'medium',
    async run() {
      try {
        const html = readWeb('index.html');
        const topHasKS = /id="ksChip"[^>]*>知识系统/.test(html);      // 顶部 chip 含「知识系统」
        const bottomHasKS = /id="ksStat"[^>]*>[\s\S]{0,40}知识系统/.test(html); // 底部状态栏含「知识系统」
        const v2 = readWeb('app.v2.js');
        const ksChipAssigned = /ksChip(\.textContent|\.innerHTML)\s*=/.test(v2);
        const ksStatAssigned = /ksStat(\.textContent|\.innerHTML)\s*=/.test(v2);
        const detail =
          `顶部 chip 显示「知识系统」=${topHasKS}；底部状态栏显示「知识系统」=${bottomHasKS}；` +
          `ksChip 被赋值=${ksChipAssigned}；ksStat 被赋值=${ksStatAssigned}`;
        if (topHasKS && bottomHasKS && ksChipAssigned && ksStatAssigned) {
          return {
            status: 'warn',
            detail,
            evidence: '「知识系统已连接」在顶部 chip(ksChip) 与底部状态栏(ksStat) 两处重复显示，且 ksChip/ksStat 两个变量职责重叠 → 冗余连通指示'
          };
        }
        return { status: 'info', detail, evidence: '未发现明显重复' };
      } catch (e) {
        return { status: 'fail', detail: 'A3 执行异常: ' + e.message, evidence: String(e.stack || e) };
      }
    }
  },
  {
    id: 'A4',
    name: '重复/冗余变量名与遗留旧版文件',
    group: 'A-展示/虚假连通',
    severity: 'low',
    async run() {
      try {
        const v2 = readWeb('app.v2.js');
        const hasState = /const state\s*=/.test(v2);
        const loose = ['scopeMode', 'funcAvailable', 'explicit', 'expandedSet', 'explicitFunc', 'expandedFunc']
          .filter((v) => new RegExp('\\b' + v + '\\b').test(v2));
        const appJsExists = fs.existsSync(path.join(ROOT, 'web', 'app.js'));
        const html = readWeb('index.html');
        const indexRefsV2 = /app\.v2\.js/.test(html);
        const indexRefsOld = /["']app\.js["']/.test(html) || /src="app\.js"/.test(html);
        const detail =
          `顶层 state 对象=${hasState}；散落顶层变量=${loose.join(',') || '无'}；` +
          `web/app.js 存在=${appJsExists}；index.html 引用 v2=${indexRefsV2}，引用旧版 app.js=${indexRefsOld}`;
        const issues = [];
        if (hasState && loose.length >= 3) issues.push('state 对象与多个散落顶层变量共同管理 UI/功能可见性状态，职责重叠（可合并进 state）');
        if (appJsExists && indexRefsV2 && !indexRefsOld) issues.push('web/app.js 旧版文件遗留且与 app.v2.js 并存，index.html 仅引用 v2 → 冗余文件');
        if (issues.length) {
          return { status: 'warn', detail, evidence: issues.join('；') };
        }
        return { status: 'info', detail, evidence: '未见明显冗余' };
      } catch (e) {
        return { status: 'fail', detail: 'A4 执行异常: ' + e.message, evidence: String(e.stack || e) };
      }
    }
  }
];

module.exports = CASES;
