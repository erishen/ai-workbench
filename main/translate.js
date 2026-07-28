const { parse } = require('node-html-parser');
const { chatCompletion } = require('./llm');

// 语种名映射（用于显式告知模型翻译方向，避免模型自行判断导致漏译）
const LANG_NAME = { zh: 'Chinese', en: 'English' };

// 显式指定「从 srcLang 全量译成 tgtLang」，并强调逐句翻译、不得跳过
function buildSystemPrompt(srcLang, tgtLang) {
  const src = LANG_NAME[srcLang] || 'the source language';
  const tgt = LANG_NAME[tgtLang] || 'Chinese';
  return `You are a professional translator. Translate the ENTIRE text below from ${src} into ${tgt}. Output ONLY the ${tgt} translation — no explanation, no notes, no commentary. Preserve the original structure, paragraph breaks, Markdown formatting, code blocks, URLs, and proper nouns. Translate EVERY sentence; do NOT leave any part of the input untranslated.`;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

// 提取页面正文文本：先剔除噪音节点，再定位正文容器（文章主体），只取正文
function extractText(html) {
  const root = parse(html);

  // 1) 删除明显非正文的噪音节点（标签 + 广告/侧边栏/评论等类名/ID）
  const NOISE_TAGS = ['script', 'style', 'noscript', 'svg', 'head', 'nav', 'footer', 'header', 'form', 'iframe', 'aside', 'button'];
  const NOISE_CLASS = /(^|[\s-_])(ad|ads|advert|sidebar|widget|comment|comments|reply|popup|modal|banner|cookie|promo|recommend|related|share|social|newsletter|toc|tableofcontents)([\s-_]|$)/i;
  root.querySelectorAll('*').forEach((n) => {
    const tag = (n.tagName || '').toLowerCase();
    if (NOISE_TAGS.includes(tag)) {
      n.remove();
      return;
    }
    const cls = `${(n.getAttribute('class') || '').toLowerCase()} ${(n.getAttribute('id') || '').toLowerCase()}`;
    if (NOISE_CLASS.test(cls)) n.remove();
  });

  // 2) 定位正文容器（只翻译文章主体，无关内容已剔除）
  const container = findContentRoot(root) || root.querySelector('body') || root;

  // 3) 在容器内下钻到散文块（含 <p> 最多的后代），排除 byline/标签/版权等兄弟节点
  const proseEl = findProseBlock(container) || container;

  // 4) 标题若不在散文块内，则前置保留（避免把文章标题也裁掉）
  let raw = proseEl.text || '';
  const titleEl = container.querySelector('h1, h2');
  const hasOwnTitle = proseEl.querySelector('h1, h2');
  if (titleEl && !hasOwnTitle) {
    raw = `${(titleEl.text || '').trim()}\n\n${raw}`;
  }

  const text = decodeEntities(raw);
  // 5) 清理：按行去噪，并剔除头尾样板短句（版权/日期/作者/分享/标签/相关等）
  return cleanLines(text);
}

// 在正文容器内定位真正的散文块：含 <p> 文本最多的后代元素
function findProseBlock(container) {
  let best = null;
  let bestLen = 0;
  container.querySelectorAll('div, section, article, main').forEach((el) => {
    let len = 0;
    el.querySelectorAll('p').forEach((p) => {
      len += (p.text || '').trim().length;
    });
    if (len > bestLen) {
      bestLen = len;
      best = el;
    }
  });
  return bestLen > 50 ? best : null;
}

// 按行清理并剔除头尾无关样板短句（中英文模式 + 长度判定）
function cleanLines(text) {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const EN_BOILER = /(©|copyright|all rights reserved|published|updated on|posted on|\bby\s|author|share|follow|subscribe|sign ?up|newsletter|read more|next (post|article|story)|related|tags?:|category:|advert(isement)?|cookie|privacy policy|terms of (use|service)|menu|skip to content|search|login|register|more stories|comments?|leave a comment|written by|photo:|image:|source:|home)/i;
  const CN_BOILER = /(作者|发布于|发表于|更新于|来源[:：]|版权|转载|分享|关注|订阅|标签[:：]|分类[:：]|上一篇|下一篇|相关阅读|相关推荐|热门|评论|免责声明|阅读原文|责编|编辑[:：]|图源|摄影|出品|首页|登录|注册)/;
  const DATE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d{1,2}|\d{1,2}\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}/i;
  const isBoiler = (s) => EN_BOILER.test(s) || CN_BOILER.test(s) || DATE.test(s) || s.length < 4;

  let start = 0;
  while (start < lines.length && isBoiler(lines[start])) start++;
  let end = lines.length - 1;
  while (end > start && isBoiler(lines[end])) end--;
  // 若整篇都被判定为样板（极端情况），退回原样，避免清空
  if (start > end) return lines.join('\n');
  return lines.slice(start, end + 1).join('\n');
}

// 定位最可能为正文的容器：优先语义标签，再按 content 类名，最后按文本量评分
function findContentRoot(root) {
  for (const sel of ['article', 'main']) {
    const el = root.querySelector(sel);
    if (el && (el.text || '').trim().length > 200) return el;
  }
  const roleMain = root.querySelector('[role="main"]');
  if (roleMain && (roleMain.text || '').trim().length > 200) return roleMain;

  const CONTENT_HINT = /(article|post|content|entry|markdown|body|story|news|blog|text|main|read)/i;
  let best = null;
  let bestLen = 0;
  root.querySelectorAll('div, section, article, main').forEach((el) => {
    const cls = `${(el.getAttribute('class') || '').toLowerCase()} ${(el.getAttribute('id') || '').toLowerCase()}`;
    if (!CONTENT_HINT.test(cls)) return;
    const len = (el.text || '').trim().length;
    if (len > bestLen) {
      bestLen = len;
      best = el;
    }
  });
  if (best && bestLen > 200) return best;

  // 兜底：所有块级容器里文本最多的
  let fbBest = null;
  let fbLen = 0;
  root.querySelectorAll('div, section, article').forEach((el) => {
    const len = (el.text || '').trim().length;
    if (len > fbLen) {
      fbLen = len;
      fbBest = el;
    }
  });
  return fbBest;
}

// 语种检测：CJK 字符占比超过阈值判定为中文
function detectLang(text) {
  const cjk = (text.match(/[一-鿿]/g) || []).length;
  const total = text.replace(/\s/g, '').length || 1;
  return cjk / total > 0.1 ? 'zh' : 'en';
}

// 按段落分块，避免单次翻译超出上下文窗口；单段超长时按句子再切
function chunkText(text, max = 3000) {
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let cur = '';
  const flush = () => {
    if (cur) {
      chunks.push(cur);
      cur = '';
    }
  };

  for (const p of paras) {
    if (p.length > max) {
      // 单段超长：先 flush 已有内容，再按句子切分
      flush();
      for (const piece of splitBySentences(p, max)) chunks.push(piece);
      continue;
    }
    if (cur && (cur + '\n\n' + p).length > max) {
      flush();
      cur = p;
    } else {
      cur = cur ? cur + '\n\n' + p : p;
    }
  }
  flush();
  return chunks.length ? chunks : [text];
}

// 单段超长时按句子切分（中英文句末标点 / 换行），极端情况再硬截断兜底
function splitBySentences(p, max) {
  const pieces = p.split(/([。.!?！？\n])/);
  const sents = [];
  let buf = '';
  for (const piece of pieces) {
    buf += piece;
    if (/[。.!?！？\n]/.test(piece)) {
      sents.push(buf);
      buf = '';
    }
  }
  if (buf) sents.push(buf);

  const out = [];
  let cur = '';
  for (const s of sents) {
    if (cur && (cur + s).length > max) {
      out.push(cur);
      cur = s;
    } else {
      cur = cur ? cur + s : s;
    }
  }
  if (cur) out.push(cur);

  // 兜底：连单个句子都超过 max，直接按字符硬截断
  return out.flatMap((c) => {
    if (c.length <= max) return [c];
    const hard = [];
    for (let i = 0; i < c.length; i += max) hard.push(c.slice(i, i + max));
    return hard;
  });
}

// 翻译单个 URL 指向的页面
// creds = { baseURL, apiKey, model }（由上层按所选模型配置解析；不传则用主配置）
// onProgress(entry) 用于把过程日志回传给渲染进程做展示
async function translateUrl(url, creds, onProgress) {
  const emit = (level, msg, extra = {}) => {
    if (onProgress) onProgress({ ts: Date.now(), level, msg, ...extra });
  };
  // 累计 token 消耗（输入/输出/合计），供统计展示
  const usageSum = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const addUsage = (u) => {
    if (!u) return;
    usageSum.promptTokens += u.promptTokens || 0;
    usageSum.completionTokens += u.completionTokens || 0;
    usageSum.totalTokens += u.totalTokens || 0;
  };

  // 协议白名单：仅允许 http/https，避免 file:// / 内网等非预期 URL 经 fetch 读取
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    emit('error', 'URL 格式无效');
    throw new Error(`URL 格式无效：${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    emit('error', `仅支持 http/https 协议（收到 ${parsed.protocol}）`);
    throw new Error(`仅支持 http/https 协议的 URL（收到 ${parsed.protocol}）`);
  }
  emit('info', `开始抓取页面：${url}`);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TranslateAgent/1.0)' },
  });
  if (!res.ok) {
    emit('error', `页面抓取失败 HTTP ${res.status}`);
    throw new Error(`页面抓取失败 HTTP ${res.status} (${url})`);
  }
  const html = await res.text();
  emit('success', `抓取成功 HTTP ${res.status}，得到 ${html.length} 字节 HTML`);

  const text = extractText(html);
  if (!text.trim()) {
    emit('error', '未能从页面提取到可读文本');
    throw new Error('未能从页面提取到可读文本');
  }
  emit('success', `提取正文 ${text.length} 字符（已剔除脚本/侧边栏/评论/byline/标签/版权等，仅保留正文）`);

  const lang = detectLang(text);
  const target = lang === 'zh' ? 'en' : 'zh';
  const langName = lang === 'zh' ? '中文' : '英文';
  const targetName = target === 'en' ? '英文' : '中文';
  emit('info', `语种检测：${langName} → 目标 ${targetName}`);

  // 显式翻译方向提示词（不再让模型自行判断语种，避免漏译）
  const systemPrompt = buildSystemPrompt(lang, target);

  const chunks = chunkText(text);
  emit('info', `按段落/句子分块，共 ${chunks.length} 块（每块 ≤ 3000 字符）`);

  let out = '';
  for (let i = 0; i < chunks.length; i++) {
    emit('info', `翻译第 ${i + 1}/${chunks.length} 段（${chunks[i].length} 字符）`, {
      index: i + 1,
      total: chunks.length,
    });
    const r1 = await chatCompletion({
      baseURL: creds.baseURL,
      apiKey: creds.apiKey,
      model: creds.model,
      proxy: creds.proxy,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: chunks[i] },
      ],
      onLog: (entry) => emit(entry.level, entry.msg),
    });
    addUsage(r1.usage);
    let content = r1.content.trim();
    // 校验：目标为中文但译文仍被判定为英文（模型未真正翻译）→ 强制重试一次
    if (target === 'zh' && detectLang(content) === 'en') {
      emit('info', `第 ${i + 1} 段译文仍为英文，强制重试一次`);
      const forced = `${systemPrompt}\n\nIMPORTANT: The input is in English. Output ONLY the Chinese translation and nothing else.`;
      const r2 = await chatCompletion({
        baseURL: creds.baseURL,
        apiKey: creds.apiKey,
        model: creds.model,
        proxy: creds.proxy,
        messages: [
          { role: 'system', content: forced },
          { role: 'user', content: chunks[i] },
        ],
        onLog: (entry) => emit(entry.level, entry.msg),
      });
      addUsage(r2.usage);
      content = r2.content.trim();
    }
    out += (i > 0 ? '\n\n' : '') + content;
    emit('success', `第 ${i + 1}/${chunks.length} 段翻译完成`, {
      index: i + 1,
      total: chunks.length,
      usage: { ...usageSum },
    });
    if (usageSum.totalTokens > 0) {
      emit('token', `累计 token 消耗：输入 ${usageSum.promptTokens} / 输出 ${usageSum.completionTokens} / 合计 ${usageSum.totalTokens}`);
    }
  }

  emit('success', `翻译完成，共生成 ${out.length} 字符译文`);
  return { lang, target, translated: out, url, chars: text.length, usage: { ...usageSum } };
}

module.exports = { extractText, detectLang, chunkText, translateUrl };
