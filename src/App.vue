<script setup>
import { computed, nextTick, onMounted, ref } from 'vue'
import { api } from './api'
import StatusBar from './components/StatusBar.vue'
import IssuePanel from './components/IssuePanel.vue'
import DevPanel from './components/DevPanel.vue'

const state = ref(null)
const draftBody = ref('')
const draftTitle = ref('')
const scan = ref(null)
const busy = ref('')
const feedback = ref(null)          // {kind, text, errors?}
const highlightLine = ref(0)
const concurrentResult = ref('')

const editorRef = ref(null)

const latestPassed = computed(() => (scan.value?.passed ? scan.value : null))

// 校对通过是否仍然"新鲜"：扫描快照的正文/权限/规则版本与当前一致，
// 且资源任务全部 ok（图片撤回/批注重开/权限改变会在发布时由依赖清单权威复核）
const dependencyFresh = computed(() => {
  const s = latestPassed.value
  const d = state.value?.doc
  if (!s || !d) return false
  if (s.bodyRev !== d.bodyRev || s.permRev !== d.permRev || s.ruleVersion !== d.ruleVersion) return false
  return s.jobs.every((j) => j.status === 'ok')
})

async function loadState() {
  state.value = await api.state()
  if (draftBody.value === '' && !draftTitle.value) {
    draftBody.value = state.value.doc.body
    draftTitle.value = state.value.doc.title
  }
}

function notify(kind, text, errors) {
  feedback.value = { kind, text, errors }
  if (kind === 'ok') setTimeout(() => { if (feedback.value?.text === text) feedback.value = null }, 4000)
}

async function save() {
  busy.value = 'save'
  try {
    const r = await api.saveBody(draftTitle.value, draftBody.value)
    await loadState()
    notify('ok', `内容已保存（正文修订 r${r.body_rev}）。保存不等于校对通过。`)
  } catch (e) { notify('err', e.message) } finally { busy.value = '' }
}

async function doScan() {
  busy.value = 'scan'
  scan.value = null
  try {
    const r = await api.scan()
    scan.value = await api.scanView(r.scanId)
    if (scan.value.status === 'checking') {
      notify('warn', '本地校对已完成，但资源校验结果迟到。可在问题面板手动"送达"，或等后台处理。')
    } else if (scan.value.passed) {
      notify('ok', `校对通过（#${scan.value.id}）。依赖清单已生成——发布时将原子复核。`)
    } else {
      notify('err', `校对未通过（#${scan.value.id}），共 ${scan.value.blockingCount} 个阻断问题。`)
    }
  } catch (e) { notify('err', e.message) } finally { busy.value = '' }
}

async function deliverAssets() {
  if (!scan.value) return
  busy.value = 'assets'
  try {
    scan.value = await api.processAssets(scan.value.id)
    notify(scan.value.passed ? 'ok' : 'err',
      scan.value.passed ? '迟到的资源校验已送达：校对通过，可以发布。'
                        : '资源校验结果失败（资源可能已被撤回），校对未通过。')
  } catch (e) { notify('err', e.message) } finally { busy.value = '' }
}

async function locate(line) {
  highlightLine.value = line
  await nextTick()
  const ta = editorRef.value
  if (!ta) return
  const lines = draftBody.value.split('\n')
  const before = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0)
  ta.focus()
  ta.setSelectionRange(before, before + lines[line - 1].length)
  const lineHeight = parseFloat(getComputedStyle(ta).lineHeight || '22')
  ta.scrollTop = Math.max(0, (line - 3) * lineHeight)
}

async function exempt({ issueId, reason }) {
  busy.value = 'exempt'
  try {
    await api.exempt(issueId, reason)
    notify('ok', '豁免已创建（仅绑定该具体问题指纹与当前版本）。请重新扫描使其生效。')
  } catch (e) { notify('err', e.message) } finally { busy.value = '' }
}

async function publish(label = '发布', idemKey) {
  if (!scan.value) { notify('err', '请先扫描校对。'); return }
  if (scan.value.status === 'checking') { notify('err', '资源校验尚未完成，不能发布。'); return }
  busy.value = 'publish'
  concurrentResult.value = ''
  try {
    const key = idemKey || `k-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const r = await api.publish(scan.value.id, key)
    await loadState()
    notify('ok', r.message + (r.idempotent ? '（幂等返回）' : ''))
    return r
  }  catch (e) {
    const errs = e.payload?.errors
    notify('err', e.message, errs)
    if (e.payload?.recheck) {
      // 依赖失效：刷新状态，提示重新扫描
      await loadState()
    }
    throw e
  } finally { busy.value = '' }
}

// 并发点击发布：同一 scanId + 同一幂等键，期望只有一份正式快照
async function concurrentPublish() {
  if (!scan.value || scan.value.status !== 'passed') { notify('err', '请先取得一次校对通过。'); return }
  busy.value = 'concurrent'
  const key = `concurrent-${scan.value.id}`
  try {
    const results = await Promise.allSettled([
      api.publish(scan.value.id, key),
      api.publish(scan.value.id, key),
      api.publish(scan.value.id, key),
    ])
    await loadState()
    const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value)
    const versions = [...new Set(ok.map((r) => `v${r.versionNo}`))]
    concurrentResult.value =
      `3 个并发请求：成功 ${ok.length}，唯一正式版本 ${versions.join(', ')}；` +
      (versions.length === 1 && state.value.doc.published ? '✅ 只有一个确定快照' : '❌ 出现多个版本')
  } finally { busy.value = '' }
}

// 任务重试：两次带同一幂等键，结果应相同且无第二快照
async function retryPublish() {
  if (!scan.value || scan.value.status !== 'passed') { notify('err', '请先取得一次校对通过。'); return }
  busy.value = 'retry'
  const key = `retry-${scan.value.id}`
  try {
    const a = await api.publish(scan.value.id, key)
    const b = await api.publish(scan.value.id, key)
    await loadState()
    concurrentResult.value =
      `任务重试：两次请求得到 v${a.versionNo} / v${b.versionNo}，` +
      (a.versionNo === b.versionNo ? '✅ 幂等，未产生重复发布' : '❌ 重复发布')
  } catch (e) { notify('err', e.message, e.payload?.errors) } finally { busy.value = '' }
}

async function onDevAction(a) {
  try {
    if (a.type === 'withdraw') await api.withdraw(a.id, a.withdrawn)
    if (a.type === 'comment') await api.setComment(a.id, a.open)
    if (a.type === 'author') await api.setAuthor(a.isAuthor)
    if (a.type === 'rule') await api.activateRule(a.version, `测试升级 ${a.version}`)
    if (a.type === 'outage') await api.setDbOutage(a.on)
    await loadState()
    notify('warn', '世界状态已变化。旧的校对通过可能已失效——发布时会被依赖复核拦截（或先重新扫描）。')
  } catch (e) { notify('err', e.message) }
}

const lineCount = computed(() => draftBody.value.split('\n').length)

onMounted(loadState)
</script>

<template>
  <div class="page">
    <header class="hero">
      <div>
        <p class="eyebrow">文稿平台 · 发布校对关口</p>
        <h1>Catalpa 文稿发布台</h1>
        <p class="subtitle">
          保存、校对通过、已经发布是三种不同状态；发布以依赖清单原子复核，不靠更新时间。
        </p>
      </div>
      <div class="stats">
        <span>{{ lineCount }} 行</span>
        <span>{{ draftBody.length }} 字符</span>
      </div>
    </header>

    <StatusBar v-if="state" :doc="state.doc" :latest-scan="latestPassed" :dependency-fresh="dependencyFresh" />

    <div v-if="feedback" class="feedback" :class="feedback.kind">
      <strong>
        {{ feedback.kind === 'ok' ? '✅ ' : feedback.kind === 'warn' ? '⚠️ ' : '⛔ ' }}
        {{ feedback.text }}
      </strong>
      <ul v-if="feedback.errors?.length">
        <li v-for="(er, i) in feedback.errors" :key="i">
          · {{ er.message || er.kind }}
        </li>
      </ul>
    </div>

    <main class="workspace">
      <section class="panel editor-panel">
        <div class="panel-header">
          <h2>文稿编辑</h2>
          <div class="actions">
            <input class="title-input" v-model="draftTitle" placeholder="标题" />
            <button class="btn" :disabled="!!busy" @click="save">
              {{ busy === 'save' ? '保存中…' : '保存内容' }}
            </button>
          </div>
        </div>
        <textarea
          ref="editorRef"
          v-model="draftBody"
          class="editor"
          spellcheck="false"
        />
        <div v-if="highlightLine" class="loc-hint">
          已定位到第 {{ highlightLine }} 行（再次点击其他问题可切换）
          <button class="mini-btn" @click="highlightLine = 0">清除</button>
        </div>
      </section>

      <section class="panel gate-panel">
        <div class="panel-header">
          <h2>校对关口</h2>
          <div class="actions">
            <button class="btn" :disabled="!!busy" @click="doScan">
              {{ busy === 'scan' ? '扫描中…' : '扫描校对' }}
            </button>
            <button class="btn primary" :disabled="!!busy || !scan || scan.status !== 'passed'"
                    @click="publish()">
              {{ busy === 'publish' ? '发布事务执行中…' : '发布正式版' }}
            </button>
          </div>
        </div>

        <IssuePanel
          :scan="scan"
          @locate="locate"
          @exempt="exempt"
          @process-assets="deliverAssets"
        />

        <div class="concurrency">
          <h4>并发与可靠性测试</h4>
          <div class="actions wrap">
            <button class="mini-btn" :disabled="!!busy" @click="concurrentPublish">
              {{ busy === 'concurrent' ? '并发提交中…' : '并发点击发布 ×3' }}
            </button>
            <button class="mini-btn" :disabled="!!busy" @click="retryPublish">
              模拟任务重试
            </button>
          </div>
          <p v-if="concurrentResult" class="conc-result">{{ concurrentResult }}</p>
          <p class="hint">
            其他场景：先「扫描校对」→ 在下方事件面板撤回图片 / 重开批注 / 改权限 → 再点发布，
            观察依赖清单如何精确拦截（正文可保持不变）。
          </p>
        </div>

        <DevPanel v-if="state" :state="state" @action="onDevAction" />
      </section>
    </main>
  </div>
</template>

<style scoped>
.feedback {
  margin: 12px 24px; padding: 10px 14px; border-radius: 10px; font-size: 14px;
  border: 1px solid;
}
.feedback.ok { background: #ecfdf3; border-color: #86efac; color: #166534; }
.feedback.warn { background: #fffbeb; border-color: #fcd34d; color: #92400e; }
.feedback.err { background: #fef2f2; border-color: #fca5a5; color: #991b1b; }
.feedback ul { margin: 6px 0 0; padding-left: 18px; }
.panel-header .actions { display: flex; gap: 8px; align-items: center; }
.title-input {
  padding: 6px 10px; border: 1px solid var(--border, #d7dbe3); border-radius: 8px;
  font-size: 14px; width: 180px;
}
.loc-hint {
  padding: 6px 12px; font-size: 12px; color: #2563eb;
  background: #eff6ff; border-top: 1px solid #bfdbfe;
  display: flex; justify-content: space-between; align-items: center;
}
.concurrency { border-top: 1px dashed #d7dbe3; padding: 10px 14px; }
.concurrency h4 { margin: 4px 0 8px; font-size: 14px; }
.actions.wrap { flex-wrap: wrap; }
.conc-result { font-size: 13px; color: #1d4ed8; margin: 8px 0 4px; }
.hint { font-size: 12px; color: #6b7280; margin: 6px 0 0; }
</style>
