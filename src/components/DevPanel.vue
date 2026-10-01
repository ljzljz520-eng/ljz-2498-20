<script setup>
// 演示/测试用事件模拟：图片撤回、批注重开、作者权限、规则版、数据库中断
import { computed } from 'vue'

const props = defineProps({ state: Object })
defineEmits(['action'])

const nextRule = computed(() => {
  const v = props.state?.doc?.ruleVersion || 'v1'
  const n = parseInt(v.replace('v', ''), 10) || 1
  return 'v' + (n + 1)
})
</script>

<template>
  <details class="dev-panel">
    <summary>世界事件与故障注入（测试用）</summary>
    <div class="dev-grid">
      <div class="dev-block" v-for="a in state.assets" :key="a.id">
        <span>资源 {{ a.id }}（说明{{ a.description ? '有' : '缺' }}，撤回版本 r{{ a.withdrawn_rev }}）</span>
        <button class="mini-btn" @click="$emit('action', { type: 'withdraw', id: a.id, withdrawn: !a.withdrawn })">
          {{ a.withdrawn ? '恢复资源' : '撤回图片' }}
        </button>
      </div>

      <div class="dev-block" v-for="c in state.comments" :key="c.id">
        <span>批注 {{ c.id }}（{{ c.is_open ? '打开' : '已解决' }}，状态 r{{ c.status_rev }}）</span>
        <button class="mini-btn" @click="$emit('action', { type: 'comment', id: c.id, open: !c.is_open })">
          {{ c.is_open ? '标记解决' : '重新打开批注' }}
        </button>
      </div>

      <div class="dev-block">
        <span>作者权限：{{ state.doc?.author?.is_author ? '具备作者权限' : '已失去作者权限' }}</span>
        <button class="mini-btn"
          @click="$emit('action', { type: 'author', isAuthor: !state.doc?.author?.is_author })">
          {{ state.doc?.author?.is_author ? '移除作者权限' : '恢复作者权限' }}
        </button>
      </div>

      <div class="dev-block">
        <span>规则版：{{ state.doc?.ruleVersion }}</span>
        <button class="mini-btn" @click="$emit('action', { type: 'rule', version: nextRule })">
          升级规则版到 {{ nextRule }}
        </button>
      </div>

      <div class="dev-block">
        <span>数据库中断（发布瞬间）</span>
        <button class="mini-btn danger" @click="$emit('action', { type: 'outage', on: true })">开启</button>
        <button class="mini-btn" @click="$emit('action', { type: 'outage', on: false })">关闭</button>
      </div>
    </div>
  </details>
</template>
