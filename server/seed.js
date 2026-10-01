'use strict';
// 种子数据：一份演示文稿，故意包含四类问题各一个，便于界面逐项定位
function nowIso() { return new Date().toISOString(); }

function seed(db) {
  const count = db.prepare('SELECT COUNT(*) c FROM documents').get().c;
  if (count > 0) return;
  const ts = nowIso();
  db.prepare('INSERT INTO users(id,name,is_author,perm_rev) VALUES(?,?,1,1)').run('u1', '作者·林微');
  db.prepare("INSERT INTO rule_versions(version,is_active,note,created_at) VALUES('v1',1,'初始规则版：标题层级/空链接/批注/资源说明',?)").run(ts);

  const body = [
    '# Catalpa 使用指南',
    '',
    '## 一、简介',
    '',
    '本文介绍 Catalpa 文稿的基本写法，详见[官方站点]()。',
    '',
    '### 二、快速上手',
    '',
    '插入封面图：![封面](asset://cover.png)。正文配图：![架构示意：编辑器与预览](asset://arch.png)。',
    '',
    '请在发布前处理此处的评审意见 {{comment:c1}}。',
    '',
    '##### 三、语法',
    '',
    '- 标题、列表与链接',
    '- 资源必须附带说明',
  ].join('\n');

  db.prepare(`INSERT INTO documents(id,title,body,body_rev,perm_rev,author_user_id,active_rule_version,updated_at)
    VALUES('d1',?,?,1,1,'u1','v1',?)`).run('Catalpa 使用指南', body, ts);

  db.prepare(`INSERT INTO assets(id,document_id,description,withdrawn,status_rev,withdrawn_rev,updated_at)
    VALUES('cover.png','d1','',0,1,0,?)`).run(ts);                 // 缺说明
  db.prepare(`INSERT INTO assets(id,document_id,description,withdrawn,status_rev,withdrawn_rev,updated_at)
    VALUES('arch.png','d1','编辑器与预览架构示意图（CC BY）',0,1,0,?)`).run(ts);

  db.prepare(`INSERT INTO comments(id,document_id,anchor_text,is_open,status_rev,updated_at)
    VALUES('c1','d1','请在发布前处理此处的评审意见',1,1,?)`).run(ts);
}

module.exports = { seed };
