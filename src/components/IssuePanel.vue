<script setup>
// 逐项问题面板：按四类分组、显示定位与豁免，支持申请豁免
import { computed, ref } from 'vue'

const props = defineProps({
  scan: Object,
})
const emit = defineEmits(['locate', 'exempt'])

const groups = [
  { code: 'heading.skip', icon: '¶', name: '标题层级' },
  { code: 'link.empty', icon: '🔗', name: '空链接' },
  { code: 'comment.open', icon: '💬', name: '打开的批注' },
  { code: 'asset.description', icon: '🖼', name: '资源说明' },
]

const pending = ref({}) // issueId -> 豁免理由输入

const grouped = computed(() =>
  groups.map((g) => ({
    ...g,
    items: (props.scan?.issues || []).filter((i) => i.ruleCode === g.code),
  })),
)

function submitExempt(issueId) {
  const reason = (pending.value[issueId] || '').trim() || '评审确认此处可接受'
  emit('exempt', { issueId, reason })
  pending.value[issueId] = ''
}
</script>

<template>
  <div class="issue-panel">
    <div v-if="!scan" class="empty-hint">
      点击「扫描校对」生成逐项问题清单与依赖清单。
    </div>

    <template v-else>
      <div class="scan-meta">
        <span>扫描 #{{ scan.id }}</span>
        <span class="badge" :class="scan.status">
          {{ scan.status === 'checking' ? '资源校验中…' : scan.status === 'passed' ? '校对通过' : '未通过' }}
        </span>
        <span>规则版 {{ scan.ruleVersion }} · 正文 r{{ scan.bodyRev }}</span>
      </div>

      <!-- 资源校验任务（可能迟到） -->
      <div v-if="scan.jobs?.length" class="jobs">
        <strong>资源校验：</strong>
        <span v-for="j in scan.jobs" :key="j.assetId" class="job" :class="j.status">
          {{ j.assetId }}：{{ j.status === 'checking' ? '结果迟到/未完成' : j.status === 'ok' ? '通过' : '失败（已撤回）' }}
        </span>
        <button v-if="scan.jobs.some(j => j.status === 'checking')"
                class="mini-btn" @click="$emit('process-assets')">
          送达迟到的校验结果
        </button>
      </div>

      <div v-for="g in grouped" :key="g.code" class="issue-group">
        <h4>
          <span class="g-icon">{{ g.icon }}</span>{{ g.name }}
          <span class="count">{{ g.items.length }}</span>
        </h4>
        <p v-if="!g.items.length" class="none">无</p>
        <ul>
          <li v-for="it in g.items" :key="it.id" class="issue" :class="{ exempted: it.exemptionId }">
            <div class="issue-main">
              <span class="loc">第 {{ it.line }} 行</span>
              <span class="msg">{{ it.message }}</span>
            </div>
            <div class="issue-ops">
              <button class="mini-btn" @click="emit('locate', it.line)">定位</button>
              <span v-if="it.exemptionId" class="exempt-tag" :title="it.exemptionReason">
                已豁免：{{ it.exemptionReason }}
              </span>
              <template v-else>
                <input v-model="pending[it.id]" class="exempt-input"
                       placeholder="豁免理由（仅该问题+当前版本）" />
                <button class="mini-btn warn" @click="submitExempt(it.id)">申请豁免</button>
              </template>
            </div>
          </li>
        </ul>
      </div>
    </template>
  </div>
</template>
