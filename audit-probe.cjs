'use strict';
const fs = require('fs');
(async () => {
  const urls = [
    'http://localhost:4123/api/audit-log?action=commit&limit=20&project=testCaseGenerator',
    'http://localhost:4123/api/audit-log?limit=20&project=testCaseGenerator',
    'http://localhost:3000/api/audit-log?action=commit&limit=20&project=testCaseGenerator',
  ];
  const out = [];
  for (const u of urls) {
    try {
      const r = await fetch(u);
      const t = await r.text();
      out.push('URL=' + u + '\nstatus=' + r.status + '\n' + t.slice(0, 600) + '\n---');
    } catch (e) {
      out.push('URL=' + u + '\nERR=' + e.message + '\n---');
    }
  }
  fs.writeFileSync('audit-probe-out.txt', out.join('\n'));
  console.log('done');
})();
