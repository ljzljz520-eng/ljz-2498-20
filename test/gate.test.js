'use strict';
// 发布校对关口端到端测试（真实 HTTP + 临时 SQLite 库）
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

process.env.GATE_DB = path.join(__dirname, '..', 'tmp', `test-${process.pid}.db`);
process.env.PORT = '8791';
fs.rmSync(path.dirname(process.env.GATE_DB), { recursive: true, force: true });

const { server } = require('../server/index.js');

function listen() {
  return new Promise((resolve) => server.listen(Number(process.env.PORT), resolve));
}
function closeServer() {
  return new Promise((resolve) => server.close(() => {
    try { fs.rmSync(path.dirname(process.env.GATE_DB), { recursive: true, force: true }); } catch {}
    resolve();
  }));
}

function call(method, urlPath, body) {
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: Number(process.env.PORT), path: urlPath, method,
      headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let ready = false;
test.before(async () => { await listen(); ready = true; });
test.after(async () => { await closeServer(); });

async function freshScanAndFix() {
  // 修复种子文稿的全部四类问题并完成资源校验，返回通过的 scanId
  const { json: st } = await call('GET', '/api/state');
  let body = st.doc.body
    .replace('[官方站点]()', '[官方站点](https://catalpa.example.com)')
    .replace('##### 三、语法', '#### 三、语法');
  await call('PUT', '/api/documents/d1/body', { title: st.doc.title, body });
  await call('PUT', '/api/assets/cover.png/description', { description: '封面图（版权）' });
  await call('POST', '/api/comments/c1/open', { open: false });
  const { json: sc } = await call('POST', '/api/documents/d1/scan');
  await call('POST', `/api/scans/${sc.id}/process-assets`);
  const { json: view } = await call('GET', `/api/scans/${sc.id}`);
  assert.equal(view.status, 'passed', '前置条件：扫描必须通过');
  return sc.id;
}

test('四项规则逐项可定位（标题层级/空链接/批注/资源说明）', async () => {
  const { status, json } = await call('POST', '/api/documents/d1/scan');
  assert.equal(status, 200);
  const codes = json.issues.map((i) => i.ruleCode).sort();
  assert.deepEqual(codes, ['asset.description', 'comment.open', 'heading.skip', 'link.empty']);
  for (const i of json.issues) {
    assert.ok(i.line > 0, '每个问题都带行号');
    assert.ok(i.fingerprint.length === 64, '每个问题都有稳定指纹');
  }
  // 资源任务登记为"校验中"（迟到模型）
  assert.ok(json.jobs.length === 2 && json.jobs.every((j) => j.status === 'checking'));
});

test('资源校验迟到时拒绝发布；送达后才能发布', async () => {
  // 本地问题全部修复，但不"送达"资源校验 -> 扫描停留在 checking
  const st = (await call('GET', '/api/state')).json;
  const body = st.doc.body
    .replace('[官方站点]()', '[官方站点](https://catalpa.example.com)')
    .replace('##### 三、语法', '#### 三、语法');
  await call('PUT', '/api/documents/d1/body', { title: st.doc.title, body });
  await call('PUT', '/api/assets/cover.png/description', { description: '封面图（版权）' });
  await call('POST', '/api/comments/c1/open', { open: false });
  const checking = (await call('POST', '/api/documents/d1/scan')).json;
  assert.equal(checking.status, 'checking');
  const rejected = await call('POST', '/api/documents/d1/publish', { scanId: checking.id });
  assert.equal(rejected.status, 409);
  assert.ok(rejected.json.errors.some((e) => e.kind === 'asset.checking'),
    '资源结果迟到时必须拒绝发布');

  const scanId = await freshScanAndFix();
  const r = await call('POST', '/api/documents/d1/publish', { scanId, idempotencyKey: 'happy-1' });
  assert.equal(r.status, 200);
  assert.ok(r.json.versionNo >= 1);
});

test('扫描后修改标题：正文依赖失配，拒绝并指明行', async () => {
  const scanId = await freshScanAndFix();
  const { json: st } = await call('GET', '/api/state');
  // 只改一个标题文字
  const body = st.doc.body.replace('## 一、简介', '## 一、文稿简介');
  await call('PUT', '/api/documents/d1/body', { title: st.doc.title, body });
  const r = await call('POST', '/api/documents/d1/publish', { scanId });
  assert.equal(r.status, 409);
  assert.ok(r.json.errors.some((e) => e.kind === 'heading' && /第 3 行/.test(e.message)));
  // 恢复
  const body2 = body.replace('## 一、文稿简介', '## 一、简介');
  await call('PUT', '/api/documents/d1/body', { title: st.doc.title, body: body2 });
});

test('正文未变：图片撤回 / 批注重新打开 / 作者权限改变都会使旧通过失效', async () => {
  // 图片撤回
  let scanId = await freshScanAndFix();
  await call('POST', '/api/assets/arch.png/withdraw', { withdrawn: true });
  let r = await call('POST', '/api/documents/d1/publish', { scanId });
  assert.equal(r.status, 409);
  assert.ok(r.json.errors.some((e) => e.kind === 'asset.withdrawn'));
  await call('POST', '/api/assets/arch.png/withdraw', { withdrawn: false });

  // 批注重新打开（依赖记录中它原本是已解决状态）
  scanId = await freshScanAndFix();
  await call('POST', '/api/comments/c1/open', { open: true });
  r = await call('POST', '/api/documents/d1/publish', { scanId });
  assert.equal(r.status, 409);
  assert.ok(r.json.errors.some((e) => /重新打开/.test(e.message)));
  await call('POST', '/api/comments/c1/open', { open: false });

  // 作者权限改变
  scanId = await freshScanAndFix();
  await call('POST', '/api/documents/d1/author', { isAuthor: false });
  r = await call('POST', '/api/documents/d1/publish', { scanId });
  assert.equal(r.status, 409);
  assert.ok(r.json.errors.some((e) => e.kind === 'permission.author'));
  await call('POST', '/api/documents/d1/author', { isAuthor: true });
});

test('豁免限定具体问题与版本：新增同类错误不能继承旧理由', async () => {
  // 构造一份"只剩一个空链接"的文稿（不依赖其它测试留下的正文状态）
  const st0 = (await call('GET', '/api/state')).json;
  let body = st0.doc.body
    .replace('##### 三、语法', '#### 三、语法')
    .replace(/\[官方站点\]\([^)]*\)/, '[官方站点]()');
  await call('PUT', '/api/documents/d1/body', { title: st0.doc.title, body });
  await call('PUT', '/api/assets/cover.png/description', { description: '封面图（版权）' });
  await call('POST', '/api/comments/c1/open', { open: false });

  const sc0 = (await call('POST', '/api/documents/d1/scan')).json;
  const links0 = sc0.issues.filter((i) => i.ruleCode === 'link.empty');
  assert.equal(links0.length, 1);
  assert.equal(links0[0].exemptionId, null);
  const ex = await call('POST', `/api/issues/${links0[0].id}/exempt`, { reason: '占位链接可接受' });
  assert.equal(ex.status, 200);

  // 重新扫描：唯一空链接已被豁免，资源送达后可发布 -> 证明豁免对"同一具体问题+同一版本"有效
  let sc = (await call('POST', '/api/documents/d1/scan')).json;
  await call('POST', `/api/scans/${sc.id}/process-assets`);
  sc = (await call('GET', `/api/scans/${sc.id}`)).json;
  assert.equal(sc.status, 'passed');
  const only = sc.issues.find((i) => i.ruleCode === 'link.empty');
  assert.ok(only && only.exemptionId, '同一问题+同版本应命中豁免');

  // 正文修订：在别处新增一个"同类"空链接 -> 旧豁免不能继承，且旧链接豁免因超出版本范围失效
  const st1 = (await call('GET', '/api/state')).json;
  const changed = st1.doc.body.replace('请在发布前', '备用入口[备用]() 请在发布前');
  await call('PUT', '/api/documents/d1/body', { title: st1.doc.title, body: changed });
  const sc1 = (await call('POST', '/api/documents/d1/scan')).json;
  const links = sc1.issues.filter((i) => i.ruleCode === 'link.empty');
  assert.equal(links.length, 2);
  assert.ok(links.every((i) => i.exemptionId === null),
    '新增同类错误不得继承旧理由；旧豁免也因版本区间不再适用');

  // 恢复
  await call('PUT', '/api/documents/d1/body', { title: st1.doc.title, body: st1.doc.body });
});

test('并发点击发布 ×N：只有一个确定快照，其余幂等返回', async () => {
  const scanId = await freshScanAndFix();
  const key = 'concurrent-key-1';
  const rs = await Promise.all([
    call('POST', '/api/documents/d1/publish', { scanId, idempotencyKey: key }),
    call('POST', '/api/documents/d1/publish', { scanId, idempotencyKey: key }),
    call('POST', '/api/documents/d1/publish', { scanId, idempotencyKey: key }),
    call('POST', '/api/documents/d1/publish', { scanId, idempotencyKey: key }),
  ]);
  for (const r of rs) assert.equal(r.status, 200);
  const versions = new Set(rs.map((r) => r.json.versionNo));
  assert.equal(versions.size, 1, '只产生一个正式版本号');
  // 即便不带相同幂等键，同 scanId 再发也必须返回同一版本（唯一约束兜底）
  const again = await call('POST', '/api/documents/d1/publish', { scanId, idempotencyKey: 'other-key' });
  assert.equal(again.status, 200);
  assert.equal(again.json.idempotent, true);
  const { json: stt } = await call('GET', '/api/state');
  assert.ok(stt.doc.published && !stt.doc.published.stale, '发布指针指向最新快照');
});

test('任务重试：同一幂等键重复请求不产生第二快照', async () => {
  const scanId = await freshScanAndFix();
  const before = (await call('GET', '/api/state')).json.doc.published?.versionNo ?? 0;
  const a = await call('POST', '/api/documents/d1/publish', { scanId, idempotencyKey: 'retry-key' });
  const b = await call('POST', '/api/documents/d1/publish', { scanId, idempotencyKey: 'retry-key' });
  assert.equal(a.status, 200);
  assert.equal(a.json.versionNo, b.json.versionNo, '重试返回同一版本号');
  assert.equal(b.json.idempotent, true, '第二次为重放请求，必须幂等返回');
  const after = (await call('GET', '/api/state')).json.doc.published.versionNo;
  assert.ok(after >= before, '发布指针不倒退');
  assert.equal(after, Math.max(before, a.json.versionNo),
    '两次请求合计最多产生一个新版本（首次创建，重试幂等）');
});

test('数据库中断：提交前失败不留下快照/指针，关闭故障后可安全重试', async () => {
  const scanId = await freshScanAndFix();
  await call('POST', '/api/faults/db-outage', { on: true });
  const bad = await call('POST', '/api/documents/d1/publish', { scanId, idempotencyKey: 'will-fail' });
  assert.equal(bad.status, 500);
  assert.match(bad.json.error, /simulated database outage/);

  const { json: st1 } = await call('GET', '/api/state');
  const beforeCount = countPublished(st1);
  // 半套结果检查：指针不应指向本次（st1.published 可能来自更早测试，关键是没有新版本产生）
  await call('POST', '/api/faults/db-outage', { on: false });
  const ok = await call('POST', '/api/documents/d1/publish', { scanId, idempotencyKey: 'will-fail' });
  assert.equal(ok.status, 200, '中断恢复后重试应成功（之前无任何提交）');
  const { json: st2 } = await call('GET', '/api/state');
  assert.equal(countPublished(st2), beforeCount + 1, '故障期间零提交，恢复后恰好一个新版本');
});

function countPublished(st) {
  return st.doc.published ? st.doc.published.versionNo : 0;
}
