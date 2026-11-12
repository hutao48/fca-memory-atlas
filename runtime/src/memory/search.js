// FCA Local Runtime — 记忆搜索：fulltext(FTS5 bigram) / semantic(local-hash-v1) / hybrid
import { validationFailed } from '../core/errors.js';
import { makeHighlight, tokenizeQuery } from '../core/text.js';
import { presentMemory } from './present.js';
import { buildMemoryFilterSql, parsePagination, makeCursor } from './filters.js';
import { searchFulltext } from './fulltext.js';
import { searchSemantic, SEMANTIC_MODEL, embedQuery, ensureEmbeddings } from './semantic.js';

export const SEARCH_MODES = Object.freeze(['fulltext', 'semantic', 'hybrid']);
const MODE_SET = new Set(SEARCH_MODES);
const MAX_QUERY_LENGTH = 2000;
const HYBRID_CANDIDATES = 600;

export function createSearchService({ dbHolder, logger }) {
  function recentMemories(d, { filters, includeDeleted, limit, offset }) {
    const filter = buildMemoryFilterSql(filters, { includeDeleted });
    const where = filter.sql ? `WHERE ${filter.sql}` : '';
    const total = Number(d.prepare(`SELECT count(*) c FROM memories m ${where}`).get(...filter.params)?.c ?? 0);
    const rows = d
      .prepare(
        `SELECT * FROM memories m ${where}
         ORDER BY (occurred_at IS NULL) ASC, occurred_at DESC, updated_at DESC, id ASC
         LIMIT ? OFFSET ?`,
      )
      .all(...filter.params, limit, offset);
    return { rows, total };
  }

  function loadRows(d, ids) {
    if (ids.length === 0) return new Map();
    const placeholders = ids.map(() => '?').join(',');
    const rows = d.prepare(`SELECT * FROM memories m WHERE m.id IN (${placeholders})`).all(...ids);
    return new Map(rows.map((r) => [r.id, r]));
  }

  function presentHitItems(d, orderedHits, tokens) {
    const ids = orderedHits.map((h) => h.memory_id);
    const rows = loadRows(d, ids);
    const items = [];
    for (const hit of orderedHits) {
      const row = rows.get(hit.memory_id);
      if (!row) continue;
      const memory = presentMemory(d, row);
      const tagNames = memory.tag_names;
      const highlights = [];
      const titleHit = makeHighlight(memory.title, tokens, { field: 'title', maxLen: 120, context: 40 });
      if (titleHit) highlights.push(titleHit);
      const bodyHit = makeHighlight(memory.body, tokens, { field: 'body', maxLen: 200, context: 60 });
      if (bodyHit) highlights.push(bodyHit);
      for (const tagName of tagNames) {
        const tagHit = makeHighlight(tagName, tokens, { field: 'tags', maxLen: 80, context: 20 });
        if (tagHit) highlights.push(tagHit);
      }
      items.push({
        memory,
        score: hit.score,
        highlights,
        matched_by: hit.matched_by,
      });
    }
    return items;
  }

  /**
   * 搜索。
   * @param {{query?:string, mode?:string, filters?:object, limit?:number, cursor?:string|null, include_deleted?:boolean}} input
   */
  function search(input = {}) {
    const started = performance.now();
    const mode = input.mode ?? 'fulltext';
    if (!MODE_SET.has(mode)) throw validationFailed([{ field: 'mode', message: `必须是 ${SEARCH_MODES.join('|')}` }]);
    const query = input.query === undefined || input.query === null ? '' : String(input.query);
    if (query.length > MAX_QUERY_LENGTH) throw validationFailed([{ field: 'query', message: `查询不得超过 ${MAX_QUERY_LENGTH} 字符` }]);
    const filters = input.filters && typeof input.filters === 'object' && !Array.isArray(input.filters) ? { ...input.filters } : {};
    if (typeof input.include_deleted === 'boolean') filters.include_deleted = input.include_deleted;
    const includeDeleted = filters.include_deleted === true || filters.deleted_only === true;
    const { limit, offset } = parsePagination({ limit: input.limit, cursor: input.cursor });
    const d = dbHolder.requireDb();
    const filterSql = buildMemoryFilterSql(filters, { includeDeleted });
    const tokens = tokenizeQuery(query);
    const trimmedQuery = query.trim();

    if (!trimmedQuery) {
      const { rows, total } = recentMemories(d, { filters, includeDeleted, limit, offset });
      const items = rows.map((row) => ({ memory: presentMemory(d, row), score: 0, highlights: [], matched_by: ['recent'] }));
      return {
        items,
        next_cursor: offset + rows.length < total ? makeCursor(offset + rows.length) : null,
        total,
        took_ms: Math.round((performance.now() - started) * 1000) / 1000,
        mode: trimmedQuery ? mode : 'recent',
        engine: { fulltext: 'fts5-bigram-v1', semantic: SEMANTIC_MODEL },
      };
    }

    if (mode === 'fulltext') {
      const { hits, total } = searchFulltext(d, trimmedQuery, { filters: filterSql, limit, offset });
      return {
        items: presentHitItems(d, hits.map((h) => ({ ...h, matched_by: ['fulltext'] })), tokens),
        next_cursor: offset + hits.length < total ? makeCursor(offset + hits.length) : null,
        total,
        took_ms: Math.round((performance.now() - started) * 1000) / 1000,
        mode,
        engine: { fulltext: 'fts5-bigram-v1', semantic: SEMANTIC_MODEL },
      };
    }

    if (mode === 'semantic') {
      const { hits, total } = searchSemantic(d, trimmedQuery, { filters: filterSql, limit, offset, logger });
      return {
        items: presentHitItems(d, hits.map((h) => ({ ...h, matched_by: ['semantic'] })), tokens),
        next_cursor: offset + hits.length < total ? makeCursor(offset + hits.length) : null,
        total,
        took_ms: Math.round((performance.now() - started) * 1000) / 1000,
        mode,
        engine: { fulltext: 'fts5-bigram-v1', semantic: SEMANTIC_MODEL },
      };
    }

    // hybrid：fulltext + semantic 候选加权融合（各归一化后 0.6/0.4）
    ensureEmbeddings(d, { logger });
    const fulltextResult = searchFulltext(d, trimmedQuery, { filters: filterSql, limit: HYBRID_CANDIDATES, offset: 0 });
    const semanticResult = searchSemantic(d, trimmedQuery, { filters: filterSql, limit: HYBRID_CANDIDATES, offset: 0, logger });
    const ftMax = Math.max(1e-9, ...fulltextResult.hits.map((h) => h.score));
    const semMax = Math.max(1e-9, ...semanticResult.hits.map((h) => h.score));
    const combined = new Map();
    for (const hit of fulltextResult.hits) {
      combined.set(hit.memory_id, {
        memory_id: hit.memory_id,
        score: 0.6 * (hit.score / ftMax),
        matched_by: ['fulltext'],
        ft: hit.score / ftMax,
        sem: 0,
      });
    }
    for (const hit of semanticResult.hits) {
      const existing = combined.get(hit.memory_id);
      const semScore = hit.score / semMax;
      if (existing) {
        existing.score += 0.4 * semScore;
        existing.sem = semScore;
        existing.matched_by.push('semantic');
      } else {
        combined.set(hit.memory_id, {
          memory_id: hit.memory_id,
          score: 0.4 * semScore,
          matched_by: ['semantic'],
          ft: 0,
          sem: semScore,
        });
      }
    }
    const ranked = [...combined.values()]
      .map((h) => ({ ...h, score: Math.round(h.score * 1e6) / 1e6 }))
      .sort((a, b) => (b.score - a.score) || a.memory_id.localeCompare(b.memory_id));
    const total = ranked.length;
    const page = ranked.slice(offset, offset + limit);
    return {
      items: presentHitItems(d, page, tokens),
      next_cursor: offset + page.length < total ? makeCursor(offset + page.length) : null,
      total,
      took_ms: Math.round((performance.now() - started) * 1000) / 1000,
      mode,
      engine: { fulltext: 'fts5-bigram-v1', semantic: SEMANTIC_MODEL },
      candidates: { fulltext: fulltextResult.hits.length, semantic: semanticResult.hits.length },
    };
  }

  return { search, SEARCH_MODES };
}
