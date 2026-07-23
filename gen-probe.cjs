'use strict';
const fs = require('fs');
(async () => {
  const t0 = Date.now();
  const r = await fetch('http://localhost:4123/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      op: 'gen_cases', project: 'testCaseGenerator',
      sourceRefs: { project: 'testCaseGenerator' },
      scope: { modules: ['add', 'login'], depth: 'full' },
      constraints: { framework: 'pytest', note: '覆盖主流程与异常分支' },
    }),
  });
  const t = await r.text();
  fs.writeFileSync('gen-probe-out.txt', 'status=' + r.status + '\n耗时=' + (Date.now() - t0) + 'ms\n' + t);
  console.log('status', r.status, 'len', t.length, '耗时', (Date.now() - t0) + 'ms');
})();
