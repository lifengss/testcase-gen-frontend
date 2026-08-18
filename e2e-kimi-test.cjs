// 临时端到端验证：连续两次 /api/generate 走 kimi 通道（验证完删除）
const base = 'http://localhost:4123';
async function gen(tag) {
  const body = {
    op: 'gen_cases',
    project: 'demo',
    constraints: { limit: 3 },
    scope: {},
    sourceRefs: {},
    query: '为一个用户登录接口生成3条测试用例，覆盖正常登录、密码错误、账号锁定',
  };
  const r = await fetch(base + '/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  const d = data && data.data;
  console.log(tag, '| engine=' + (d && d.engine), '| contentLen=' + (d && d.content && d.content.length));
}
async function main() {
  await gen('RUN1');
  await gen('RUN2');
}
main().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
