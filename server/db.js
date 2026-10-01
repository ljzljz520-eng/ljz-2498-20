'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let _dbPath = process.env.GATE_DB || path.join(__dirname, '..', 'data', 'gate.db');

function setDbPath(p) { _dbPath = p; }

function openDb() {
  if (_dbPath !== ':memory:') fs.mkdirSync(path.dirname(_dbPath), { recursive: true });
  const db = new Database(_dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 4000');
  return db;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_author INTEGER NOT NULL DEFAULT 1,   -- 是否拥有"作者"权限（发布要求作者权限）
  perm_rev INTEGER NOT NULL DEFAULT 0     -- 文档级权限版本由 documents.perm_rev 记录；此表仅存用户状态
);

-- 文稿（关系库保存正文修订、权限版本、发布指针）
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  body_rev INTEGER NOT NULL DEFAULT 1,    -- 仅在正文/标题实际变化时递增
  perm_rev INTEGER NOT NULL DEFAULT 1,    -- 作者权限变化时递增
  author_user_id TEXT NOT NULL REFERENCES users(id),
  active_rule_version TEXT NOT NULL DEFAULT 'v1',
  published_version_id INTEGER,           -- 发布指针 -> published_versions.id
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  description TEXT NOT NULL DEFAULT '',   -- 资源说明（缺失则报 asset.description）
  withdrawn INTEGER NOT NULL DEFAULT 0,   -- 是否被撤回
  status_rev INTEGER NOT NULL DEFAULT 1,  -- 说明/状态变化递增
  withdrawn_rev INTEGER NOT NULL DEFAULT 0, -- 撤回动作版本（非0表示曾撤回）
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  anchor_text TEXT NOT NULL DEFAULT '',
  is_open INTEGER NOT NULL DEFAULT 1,     -- 1=打开的批注
  status_rev INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

-- 规则版：同一时间只有一条 active
CREATE TABLE IF NOT EXISTS rule_versions (
  version TEXT PRIMARY KEY,
  is_active INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- 扫描（预检）报告
CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL REFERENCES documents(id),
  rule_version TEXT NOT NULL,
  status TEXT NOT NULL,                   -- checking | passed | failed
  blocking_count INTEGER NOT NULL DEFAULT 0,
  body_rev INTEGER NOT NULL,
  perm_rev INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

-- 逐项问题（可定位）
CREATE TABLE IF NOT EXISTS scan_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id INTEGER NOT NULL REFERENCES scans(id),
  rule_code TEXT NOT NULL,                -- heading.skip / link.empty / comment.open / asset.description
  severity TEXT NOT NULL DEFAULT 'block',
  line INTEGER,                           -- 行号
  ref_id TEXT,                            -- commentId / assetId
  message TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  fingerprint TEXT NOT NULL,
  exemption_id INTEGER                    -- 命中的豁免（NULL=未豁免）
);
CREATE INDEX IF NOT EXISTS idx_scan_issues_scan ON scan_issues(scan_id);

-- 豁免：限定具体问题(rule_code+fingerprint)与版本区间
CREATE TABLE IF NOT EXISTS exemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL REFERENCES documents(id),
  rule_code TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  reason TEXT NOT NULL,
  valid_from_rev INTEGER NOT NULL,
  valid_to_rev INTEGER NOT NULL,          -- 含；通常与申请时版本相同
  rule_version TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ex_match
  ON exemptions(document_id, rule_code, fingerprint, revoked);

-- 依赖清单（每次扫描一份）
CREATE TABLE IF NOT EXISTS scan_dependencies (
  scan_id INTEGER PRIMARY KEY REFERENCES scans(id),
  manifest_json TEXT NOT NULL
);

-- 不可变的正式发布快照（scan_id 唯一：一个通过报告只能成为一个正式版）
CREATE TABLE IF NOT EXISTS published_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL REFERENCES documents(id),
  version_no INTEGER NOT NULL,            -- 对外版本号 v1,v2...
  scan_id INTEGER NOT NULL UNIQUE,
  rule_version TEXT NOT NULL,
  body_rev INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,            -- 确定快照：正文/规则版/依赖清单/问题
  created_at TEXT NOT NULL,
  UNIQUE(document_id, version_no)
);

-- 资源外部校验任务（可能迟到/重试）
CREATE TABLE IF NOT EXISTS asset_check_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL REFERENCES documents(id),
  scan_id INTEGER REFERENCES scans(id),
  asset_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'checking',-- checking | ok | failed
  detail TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_scan ON asset_check_jobs(scan_id);

-- 幂等键（任务重试/并发点击去重）
CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope TEXT NOT NULL,                    -- 如 'publish:<docId>'
  idem_key TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, idem_key)
);

-- 演示/测试用故障注入开关（键值）
CREATE TABLE IF NOT EXISTS fault_injections (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function init(db) {
  db.exec(SCHEMA);
}

// 在事务中执行；fn(db) 返回结果。SQLITE_BUSY 有界重试。
function withImmediate(db, fn, { retries = 25, waitMs = 40 } = {}) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const tx = db.transaction(() => fn(db));
    try {
      return tx.immediate();
    } catch (e) {
      const busy = e && (e.code === 'SQLITE_BUSY' || String(e.code) === 'SQLITE_BUSY'
        || /database is locked/i.test(e.message || ''));
      if (busy && attempt < retries) {
        attempt++;
        // 同步等待（better-sqlite3 为同步驱动）
        const until = Date.now() + waitMs;
        while (Date.now() < until) { /* spin briefly */ }
        continue;
      }
      throw e;
    }
  }
}

module.exports = { openDb, init, withImmediate, setDbPath, SCHEMA };
