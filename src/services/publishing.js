// Relaional-style publishing gate prototype.
// The same pure module runs in the browser demo and in Node tests.

export const RULE_VERSION = '2026.10.01'
const PUBLISH_ROLES = new Set(['owner', 'author'])
const MANIFEST_SCHEMA = 'catalpa.publish-manifest/v1'

export class DbUnavailableError extends Error {
  constructor(message = '数据库不可用，发布事务未开始或已回滚') {
    super(message)
    this.name = 'DbUnavailableError'
  }
}

export class DbCommitError extends Error {
  constructor(message = '数据库提交失败，事务已回滚') {
    super(message)
    this.name = 'DbCommitError'
  }
}

export class RuleViolationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RuleViolationError'
  }
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`
}

// Cyrb53: deterministic 64-bit-style hash. Production should store SHA-256.
export function hash(value) {
  const input = typeof value === 'string' ? value : stableStringify(value)
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return `${(h2 >>> 0).toString(16).padStart(8, '0')}${(h1 >>> 0).toString(16).padStart(8, '0')}`
}

export function normalizeContent(content) {
  return (content ?? '').replace(/\r\n/g, '\n').replace(/\s+$/g, '')
}

export function hashContent(content) {
  return hash(normalizeContent(content))
}

function short(value) {
  return String(value ?? '').slice(0, 10)
}

export function parseCatalpa(source) {
  const lines = normalizeContent(source).split('\n')
  const headings = []
  const links = []
  const resourceRefs = []
  let inFence = false

  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (/^```/.test(trimmed)) {
      inFence = !inFence
      return
    }
    if (inFence || trimmed === '') return

    const heading = trimmed.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (heading) {
      const indent = line.indexOf(trimmed)
      headings.push({
        line: index + 1,
        column: indent + heading[1].length + 2,
        level: heading[1].length,
        text: heading[2].trim(),
      })
    }

    const referencePattern = /(!?)\[([^\]]*)\]\(\s*([^)\s]*)\s*\)/g
    let match
    while ((match = referencePattern.exec(line)) !== null) {
      const isImage = match[1] === '!'
      const text = match[2]
      const target = match[3]
      const column = match.index + 1
      if (isImage) {
        resourceRefs.push({
          line: index + 1,
          column,
          alt: text,
          resourceId: target.replace(/^resource:/, ''),
        })
      } else if (target.trim() === '') {
        links.push({ line: index + 1, column, text, target: '' })
      }
    }
  })

  return { headings, links, resourceRefs }
}

function fingerprintFor(identity) {
  return hash(identity)
}

function buildFindings(ast, env) {
  const findings = []
  const push = (finding) => findings.push({
    severity: 'blocker',
    exemptable: false,
    ...finding,
    id: `f_${finding.fingerprint.slice(0, 12)}`,
  })

  if (ast.headings.length === 0) {
    const fingerprint = fingerprintFor({ code: 'heading.missing-h1', subject: 'document' })
    push({
      code: 'heading.missing-h1',
      title: '缺少一级标题',
      detail: '正式文稿必须以一个 H1 作为标题层级根节点。',
      line: 1,
      column: 1,
      exemptable: true,
      fingerprint,
    })
  } else {
    let previous = null
    for (const heading of ast.headings) {
      if (previous && heading.level > previous.level + 1) {
        const fingerprint = fingerprintFor({
          code: 'heading.skip-level',
          line: heading.line,
          text: heading.text,
          previousLevel: previous.level,
          level: heading.level,
        })
        push({
          code: 'heading.skip-level',
          title: '标题层级跳跃',
          detail: `上一标题为 H${previous.level}，这里直接使用 H${heading.level}，中间缺少 H${previous.level + 1}。`,
          line: heading.line,
          column: heading.column,
          excerpt: heading.text,
          exemptable: true,
          fingerprint,
        })
      }
      previous = heading
    }
  }

  for (const link of ast.links) {
    push({
      code: 'link.empty',
      title: '空链接',
      detail: `链接“${link.text || '未命名链接'}”没有目标地址。`,
      line: link.line,
      column: link.column,
      excerpt: link.text,
      exemptable: true,
      fingerprint: fingerprintFor({
        code: 'link.empty',
        line: link.line,
        column: link.column,
        text: link.text,
      }),
    })
  }

  for (const ref of ast.resourceRefs) {
    const resource = env.resources[ref.resourceId]
    if (!resource) {
      push({
        code: 'resource.missing',
        title: '资源不存在',
        detail: `资源 ${ref.resourceId} 已不在资源库中。`,
        line: ref.line,
        column: ref.column,
        resourceId: ref.resourceId,
        fingerprint: fingerprintFor({ code: 'resource.missing', line: ref.line, resourceId: ref.resourceId }),
      })
      continue
    }

    if (ref.alt.trim() === '') {
      push({
        code: 'resource.alt-missing',
        title: '资源说明缺失',
        detail: `图片 ${ref.resourceId} 缺少可读的替代说明。`,
        line: ref.line,
        column: ref.column,
        resourceId: ref.resourceId,
        exemptable: true,
        fingerprint: fingerprintFor({ code: 'resource.alt-missing', line: ref.line, resourceId: ref.resourceId }),
      })
    }

    if (resource.status !== 'active') {
      push({
        code: 'resource.revoked',
        title: '资源已撤回',
        detail: `资源 ${ref.resourceId} 当前状态为 ${resource.status}，不能进入正式版本。`,
        line: ref.line,
        column: ref.column,
        resourceId: ref.resourceId,
        currentVersion: resource.version,
        fingerprint: fingerprintFor({
          code: 'resource.revoked',
          line: ref.line,
          resourceId: ref.resourceId,
          status: resource.status,
        }),
      })
    }

    if (resource.description.trim() === '') {
      push({
        code: 'resource.description-missing',
        title: '资源库说明缺失',
        detail: `资源 ${ref.resourceId} 还没有在资源库登记说明。`,
        line: ref.line,
        column: ref.column,
        resourceId: ref.resourceId,
        currentVersion: resource.version,
        exemptable: true,
        fingerprint: fingerprintFor({
          code: 'resource.description-missing',
          line: ref.line,
          resourceId: ref.resourceId,
        }),
      })
    }

    const check = env.resourceChecks[ref.resourceId]
    if (!check) {
      push({
        code: 'resource.check-pending',
        title: '资源校验尚未完成',
        detail: `资源 ${ref.resourceId} 缺少绑定当前文稿版本的校验结果。`,
        line: ref.line,
        column: ref.column,
        resourceId: ref.resourceId,
        fingerprint: fingerprintFor({ code: 'resource.check-pending', line: ref.line, resourceId: ref.resourceId }),
      })
    } else if (check.content_hash !== env.contentHash || check.resource_version !== resource.version) {
      push({
        code: 'resource.check-stale',
        title: '资源校验结果已过期',
        detail: '资源结果来自旧文稿或旧资源版本；迟到结果不能替代当前版本的重新校验。',
        line: ref.line,
        column: ref.column,
        resourceId: ref.resourceId,
        currentVersion: resource.version,
        checkVersion: check.resource_version,
        checkContent: short(check.content_hash),
        currentContent: short(env.contentHash),
        fingerprint: fingerprintFor({
          code: 'resource.check-stale',
          line: ref.line,
          resourceId: ref.resourceId,
          currentVersion: resource.version,
          checkVersion: check.resource_version,
          contentHash: env.contentHash,
        }),
      })
    } else if (check.status !== 'pass') {
      push({
        code: 'resource.check-failed',
        title: '资源校验未通过',
        detail: `资源 ${ref.resourceId} 的外部校验状态为 ${check.status}。`,
        line: ref.line,
        column: ref.column,
        resourceId: ref.resourceId,
        fingerprint: fingerprintFor({
          code: 'resource.check-failed',
          line: ref.line,
          resourceId: ref.resourceId,
          resourceVersion: resource.version,
        }),
      })
    }
  }

  for (const comment of env.comments) {
    if (comment.status === 'open') {
      push({
        code: 'comment.open',
        title: '批注仍打开',
        detail: `批注 ${comment.id} 尚未解决：${comment.text}`,
        line: comment.line,
        column: 1,
        commentId: comment.id,
        commentVersion: comment.version,
        exemptable: true,
        fingerprint: fingerprintFor({
          code: 'comment.open',
          line: comment.line,
          commentId: comment.id,
          commentVersion: comment.version,
        }),
      })
    }
  }

  if (!PUBLISH_ROLES.has(env.permission.role)) {
    push({
      code: 'permission.publish-denied',
      title: '没有发布权限',
      detail: `作者当前角色 ${env.permission.role} 不能发布正式版本。`,
      userId: env.permission.user_id,
      role: env.permission.role,
      permissionVersion: env.permission.version,
      fingerprint: fingerprintFor({
        code: 'permission.publish-denied',
        userId: env.permission.user_id,
        role: env.permission.role,
        version: env.permission.version,
      }),
    })
  }

  return findings
}

export function evaluateState(input) {
  const {
    documentVersion,
    content,
    resources,
    comments,
    permission,
    resourceChecks,
    exemptions,
  } = input
  const contentHash = hashContent(content)
  const ast = parseCatalpa(content)
  const env = {
    documentVersion,
    contentHash,
    resources,
    comments,
    permission,
    resourceChecks,
  }

  const activeExemptions = (exemptions ?? []).filter(
    (item) => item.active &&
      item.document_version === documentVersion &&
      item.rule_version === RULE_VERSION,
  )
  const exemptionByFingerprint = new Map(activeExemptions.map((item) => [item.fingerprint, item]))
  const findings = buildFindings(ast, env).map((finding) => {
    const exemption = exemptionByFingerprint.get(finding.fingerprint)
    if (finding.exemptable && exemption) {
      return {
        ...finding,
        exempt: true,
        exemption_id: exemption.id,
        exemption_reason: exemption.reason,
      }
    }
    return finding
  })

  const matchedExemptions = activeExemptions
    .filter((exemption) => findings.some((finding) => finding.fingerprint === exemption.fingerprint && finding.exempt))
    .map(({ id, fingerprint, reason, code }) => ({ id, fingerprint, reason: hash(reason), code }))

  const resourceView = {}
  Object.values(resources)
    .sort((a, b) => a.resource_id.localeCompare(b.resource_id))
    .forEach((resource) => {
      resourceView[resource.resource_id] = {
        version: resource.version,
        status: resource.status,
        descriptionHash: hash(resource.description),
      }
    })

  const checkView = {}
  ast.resourceRefs
    .map((ref) => ref.resourceId)
    .filter((id, index, ids) => ids.indexOf(id) === index)
    .sort()
    .forEach((id) => {
      const check = resourceChecks[id]
      if (check) {
        checkView[id] = {
          status: check.status,
          resourceVersion: check.resource_version,
          contentHash: check.content_hash,
          evidenceHash: check.evidence_hash,
        }
      } else {
        checkView[id] = null
      }
    })

  const manifest = {
    schema: MANIFEST_SCHEMA,
    ruleVersion: RULE_VERSION,
    documentVersion,
    contentHash,
    ast,
    resources: resourceView,
    comments: Object.fromEntries([...comments]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((comment) => [comment.id, { status: comment.status, version: comment.version, line: comment.line }])),
    permission: {
      userId: permission.user_id,
      role: permission.role,
      version: permission.version,
    },
    resourceChecks: checkView,
    exemptions: matchedExemptions,
  }
  const manifestHash = hash(manifest)
  const blockingFindings = findings.filter((finding) => !finding.exempt)

  return {
    ast,
    contentHash,
    manifest,
    manifestHash,
    findings,
    blockingFindings,
    passed: blockingFindings.length === 0,
  }
}

export function createRelationalStore(options = {}) {
  const state = {
    connected: true,
    meta: { version: 0 },
    tables: {
      rule_versions: new Map(),
      documents: new Map(),
      document_versions: new Map(),
      resources: new Map(),
      comments: new Map(),
      permissions: new Map(),
      resource_checks: new Map(),
      exemptions: new Map(),
      validation_runs: [],
      snapshots: new Map(),
      publication_pointers: new Map(),
      idempotency_keys: new Map(),
    },
  }

  const lockedKeys = new Set()
  const waitQueues = new Map()
  let commitFailures = options.commitFailures ?? 0
  const now = options.now ?? (() => new Date().toISOString())

  function acquire(key) {
    if (!lockedKeys.has(key)) {
      lockedKeys.add(key)
      waitQueues.set(key, [])
      return Promise.resolve()
    }
    return new Promise((resolve) => waitQueues.get(key).push(resolve))
  }

  function release(key) {
    const queue = waitQueues.get(key)
    if (queue && queue.length > 0) {
      const next = queue.shift()
      next()
    } else {
      lockedKeys.delete(key)
      waitQueues.delete(key)
    }
  }

  return {
    state,
    now,
    isConnected() {
      return state.connected
    },
    setConnected(connected) {
      state.connected = connected
    },
    failNextCommits(count = 1) {
      commitFailures += count
    },
    async transaction(keys, callback) {
      if (!state.connected) throw new DbUnavailableError()
      const sortedKeys = [...new Set(keys)].sort()
      for (const key of sortedKeys) await acquire(key)

      const working = structuredClone(state)
      const tx = { state: working, tables: working.tables, now }
      try {
        const result = await callback(tx)
        if (!state.connected) throw new DbUnavailableError('提交前数据库连接中断')
        if (commitFailures > 0) {
          commitFailures -= 1
          throw new DbCommitError()
        }
        state.tables = working.tables
        state.meta.version += 1
        return result
      } finally {
        for (let i = sortedKeys.length - 1; i >= 0; i -= 1) release(sortedKeys[i])
      }
    },
  }
}

export const initialDemoContent = `# Catalpa 发布校对关口

保存只表示草稿已落库，不等于校对通过或已发布。

![季度增长趋势](resource:growth.png)

[旧活动入口]()

## 正文结构
#### 这里直接跳到四级标题

另一个 [空链接]() 也需要逐项处理。
`

export function createDemoPlatform(options = {}) {
  const store = createRelationalStore(options)
  const docId = 'doc_release'
  const userId = 'u_editor'

  // Seed data is installed synchronously before any API caller can obtain the
  // returned platform. Avoid an unawaited transaction here so a browser/test
  // cannot enter the public API before seed commit.
  const { tables } = store.state
  const timestamp = store.now()
  const contentHash = hashContent(initialDemoContent)
  tables.rule_versions.set(RULE_VERSION, { version: RULE_VERSION, active: true, created_at: timestamp })
  tables.documents.set(docId, {
    id: docId,
    title: 'Catalpa 发布流程演示',
    current_version_id: 'ver_1',
    created_at: timestamp,
  })
  tables.document_versions.set('ver_1', {
    id: 'ver_1',
    document_id: docId,
    number: 1,
    content: initialDemoContent,
    content_hash: contentHash,
    created_at: timestamp,
  })
  tables.resources.set(`${docId}:growth.png`, {
    document_id: docId,
    resource_id: 'growth.png',
    status: 'active',
    description: '',
    version: 1,
    updated_at: timestamp,
  })
  tables.comments.set(`${docId}:c_data_source`, {
    document_id: docId,
    id: 'c_data_source',
    line: 5,
    text: '请补充图片的数据来源',
    status: 'open',
    version: 1,
    updated_at: timestamp,
  })
  tables.permissions.set(`${docId}:${userId}`, {
    document_id: docId,
    user_id: userId,
    role: 'owner',
    version: 1,
    updated_at: timestamp,
  })

  const api = createPublishingApi(store, options)
  return { store, api, docId, userId, initialContent: initialDemoContent, RULE_VERSION }
}

function createPublishingApi(store, options = {}) {
  const scanDelay = options.scanDelay ?? 650
  const scanResource = options.scanResource ?? (async (capture) => {
    await new Promise((resolve) => setTimeout(resolve, scanDelay))
    return Object.fromEntries(capture.refs.map((ref) => {
      const resource = capture.resources[ref.resourceId]
      return [ref.resourceId, resource?.status === 'active' ? 'pass' : 'fail']
    }))
  })

  function loadContext(tx, docId, userId) {
    const { tables } = tx
    const document = tables.documents.get(docId)
    if (!document) throw new RuleViolationError('文稿不存在')
    const version = tables.document_versions.get(document.current_version_id)
    const ast = parseCatalpa(version.content)
    const resources = {}
    for (const row of tables.resources.values()) {
      if (row.document_id === docId) resources[row.resource_id] = row
    }
    const comments = [...tables.comments.values()]
      .filter((row) => row.document_id === docId)
      .sort((a, b) => a.id.localeCompare(b.id))
    const permission = tables.permissions.get(`${docId}:${userId}`)
    if (!permission) throw new RuleViolationError('作者权限记录不存在')
    const resourceChecks = {}
    ast.resourceRefs
      .map((ref) => ref.resourceId)
      .filter((id, index, ids) => ids.indexOf(id) === index)
      .forEach((id) => {
        const check = tables.resource_checks.get(`${docId}:${id}`)
        if (check) resourceChecks[id] = check
      })
    const exemptions = [...tables.exemptions.values()].filter((row) => row.document_id === docId)
    const evaluation = evaluateState({
      documentVersion: version.id,
      content: version.content,
      resources,
      comments,
      permission,
      resourceChecks,
      exemptions,
    })
    return { document, version, ast, resources, comments, permission, resourceChecks, exemptions, evaluation }
  }

  function recordRun(tx, docId, context, status, extra = {}) {
    const run = {
      id: `run_${tx.tables.validation_runs.length + 1}`,
      document_id: docId,
      document_version: context.version.id,
      content_hash: context.evaluation.contentHash,
      rule_version: RULE_VERSION,
      manifest: context.evaluation.manifest,
      manifest_hash: context.evaluation.manifestHash,
      findings: context.evaluation.findings,
      blocking_count: context.evaluation.blockingFindings.length,
      status,
      created_at: tx.now(),
      ...extra,
    }
    tx.tables.validation_runs.push(run)
    return run
  }

  function refreshContext(tx, docId, userId) {
    return loadContext(tx, docId, userId)
  }

  return {
    RULE_VERSION,

    saveDocument(docId, content, actor = 'u_editor') {
      const key = `document:${docId}`
      const normalized = normalizeContent(content)
      const contentHash = hashContent(normalized)
      return store.transaction([key], (tx) => {
        const document = tx.tables.documents.get(docId)
        let version = [...tx.tables.document_versions.values()].find(
          (row) => row.document_id === docId && row.content_hash === contentHash,
        )
        if (!version) {
          const number = [...tx.tables.document_versions.values()]
            .filter((row) => row.document_id === docId)
            .reduce((max, row) => Math.max(max, row.number), 0) + 1
          version = {
            id: `ver_${number}_${contentHash.slice(0, 10)}`,
            document_id: docId,
            number,
            content: normalized,
            content_hash: contentHash,
            created_at: tx.now(),
          }
          tx.tables.document_versions.set(version.id, version)
        }
        document.current_version_id = version.id
        document.updated_by = actor
        document.updated_at = tx.now()
        return { ...version }
      })
    },

    async runProofread(docId, userId = 'u_editor') {
      const key = `document:${docId}`
      const captured = await store.transaction([key], (tx) => {
        const context = loadContext(tx, docId, userId)
        return {
          documentVersion: context.version.id,
          contentHash: context.evaluation.contentHash,
          refs: context.ast.resourceRefs
            .map(({ resourceId, line, column, alt }) => ({ resourceId, line, column, alt }))
            .filter((ref, index, refs) => refs.findIndex((item) => item.resourceId === ref.resourceId) === index),
          resources: Object.fromEntries(Object.entries(context.resources).map(([id, row]) => [id, {
            status: row.status,
            version: row.version,
            description: row.description,
          }])),
          startedAt: tx.now(),
        }
      })

      const scannerResults = await scanResource(captured)

      return store.transaction([key], (tx) => {
        const current = loadContext(tx, docId, userId)
        const resourceChanged = captured.refs.some((ref) => {
          const before = captured.resources[ref.resourceId]
          const after = current.resources[ref.resourceId]
          return !before || !after || before.version !== after.version
        })
        const changedDuringScan = current.version.id !== captured.documentVersion ||
          current.evaluation.contentHash !== captured.contentHash ||
          resourceChanged

        if (changedDuringScan) {
          return recordRun(tx, docId, current, 'stale', {
            stale_reason: '资源校验期间文稿版本或资源版本发生变化，迟到结果未写入。',
            captured_content_hash: captured.contentHash,
            current_content_hash: current.evaluation.contentHash,
          })
        }

        for (const ref of captured.refs) {
          const resource = current.resources[ref.resourceId]
          const status = scannerResults[ref.resourceId] === 'pass' ? 'pass' : 'fail'
          const evidence = {
            scanner: 'built-in-resource-scanner',
            resourceId: ref.resourceId,
            resourceVersion: resource.version,
            contentHash: current.evaluation.contentHash,
            status,
          }
          tx.tables.resource_checks.set(`${docId}:${ref.resourceId}`, {
            document_id: docId,
            resource_id: ref.resourceId,
            document_version: current.version.id,
            content_hash: current.evaluation.contentHash,
            resource_version: resource.version,
            status,
            evidence_hash: hash(evidence),
            checked_at: tx.now(),
          })
        }

        const completed = refreshContext(tx, docId, userId)
        return recordRun(tx, docId, completed, completed.evaluation.passed ? 'passed' : 'failed')
      })
    },

    addExemption(docId, fingerprint, reason, userId = 'u_editor') {
      const key = `document:${docId}`
      if (!reason || !reason.trim()) throw new RuleViolationError('豁免必须填写具体理由')
      return store.transaction([key], (tx) => {
        const context = loadContext(tx, docId, userId)
        const finding = context.evaluation.findings.find((item) => item.fingerprint === fingerprint)
        if (!finding) throw new RuleViolationError('只能豁免当前版本仍存在的具体问题')
        if (!finding.exemptable) throw new RuleViolationError('该依赖或权限问题不能豁免')
        if (finding.exempt) throw new RuleViolationError('该问题已有当前版本豁免')
        const duplicate = [...tx.tables.exemptions.values()].some(
          (item) => item.document_id === docId &&
            item.document_version === context.version.id &&
            item.rule_version === RULE_VERSION &&
            item.fingerprint === fingerprint &&
            item.active,
        )
        if (duplicate) throw new RuleViolationError('豁免已存在')
        const id = `ex_${tx.tables.exemptions.size + 1}_${fingerprint.slice(0, 8)}`
        tx.tables.exemptions.set(id, {
          id,
          document_id: docId,
          document_version: context.version.id,
          rule_version: RULE_VERSION,
          fingerprint,
          code: finding.code,
          reason: reason.trim(),
          actor: userId,
          active: true,
          created_at: tx.now(),
        })
        const refreshed = refreshContext(tx, docId, userId)
        return recordRun(tx, docId, refreshed, refreshed.evaluation.passed ? 'passed' : 'failed')
      })
    },

    revokeExemption(docId, exemptionId, userId = 'u_editor') {
      const key = `document:${docId}`
      return store.transaction([key], (tx) => {
        const exemption = tx.tables.exemptions.get(exemptionId)
        if (!exemption || exemption.document_id !== docId) throw new RuleViolationError('豁免不存在')
        exemption.active = false
        exemption.revoked_by = userId
        exemption.revoked_at = tx.now()
        const refreshed = refreshContext(tx, docId, userId)
        return recordRun(tx, docId, refreshed, refreshed.evaluation.passed ? 'passed' : 'failed')
      })
    },

    setResourceStatus(docId, resourceId, status, userId = 'u_editor') {
      const key = `document:${docId}`
      return store.transaction([key], (tx) => {
        const row = tx.tables.resources.get(`${docId}:${resourceId}`)
        if (!row) throw new RuleViolationError('资源不存在')
        if (row.status !== status) {
          row.status = status
          row.version += 1
          row.updated_by = userId
          row.updated_at = tx.now()
        }
        return { ...row }
      })
    },

    setResourceDescription(docId, resourceId, description, userId = 'u_editor') {
      const key = `document:${docId}`
      return store.transaction([key], (tx) => {
        const row = tx.tables.resources.get(`${docId}:${resourceId}`)
        if (!row) throw new RuleViolationError('资源不存在')
        const next = description.trim()
        if (row.description !== next) {
          row.description = next
          row.version += 1
          row.updated_by = userId
          row.updated_at = tx.now()
        }
        return { ...row }
      })
    },

    setCommentStatus(docId, commentId, status, userId = 'u_editor') {
      const key = `document:${docId}`
      return store.transaction([key], (tx) => {
        const row = tx.tables.comments.get(`${docId}:${commentId}`)
        if (!row) throw new RuleViolationError('批注不存在')
        if (row.status !== status) {
          row.status = status
          row.version += 1
          row.updated_by = userId
          row.updated_at = tx.now()
        }
        return { ...row }
      })
    },

    changePermission(docId, userId, role) {
      const key = `document:${docId}`
      return store.transaction([key], (tx) => {
        const row = tx.tables.permissions.get(`${docId}:${userId}`)
        if (!row) throw new RuleViolationError('权限不存在')
        if (row.role !== role) {
          row.role = role
          row.version += 1
          row.updated_at = tx.now()
        }
        return { ...row }
      })
    },

    async publishDocument(docId, options = {}) {
      const userId = options.userId ?? 'u_editor'
      const requestId = options.requestId ??
        `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
      const key = `document:${docId}`
      return store.transaction([key], (tx) => {
        const cached = tx.tables.idempotency_keys.get(requestId)
        if (cached) return { ...cached.response, deduplicated: true }

        const context = loadContext(tx, docId, userId)
        if (!context.evaluation.passed) {
          const run = recordRun(tx, docId, context, 'failed', {
            failed_reason: '存在未豁免阻断问题',
          })
          const response = {
            ok: false,
            requestId,
            reason: 'blocking-findings',
            run,
            blockingFindings: context.evaluation.blockingFindings,
          }
          tx.tables.idempotency_keys.set(requestId, {
            id: requestId,
            document_id: docId,
            response,
            created_at: tx.now(),
          })
          return response
        }

        const snapshotId = `snap_${hash({
          docId,
          contentHash: context.evaluation.contentHash,
          manifestHash: context.evaluation.manifestHash,
          ruleVersion: RULE_VERSION,
        }).slice(0, 18)}`
        const alreadyExisted = tx.tables.snapshots.has(snapshotId)
        if (!alreadyExisted) {
          tx.tables.snapshots.set(snapshotId, {
            id: snapshotId,
            document_id: docId,
            document_version: context.version.id,
            content: context.version.content,
            content_hash: context.evaluation.contentHash,
            manifest: context.evaluation.manifest,
            manifest_hash: context.evaluation.manifestHash,
            rule_version: RULE_VERSION,
            created_at: tx.now(),
          })
        }
        const previousPointer = tx.tables.publication_pointers.get(docId)
        tx.tables.publication_pointers.set(docId, {
          document_id: docId,
          snapshot_id: snapshotId,
          published_at: alreadyExisted && previousPointer?.snapshot_id === snapshotId
            ? previousPointer.published_at
            : tx.now(),
          request_id: requestId,
        })
        const run = recordRun(tx, docId, context, 'passed', { snapshot_id: snapshotId })
        const response = {
          ok: true,
          requestId,
          deduplicated: alreadyExisted,
          snapshotId,
          pointer: tx.tables.publication_pointers.get(docId),
          run,
        }
        tx.tables.idempotency_keys.set(requestId, {
          id: requestId,
          document_id: docId,
          response,
          created_at: tx.now(),
        })
        return response
      })
    },

    getDashboard(docId, userId = 'u_editor') {
      const key = `document:${docId}`
      return store.transaction([key], (tx) => {
        const context = loadContext(tx, docId, userId)
        const runs = tx.tables.validation_runs.filter((run) => run.document_id === docId)
        const latestRun = runs.at(-1) ?? null
        const matchingRun = latestRun &&
          latestRun.content_hash === context.evaluation.contentHash &&
          latestRun.manifest_hash === context.evaluation.manifestHash
          ? latestRun
          : null
        const pointer = tx.tables.publication_pointers.get(docId) ?? null
        const publishedSnapshot = pointer ? tx.tables.snapshots.get(pointer.snapshot_id) : null
        const publishedState = !pointer
          ? 'unpublished'
          : publishedSnapshot.content_hash === context.evaluation.contentHash &&
            publishedSnapshot.manifest_hash === context.evaluation.manifestHash
            ? 'current'
            : 'older'
        const proofState = !latestRun
          ? 'never'
          : !matchingRun
            ? latestRun.status === 'stale'
              ? 'stale'
              : 'invalid'
            : latestRun.status

        return {
          ruleVersion: RULE_VERSION,
          document: context.document,
          version: context.version,
          evaluation: context.evaluation,
          latestRun,
          matchingRun,
          proofState,
          pointer,
          publishedSnapshot,
          publishedState,
          resources: Object.values(context.resources),
          comments: context.comments,
          permission: context.permission,
          resourceChecks: context.resourceChecks,
          exemptions: context.exemptions,
          databaseConnected: store.isConnected(),
        }
      })
    },
  }
}
