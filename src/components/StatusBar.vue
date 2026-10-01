<script setup>
// 三态互斥状态条：内容已保存 / 校对通过 / 已经发布
defineProps({
  doc: Object,
  latestScan: Object,   // 最近一次扫描视图
  dependencyFresh: Boolean, // 校对通过的依赖当前是否仍有效（由发布前探测/上次结果推断）
})
</script>

<template>
  <div class="status-bar">
    <div class="state-chip saved" title="文稿正文与属性已落库">
      <span class="dot" />
      <div>
        <strong>内容已保存</strong>
        <small v-if="doc">正文修订 r{{ doc.bodyRev }} · 权限 r{{ doc.permRev }}</small>
      </div>
    </div>

    <div class="arrow">→</div>

    <div
      class="state-chip"
      :class="latestScan && latestScan.passed ? (dependencyFresh ? 'passed' : 'stale') : 'off'"
      title="仅代表最近一次校对通过；依赖变化后可能失效，发布时事务内会再次权威复核"
    >
      <span class="dot" />
      <div>
        <strong>校对通过</strong>
        <small v-if="latestScan && latestScan.passed">
          扫描 #{{ latestScan.id }} · 规则版 {{ latestScan.ruleVersion }}
          <em :class="dependencyFresh ? 'fresh' : 'warn'">
            （依赖{{ dependencyFresh ? '仍有效' : '已变化，需重新扫描' }}）
          </em>
        </small>
        <small v-else>尚无通过的校对</small>
      </div>
    </div>

    <div class="arrow">→</div>

    <div class="state-chip" :class="doc && doc.published ? 'published' : 'off'"
         title="已存在不可变的正式发布快照">
      <span class="dot" />
      <div>
        <strong>已经发布</strong>
        <small v-if="doc && doc.published">
          正式版 v{{ doc.published.versionNo }}
          <em v-if="doc.published.stale" class="warn">· 有未发布改动</em>
          <em v-else class="fresh">· 最新</em>
        </small>
        <small v-else>尚未发布</small>
      </div>
    </div>
  </div>
</template>
