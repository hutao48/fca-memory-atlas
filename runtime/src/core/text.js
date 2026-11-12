// FCA Local Runtime — 文本归一化、中文 bigram 分词、摘要高亮
// 说明：node:sqlite 的 FTS5 可用；但 unicode61 对中文不分词，因此写入前先把文本
// 预分词为「中文 unigram+bigram / 拉丁单词」的空格分隔 token 串，再用 FTS5 索引。

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
const LATIN_CH_RE = /[a-z0-9]/;

/** NFKC + 小写归一化（长度不变，便于高亮定位）。 */
export function normalizeText(input) {
  const s = input === null || input === undefined ? '' : String(input);
  return s.normalize('NFKC').toLowerCase();
}

export function isCjkChar(ch) {
  return CJK_RE.test(ch);
}

/**
 * 索引分词：
 * - 连续 CJK 段：每个 unigram + 每个 bigram
 * - 拉丁/数字段：整词（含内部 _ -）
 * @param {string} input
 * @returns {string[]}
 */
export function tokenizeForIndex(input) {
  const norm = normalizeText(input);
  const tokens = [];
  let latin = '';
  const flushLatin = () => {
    if (latin) {
      tokens.push(latin);
      latin = '';
    }
  };
  let i = 0;
  while (i < norm.length) {
    const ch = norm[i];
    if (isCjkChar(ch)) {
      flushLatin();
      let j = i;
      while (j < norm.length && isCjkChar(norm[j])) j += 1;
      const run = norm.slice(i, j);
      for (let k = 0; k < run.length; k += 1) tokens.push(run[k]);
      for (let k = 0; k + 1 < run.length; k += 1) tokens.push(run.slice(k, k + 2));
      i = j;
    } else if (LATIN_CH_RE.test(ch) || ch === '_' || ch === '-') {
      latin += ch;
      i += 1;
    } else {
      flushLatin();
      i += 1;
    }
  }
  flushLatin();
  return tokens;
}

/** 去重 + 排序，保证索引字符串确定性。 */
export function tokenizedIndexText(input) {
  const tokens = tokenizeForIndex(input);
  return [...new Set(tokens)].sort().join(' ');
}

/**
 * 查询分词：中文段长度 >= 2 时只用 bigram（更精确），恰好 1 个字符时用 unigram；
 * 拉丁段整词。去重保持顺序。
 * @param {string} query
 * @returns {string[]}
 */
export function tokenizeQuery(query) {
  const norm = normalizeText(query);
  const tokens = [];
  let latin = '';
  const flushLatin = () => {
    if (latin) {
      tokens.push(latin);
      latin = '';
    }
  };
  let i = 0;
  while (i < norm.length) {
    const ch = norm[i];
    if (isCjkChar(ch)) {
      flushLatin();
      let j = i;
      while (j < norm.length && isCjkChar(norm[j])) j += 1;
      const run = norm.slice(i, j);
      if (run.length >= 2) {
        for (let k = 0; k + 1 < run.length; k += 1) tokens.push(run.slice(k, k + 2));
      } else {
        tokens.push(run);
      }
      i = j;
    } else if (LATIN_CH_RE.test(ch) || ch === '_' || ch === '-') {
      latin += ch;
      i += 1;
    } else {
      flushLatin();
      i += 1;
    }
  }
  flushLatin();
  return [...new Set(tokens)];
}

/** 构建 FTS5 MATCH 表达式：token 加引号 + OR 组合（bm25 负责排序）。 */
export function buildFtsMatchExpression(query) {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

/** 高亮用的命中子串：中文 token 为子串，拉丁 token 为整词（大小写不敏感）。 */
function findFirstHit(normText, tokens) {
  let best = null;
  for (const token of tokens) {
    let idx = normText.indexOf(token);
    if (idx === -1) continue;
    if (best === null || idx < best.index) best = { index: idx, token };
  }
  return best;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 生成高亮片段（<mark> 包裹命中词）。片段基于原文（保留用户原大小写）。
 * @returns {{field:string, snippet:string}|null}
 */
export function makeHighlight(text, tokens, { field = 'body', maxLen = 180, context = 60 } = {}) {
  if (!text || tokens.length === 0) return null;
  const norm = normalizeText(text);
  const hit = findFirstHit(norm, tokens);
  if (!hit) return null;
  const start = Math.max(0, hit.index - context);
  const end = Math.min(text.length, hit.index + hit.token.length + context);
  const prefix = (start > 0 ? '…' : '') + escapeHtml(text.slice(start, hit.index));
  const mark = `<mark>${escapeHtml(text.slice(hit.index, hit.index + hit.token.length))}</mark>`;
  const suffix = escapeHtml(text.slice(hit.index + hit.token.length, end)) + (end < text.length ? '…' : '');
  let snippet = prefix + mark + suffix;
  if (snippet.length > maxLen) snippet = snippet.slice(0, maxLen) + '…';
  return { field, snippet };
}

/** 简易 token 出现次数（用于语义/混合搜索的轻量词法加权）。 */
export function countTokenOverlap(text, tokens) {
  if (!text || !tokens || tokens.length === 0) return 0;
  const norm = normalizeText(text);
  let count = 0;
  for (const t of tokens) if (norm.includes(t)) count += 1;
  return count;
}

/** 去掉不适合日志/控制台输出的字符。 */
export function printable(input, maxLen = 200) {
  const s = String(input ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}
