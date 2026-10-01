# 发布校对关口设计

## 1. 目标

发布不是“最近一次校对通过”的简单标记。以下变化都可能让旧通过失效，即使正文没有修改：

- 图片或附件被撤回、删除、版本更新；
- 资源库说明或资源校验证据发生变化；
- 已解决批注被重新打开；
- 作者权限由 `owner/author` 变为其他角色；
- 规则版本升级；
- 豁免不再绑定当前文稿版本或规则版本。

因此发布依据是 **事务内重新读取到的依赖清单 + 规则校验结果**，不是文稿 `updated_at`，也不是页面上保留的旧校验结果。

## 2. 校验对象

校验器把正文解析成 AST，并输出带行列坐标的问题：

| 规则 | 说明 | 是否可豁免 |
| --- | --- | --- |
| `heading.missing-h1` | 缺少唯一标题根节点 | 可豁免 |
| `heading.skip-level` | 标题层级一次跳跃超过一级 | 可豁免 |
| `link.empty` | Markdown 链接目标为空 | 可豁免 |
| `resource.missing` | 正文引用的资源不存在 | 不可豁免 |
| `resource.alt-missing` | 图片缺少正文替代说明 | 可豁免 |
| `resource.description-missing` | 资源库未登记说明 | 可豁免 |
| `resource.revoked` | 资源状态不是 active | 不可豁免 |
| `resource.check-pending` | 缺少绑定当前文稿版本的资源校验证据 | 不可豁免 |
| `resource.check-stale` | 证据属于旧文稿或旧资源版本 | 不可豁免 |
| `resource.check-failed` | 外部资源扫描失败 | 不可豁免 |
| `comment.open` | 批注仍打开 | 可豁免 |
| `permission.publish-denied` | 当前作者没有发布权限 | 不可豁免 |

每个问题都有稳定指纹，指纹来自规则码、位置、资源/批注标识和当前版本关键字段。新增同类错误会得到新指纹，不能继承旧豁免。

## 3. 豁免模型

豁免必须同时绑定：

- 文稿 ID；
- 文稿版本；
- 规则版本；
- 问题指纹；
- 具体理由；
- 授权人与启用/撤销状态。

数据库对 `(document_id, document_version, rule_version, fingerprint)` 的启用豁免建立唯一索引。豁免不是“规则码级别”的通行证。例如同一行空链接被豁免，在下一版本新增另一个空链接时，新问题不会被豁免。

## 4. 依赖清单

通过校验后生成 `catalpa.publish-manifest/v1`：

```json
{
  "schema": "catalpa.publish-manifest/v1",
  "ruleVersion": "2026.10.01",
  "documentVersion": "ver_1",
  "contentHash": "...",
  "ast": { "headings": [], "links": [], "resourceRefs": [] },
  "resources": {
    "growth.png": {
      "version": 2,
      "status": "active",
      "descriptionHash": "..."
    }
  },
  "comments": {
    "c_data_source": { "status": "resolved", "version": 2, "line": 5 }
  },
  "permission": { "userId": "u_editor", "role": "owner", "version": 1 },
  "resourceChecks": {
    "growth.png": {
      "status": "pass",
      "resourceVersion": 2,
      "contentHash": "...",
      "evidenceHash": "..."
    }
  },
  "exemptions": []
}
```

`manifestHash` 只由上述确定性数据计算，不包含创建时间或随机请求 ID。正式快照 ID 由内容哈希、清单哈希和规则版本决定，所以同一确定状态不会因重复点击生成多个正式快照。

## 5. 预检与发布事务的取舍

### 方案 A：发布请求在一个数据库事务内完成所有工作

把正文规则、批注、权限、资源状态、外部资源扫描、快照写入和指针更新全部放入一个数据库事务。

- 优点：读集合一致性直观。
- 缺点：外部资源扫描耗时不可控，会长时间持有行锁，可能把连接池耗尽；事务内等待外部系统也难以解释“哪些检查已完成、哪些尚未完成”。

### 方案 B：只保存预检结果，发布时信任预检标记

预检成功后保存 `passed`，发布只比较文稿更新时间或版本号。

- 优点：实现简单。
- 缺点：正文未变但图片撤回、批注重开或权限变化时无法发现；外部迟到结果可能覆盖新版本状态；容易读到预检过程中写入的半套结果。

### 方案 C：预检收集外部证据，发布事务内原子重算（本项目采用）

预检阶段：

1. 捕获文稿版本、内容哈希、资源 ID 与资源版本；
2. 调用外部资源扫描器；
3. 扫描器返回后再次进入短事务；
4. 如果文稿或资源版本已变化，丢弃迟到结果并把本次校对记为 `stale`；
5. 若仍匹配，写入绑定 `(document_version, content_hash, resource_version)` 的资源证据；
6. 重算完整规则、依赖清单和 `manifestHash`。

发布阶段使用短的 `SERIALIZABLE` 事务：

```sql
BEGIN ISOLATION LEVEL SERIALIZABLE;

-- 请求幂等
SELECT response FROM idempotency_keys WHERE id = :request_id FOR UPDATE;

-- 锁定本次判断会读取的文稿、版本、资源、批注、权限和豁免行
SELECT ... FROM document_versions WHERE id = :current_version_id FOR UPDATE;
SELECT ... FROM resources      WHERE document_id = :doc_id FOR UPDATE;
SELECT ... FROM comments       WHERE document_id = :doc_id FOR UPDATE;
SELECT ... FROM permissions    WHERE document_id = :doc_id AND user_id = :user_id FOR UPDATE;
SELECT ... FROM exemptions     WHERE document_id = :doc_id FOR UPDATE;
SELECT ... FROM resource_checks WHERE document_id = :doc_id FOR UPDATE;

-- 后端在同一事务快照上执行确定性校验器：
-- 1) AST/标题/链接；
-- 2) 资源状态、说明和版本；
-- 3) resource_checks 的 content_hash/resource_version/status/evidence_hash；
-- 4) open 批注；
-- 5) 作者角色；
-- 6) 当前版本、规则版本、问题指纹匹配的豁免。
-- 任何 blocker 都会导致返回结构化失败并回滚快照写入。

INSERT INTO published_snapshots (...)
ON CONFLICT (document_id, content_hash, manifest_hash, rule_version)
DO UPDATE SET snapshot_id = published_snapshots.id
RETURNING id;

INSERT INTO validation_runs (...);
UPDATE publication_pointers
   SET snapshot_id = :snapshot_id, request_id = :request_id, published_at = now()
 WHERE document_id = :doc_id
   ON CONFLICT (document_id) DO UPDATE SET ...;

INSERT INTO idempotency_keys (...) ON CONFLICT (id) DO NOTHING;
COMMIT;
```

如果提交时发现并发依赖写入，数据库回滚序列化失败；服务端可在明确策略下使用同一个请求键重试，并重新执行完整检查。这个方案既不把不可控外部 I/O 放进发布事务，也不会信任旧的 `passed` 标记。

## 6. 状态语义

界面必须分开显示三种状态：

1. **内容已保存**：编辑区内容哈希等于当前草稿版本；
2. **校对通过**：最近校对记录的内容哈希和清单哈希都等于当前事务快照；
3. **已发布**：文稿的发布指针指向不可变快照，且该快照内容/清单是否仍对应当前状态单独显示。

依赖变化后，最近校对记录还可能存在，但 `manifestHash` 已不再匹配，因此状态显示为“校对已被依赖变化失效”，不能发布。

## 7. 测试矩阵

| 场景 | 预期 |
| --- | --- |
| 并发点击发布 | 文档级锁串行执行，同一幂等键返回同一结果，只生成一个快照 |
| 扫描后修改标题 | 捕获版本与当前版本不同，迟到资源结果丢弃，校对状态为 stale |
| 资源校验迟到 | 扫描窗口中资源版本变化，旧证据不写入；即使正文不变也需重新校对 |
| 图片撤回 | 正文未变仍产生 `resource.revoked`，发布失败 |
| 批注重开 | 旧通过失效，发布事务重新发现 open 批注 |
| 作者权限改变 | 旧通过失效，权限 blocker 不可豁免 |
| 任务重试 | 提交失败后无快照、无幂等记录；同一请求键重试安全 |
| 数据库中断 | 事务抛错并回滚，恢复后重新读取完整依赖 |
| 豁免新同类错误 | 指纹不同则不继承旧豁免 |
| 重复发布同一状态 | 快照 ID 相同，发布指针复用不可变快照 |

运行：

```bash
node --test test/publishing.test.js
npm run build
```

前端原型使用内存关系表模拟锁、事务、提交失败和连接中断；生产实现可按 `backend/schema.sql` 落到 PostgreSQL。
