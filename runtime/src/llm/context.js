// FCA Local Runtime — LLM 最小上下文选择（ADR-007 §2）
// 约束：只在本地检索并筛选 top-K 记忆，按字段白名单 + 字符预算裁剪；
//       绝不整库/全日志/全关系图上传；上下文附带“数据来源与筛选说明”。
import { tokenizeQuery } from '../core/text.js';

export const CONTEXT_SOURCE_NOTE =
  '上下文由 FCA Runtime 在本地检索（FTS5 中文 bigram + 本地哈希语义 hybrid）后，按字段白名单与字符预算裁剪；' +
  '仅发送筛选后的最小记忆上下文，不发送整库数据库、全量日志或完整关系图。';

export const CONTEXT_FIELD_WHITELIST = Object.freeze(['title', 'body_excerpt', 'occurred_at', 'source_type', 'credibility', 'memory_type', 'tags']);

const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 20;
const MAX_TITLE_CHARS = 200;
const MAX_EXCERPT_CHARS = 1200;
const MIN_BUDGET = 500;

function truncate(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function pickQueryFromMessages(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message && message.role === 'user' && typeof message.content === 'string' && message.content.trim()) {
      return message.content.trim();
    }
  }
  return '';
}

/**
 * 选择最小上下文。
 * @param {{db:object, services:object, config:object, logger?:object}} deps
 * @param {{query?:string, memory_ids?:string[], top_k?:number, budget_chars?:number, use_context?:boolean}} options
 * @returns {{items:Array<object>, chars:number, selection:string, note:string, stats:object}}
 */
export function selectContext({ db, services, config, logger = null }, options = {}) {
  const topK = Math.min(MAX_TOP_K, Math.max(1, Number(options.top_k) || Number(config?.llmContextTopK) || DEFAULT_TOP_K));
  const budget = Math.max(MIN_BUDGET, Number(options.budget_chars) || Number(config?.llmContextBudgetChars) || 6000);
  const note = CONTEXT_SOURCE_NOTE;
  if (options.use_context === false) {
    return { items: [], chars: 0, selection: 'disabled', note: '本次请求显式关闭了记忆上下文（use_context=false）。', stats: { candidates: 0, selected: 0, chars: 0 } };
  }

  const explicitIds = Array.isArray(options.memory_ids) ? [...new Set(options.memory_ids.map(String))].slice(0, MAX_TOP_K * 2) : [];
  const query = typeof options.query === 'string' ? options.query.trim() : '';
  let candidates = [];
  let selection = 'none';

  if (explicitIds.length > 0) {
    selection = 'explicit_ids';
    const placeholders = explicitIds.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT id, title, body, memory_type, occurred_at, source_type, credibility FROM memories WHERE deleted_at IS NULL AND id IN (${placeholders})`)
      .all(...explicitIds);
    const byId = new Map(rows.map((row) => [row.id, row]));
    candidates = explicitIds.map((id) => byId.get(id)).filter(Boolean);
  } else if (query) {
    selection = 'local_hybrid_search';
    if (!tokenizeQuery(query).length) {
      selection = 'empty_query';
    } else {
      try {
        const result = services.search.search({ query, mode: 'hybrid', limit: topK, filters: { include_deleted: false } });
        candidates = result.items.map((item) => ({
          id: item.memory.id,
          title: item.memory.title,
          body: item.memory.body,
          memory_type: item.memory.memory_type,
          occurred_at: item.memory.occurred_at,
          source_type: item.memory.source?.type ?? null,
          credibility: item.memory.credibility,
          tag_names: item.memory.tag_names ?? [],
        }));
      } catch (err) {
        logger?.warn?.('LLM 上下文本地检索失败，按空上下文继续（不伪造记忆）', { error: err.message });
        candidates = [];
        selection = 'search_failed';
      }
    }
  }

  const items = [];
  let chars = 0;
  for (const candidate of candidates) {
    if (items.length >= topK) break;
    if (!candidate || !candidate.id) continue;
    const title = truncate(candidate.title ?? '', MAX_TITLE_CHARS);
    const remaining = budget - chars;
    if (remaining < 80) break;
    const excerptBudget = Math.max(0, Math.min(MAX_EXCERPT_CHARS, remaining - title.length - 80));
    const body = String(candidate.body ?? '');
    const excerpt = body.length > excerptBudget ? `${body.slice(0, excerptBudget)}…` : body;
    const item = {
      id: candidate.id,
      title,
      body_excerpt: excerpt,
      memory_type: candidate.memory_type ?? null,
      occurred_at: candidate.occurred_at ?? null,
      source_type: candidate.source_type ?? null,
      credibility: Number.isFinite(Number(candidate.credibility)) ? Number(candidate.credibility) : null,
      tags: Array.isArray(candidate.tag_names) ? candidate.tag_names.slice(0, 8) : [],
    };
    const cost = item.title.length + item.body_excerpt.length;
    if (items.length > 0 && chars + cost > budget) break;
    items.push(item);
    chars += cost;
  }

  return {
    items,
    chars,
    selection,
    note,
    stats: {
      candidates: candidates.length,
      selected: items.length,
      chars,
      budget_chars: budget,
      top_k: topK,
      fields: [...CONTEXT_FIELD_WHITELIST],
      query_used: query ? truncate(query, 500) : null,
    },
  };
}

/** 把最小上下文渲染为提示词片段（仅本地构造，不额外泄露内容）。 */
export function renderContextBlock(context) {
  if (!context || context.items.length === 0) {
    return `[相关记忆]\n（本次没有检索到可用记忆；不要编造记忆内容。）\n数据来源与筛选说明：${context?.note ?? CONTEXT_SOURCE_NOTE}`;
  }
  const lines = context.items.map((item, index) => {
    const meta = [
      item.memory_type ? `类型:${item.memory_type}` : null,
      item.occurred_at ? `时间:${item.occurred_at}` : null,
      item.source_type ? `来源:${item.source_type}` : null,
      item.credibility !== null && item.credibility !== undefined ? `可信度:${item.credibility}` : null,
      item.tags && item.tags.length ? `标签:${item.tags.join('/')}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    return `[${index + 1}] ${item.title}${meta ? `（${meta}）` : ''}\n${item.body_excerpt}`;
  });
  return `[相关记忆（本地检索结果，共 ${context.items.length} 条）]\n${lines.join('\n---\n')}\n数据来源与筛选说明：${context.note}`;
}

const DEFAULT_SYSTEM_PROMPT =
  '你是 FCA Memory Atlas 的本地记忆助手。请基于标注为“相关记忆”的本地检索结果谨慎回答；' +
  '不要编造记忆中不存在的事实；如果上下文不足，明确说明。回复语言跟随用户。';

/**
 * 组装真正发给 Provider 的 messages：注入 system 提示 + 最小上下文。
 * - 调用方给了 messages：合并其中的 system 消息到顶部，其余保序透传；
 * - 只给 query：构造 system + user 两条。
 */
export function composeChatMessages({ messages = null, query = '', context = null, system_prompt = null } = {}) {
  const contextBlock = context ? renderContextBlock(context) : '';
  let inputMessages = Array.isArray(messages) ? messages : [];
  const systemFromInput = inputMessages
    .filter((message) => message && message.role === 'system' && typeof message.content === 'string')
    .map((message) => message.content.trim())
    .filter(Boolean);
  inputMessages = inputMessages.filter((message) => message && message.role !== 'system');
  const userQuery = query && query.trim() ? query.trim() : pickQueryFromMessages(inputMessages);
  const systemParts = [
    typeof system_prompt === 'string' && system_prompt.trim() ? system_prompt.trim() : DEFAULT_SYSTEM_PROMPT,
    contextBlock,
    ...systemFromInput,
  ].filter(Boolean);
  const system = systemParts.join('\n\n');
  if (inputMessages.length > 0) {
    return [{ role: 'system', content: system }, ...inputMessages];
  }
  return [
    { role: 'system', content: system },
    { role: 'user', content: userQuery || '（无用户问题）' },
  ];
}

export { pickQueryFromMessages, DEFAULT_SYSTEM_PROMPT };
