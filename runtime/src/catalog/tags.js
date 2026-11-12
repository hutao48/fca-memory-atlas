// FCA Local Runtime — 标签服务（标签由记忆写入时隐式解析/创建，无独立公开写接口）
import { newId } from '../core/ids.js';
import { validationFailed } from '../core/errors.js';

const MAX_TAG_NAME = 100;
const MAX_TAGS_PER_MEMORY = 64;

function normalizeTagRef(ref) {
  if (typeof ref === 'string') {
    const name = ref.trim();
    if (!name) throw validationFailed([{ field: 'tags', message: '标签不能为空字符串' }]);
    if (name.length > MAX_TAG_NAME) throw validationFailed([{ field: 'tags', message: `标签名不得超过 ${MAX_TAG_NAME} 字符` }]);
    return { id: /^tag_[0-9a-f]{32}$/.test(name) ? name : null, name };
  }
  if (ref && typeof ref === 'object') {
    const id = typeof ref.id === 'string' ? ref.id : null;
    const name = typeof ref.name === 'string' ? ref.name.trim() : '';
    if (!id && !name) throw validationFailed([{ field: 'tags', message: '标签需要 id 或 name' }]);
    if (name.length > MAX_TAG_NAME) throw validationFailed([{ field: 'tags', message: `标签名不得超过 ${MAX_TAG_NAME} 字符` }]);
    return { id, name };
  }
  throw validationFailed([{ field: 'tags', message: '标签必须是字符串或 {id,name} 对象' }]);
}

export function createTagService({ dbHolder }) {
  function presentTag(row) {
    if (!row) return null;
    return { id: row.id, name: row.name, color: row.color ?? null };
  }

  function byId(db, id) {
    return db.prepare('SELECT * FROM tags WHERE id = ?').get(id) ?? null;
  }

  function byName(db, name) {
    return db.prepare('SELECT * FROM tags WHERE name = ? AND deleted_at IS NULL').get(name) ?? null;
  }

  /**
   * 确保标签存在（事务内调用）。返回 {tag, created}。
   */
  function ensureTx(db, ref) {
    const normalized = normalizeTagRef(ref);
    if (normalized.id) {
      const found = byId(db, normalized.id);
      if (found && !found.deleted_at) return { tag: found, created: false };
      if (found && found.deleted_at) {
        // 恢复已删除标签
        db.prepare('UPDATE tags SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(new Date().toISOString(), found.id);
        return { tag: byId(db, found.id), created: false };
      }
      if (!normalized.name) {
        throw validationFailed([{ field: 'tags', message: `标签不存在：${normalized.id}` }]);
      }
    }
    if (normalized.name) {
      const found = byName(db, normalized.name);
      if (found) return { tag: found, created: false };
    }
    const now = new Date().toISOString();
    const id = newId('tag');
    db.prepare('INSERT INTO tags(id, name, color, created_at, updated_at, version) VALUES(?,?,?,?,?,1)').run(
      id,
      normalized.name,
      null,
      now,
      now,
    );
    return { tag: byId(db, id), created: true };
  }

  /** 事务内批量确保标签，返回 tag 行数组（按输入顺序去重）。 */
  function ensureManyTx(db, refs) {
    if (refs === undefined || refs === null) return [];
    if (!Array.isArray(refs)) throw validationFailed([{ field: 'tags', message: 'tags 必须是数组' }]);
    if (refs.length > MAX_TAGS_PER_MEMORY) {
      throw validationFailed([{ field: 'tags', message: `标签数量不得超过 ${MAX_TAGS_PER_MEMORY}` }]);
    }
    const out = [];
    const seen = new Set();
    for (const ref of refs) {
      const { tag } = ensureTx(db, ref);
      if (seen.has(tag.id)) continue;
      seen.add(tag.id);
      out.push(tag);
    }
    return out;
  }

  function attachToMemoryTx(db, memoryId, tagRows) {
    db.prepare('DELETE FROM memory_tags WHERE memory_id = ?').run(memoryId);
    const stmt = db.prepare('INSERT OR IGNORE INTO memory_tags(memory_id, tag_id) VALUES(?,?)');
    for (const tag of tagRows) stmt.run(memoryId, tag.id);
  }

  /** 单条记忆的标签（响应含 tag 与 tag_names）。 */
  function forMemory(db, memoryId) {
    return db
      .prepare(
        `SELECT t.id, t.name, t.color FROM memory_tags mt
         JOIN tags t ON t.id = mt.tag_id
         WHERE mt.memory_id = ? AND t.deleted_at IS NULL
         ORDER BY t.name ASC`,
      )
      .all(memoryId);
  }

  /** 批量：memory_id -> tags 数组（供 graph/search 使用）。 */
  function forMemories(db, memoryIds) {
    const map = new Map();
    if (!memoryIds.length) return map;
    const placeholders = memoryIds.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT mt.memory_id, t.id, t.name, t.color FROM memory_tags mt
         JOIN tags t ON t.id = mt.tag_id
         WHERE mt.memory_id IN (${placeholders}) AND t.deleted_at IS NULL
         ORDER BY t.name ASC`,
      )
      .all(...memoryIds);
    for (const row of rows) {
      if (!map.has(row.memory_id)) map.set(row.memory_id, []);
      map.get(row.memory_id).push({ id: row.id, name: row.name, color: row.color ?? null });
    }
    return map;
  }

  function count(db) {
    return Number(db.prepare('SELECT count(*) c FROM tags WHERE deleted_at IS NULL').get()?.c ?? 0);
  }

  /**
   * 标签目录（带活跃记忆计数），供 Desktop 筛选器使用。
   * @param {{q?:string|null, limit?:number}} options
   */
  function catalog(db, { q = null, limit = 200 } = {}) {
    const parsedLimit = Math.min(500, Math.max(1, Number(limit) || 200));
    const where = ['t.deleted_at IS NULL'];
    const params = [];
    if (q) {
      where.push('t.name LIKE ?');
      params.push(`%${String(q).replace(/[%_]/g, (m) => `\\${m}`)}%`);
    }
    const rows = db
      .prepare(
        `SELECT t.id, t.name, t.created_at,
                (SELECT count(*) FROM memory_tags mt JOIN memories m ON m.id = mt.memory_id
                 WHERE mt.tag_id = t.id AND m.deleted_at IS NULL) AS count
         FROM tags t WHERE ${where.join(' AND ')}
         ORDER BY count DESC, t.name ASC LIMIT ?`,
      )
      .all(...params, parsedLimit);
    return rows.map((r) => ({ id: r.id, name: r.name, count: Number(r.count), created_at: r.created_at }));
  }

  return { presentTag, byId, byName, ensureTx, ensureManyTx, attachToMemoryTx, forMemory, forMemories, count, catalog };
}
