'use strict';
// 发布校对关口领域服务：扫描 / 依赖清单 / 事务内权威复核 / 豁免 / 资源校验任务
const { validateDocument } = require('./validators');

function nowIso() { return new Date().toISOString(); }

function rowToAssetMap(db, docId) {
  const rows = db.prepare('SELECT * FROM assets WHERE document_id=?').all(docId);
  return new Map(rows.map((r) => [r.id, r]));
}
function rowToCommentMap(db, docId) {
  const rows = db.prepare('SELECT * FROM comments WHERE document_id=?').all(docId);
  return new Map(rows.map((r) => [r.id, r]));
}

function getFault(db, name) {
  const r = db.prepare('SELECT value FROM fault_injections WHERE name=?').get(name);
  return r ? r.value === '1' : false;
}
function setFault(db, name, on) {
  db.prepare(`INSERT INTO fault_injections(name,value) VALUES(?,?)
              ON CONFLICT(name) DO UPDATE SET value=excluded.value`)
    .run(name, on ? '1' : '0');
}

// 把扫描问题与豁免匹配（限定 rule+指纹+版本区间+规则版，且未撤销）
function matchExemptions(db, docId, ruleVersion, bodyRev, issues) {
  const stmt = db.prepare(`SELECT * FROM exemptions
    WHERE document_id=? AND rule_code=? AND fingerprint=? AND revoked=0
      AND rule_version=? AND valid_from_rev<=? AND valid_to_rev>=?`);
  for (const iss of issues) {
    const ex = stmt.get(docId, iss.rule_code, iss.fingerprint, ruleVersion, bodyRev, bodyRev);
    iss.exemption_id = ex ? ex.id : null;
    iss.exemption_reason = ex ? ex.reason : null;
  }
  return issues;
}

/**
 * 执行扫描（预检）。本地校验确定性执行；外部资源校验登记任务，可能迟到。
 * 返回 scanId。扫描状态：checking（资源校验未齐）| passed | failed。
 */
function runScan(db, docId) {
  return db.transaction(() => {
    const doc = db.prepare('SELECT * FROM documents WHERE id=?').get(docId);
    if (!doc) throw httpError(404, '文稿不存在');
    const assets = rowToAssetMap(db, docId);
    const comments = rowToCommentMap(db, docId);

    const { issues, manifest } = validateDocument({ body: doc.body, assets, comments });
    matchExemptions(db, docId, doc.active_rule_version, doc.body_rev, issues);
    manifest.documentId = docId;
    manifest.bodyRev = doc.body_rev;
    manifest.permRev = doc.perm_rev;
    manifest.permission = { authorUserId: doc.author_user_id, permRev: doc.perm_rev };
    manifest.ruleVersion = doc.active_rule_version;
    manifest.exemptionsUsed = issues
      .filter((i) => i.exemption_id)
      .map((i) => ({ exemptionId: i.exemption_id, ruleCode: i.rule_code, fingerprint: i.fingerprint }));

    const blocking = issues.filter((i) => !i.exemption_id);
    const ts = nowIso();
    const info = db.prepare(`INSERT INTO scans
      (document_id, rule_version, status, blocking_count, body_rev, perm_rev, created_at)
      VALUES (?,?,?,?,?,?,?)`)
      .run(docId, doc.active_rule_version, 'checking', blocking.length,
        doc.body_rev, doc.perm_rev, ts);
    const scanId = info.lastInsertRowid;

    const insIssue = db.prepare(`INSERT INTO scan_issues
      (scan_id, rule_code, severity, line, ref_id, message, detail_json, fingerprint, exemption_id)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    for (const i of issues) {
      insIssue.run(scanId, i.rule_code, 'block', i.line ?? null, i.ref_id, i.message,
        JSON.stringify(i.detail || {}), i.fingerprint, i.exemption_id);
    }
    db.prepare('INSERT INTO scan_dependencies(scan_id, manifest_json) VALUES (?,?)')
      .run(scanId, JSON.stringify(manifest));

    // 为每个被引用资源登记外部校验任务
    const assetIds = [...new Set(manifest.content.assetRefs.map((r) => r.assetId))];
    const insJob = db.prepare(`INSERT INTO asset_check_jobs
      (document_id, scan_id, asset_id, status, created_at, updated_at)
      VALUES (?,?,?,'checking',?,?)`);
    for (const assetId of assetIds) insJob.run(docId, scanId, assetId, ts, ts);

    // 本地已有阻断问题：直接 failed（资源任务仍保留，供界面解释）
    if (blocking.length > 0) {
      db.prepare("UPDATE scans SET status='failed', finished_at=? WHERE id=?").run(nowIso(), scanId);
    }
    return scanId;
  })();
}

/**
 * 处理某扫描（或全部）资源校验任务。读取资源"当前"状态：
 * 撤回 -> failed；否则 ok。全部结束后收敛扫描状态。
 * 由后台定时器调用，也可由测试/界面手动触发（模拟"迟到的资源校验"落地）。
 */
function processAssetJobs(db, scanId = null) {
  const rows = db.prepare(`SELECT * FROM asset_check_jobs
    WHERE status='checking' ${scanId ? 'AND scan_id=?' : ''}`).all(...(scanId ? [scanId] : []));
  for (const job of rows) {
    const a = db.prepare('SELECT * FROM assets WHERE id=?').get(job.asset_id);
    const failed = !a || a.withdrawn === 1;
    db.prepare(`UPDATE asset_check_jobs SET status=?, attempts=attempts+1, detail=?, updated_at=?
      WHERE id=?`)
      .run(failed ? 'failed' : 'ok', failed ? '资源已被撤回或不存在' : '资源可访问且说明完整', nowIso(), job.id);
  }
  // 收敛受影响扫描
  const scanIds = [...new Set(rows.map((r) => r.scan_id))];
  for (const sid of scanIds) convergeScan(db, sid);
  return rows.length;
}

function convergeScan(db, scanId) {
  const scan = db.prepare('SELECT * FROM scans WHERE id=?').get(scanId);
  if (!scan || scan.status !== 'checking') return;
  const pending = db.prepare("SELECT COUNT(*) c FROM asset_check_jobs WHERE scan_id=? AND status='checking'").get(scanId).c;
  if (pending > 0) return; // 资源校验仍迟到
  const bad = db.prepare("SELECT COUNT(*) c FROM asset_check_jobs WHERE scan_id=? AND status='failed'").get(scanId).c;
  db.prepare("UPDATE scans SET status=?, finished_at=? WHERE id=?")
    .run(bad ? 'failed' : 'passed', nowIso(), scanId);
}

// ---- 依赖清单逐项核对：返回失配项列表（可解释，不用时间戳）----
function verifyManifest(db, doc, scan, manifest) {
  const mismatches = [];

  if (doc.body_rev !== scan.body_rev) {
    mismatches.push({ kind: 'content.revision', expected: scan.body_rev, actual: doc.body_rev,
      message: `正文修订已变化（扫描基于 r${scan.body_rev}，当前 r${doc.body_rev}）` });
  }
  if (doc.active_rule_version !== scan.rule_version) {
    mismatches.push({ kind: 'rule.version', expected: scan.rule_version, actual: doc.active_rule_version,
      message: `规则版已升级（${scan.rule_version} → ${doc.active_rule_version}）` });
  }

  // 标题/链接：重新解析当前正文逐项对比（精确定位到行）
  const { manifest: nowManifest } = validateDocument({
    body: doc.body,
    assets: rowToAssetMap(db, doc.id),
    comments: rowToCommentMap(db, doc.id),
  });
  const hThen = manifest.content.headings, hNow = nowManifest.content.headings;
  if (JSON.stringify(hThen) !== JSON.stringify(hNow)) {
    const nowByLine = new Map(hNow.map((h) => [h.line, h]));
    for (const h of hThen) {
      const cur = nowByLine.get(h.line);
      if (!cur || cur.level !== h.level || cur.textHash !== h.textHash) {
        mismatches.push({ kind: 'heading', line: h.line,
          message: cur ? `第 ${h.line} 行标题在扫描后被修改（H${cur.level}）`
                       : `第 ${h.line} 行标题在扫描后被删除/移动` });
      }
    }
    for (const h of hNow) {
      if (!hThen.some((x) => x.line === h.line && x.level === h.level && x.textHash === h.textHash)) {
        if (!hThen.some((x) => x.line === h.line)) {
          mismatches.push({ kind: 'heading', line: h.line, message: `第 ${h.line} 行出现扫描时不存在的标题` });
        }
      }
    }
  }
  const lThen = manifest.content.links, lNow = nowManifest.content.links;
  if (JSON.stringify(lThen) !== JSON.stringify(lNow)) {
    mismatches.push({ kind: 'links', message: '正文链接在扫描后发生变化' });
  }

  // 资源：正文未变，图片也可能被撤回 -> 版本号/撤回版本失配
  for (const e of manifest.assets) {
    const a = db.prepare('SELECT * FROM assets WHERE id=?').get(e.assetId);
    if (!a) { mismatches.push({ kind: 'asset.missing', assetId: e.assetId, message: `资源 ${e.assetId} 已不存在` }); continue; }
    if (a.withdrawn === 1 || a.withdrawn_rev !== e.withdrawnRev) {
      mismatches.push({ kind: 'asset.withdrawn', assetId: e.assetId,
        message: `资源 ${e.assetId} 已被撤回（撤回版本 ${e.withdrawnRev} → ${a.withdrawn_rev}），尽管正文未变` });
    }
    if (a.status_rev !== e.statusRev) {
      mismatches.push({ kind: 'asset.status', assetId: e.assetId,
        message: `资源 ${e.assetId} 状态/说明已变化（版本 ${e.statusRev} → ${a.status_rev}）` });
    }
  }

  // 批注：可能被重新打开
  for (const e of manifest.comments) {
    const c = db.prepare('SELECT * FROM comments WHERE id=?').get(e.commentId);
    if (!c || c.status_rev !== e.statusRev || (c.is_open ? 1 : 0) !== (e.isOpen ? 1 : 0)) {
      const reopened = c && e.isOpen === false && c.is_open === 1;
      mismatches.push({ kind: 'comment.status', commentId: e.commentId,
        message: reopened
          ? `批注 ${e.commentId} 在扫描通过后被重新打开（状态版本 ${e.statusRev} → ${c.status_rev}）`
          : `批注 ${e.commentId} 状态已变化（状态版本 ${e.statusRev} → ${c ? c.status_rev : '不存在'}）` });
    }
  }

  // 作者权限
  if (doc.perm_rev !== scan.perm_rev || doc.perm_rev !== manifest.permRev) {
    mismatches.push({ kind: 'permission',
      message: `作者权限版本已变化（扫描时 r${scan.perm_rev}，当前 r${doc.perm_rev}）` });
  }
  const author = db.prepare('SELECT * FROM users WHERE id=?').get(doc.author_user_id);
  if (!author || author.is_author !== 1) {
    mismatches.push({ kind: 'permission.author', message: '当前作者已失去发布所需的作者权限' });
  }

  // 被使用的豁免：仍存在、未撤销、版本区间仍覆盖当前修订
  for (const e of manifest.exemptionsUsed || []) {
    const ex = db.prepare('SELECT * FROM exemptions WHERE id=?').get(e.exemptionId);
    if (!ex || ex.revoked === 1) {
      mismatches.push({ kind: 'exemption.revoked', exemptionId: e.exemptionId, ruleCode: e.ruleCode,
        message: `问题 ${e.ruleCode} 使用的豁免 #${e.exemptionId} 已被撤销` });
    } else if (ex.fingerprint !== e.fingerprint) {
      mismatches.push({ kind: 'exemption.fingerprint', exemptionId: e.exemptionId,
        message: `豁免 #${e.exemptionId} 绑定的具体问题与扫描结果不一致` });
    } else if (!(ex.valid_from_rev <= doc.body_rev && doc.body_rev <= ex.valid_to_rev)) {
      mismatches.push({ kind: 'exemption.range', exemptionId: e.exemptionId,
        message: `豁免 #${e.exemptionId} 仅适用于 r${ex.valid_from_rev}~r${ex.valid_to_rev}，当前为 r${doc.body_rev}` });
    }
  }
  return mismatches;
}

function httpError(status, message, extra = {}) {
  const e = new Error(message); e.status = status; Object.assign(e, extra); return e;
}

/**
 * 发布：单个 IMMEDIATE 事务内完成全部权威检查 + 写不可变快照 + 移动发布指针。
 * 幂等：同 idempotencyKey（或同 scanId 已发布）返回首次结果，不产生第二快照。
 */
function publish(db, docId, scanId, idemKey) {
  const scope = `publish:${docId}`;
  if (idemKey) {
    const prior = db.prepare('SELECT result_json FROM idempotency_keys WHERE scope=? AND idem_key=?')
      .get(scope, idemKey);
    if (prior) return { ...JSON.parse(prior.result_json), idempotent: true };
  }
  const doc0 = db.prepare('SELECT * FROM documents WHERE id=?').get(docId);
  if (!doc0) throw httpError(404, '文稿不存在');

  // 故障注入：模拟发布瞬间数据库中断（事务随后回滚，不留半套结果）
  if (getFault(db, 'db_outage')) {
    throw Object.assign(new Error('SQLITE_IOERR: simulated database outage during commit'), { code: 'SQLITE_IOERR' });
  }

  return require('./db').withImmediate(db, (tx) => {
    // 锁文档行
    const doc = tx.prepare('SELECT * FROM documents WHERE id=?').get(docId);

    if (idemKey) {
      const prior = tx.prepare('SELECT result_json FROM idempotency_keys WHERE scope=? AND idem_key=?')
        .get(scope, idemKey);
      if (prior) return { ...JSON.parse(prior.result_json), idempotent: true };
    }

    // 该扫描已成为正式版 -> 并发点击/重试返回同一份确定快照
    const existing = tx.prepare('SELECT * FROM published_versions WHERE scan_id=?').get(scanId);
    if (existing) {
      const out = { ok: true, idempotent: true, versionNo: existing.version_no,
        versionId: existing.id, snapshotAt: existing.created_at,
        message: `该校对结果已发布为正式版 v${existing.version_no}` };
      return out;
    }

    const scan = tx.prepare('SELECT * FROM scans WHERE id=?').get(scanId);
    if (!scan || scan.document_id !== docId) throw httpError(400, '校对报告不存在或不属于该文稿');
    const depRow = tx.prepare('SELECT manifest_json FROM scan_dependencies WHERE scan_id=?').get(scanId);
    if (!depRow) throw httpError(400, '校对报告缺少依赖清单');
    const manifest = JSON.parse(depRow.manifest_json);

    const errors = [];
    if (scan.status === 'checking') {
      errors.push({ kind: 'asset.checking', message: '资源校验尚未完成（存在迟到的资源校验结果），暂不能发布' });
    } else if (scan.status === 'failed') {
      errors.push({ kind: 'scan.failed', message: '该次校对未通过，不能发布' });
    }

    // 1) 依赖清单逐项复核（正文之外的变化也能发现）
    const mismatches = verifyManifest(tx, doc, scan, manifest);

    // 2) 用当前状态重跑一遍校验并匹配豁免：
    //    新增的同类错误指纹不同，不能继承旧豁免 -> 自动阻断
    const fresh = validateDocument({
      body: doc.body,
      assets: rowToAssetMap(tx, docId),
      comments: rowToCommentMap(tx, docId),
    });
    matchExemptions(tx, docId, doc.active_rule_version, doc.body_rev, fresh.issues);
    const freshBlocking = fresh.issues.filter((i) => !i.exemption_id)
      .map((i) => ({ kind: 'issue.' + i.rule_code, line: i.line, refId: i.ref_id, message: i.message }));

    if (mismatches.length) errors.push(...mismatches.map((m) => ({ kind: m.kind, message: m.message })));
    if (freshBlocking.length) errors.push(...freshBlocking);

    // 资源任务终态复核（迟到期间撤回 -> failed）
    const badJobs = tx.prepare("SELECT asset_id, status, detail FROM asset_check_jobs WHERE scan_id=? AND status!='ok'")
      .all(scanId);
    for (const j of badJobs) {
      errors.push({ kind: 'asset.job', assetId: j.asset_id,
        message: j.status === 'checking' ? `资源 ${j.asset_id} 校验仍在进行（结果迟到）`
                                         : `资源 ${j.asset_id} 校验失败：${j.detail}` });
    }

    if (errors.length) {
      throw httpError(409, '发布被拒绝：校对依赖已失效或仍有阻断问题', { recheck: true, errors });
    }

    // 全部成立 -> 唯一确定快照（不可变），scan_id 唯一约束兜底
    const maxNo = tx.prepare('SELECT COALESCE(MAX(version_no),0) n FROM published_versions WHERE document_id=?')
      .get(docId).n;
    const versionNo = maxNo + 1;
    const ts = nowIso();
    const snapshot = {
      documentId: docId, versionNo, scanId,
      title: doc.title, body: doc.body, bodyRev: doc.body_rev, permRev: doc.perm_rev,
      ruleVersion: doc.active_rule_version, manifest,
      freshIssues: fresh.issues.map((i) => ({ ruleCode: i.rule_code, line: i.line, exempted: !!i.exemption_id })),
      createdAt: ts,
    };
    const ins = tx.prepare(`INSERT INTO published_versions
      (document_id, version_no, scan_id, rule_version, body_rev, snapshot_json, created_at)
      VALUES (?,?,?,?,?,?,?)`)
      .run(docId, versionNo, scanId, doc.active_rule_version, doc.body_rev, JSON.stringify(snapshot), ts);
    const versionId = ins.lastInsertRowid;
    tx.prepare('UPDATE documents SET published_version_id=? WHERE id=?').run(versionId, docId);

    const out = { ok: true, idempotent: false, versionNo, versionId, snapshotAt: ts,
      message: `已发布正式版 v${versionNo}（规则版 ${doc.active_rule_version}，正文 r${doc.body_rev} 的确定快照）` };
    if (idemKey) {
      tx.prepare('INSERT INTO idempotency_keys(scope,idem_key,result_json,created_at) VALUES(?,?,?,?)')
        .run(scope, idemKey, JSON.stringify(out), ts);
    }
    return out;
  });
}

// 针对具体问题+当前版本创建豁免（不覆盖同类新错误）
function grantExemption(db, issueId, reason) {
  return db.transaction(() => {
    const iss = db.prepare('SELECT * FROM scan_issues WHERE id=?').get(issueId);
    if (!iss) throw httpError(404, '问题不存在');
    const scan = db.prepare('SELECT * FROM scans WHERE id=?').get(iss.scan_id);
    const ts = nowIso();
    const info = db.prepare(`INSERT INTO exemptions
      (document_id, rule_code, fingerprint, reason, valid_from_rev, valid_to_rev, rule_version, created_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(scan.document_id, iss.rule_code, iss.fingerprint, reason,
        scan.body_rev, scan.body_rev, scan.rule_version, ts);
    return { exemptionId: info.lastInsertRowid, ruleCode: iss.rule_code, fingerprint: iss.fingerprint,
      validRev: scan.body_rev, message: '豁免已创建，仅绑定该具体问题与当前版本；请重新扫描使其生效' };
  })();
}

// ---- 演示/测试变更动作（都会推进相应版本，模拟真实世界事件）----
function saveBody(db, docId, title, body) {
  return db.transaction(() => {
    const doc = db.prepare('SELECT * FROM documents WHERE id=?').get(docId);
    if (!doc) throw httpError(404, '文稿不存在');
    const changed = doc.body !== body || doc.title !== title;
    db.prepare('UPDATE documents SET title=?, body=?, body_rev=body_rev+?, updated_at=? WHERE id=?')
      .run(title, body, changed ? 1 : 0, nowIso(), docId);
    return db.prepare('SELECT body_rev FROM documents WHERE id=?').get(docId);
  })();
}
function withdrawAsset(db, assetId, withdrawn) {
  return db.transaction(() => {
    const a = db.prepare('SELECT * FROM assets WHERE id=?').get(assetId);
    if (!a) throw httpError(404, '资源不存在');
    if (withdrawn) {
      db.prepare('UPDATE assets SET withdrawn=1, withdrawn_rev=withdrawn_rev+1, status_rev=status_rev+1, updated_at=? WHERE id=?')
        .run(nowIso(), assetId);
    } else {
      db.prepare('UPDATE assets SET withdrawn=0, status_rev=status_rev+1, updated_at=? WHERE id=?')
        .run(nowIso(), assetId);
    }
    return db.prepare('SELECT * FROM assets WHERE id=?').get(assetId);
  })();
}
function setAssetDescription(db, assetId, description) {
  return db.transaction(() => {
    const a = db.prepare('SELECT * FROM assets WHERE id=?').get(assetId);
    if (!a) throw httpError(404, '资源不存在');
    db.prepare('UPDATE assets SET description=?, status_rev=status_rev+1, updated_at=? WHERE id=?')
      .run(description, nowIso(), assetId);
    return db.prepare('SELECT * FROM assets WHERE id=?').get(assetId);
  })();
}
function setCommentOpen(db, commentId, isOpen) {
  return db.transaction(() => {
    const c = db.prepare('SELECT * FROM comments WHERE id=?').get(commentId);
    if (!c) throw httpError(404, '批注不存在');
    if ((c.is_open ? 1 : 0) !== (isOpen ? 1 : 0)) {
      db.prepare('UPDATE comments SET is_open=?, status_rev=status_rev+1, updated_at=? WHERE id=?')
        .run(isOpen ? 1 : 0, nowIso(), commentId);
    }
    return db.prepare('SELECT * FROM comments WHERE id=?').get(commentId);
  })();
}
function setAuthorPermission(db, docId, isAuthor) {
  return db.transaction(() => {
    const doc = db.prepare('SELECT * FROM documents WHERE id=?').get(docId);
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(doc.author_user_id);
    if ((u.is_author ? 1 : 0) !== (isAuthor ? 1 : 0)) {
      db.prepare('UPDATE users SET is_author=? WHERE id=?').run(isAuthor ? 1 : 0, u.id);
      db.prepare('UPDATE documents SET perm_rev=perm_rev+1 WHERE id=?').run(docId);
    }
    return db.prepare('SELECT * FROM documents WHERE id=?').get(docId);
  })();
}
function activateRule(db, version, note) {
  return db.transaction(() => {
    const ts = nowIso();
    db.prepare('INSERT INTO rule_versions(version,is_active,note,created_at) VALUES(?,1,?,?)')
      .run(version, note || '', ts);
    db.prepare('UPDATE rule_versions SET is_active=0 WHERE version<>?').run(version);
    db.prepare('UPDATE documents SET active_rule_version=?').run(version);
    return { version };
  })();
}

module.exports = {
  runScan, processAssetJobs, publish, grantExemption, saveBody,
  withdrawAsset, setAssetDescription, setCommentOpen, setAuthorPermission, activateRule,
  getFault, setFault, httpError,
};
