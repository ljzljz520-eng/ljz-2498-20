<script setup>
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import { renderCatalpa } from './utils/catalpa'
import {
  createDemoPlatform,
  hashContent,
  normalizeContent,
  RULE_VERSION,
} from './services/publishing'

const platform = createDemoPlatform({ scanDelay: 700 })
const api = platform.api
const docId = platform.docId
const userId = platform.userId

const dashboard = ref(null)
const draft = ref(platform.initialContent)
const editorEl = ref(null)
const busy = ref('')
const notice = ref('')
const noticeKind = ref('info')
const requestKey = ref('')
const resourceDrafts = reactive({})
const exemptionDraft = reactive({ fingerprint: '', reason: '' })
const testLog = ref('')
let locateToken = 0

const fixedDraft = `# Catalpa 发布校对关口

保存只表示草稿已落库，不等于校对通过或已发布。

![季度增长趋势：2026 年三季度营收环比增长 18%](resource:growth.png)

[Vue 官方文档](https://vuejs.org/)

## 正文结构
### 依赖也参与校对

另一个 [项目说明](https://example.com/docs) 已补充目标地址。
`

const previewHtml = computed(() => renderCatalpa(draft.value))
const lineCount = computed(() => normalizeContent(draft.value).split(/\n/).length)
const charCount = computed(() => normalizeContent(draft.value).length)
const savedHash = computed(() => dashboard.value?.evaluation.contentHash ?? '')
const isDirty = computed(() => hashContent(draft.value) !== savedHash.value)
const findings = computed(() => dashboard.value?.evaluation.findings ?? [])
const blockingFindings = computed(() => dashboard.value?.evaluation.blockingFindings ?? [])
const matchedExemptions = computed(() => dashboard.value?.exemptions ?? [])
const latestRun = computed(() => dashboard.value?.latestRun ?? null)
const databaseConnected = computed(() => Boolean(dashboard.value?.databaseConnected))

const saveState = computed(() => {
  if (!dashboard.value) return { label: '加载中', tone: 'muted' }
  if (isDirty.value) return { label: '内容未保存', tone: 'warning' }
  return { label: '内容已保存', tone: 'ok' }
})

const proofState = computed(() => {
  if (!dashboard.value || !latestRun.value) return { label: '尚未校对', tone: 'muted' }
  const map = {
    passed: { label: '校对通过', tone: 'ok' },
    failed: { label: '校对未通过', tone: 'danger' },
    stale: { label: '校对结果已过期', tone: 'warning' },
    invalid: { label: '校对已被依赖变化失效', tone: 'warning' },
    never: { label: '尚未校对', tone: 'muted' },
  }
  return map[dashboard.value.proofState] ?? map.never
})

const publishState = computed(() => {
  if (!dashboard.value?.pointer) return { label: '尚未发布', tone: 'muted' }
  if (dashboard.value.publishedState === 'current') return { label: '已发布当前快照', tone: 'ok' }
  return { label: '正式版本落后于当前内容', tone: 'warning' }
})

const canProof = computed(() => !isDirty.value && !busy.value && databaseConnected.value)
const canPublish = computed(() =>
  !isDirty.value &&
  !busy.value &&
  databaseConnected.value &&
  dashboard.value?.proofState === 'passed',
)

async function refresh() {
  dashboard.value = await api.getDashboard(docId, userId)
  for (const resource of dashboard.value.resources) {
    if (resourceDrafts[resource.resource_id] === undefined) {
      resourceDrafts[resource.resource_id] = resource.description
    }
  }
}

function notify(message, kind = 'info') {
  notice.value = message
  noticeKind.value = kind
}

async function action(label, callback) {
  if (busy.value) return
  busy.value = label
  notice.value = ''
  try {
    const result = await callback()
    await refresh()
    return result
  } catch (error) {
    notify(`${label}失败：${error.message}`, 'danger')
    throw error
  } finally {
    busy.value = ''
  }
}

async function quietAction(label, callback) {
  busy.value = label
  notice.value = ''
  try {
    const result = await callback()
    await refresh()
    return result
  } finally {
    busy.value = ''
  }
}

function saveDraft() {
  return action('保存内容', () => api.saveDocument(docId, draft.value, userId))
}

function proofread() {
  return action('执行校对', async () => {
    const run = await api.runProofread(docId, userId)
    notify(`校对完成：${statusLabel(run.status)}；依赖清单 ${run.manifest_hash.slice(0, 10)}…`, run.status === 'passed' ? 'ok' : 'warning')
    return run
  })
}

async function publish() {
  const key = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  requestKey.value = key
  const result = await action('发布正式版本', () => api.publishDocument(docId, { userId, requestId: key }))
  if (result.ok) {
    notify(`发布指针已指向快照 ${result.snapshotId.slice(0, 14)}…（幂等键 ${key.slice(0, 10)}…）`, 'ok')
  } else {
    requestKey.value = ''
    notify('发布被校对关口拒绝：仍有未豁免阻断问题。新的内容/依赖变化后会生成新的幂等键。', 'danger')
  }
}

function statusLabel(status) {
  return {
    passed: '通过',
    failed: '未通过',
    stale: '结果过期',
  }[status] ?? status
}

async function concurrentPublish() {
  const key = `req_concurrent_${Date.now().toString(36)}`
  requestKey.value = key
  busy.value = '并发发布'
  notice.value = ''
  try {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => api.publishDocument(docId, { userId, requestId: key })),
    )
    await refresh()
    const snapshotIds = new Set(results.map((item) => item.snapshotId).filter(Boolean))
    testLog.value = `5 个并发请求使用同一幂等键，成功 ${results.filter((item) => item.ok).length} 个；确定快照数量 ${snapshotIds.size}；首个请求 dedup=false，其余均复用结果。`
    notify('并发发布完成：事务串行化 + 幂等键保证只有一个确定快照。', snapshotIds.size <= 1 ? 'ok' : 'danger')
  } catch (error) {
    notify(`并发发布失败：${error.message}`, 'danger')
  } finally {
    busy.value = ''
  }
}

function fillFixedDraft() {
  draft.value = fixedDraft
  notify('已把修复后的标题和链接放入编辑区，请先“保存内容”，再保存资源说明并重新校对。')
}

async function saveResourceDescription(resourceId) {
  await action('保存资源说明', () => api.setResourceDescription(docId, resourceId, resourceDrafts[resourceId], userId))
  notify('资源说明已保存；资源版本变化会立即使旧资源校验过期。', 'ok')
}

async function toggleResource(resource) {
  const next = resource.status === 'active' ? 'revoked' : 'active'
  await action(next === 'revoked' ? '撤回资源' : '恢复资源', () => api.setResourceStatus(docId, resource.resource_id, next, userId))
  notify(next === 'revoked' ? '图片已撤回：正文未变也会阻断发布。' : '资源已恢复，但资源版本已变化，需要重新校对。', 'warning')
}

async function toggleComment(comment) {
  const next = comment.status === 'open' ? 'resolved' : 'open'
  await action(next === 'open' ? '重开批注' : '解决批注', () => api.setCommentStatus(docId, comment.id, next, userId))
}

async function changeRole(event) {
  await action('调整作者权限', () => api.changePermission(docId, userId, event.target.value))
  notify('作者权限版本已更新；旧校对结果不会再被发布事务接受。', 'warning')
}

function setDatabaseConnected(event) {
  const connected = event.target.checked
  platform.store.setConnected(connected)
  if (connected) {
    refresh().then(() => notify('数据库连接已恢复。', 'ok'))
  } else if (dashboard.value) {
    dashboard.value.databaseConnected = false
    notify('数据库连接已中断；所有保存、校对、发布事务都会失败并回滚。', 'danger')
  }
}

function failNextCommit() {
  platform.store.failNextCommits(1)
  notify('已注入一次提交失败；下一次发布将在提交点回滚，可随后用同一幂等键重试。', 'warning')
}

function startExemption(finding) {
  exemptionDraft.fingerprint = finding.fingerprint
  exemptionDraft.reason = ''
  notify('请填写该问题在当前版本可发布的具体理由；新增同类错误不会继承此豁免。')
}

async function submitExemption() {
  if (!exemptionDraft.fingerprint) return
  await action('登记豁免', () => api.addExemption(docId, exemptionDraft.fingerprint, exemptionDraft.reason, userId))
  exemptionDraft.fingerprint = ''
  exemptionDraft.reason = ''
  notify('豁免仅绑定具体指纹、文稿版本和规则版本。', 'ok')
}

function cancelExemption() {
  exemptionDraft.fingerprint = ''
  exemptionDraft.reason = ''
}

async function revokeExemption(exemptionId) {
  await action('撤销豁免', () => api.revokeExemption(docId, exemptionId, userId))
}

async function locate(finding) {
  if (!finding.line) {
    notify('权限问题没有正文位置，请在下方“作者权限”卡片处理。')
    return
  }
  const textarea = editorEl.value
  const lines = normalizeContent(draft.value).split('\n')
  const lineIndex = Math.max(0, finding.line - 1)
  const start = lines.slice(0, lineIndex).reduce((sum, line) => sum + line.length + 1, 0)
  const column = Math.max(0, (finding.column ?? 1) - 1)
  const endLine = lines[lineIndex] ?? ''
  const end = start + Math.min(endLine.length, column + 24)
  textarea.focus()
  textarea.setSelectionRange(start + column, end)
  const token = ++locateToken
  await nextTick()
  requestAnimationFrame(() => {
    if (token !== locateToken) return
    textarea.style.lineHeight = getComputedStyle(textarea).lineHeight
    const lineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight) || 26
    textarea.scrollTop = Math.max(0, lineIndex * lineHeight - textarea.clientHeight / 3)
  })
}

onMounted(refresh)
</script>

<template>
  <div class="page" v-if="dashboard">
    <header class="hero">
      <div>
        <p class="eyebrow">规则版本 {{ RULE_VERSION }} · 事务型发布关口</p>
        <h1>文稿发布校对</h1>
        <p class="subtitle">标题层级、空链接、批注、资源说明和外部资源校验全部生成依赖清单；发布时在数据库事务内重新核对。</p>
      </div>
      <div class="status-stack">
        <span class="status-pill" :class="saveState.tone">{{ saveState.label }}</span>
        <span class="status-pill" :class="proofState.tone">{{ proofState.label }}</span>
        <span class="status-pill" :class="publishState.tone">{{ publishState.label }}</span>
      </div>
    </header>

    <section v-if="notice" class="notice" :class="noticeKind">{{ notice }}</section>

    <section class="version-bar">
      <div>
        <strong>当前保存版本：</strong>{{ dashboard.version.id }}
        <span class="hash">内容 {{ dashboard.evaluation.contentHash.slice(0, 10) }}</span>
      </div>
      <div>
        <strong>最近校对：</strong>
        <template v-if="latestRun">{{ latestRun.id }} · {{ statusLabel(latestRun.status) }} · {{ latestRun.manifest_hash.slice(0, 10) }}</template>
        <template v-else>无</template>
      </div>
      <div>
        <strong>发布指针：</strong>{{ dashboard.pointer?.snapshot_id ?? '未指向任何快照' }}
      </div>
      <div class="spacer"></div>
      <button class="btn" type="button" :disabled="!databaseConnected || busy !== ''" @click="saveDraft">
        {{ busy === '保存内容' ? '保存中…' : '保存内容' }}
      </button>
      <button class="btn" type="button" :disabled="!canProof" @click="proofread">
        {{ busy === '执行校对' ? '扫描资源中…' : '执行校对' }}
      </button>
      <button class="btn primary" type="button" :disabled="!canPublish" @click="publish">
        {{ busy === '发布正式版本' ? '事务提交中…' : '发布' }}
      </button>
    </section>

    <main class="workspace">
      <section class="panel editor-panel">
        <div class="panel-header">
          <div>
            <h2>正文编辑区</h2>
            <p>{{ lineCount }} 行 · {{ charCount }} 字符 · 只比较内容哈希，不把更新时间作为发布依据</p>
          </div>
          <div class="actions">
            <button class="ghost-btn" type="button" @click="fillFixedDraft">填入修复样例</button>
          </div>
        </div>
        <textarea
          ref="editorEl"
          v-model="draft"
          class="editor"
          spellcheck="false"
          aria-label="文稿正文"
        />
        <details class="preview-box" open>
          <summary>预览当前编辑内容</summary>
          <article class="preview" v-html="previewHtml"></article>
        </details>
      </section>

      <section class="panel findings-panel">
        <div class="panel-header vertical">
          <div>
            <h2>逐项校对结果</h2>
            <p>点击“定位”跳转到正文坐标；资源、批注和权限问题提供独立处理入口。</p>
          </div>
          <div class="finding-counts">
            <span class="badge danger">{{ blockingFindings.length }} 个阻断</span>
            <span class="badge ok">{{ findings.length - blockingFindings.length }} 个已豁免</span>
          </div>
        </div>

        <div v-if="findings.length === 0" class="empty good">
          当前事务快照没有发现规则问题，可以发布。
        </div>
        <article
          v-for="finding in findings"
          :key="finding.fingerprint"
          class="finding-card"
          :class="finding.exempt ? 'exempt' : 'blocking'"
        >
          <div class="finding-main">
            <span class="finding-code">{{ finding.code }}</span>
            <h3>{{ finding.title }}</h3>
            <p>{{ finding.detail }}</p>
            <dl class="location">
              <template v-if="finding.line">
                <div><dt>位置</dt><dd>{{ finding.line }}:{{ finding.column ?? 1 }}</dd></div>
              </template>
              <div v-if="finding.resourceId"><dt>资源</dt><dd>{{ finding.resourceId }}</dd></div>
              <div v-if="finding.commentId"><dt>批注</dt><dd>{{ finding.commentId }}</dd></div>
              <div v-if="finding.role"><dt>角色</dt><dd>{{ finding.role }} · v{{ finding.permissionVersion }}</dd></div>
              <div v-if="finding.currentVersion"><dt>资源版本</dt><dd>v{{ finding.currentVersion }}</dd></div>
            </dl>
            <p v-if="finding.exempt" class="exemption-note">
              已由 {{ finding.exemption_id }} 豁免：{{ finding.exemption_reason }}
            </p>
          </div>
          <div class="finding-actions">
            <button class="ghost-btn" type="button" @click="locate(finding)">定位</button>
            <button
              v-if="finding.exemptable && !finding.exempt"
              class="ghost-btn warning"
              type="button"
              @click="startExemption(finding)"
            >
              申请豁免
            </button>
          </div>
        </article>

        <form v-if="exemptionDraft.fingerprint" class="exemption-form" @submit.prevent="submitExemption">
          <h3>登记版本化豁免</h3>
          <p>豁免指纹：<code>{{ exemptionDraft.fingerprint }}</code></p>
          <textarea v-model="exemptionDraft.reason" placeholder="必须说明为什么这一个具体问题可以在当前文稿版本发布" />
          <div class="actions end">
            <button class="ghost-btn" type="button" @click="cancelExemption">取消</button>
            <button class="btn primary" type="submit">确认豁免</button>
          </div>
        </form>

        <section class="subcard">
          <h3>已绑定当前版本的豁免</h3>
          <p v-if="matchedExemptions.length === 0" class="muted">暂无豁免。</p>
          <div v-for="item in matchedExemptions" :key="item.id" class="exemption-row">
            <div>
              <strong>{{ item.code }}</strong>
              <span class="hash">{{ item.id }}</span>
              <p>{{ item.reason }}</p>
            </div>
            <button class="ghost-btn danger" type="button" @click="revokeExemption(item.id)">撤销</button>
          </div>
        </section>
      </section>
    </main>

    <section class="dependency-grid">
      <article class="dependency-card">
        <h2>资源说明与撤回状态</h2>
        <p class="muted">资源版本递增会使旧资源校验和旧校对失效；外部结果只作为绑定版本的证据。</p>
        <div v-for="resource in dashboard.resources" :key="resource.resource_id" class="resource-row">
          <div class="resource-title">
            <strong>{{ resource.resource_id }}</strong>
            <span class="badge" :class="resource.status === 'active' ? 'ok' : 'danger'">
              {{ resource.status === 'active' ? '可用' : '已撤回' }} · v{{ resource.version }}
            </span>
          </div>
          <textarea v-model="resourceDrafts[resource.resource_id]" placeholder="资源库说明：图片内容、来源或版权信息" />
          <div class="actions end">
            <button class="ghost-btn" type="button" @click="saveResourceDescription(resource.resource_id)">保存说明</button>
            <button class="ghost-btn" :class="resource.status === 'active' ? 'danger' : 'ok'" type="button" @click="toggleResource(resource)">
              {{ resource.status === 'active' ? '撤回图片' : '恢复图片' }}
            </button>
          </div>
          <p class="check-state">
            校验：
            <template v-if="dashboard.resourceChecks[resource.resource_id]">
              {{ dashboard.resourceChecks[resource.resource_id].status }} ·
              资源 v{{ dashboard.resourceChecks[resource.resource_id].resource_version }}
            </template>
            <template v-else>尚未完成</template>
          </p>
        </div>
      </article>

      <article class="dependency-card">
        <h2>批注</h2>
        <div v-for="comment in dashboard.comments" :key="comment.id" class="comment-row">
          <div>
            <span class="badge" :class="comment.status === 'open' ? 'danger' : 'ok'">
              {{ comment.status === 'open' ? '打开' : '已解决' }} · v{{ comment.version }}
            </span>
            <p>{{ comment.text }}</p>
            <span class="hash">位置 {{ comment.line }} 行</span>
          </div>
          <button class="ghost-btn" type="button" @click="toggleComment(comment)">
            {{ comment.status === 'open' ? '解决' : '重新打开' }}
          </button>
        </div>

        <h2>作者权限</h2>
        <label class="role-line">
          当前角色
          <select :value="dashboard.permission.role" @change="changeRole">
            <option value="owner">owner（可发布）</option>
            <option value="author">author（可发布）</option>
            <option value="reviewer">reviewer（不可发布）</option>
            <option value="viewer">viewer（不可发布）</option>
          </select>
        </label>
        <p class="muted">权限记录当前为 v{{ dashboard.permission.version }}；发布事务读取当前权限版本，不相信旧通过标记。</p>
      </article>

      <article class="dependency-card tests">
        <h2>故障与并发测试</h2>
        <label class="switch-row">
          <input type="checkbox" :checked="databaseConnected" @change="setDatabaseConnected" />
          数据库连接正常
        </label>
        <button class="ghost-btn warning" type="button" :disabled="!databaseConnected || Boolean(busy)" @click="failNextCommit">
          注入下一次提交失败
        </button>
        <button class="ghost-btn" type="button" :disabled="!canPublish" @click="concurrentPublish">
          模拟 5 次并发点击发布
        </button>
        <p class="muted">资源迟到测试：点击“执行校对”后，在约 700ms 扫描窗口内撤回或恢复图片，旧结果会因资源版本变化被丢弃。</p>
        <pre v-if="testLog" class="test-output">{{ testLog }}</pre>
      </article>

      <article class="dependency-card manifest">
        <h2>发布依赖清单</h2>
        <p class="muted">正式快照包含内容、AST 定位、资源、批注、权限、资源校验证据和豁免；清单哈希不包含时间戳。</p>
        <pre>{{ JSON.stringify(dashboard.evaluation.manifest, null, 2) }}</pre>
      </article>
    </section>
  </div>
</template>
