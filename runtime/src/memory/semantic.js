// FCA Local Runtime — 本地确定性哈希 embedding（local-hash-v1）+ 余弦相似度
// 明确标注：这不是神经语义模型，而是零依赖、离线、确定性的词法哈希向量，
// 仅提供近似的语义/词法混合检索能力（契约要求 semantic 可选且不依赖外部服务）。
import { tokenizeForIndex } from '../core/text.js';

export const SEMANTIC_MODEL = 'local-hash-v1';
export const EMBEDDING_DIM = 256;
const MAX_BODY_CHARS = 8_000;

function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function addText(vec, text, weight) {
  if (!text) return;
  const counts = new Map();
  for (const token of tokenizeForIndex(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
  for (const [token, count] of counts) {
    const idx = fnv1a32(token) % EMBEDDING_DIM;
    const sign = fnv1a32(`${token}#`) & 1 ? 1 : -1;
    const tf = 1 + Math.log(count);
    vec[idx] += sign * weight * tf;
  }
}

function normalize(vec) {
  let norm = 0;
  for (let i = 0; i < vec.length; i += 1) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i += 1) vec[i] /= norm;
  }
  return vec;
}

/**
 * 记忆 embedding：title 权重 2、tags 权重 1.5、body 权重 1（截断前 8000 字符）。
 * @returns {Float32Array}
 */
export function embedMemory({ title = '', body = '', tagNames = [] } = {}) {
  const vec = new Float32Array(EMBEDDING_DIM);
  addText(vec, title, 2.0);
  for (const tag of tagNames) addText(vec, tag, 1.5);
  addText(vec, String(body ?? '').slice(0, MAX_BODY_CHARS), 1.0);
  return normalize(vec);
}

/** 查询 embedding：与记忆同一 token 空间，权重 1。 */
export function embedQuery(query) {
  const vec = new Float32Array(EMBEDDING_DIM);
  addText(vec, String(query ?? ''), 1.0);
  return normalize(vec);
}

export function encodeVector(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function decodeVector(buf) {
  const copy = Buffer.from(buf);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/** 更新单条记忆的 embedding（事务内调用）。 */
export function upsertEmbedding(db, memoryId, { title, body, tagNames }) {
  const vec = embedMemory({ title, body, tagNames });
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO memory_embeddings(memory_id, dim, model, vec, updated_at) VALUES(?,?,?,?,?)
     ON CONFLICT(memory_id) DO UPDATE SET dim=excluded.dim, model=excluded.model, vec=excluded.vec, updated_at=excluded.updated_at`,
  ).run(memoryId, EMBEDDING_DIM, SEMANTIC_MODEL, encodeVector(vec), now);
  return vec;
}

export function removeEmbedding(db, memoryId) {
  db.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?').run(memoryId);
}

/**
 * 为缺失 embedding 的记忆补算（事务内）。返回补算数量。
 */
export function ensureEmbeddings(db, { logger } = {}) {
  const rows = db
    .prepare(
      `SELECT m.id, m.title, m.body,
              (SELECT group_concat(t.name, ' ') FROM memory_tags mt JOIN tags t ON t.id = mt.tag_id
               WHERE mt.memory_id = m.id AND t.deleted_at IS NULL) AS tag_names
       FROM memories m
       LEFT JOIN memory_embeddings me ON me.memory_id = m.id AND me.model = ?
       WHERE me.memory_id IS NULL`,
    )
    .all(SEMANTIC_MODEL);
  let computed = 0;
  for (const row of rows) {
    upsertEmbedding(db, row.id, { title: row.title, body: row.body, tagNames: row.tag_names ? row.tag_names.split(' ') : [] });
    computed += 1;
  }
  if (computed > 0) logger?.debug?.('补齐 semantic embedding', { count: computed, model: SEMANTIC_MODEL });
  return computed;
}

export function rebuildEmbeddings(db, { logger } = {}) {
  const started = Date.now();
  db.exec('DELETE FROM memory_embeddings');
  const count = ensureEmbeddings(db, { logger });
  logger?.info?.('语义索引重建完成', { memories: count, model: SEMANTIC_MODEL, took_ms: Date.now() - started });
  return { indexed: count, took_ms: Date.now() - started, model: SEMANTIC_MODEL };
}

/**
 * 语义检索：对带 filters 的记忆全集计算余弦相似度。
 * @returns {{hits: Array<{memory_id:string, score:number}>, total:number}}
 */
export function searchSemantic(db, query, { filters = { sql: '', params: [] }, limit = 50, offset = 0, logger } = {}) {
  ensureEmbeddings(db, { logger });
  const queryVec = embedQuery(query);
  let hasSignal = false;
  for (let i = 0; i < queryVec.length; i += 1) {
    if (queryVec[i] !== 0) {
      hasSignal = true;
      break;
    }
  }
  const whereParts = ["me.model = 'local-hash-v1'"];
  if (filters.sql) whereParts.push(`(${filters.sql})`);
  const rows = db
    .prepare(
      `SELECT me.memory_id AS memory_id, me.vec AS vec FROM memory_embeddings me
       JOIN memories m ON m.id = me.memory_id
       WHERE ${whereParts.join(' AND ')}`,
    )
    .all(...filters.params);
  const scored = [];
  if (hasSignal) {
    for (const row of rows) {
      const score = cosineSimilarity(queryVec, decodeVector(row.vec));
      if (score > 0) scored.push({ memory_id: row.memory_id, score: Math.round(score * 1e6) / 1e6 });
    }
  }
  scored.sort((a, b) => (b.score - a.score) || a.memory_id.localeCompare(b.memory_id));
  return { hits: scored.slice(Number(offset), Number(offset) + Number(limit)), total: scored.length, tokens: [], model: SEMANTIC_MODEL };
}
