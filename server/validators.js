'use strict';
const crypto = require('crypto');

function sha256(...parts) {
  return crypto.createHash('sha256').update(parts.join('')).digest('hex');
}

// 文稿语法（在现有 Catalpa/Markdown 基础上扩展）：
//   标题: # ~ ######
//   链接: [文字](目标)         目标为空或仅 '#' -> 空链接
//   资源: ![资源说明](asset://ID)  说明为空 -> 资源说明缺失（另核对资源表与撤回状态）
//   批注引用: {{comment:ID}}    对应批注处于打开状态 -> 阻断
const LINK_RE = /\[([^\]]*)\]\(([^)]*)\)/g;
const ASSET_RE = /!\[([^\]]*)\]\((asset:\/\/[A-Za-z0-9_.-]+)\)/g;
const COMMENT_RE = /\{\{comment:([A-Za-z0-9_-]+)\}\}/g;

function norm(s) { return String(s).replace(/\s+/g, ' ').trim(); }

/**
 * 纯函数校验：输入正文与资源/批注当前状态，输出逐项问题与依赖清单。
 */
function validateDocument({ body, assets, comments }) {
  const lines = String(body).split('\n');
  const issues = [];
  const manifest = {
    content: { headings: [], links: [], assetRefs: [], commentRefs: [] },
    assets: [],
    comments: [],
  };

  let prevLevel = 0;
  lines.forEach((rawLine, idx) => {
    const line = idx + 1;
    const text = rawLine;

    // 1) 标题层级
    const h = /^(#{1,6})\s+(.*\S)\s*$/.exec(text);
    if (h) {
      const level = h[1].length;
      const headingText = norm(h[2]);
      manifest.content.headings.push({ line, level, textHash: sha256('h', headingText) });
      if (prevLevel > 0 && level > prevLevel + 1) {
        issues.push({
          rule_code: 'heading.skip',
          line,
          ref_id: null,
          message: `标题层级跳跃：H${prevLevel} 之后直接出现 H${level}（应为 H${prevLevel + 1}）`,
          detail: { level, prevLevel, text: headingText },
          fingerprint: sha256('heading.skip', line, headingText),
        });
      }
      prevLevel = level;
    }

    // 2) 空链接
    let m;
    LINK_RE.lastIndex = 0;
    let linkIdx = 0;
    while ((m = LINK_RE.exec(text))) {
      const start = m.index;
      if (start > 0 && text[start - 1] === '!') continue;
      const label = m[1];
      const target = m[2];
      manifest.content.links.push({
        line, index: linkIdx, target, textHash: sha256('l', norm(label)),
      });
      if (target.trim() === '' || target.trim() === '#') {
        issues.push({
          rule_code: 'link.empty',
          line,
          ref_id: null,
          message: `空链接：「${label}」没有有效目标地址`,
          detail: { label, index: linkIdx },
          fingerprint: sha256('link.empty', line, linkIdx, norm(label)),
        });
      }
      linkIdx++;
    }

    // 3) 资源说明 + 撤回状态依赖
    ASSET_RE.lastIndex = 0;
    while ((m = ASSET_RE.exec(text))) {
      const alt = m[1];
      const assetId = m[2].slice('asset://'.length);
      const a = assets.get(assetId);
      const statusRev = a ? a.status_rev : 0;
      const withdrawnRev = a ? a.withdrawn_rev : 0;
      const withdrawn = a ? !!a.withdrawn : true;
      manifest.content.assetRefs.push({ line, assetId });
      manifest.assets.push({ assetId, statusRev, withdrawnRev, withdrawn });
      if (!norm(alt) || (a && !norm(a.description))) {
        issues.push({
          rule_code: 'asset.description',
          line,
          ref_id: assetId,
          message: !norm(alt)
            ? `资源 ${assetId} 缺少资源说明（alt/版权说明）`
            : `资源 ${assetId} 在资源库中缺少资源说明`,
          detail: { alt, exists: !!a },
          fingerprint: sha256('asset.description', assetId),
        });
      }
    }

    // 4) 打开的批注
    COMMENT_RE.lastIndex = 0;
    while ((m = COMMENT_RE.exec(text))) {
      const commentId = m[1];
      const c = comments.get(commentId);
      const statusRev = c ? c.status_rev : 0;
      const isOpen = c ? !!c.is_open : true;
      manifest.content.commentRefs.push({ line, commentId });
      manifest.comments.push({ commentId, statusRev, isOpen });
      if (isOpen) {
        issues.push({
          rule_code: 'comment.open',
          line,
          ref_id: commentId,
          message: `批注 ${commentId} 仍处于打开状态${c ? '：' + norm(c.anchor_text).slice(0, 24) : '（批注不存在）'}`,
          detail: { anchor: c ? c.anchor_text : null },
          fingerprint: sha256('comment.open', commentId),
        });
      }
    }
  });

  return { issues, manifest };
}

module.exports = { validateDocument, sha256 };
