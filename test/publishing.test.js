import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createDemoPlatform,
  DbCommitError,
  DbUnavailableError,
  hashContent,
} from '../src/services/publishing.js'

const fixedContent = `# Catalpa 发布校对关口

保存只表示草稿已落库，不等于校对通过或已发布。

![季度增长趋势：2026 年三季度营收环比增长 18%](resource:growth.png)

[Vue 官方文档](https://vuejs.org/)

## 正文结构
### 依赖也参与校对

另一个 [项目说明](https://example.com/docs) 已补充目标地址。
`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function makePublishable(platform) {
  const { api, store, docId, userId } = platform
  await api.saveDocument(docId, fixedContent, userId)
  await api.setResourceDescription(docId, 'growth.png', '资源说明：2026 年三季度营收增长图表及数据来源', userId)
  await api.setCommentStatus(docId, 'c_data_source', 'resolved', userId)
  const run = await api.runProofread(docId, userId)
  assert.equal(run.status, 'passed')
  return run
}

function snapshotCount(store) {
  return store.state.tables.snapshots.size
}

test('初始草稿不能发布：校验器定位标题、空链接、批注和资源依赖', async () => {
  const platform = createDemoPlatform()
  const { api, docId, userId } = platform
  const result = await api.publishDocument(docId, { userId })

  assert.equal(result.ok, false)
  const codes = result.blockingFindings.map((item) => item.code)
  assert.ok(codes.includes('heading.skip-level'))
  assert.ok(codes.includes('link.empty'))
  assert.ok(codes.includes('comment.open'))
  assert.ok(codes.includes('resource.alt-missing') === false)
  assert.ok(codes.includes('resource.description-missing'))
  assert.ok(codes.includes('resource.check-pending'))
  const heading = result.blockingFindings.find((item) => item.code === 'heading.skip-level')
  assert.equal(heading.line, 10)
  assert.equal(heading.column, 6)
})

test('五个并发点击发布使用同一幂等键，只产生一个确定快照', async () => {
  const platform = createDemoPlatform({ scanDelay: 1 })
  await makePublishable(platform)
  const { api, store, docId, userId } = platform
  const requestId = 'req_concurrent_exact'

  const results = await Promise.all(
    Array.from({ length: 5 }, () => api.publishDocument(docId, { userId, requestId })),
  )

  assert.equal(results.every((item) => item.ok), true)
  assert.equal(new Set(results.map((item) => item.snapshotId)).size, 1)
  assert.equal(results[0].deduplicated, false)
  assert.equal(results.slice(1).every((item) => item.deduplicated), true)
  assert.equal(snapshotCount(store), 1)
  assert.equal(store.state.tables.publication_pointers.get(docId).snapshot_id, results[0].snapshotId)
})

test('资源扫描期间修改文稿标题，迟到结果不会写入且校对记为 stale', async () => {
  const platform = createDemoPlatform({ scanDelay: 120 })
  const { api, store, docId, userId } = platform

  const pending = api.runProofread(docId, userId)
  await sleep(30)
  await api.saveDocument(docId, fixedContent, userId)
  const run = await pending

  assert.equal(run.status, 'stale')
  assert.equal(store.state.tables.resource_checks.size, 0)
  const dashboard = await api.getDashboard(docId, userId)
  assert.notEqual(dashboard.proofState, 'passed')
})

test('正文未变但图片在资源校验窗口撤回，旧资源结果和校对均失效', async () => {
  const platform = createDemoPlatform({ scanDelay: 120 })
  const { api, docId, userId } = platform

  const pending = api.runProofread(docId, userId)
  await sleep(30)
  await api.setResourceStatus(docId, 'growth.png', 'revoked', userId)
  const run = await pending

  assert.equal(run.status, 'stale')
  const dashboard = await api.getDashboard(docId, userId)
  assert.ok(dashboard.evaluation.findings.some((item) => item.code === 'resource.revoked'))
  const publish = await api.publishDocument(docId, { userId })
  assert.equal(publish.ok, false)
})

test('正文未变，批注重开或作者权限改变都会使旧通过失效', async () => {
  const platform = createDemoPlatform({ scanDelay: 1 })
  await makePublishable(platform)
  const { api, docId, userId } = platform

  await api.setCommentStatus(docId, 'c_data_source', 'open', userId)
  let dashboard = await api.getDashboard(docId, userId)
  assert.equal(dashboard.proofState, 'invalid')
  assert.ok(dashboard.evaluation.findings.some((item) => item.code === 'comment.open'))
  let publish = await api.publishDocument(docId, { userId })
  assert.equal(publish.ok, false)

  await api.setCommentStatus(docId, 'c_data_source', 'resolved', userId)
  await api.changePermission(docId, userId, 'reviewer')
  dashboard = await api.getDashboard(docId, userId)
  assert.equal(dashboard.proofState, 'invalid')
  assert.ok(dashboard.evaluation.findings.some((item) => item.code === 'permission.publish-denied'))
  publish = await api.publishDocument(docId, { userId })
  assert.equal(publish.ok, false)
})

test('资源版本变化后，旧资源证据变成 stale；重新校对才可发布', async () => {
  const platform = createDemoPlatform({ scanDelay: 1 })
  await makePublishable(platform)
  const { api, docId, userId } = platform

  await api.setResourceDescription(docId, 'growth.png', '更新后的资源说明，资源版本递增', userId)
  let dashboard = await api.getDashboard(docId, userId)
  assert.equal(dashboard.proofState, 'invalid')
  assert.ok(dashboard.evaluation.findings.some((item) => item.code === 'resource.check-stale'))
  assert.equal(await (await api.publishDocument(docId, { userId })).ok, false)

  await api.runProofread(docId, userId)
  dashboard = await api.getDashboard(docId, userId)
  assert.equal(dashboard.proofState, 'passed')
  const result = await api.publishDocument(docId, { userId })
  assert.equal(result.ok, true)
})

test('任务第一次发布在提交点失败并回滚，同一请求键可安全重试且只有一个快照', async () => {
  const platform = createDemoPlatform({ scanDelay: 1 })
  await makePublishable(platform)
  const { api, store, docId, userId } = platform
  const requestId = 'req_retry_once'

  store.failNextCommits(1)
  await assert.rejects(api.publishDocument(docId, { userId, requestId }), DbCommitError)
  assert.equal(snapshotCount(store), 0)
  assert.equal(store.state.tables.idempotency_keys.size, 0)

  const retry = await api.publishDocument(docId, { userId, requestId })
  assert.equal(retry.ok, true)
  assert.equal(retry.requestId, requestId)
  assert.equal(snapshotCount(store), 1)
})

test('数据库中断时事务不可提交；恢复后同一确定状态可发布', async () => {
  const platform = createDemoPlatform({ scanDelay: 1 })
  await makePublishable(platform)
  const { api, store, docId, userId } = platform

  store.setConnected(false)
  await assert.rejects(api.publishDocument(docId, { userId }), DbUnavailableError)
  assert.equal(snapshotCount(store), 0)

  store.setConnected(true)
  const result = await api.publishDocument(docId, { userId })
  assert.equal(result.ok, true)
  assert.equal(snapshotCount(store), 1)
})

test('豁免只绑定具体指纹、规则版和文稿版本；新增同类错误不能继承', async () => {
  const platform = createDemoPlatform({ scanDelay: 1 })
  const { api, docId, userId } = platform
  let dashboard = await api.getDashboard(docId, userId)
  const headingIssue = dashboard.evaluation.findings.find((item) => item.code === 'heading.skip-level')

  await api.addExemption(docId, headingIssue.fingerprint, '该级标题是外部模板要求，当前版本保留', userId)
  dashboard = await api.getDashboard(docId, userId)
  let issue = dashboard.evaluation.findings.find((item) => item.fingerprint === headingIssue.fingerprint)
  assert.equal(issue.exempt, true)
  assert.equal(issue.exemption_reason, '该级标题是外部模板要求，当前版本保留')

  const changed = fixedContent.replace('## 正文结构\n### 依赖也参与校对', '## 正文结构\n#### 新的具体标题问题')
  await api.saveDocument(docId, changed, userId)
  dashboard = await api.getDashboard(docId, userId)
  issue = dashboard.evaluation.findings.find((item) => item.code === 'heading.skip-level')
  assert.ok(issue)
  assert.notEqual(issue.fingerprint, headingIssue.fingerprint)
  assert.equal(issue.exempt ?? false, false)
  assert.equal(dashboard.evaluation.manifest.ruleVersion, '2026.10.01')
})

test('正式发布成功后，同一内容与依赖重复请求复用同一个不可变快照', async () => {
  const platform = createDemoPlatform({ scanDelay: 1 })
  await makePublishable(platform)
  const { api, store, docId, userId } = platform
  const first = await api.publishDocument(docId, { userId, requestId: 'req-a' })
  const second = await api.publishDocument(docId, { userId, requestId: 'req-b' })

  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(first.snapshotId, second.snapshotId)
  assert.equal(snapshotCount(store), 1)
  assert.equal(second.run.manifest_hash, first.run.manifest_hash)
  assert.equal(hashContent(store.state.tables.snapshots.get(first.snapshotId).content), first.run.content_hash)
})
