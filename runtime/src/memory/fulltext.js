// FCA Local Runtime — FTS5 中文 bigram 全文索引（写入端预分词，bm25 排序）
import { tokenizeForIndex, tokenizedIndexText, buildFtsMatchExpression, tokenizeQuery } from '../core/text.js';

/**
 * 更新单条记忆的全文索引（事务内调用）。软删除记忆保留索引以便回收站搜索，
 * 硬删除时由 removeMemoryIndex 清理。
 */
export function indexMemory(db, memoryId, { title = '', body = '', tagNames = [] } = {}) {
  const row = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(memoryId);
  if (!row) {
    removeMemoryIndex(db, memoryId);
    return;
  }
  const rowid = row.rowid;
  db.prepare('DELETE FROM memory_fts WHERE rowid = ?').run(rowid);
  db.prepare('INSERT INTO memory_fts(rowid, memory_id, title, body, tags) VALUES(?,?,?,?,?)').run(
    rowid,
    memoryId,
    tokenizedIndexText(title),
    tokenizedIndexText(body),
    tagNames.map((t) => tokenizedIndexText(t)).join(' '),
  );
}

export function removeMemoryIndex(db, memoryId) {
  const row = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(memoryId);
  if (row) {
    db.prepare('DELETE FROM memory_fts WHERE rowid = ?').run(row.rowid);
  } else {
    // 记忆行已消失（硬删除后），按存储的 memory_id 扫描删除
    db.prepare('DELETE FROM memory_fts WHERE memory_id = ?').run(memoryId);
  }
}

/** 全量重建索引（迁移/导入后调用）。 */
export function rebuildFulltextIndex(db, { logger } = {}) {
  const started = Date.now();
  db.exec('DELETE FROM memory_fts');
  const rows = db
    .prepare(
      `SELECT m.rowid AS rowid, m.id AS id, m.title AS title, m.body AS body,
              (SELECT group_concat(t.name, ' ') FROM memory_tags mt JOIN tags t ON t.id = mt.tag_id
               WHERE mt.memory_id = m.id AND t.deleted_at IS NULL) AS tag_names
       FROM memories m`,
    )
    .all();
  const insert = db.prepare('INSERT INTO memory_fts(rowid, memory_id, title, body, tags) VALUES(?,?,?,?,?)');
  for (const row of rows) {
    insert.run(
      row.rowid,
      row.id,
      tokenizedIndexText(row.title),
      tokenizedIndexText(row.body),
      tokenizedIndexText(row.tag_names ?? ''),
    );
  }
  logger?.info?.('全文索引重建完成', { memories: rows.length, took_ms: Date.now() - started });
  return { indexed: rows.length, took_ms: Date.now() - started };
}

/**
 * 全文检索；返回 [{memory_id, score, matched_tokens}] + total。
 * filters 由 search.js 构建的 SQL 片段（作用在 memories 别名 m 上）。
 */
export function searchFulltext(db, query, { filters = { sql: '', params: [] }, limit = 50, offset = 0 } = {}) {
  const matchExpression = buildFtsMatchExpression(query);
  const tokens = tokenizeQuery(query);
  if (!matchExpression) return { hits: [], total: 0, tokens };
  const whereSql = filters.sql ? ` AND ${filters.sql}` : '';
  const baseFrom = `FROM memory_fts JOIN memories m ON m.rowid = memory_fts.rowid WHERE memory_fts MATCH ?${whereSql}`;
  const total = Number(db.prepare(`SELECT count(*) c ${baseFrom}`).get(matchExpression, ...filters.params)?.c ?? 0);
  const rows = db
    .prepare(
      `SELECT memory_fts.memory_id AS memory_id, bm25(memory_fts, 5.0, 1.0, 2.0) AS rank
       ${baseFrom}
       ORDER BY rank ASC, m.updated_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(matchExpression, ...filters.params, Number(limit), Number(offset));
  const hits = rows.map((r) => ({
    memory_id: r.memory_id,
    score: Math.round(-Number(r.rank) * 1e6) / 1e6,
    matched_tokens: tokens,
  }));
  return { hits, total, tokens };
}
