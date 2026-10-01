'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { openDb, init } = require('./db');
const { seed } = require('./seed');
const gate = require('./gate');

const db = openDb();
init(db);
seed(db);

// 后台：周期性尝试完成"迟到"的资源校验任务。
// 默认不自动处理（manual 模式），便于演示/测试"资源校验迟到"；
// 设置 AUTO_ASSET=1 时，任务登记后由该循环按延迟落地。
const AUTO_ASSET = process.env.AUTO_ASSET === '1';
if (AUTO_ASSET) {
  setInterval(() => {
    try { gate.processAssetJobs(db); } catch (e) { /* 单轮失败不影响服务 */ }
  }, 800).unref();
}

function send(res, status, obj, headers = {}) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store', ...headers });
  res.end(buf);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 2_000_000) reject(gate.httpError(413, 'body too large')); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(gate.httpError(400, 'invalid JSON')); } });
    req.on('error', reject);
  });
}

function docView(id) {
  const doc = db.prepare('SELECT * FROM documents WHERE id=?').get(id);
  if (!doc) return null;
  const pub = doc.published_version_id
    ? db.prepare('SELECT version_no, created_at, body_rev FROM published_versions WHERE id=?')
        .get(doc.published_version_id) : null;
  return {
    id: doc.id, title: doc.title, body: doc.body,
    bodyRev: doc.body_rev, permRev: doc.perm_rev,
    ruleVersion: doc.active_rule_version,
    author: db.prepare('SELECT id,name,is_author FROM users WHERE id=?').get(doc.author_user_id),
    published: pub ? { versionNo: pub.version_no, at: pub.created_at, bodyRev: pub.body_rev,
                       stale: pub.body_rev !== doc.body_rev } : null,
    updatedAt: doc.updated_at,
  };
}

const routes = {
  // 文稿与相关资源/批注
  'GET /api/state': () => ({
    doc: docView('d1'),
    assets: db.prepare('SELECT id,description,withdrawn,status_rev,withdrawn_rev FROM assets WHERE document_id=?').all('d1'),
    comments: db.prepare('SELECT id,anchor_text,is_open,status_rev FROM comments WHERE document_id=?').all('d1'),
    rules: db.prepare('SELECT version,is_active,note FROM rule_versions ORDER BY rowid').all(),
    autoAsset: AUTO_ASSET,
  }),
  'PUT /api/documents/d1/body': async (p, b) => gate.saveBody(db, 'd1', String(b.title ?? ''), String(b.body ?? '')),
  'POST /api/assets/:id/withdraw': async (p, b) => ({ asset: gate.withdrawAsset(db, p.id, !!(b.withdrawn ?? true)) }),
  'PUT /api/assets/:id/description': async (p, b) => ({ asset: gate.setAssetDescription(db, p.id, String(b.description ?? '')) }),
  'POST /api/comments/:id/open': async (p, b) => ({ comment: gate.setCommentOpen(db, p.id, !!(b.open ?? true)) }),
  'POST /api/documents/d1/author': async (p, b) => ({ doc: gate.setAuthorPermission(db, 'd1', !!(b.isAuthor ?? true)) }),
  'POST /api/rules/activate': async (p, b) => gate.activateRule(db, String(b.version), String(b.note || '')),

  // 校对关口
  'POST /api/documents/d1/scan': () => {
    const scanId = gate.runScan(db, 'd1');
    if (AUTO_ASSET) setTimeout(() => { try { gate.processAssetJobs(db, scanId); } catch { /* noop */ } }, 0);
    return { scanId, ...getScanView(scanId) };
  },
  'GET /api/scans/:id': (p) => getScanView(Number(p.id)),
  'POST /api/scans/:id/process-assets': (p) => {
    const n = gate.processAssetJobs(db, Number(p.id));
    return { processed: n, ...getScanView(Number(p.id)) };
  },
  'POST /api/issues/:id/exempt': async (p, b) => gate.grantExemption(db, Number(p.id), String(b.reason || '评审确认可接受')),
  'POST /api/documents/d1/publish': async (p, b) => gate.publish(db, 'd1', Number(b.scanId), b.idempotencyKey ? String(b.idempotencyKey) : null),
  'GET /api/published/:no': (p) => {
    const v = db.prepare('SELECT * FROM published_versions WHERE document_id=? AND version_no=?').get('d1', Number(p.no));
    if (!v) throw gate.httpError(404, '版本不存在');
    return { versionNo: v.version_no, scanId: v.scan_id, ruleVersion: v.rule_version,
      bodyRev: v.body_rev, createdAt: v.created_at, snapshot: JSON.parse(v.snapshot_json) };
  },

  // 故障注入（演示：数据库中断）
  'POST /api/faults/db-outage': async (p, b) => { gate.setFault(db, 'db_outage', !!(b.on ?? true)); return { dbOutage: gate.getFault(db, 'db_outage') }; },
};

function getScanView(scanId) {
  const scan = db.prepare('SELECT * FROM scans WHERE id=?').get(scanId);
  if (!scan) throw gate.httpError(404, '扫描不存在');
  const issues = db.prepare('SELECT * FROM scan_issues WHERE scan_id=? ORDER BY id').all(scanId)
    .map((i) => ({ id: i.id, ruleCode: i.rule_code, line: i.line, refId: i.ref_id,
      message: i.message, detail: JSON.parse(i.detail_json), fingerprint: i.fingerprint,
      exemptionId: i.exemption_id,
      exemptionReason: i.exemption_id
        ? (db.prepare('SELECT reason FROM exemptions WHERE id=?').get(i.exemption_id)?.reason ?? null) : null }));
  const manifest = JSON.parse(db.prepare('SELECT manifest_json FROM scan_dependencies WHERE scan_id=?').get(scanId).manifest_json);
  const jobs = db.prepare('SELECT asset_id,status,detail,attempts FROM asset_check_jobs WHERE scan_id=? ORDER BY id').all(scanId);
  const passed = scan.status === 'passed';
  return {
    id: scan.id, status: scan.status, ruleVersion: scan.rule_version,
    bodyRev: scan.body_rev, permRev: scan.perm_rev,
    blockingCount: scan.blocking_count,
    passed,
    canPublish: passed && jobs.every((j) => j.status === 'ok'),
    issues, jobs,
    manifestSummary: {
      bodyRev: manifest.bodyRev, permRev: manifest.permRev, ruleVersion: manifest.ruleVersion,
      headings: manifest.content.headings.length, links: manifest.content.links.length,
      assets: manifest.assets, comments: manifest.comments,
      exemptionsUsed: manifest.exemptionsUsed,
    },
    createdAt: scan.created_at, finishedAt: scan.finished_at,
  };
}

function matchRoute(method, pathname) {
  for (const key of Object.keys(routes)) {
    const [m, pat] = key.split(' ');
    if (m !== method) continue;
    const pp = pat.split('/').filter(Boolean);
    const ap = pathname.split('/').filter(Boolean);
    if (pp.length !== ap.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(ap[i]);
      else if (pp[i] !== ap[i]) { ok = false; break; }
    }
    if (ok) return { handler: routes[key], params };
  }
  return null;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.png': 'image/png', '.ico': 'image/x-icon' };

function serveStatic(req, res) {
  const dist = path.join(__dirname, '..', 'dist');
  let urlPath = req.url.split('?')[0];
  let file = path.normalize(path.join(dist, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(dist)) { send(res, 403, { error: 'forbidden' }); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { send(res, 404, { error: 'not found' }); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const pathname = req.url.split('?')[0];
  try {
    if (pathname.startsWith('/api/')) {
      const m = matchRoute(req.method, pathname);
      if (!m) { send(res, 404, { error: 'no such api route', path: pathname }); return; }
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
      const out = await m.handler(m.params, body);
      send(res, 200, out);
      return;
    }
    serveStatic(req, res);
  } catch (e) {
    const status = e.status || (e.code && e.code.startsWith('SQLITE') ? 500 : 500);
    send(res, status, {
      error: e.message, code: e.code || null,
      recheck: e.recheck || false, errors: e.errors || undefined,
    });
  }
});

const PORT = process.env.PORT || 8080;
if (require.main === module) {
  server.listen(PORT, () => console.log(`gate server on http://localhost:${PORT}`));
}
module.exports = { server, db };
