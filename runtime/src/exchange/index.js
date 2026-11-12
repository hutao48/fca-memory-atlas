// FCA Local Runtime — FCA 自有格式导入/导出（JSON / JSONL / ZIP）
import fs from 'node:fs';
import path from 'node:path';
import { newId } from '../core/ids.js';
import { nowIso } from '../core/time.js';
import { validationFailed, badRequest, notFound, importFailed } from '../core/errors.js';
import { writeZip, readZip } from './zip.js';
import { presentMemory, presentVersion, presentLayoutNode, presentLayoutView } from '../memory/present.js';
import { buildMemoryFilterSql } from '../memory/filters.js';
import { bumpLayoutVersion, getUserVersion } from '../persistence/db.js';
import { isIsoDate } from '../core/time.js';

const FORMATS = new Set(['json', 'jsonl', 'zip']);
const EXPORT_FORMAT = 'fca-export';
const EXPORT_FORMAT_VERSION = '1.0';

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function readBodyFile(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch (err) {
    throw importFailed(`无法读取导入文件：${filePath}（${err.message}）`);
  }
}

/** ZIP 解析失败必须是 422 IMPORT_FAILED，而不是未归一化的 INTERNAL 500。 */
function readZipSafe(buffer) {
  try {
    return readZip(buffer);
  } catch (err) {
    throw importFailed(`ZIP 解析失败：${err.message}`);
  }
}

/** 导入过程中的 JSON 解析失败同样必须归一化为 422 IMPORT_FAILED。 */
function parseJsonSafe(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw importFailed(`${label} 不是合法 JSON`);
  }
}

/** 深度把旧 ID 替换为新 ID（用于版本快照等嵌套结构）。 */
function remapDeep(value, idMap) {
  if (typeof value === 'string') return idMap.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => remapDeep(item, idMap));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = remapDeep(v, idMap);
    return out;
  }
  return value;
}

export function createExchangeService({ dbHolder, config, logger, memory, entities, relations, identity, cognition, events }) {
  function presentTagRow(row) {
    return { id: row.id, name: row.name, color: row.color ?? null };
  }

  function collectBundle({ filters = null } = {}) {
    const d = dbHolder.requireDb();
    let memoryRows;
    if (filters && Object.keys(filters).length > 0) {
      const filter = buildMemoryFilterSql(filters, { includeDeleted: filters.include_deleted === true });
      const where = filter.sql ? `WHERE ${filter.sql}` : '';
      memoryRows = d.prepare(`SELECT * FROM memories m ${where}`).all(...filter.params);
    } else {
      memoryRows = d.prepare('SELECT * FROM memories').all();
    }
    const memoryIds = new Set(memoryRows.map((r) => r.id));
    const entityRows = d.prepare('SELECT * FROM entities').all();
    const relationRows = d
      .prepare('SELECT * FROM relations')
      .all()
      .filter((r) => {
        const fromOk = r.from_kind === 'memory' ? memoryIds.has(r.from_id) : true;
        const toOk = r.to_kind === 'memory' ? memoryIds.has(r.to_id) : true;
        return fromOk && toOk;
      });
    const tagRows = d.prepare('SELECT * FROM tags').all();
    const versionRows = d.prepare('SELECT * FROM memory_versions ORDER BY memory_id ASC, version ASC').all();
    const layoutNodeRows = d
      .prepare('SELECT * FROM layout_nodes')
      .all()
      .filter((r) => (r.node_kind === 'memory' ? memoryIds.has(r.node_id) : true));
    const layoutViewRows = d.prepare('SELECT * FROM layout_views').all();
    const counts = {
      memories: memoryRows.length,
      entities: entityRows.length,
      relations: relationRows.length,
      tags: tagRows.length,
      versions: versionRows.length,
      layout_nodes: layoutNodeRows.length,
      layout_views: layoutViewRows.length,
    };
    return {
      format: EXPORT_FORMAT,
      format_version: EXPORT_FORMAT_VERSION,
      api_version: config.apiVersion,
      product_version: config.productVersion,
      exported_at: nowIso(),
      exported_from_schema_version: getUserVersion(d),
      counts,
      data: {
        memories: memoryRows.map((row) => presentMemory(d, row)),
        entities: entityRows.map((row) => entities.presentEntity(row)),
        relations: relationRows.map((row) => relations.presentRelation(row)),
        tags: tagRows.map(presentTagRow),
        versions: versionRows.map(presentVersion),
        layout_nodes: layoutNodeRows.map(presentLayoutNode),
        layout_views: layoutViewRows.map(presentLayoutView),
        identity: identity.get(),
        cognition: cognition.get(),
      },
    };
  }

  function jsonlLines(bundle) {
    const lines = [];
    const header = { kind: 'manifest', ...bundle };
    delete header.data;
    lines.push(JSON.stringify(header));
    const push = (kind, items) => {
      for (const item of items) lines.push(JSON.stringify({ kind, data: item }));
    };
    push('tag', bundle.data.tags);
    push('entity', bundle.data.entities);
    push('relation', bundle.data.relations);
    push('memory', bundle.data.memories);
    push('version', bundle.data.versions);
    push('layout_node', bundle.data.layout_nodes);
    push('layout_view', bundle.data.layout_views);
    if (bundle.data.identity) lines.push(JSON.stringify({ kind: 'identity', data: bundle.data.identity }));
    if (bundle.data.cognition) lines.push(JSON.stringify({ kind: 'cognition', data: bundle.data.cognition }));
    return lines;
  }

  function serialize(bundle, format) {
    if (format === 'json') return Buffer.from(JSON.stringify(bundle, null, 2), 'utf8');
    if (format === 'jsonl') return Buffer.from(`${jsonlLines(bundle).join('\n')}\n`, 'utf8');
    if (format === 'zip') {
      const lines = jsonlLines(bundle);
      const header = JSON.parse(lines[0]);
      const zipEntries = [{ name: 'manifest.json', data: Buffer.from(JSON.stringify(header, null, 2), 'utf8') }];
      const group = (kind) => lines.slice(1).map((l) => JSON.parse(l)).filter((r) => r.kind === kind).map((r) => JSON.stringify(r));
      for (const [kind, fileName] of [
        ['tag', 'tags.jsonl'],
        ['entity', 'entities.jsonl'],
        ['relation', 'relations.jsonl'],
        ['memory', 'memories.jsonl'],
        ['version', 'versions.jsonl'],
        ['layout_node', 'layout_nodes.jsonl'],
        ['layout_view', 'layout_views.jsonl'],
      ]) {
        const items = group(kind);
        zipEntries.push({ name: fileName, data: Buffer.from(items.length ? `${items.join('\n')}\n` : '', 'utf8') });
      }
      const identityRec = lines.slice(1).map((l) => JSON.parse(l)).find((r) => r.kind === 'identity');
      const cognitionRec = lines.slice(1).map((l) => JSON.parse(l)).find((r) => r.kind === 'cognition');
      zipEntries.push({ name: 'identity.json', data: Buffer.from(JSON.stringify(identityRec?.data ?? null), 'utf8') });
      zipEntries.push({ name: 'cognition.json', data: Buffer.from(JSON.stringify(cognitionRec?.data ?? null), 'utf8') });
      return writeZip(zipEntries);
    }
    throw validationFailed([{ field: 'format', message: `必须是 ${[...FORMATS].join('|')}` }]);
  }

  function exportData(input = {}, meta = {}) {
    if (input && typeof input !== 'object') throw badRequest('export body 必须是 JSON 对象');
    const format = input.format ?? 'json';
    if (!FORMATS.has(format)) throw validationFailed([{ field: 'format', message: `必须是 ${[...FORMATS].join('|')}` }]);
    const filters = input.filters && typeof input.filters === 'object' ? input.filters : null;
    const bundle = collectBundle({ filters });
    const buffer = serialize(bundle, format);
    let targetPath;
    if (input.path !== undefined && input.path !== null) {
      if (typeof input.path !== 'string' || !input.path.trim()) {
        throw badRequest('export.path 必须是非空字符串');
      }
      targetPath = path.isAbsolute(input.path) ? input.path : path.join(config.paths.exportsDir, input.path);
    } else {
      const ext = format === 'zip' ? 'zip' : format;
      targetPath = path.join(config.paths.exportsDir, `fca-export-${stamp()}.${ext}`);
    }
    try {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, buffer);
    } catch (err) {
      throw importFailed(`导出文件写入失败：${err.message}`);
    }
    logger?.info?.('导出完成', { path: targetPath, format, size: buffer.length, memories: bundle.counts.memories });
    return {
      path: targetPath,
      format,
      size: buffer.length,
      counts: bundle.counts,
      created_at: bundle.exported_at,
      api_version: config.apiVersion,
      product_version: config.productVersion,
    };
  }

  function parseLinesToRecords(lines) {
    let header = null;
    const records = { memories: [], entities: [], relations: [], tags: [], versions: [], layout_nodes: [], layout_views: [], identity: null, cognition: null };
    const push = (kind, data) => {
      switch (kind) {
        case 'memory': records.memories.push(data); break;
        case 'entity': records.entities.push(data); break;
        case 'relation': records.relations.push(data); break;
        case 'tag': records.tags.push(data); break;
        case 'version': records.versions.push(data); break;
        case 'layout_node': records.layout_nodes.push(data); break;
        case 'layout_view': records.layout_views.push(data); break;
        case 'identity': records.identity = data; break;
        case 'cognition': records.cognition = data; break;
        default: break;
      }
    };
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw importFailed('JSONL 行格式损坏（无法解析 JSON）');
      }
      if (parsed.kind === 'manifest') header = parsed;
      else if (parsed.kind && parsed.data !== undefined) push(parsed.kind, parsed.data);
      else if (parsed.format === EXPORT_FORMAT) header = parsed;
    }
    return { header, records };
  }

  function recordsFromJsonBundle(bundle) {
    if (!bundle || typeof bundle !== 'object') throw importFailed('导入数据不是合法 JSON 对象');
    if (bundle.format !== EXPORT_FORMAT) {
      throw importFailed('仅支持 FCA 自身导出格式（format="fca-export"）；禁止导入旧记忆系统格式');
    }
    const data = bundle.data ?? {};
    return {
      header: bundle,
      records: {
        memories: data.memories ?? [],
        entities: data.entities ?? [],
        relations: data.relations ?? [],
        tags: data.tags ?? [],
        versions: data.versions ?? [],
        layout_nodes: data.layout_nodes ?? [],
        layout_views: data.layout_views ?? [],
        identity: data.identity ?? null,
        cognition: data.cognition ?? null,
      },
    };
  }

  function loadImportInput(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('import body 必须是 JSON 对象');
    if (input.path !== undefined && input.path !== null) {
      if (typeof input.path !== 'string' || !input.path.trim()) {
        throw badRequest('import.path 必须是非空字符串');
      }
      const filePath = path.isAbsolute(input.path) ? input.path : path.join(config.paths.exportsDir, input.path);
      if (!fs.existsSync(filePath)) throw notFound(`导入文件不存在：${filePath}`);
      const buffer = readBodyFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      if (ext === '.zip') {
        const entries = readZipSafe(buffer);
        const manifestRaw = entries.get('manifest.json');
        if (!manifestRaw) throw importFailed('ZIP 中缺少 manifest.json，不是 FCA 导出包');
        const header = parseJsonSafe(manifestRaw.toString('utf8'), 'ZIP manifest.json');
        if (header.format !== EXPORT_FORMAT) throw importFailed('ZIP manifest.format 不是 fca-export');
        const records = { memories: [], entities: [], relations: [], tags: [], versions: [], layout_nodes: [], layout_views: [], identity: null, cognition: null };
        const mapping = {
          'memories.jsonl': 'memory',
          'entities.jsonl': 'entity',
          'relations.jsonl': 'relation',
          'tags.jsonl': 'tag',
          'versions.jsonl': 'version',
          'layout_nodes.jsonl': 'layout_node',
          'layout_views.jsonl': 'layout_view',
        };
        for (const [fileName, kind] of Object.entries(mapping)) {
          const data = entries.get(fileName);
          if (!data) continue;
          for (const line of data.toString('utf8').split('\n')) {
            if (!line.trim()) continue;
            const parsed = parseJsonSafe(line, 'ZIP 内 JSONL 行');
            const payload = parsed.data !== undefined ? parsed.data : parsed;
            if (kind === 'memory') records.memories.push(payload);
            else if (kind === 'entity') records.entities.push(payload);
            else if (kind === 'relation') records.relations.push(payload);
            else if (kind === 'tag') records.tags.push(payload);
            else if (kind === 'version') records.versions.push(payload);
            else if (kind === 'layout_node') records.layout_nodes.push(payload);
            else if (kind === 'layout_view') records.layout_views.push(payload);
          }
        }
        const identityRaw = entries.get('identity.json');
        if (identityRaw) records.identity = parseJsonSafe(identityRaw.toString('utf8'), 'ZIP identity.json');
        const cognitionRaw = entries.get('cognition.json');
        if (cognitionRaw) records.cognition = parseJsonSafe(cognitionRaw.toString('utf8'), 'ZIP cognition.json');
        return { header, records, source: filePath };
      }
      const text = buffer.toString('utf8');
      if (ext === '.jsonl' || (input.format === 'jsonl')) {
        const { header, records } = parseLinesToRecords(text.split('\n'));
        if (!header || header.format !== EXPORT_FORMAT) throw importFailed('JSONL 首行缺少 fca-export manifest');
        return { header, records, source: filePath };
      }
      return { ...recordsFromJsonBundle(parseJsonSafe(text, '导入 JSON 文件')), source: filePath };
    }
    if (input.format === 'zip' || input.format === 'zip_base64' || input.zip_base64) {
      const base64 = input.zip_base64 ?? input.data;
      if (typeof base64 !== 'string') throw importFailed('ZIP 导入需要 zip_base64 字符串');
      const buffer = Buffer.from(base64, 'base64');
      const entries = readZip(buffer);
      const manifestRaw = entries.get('manifest.json');
      if (!manifestRaw) throw importFailed('ZIP 中缺少 manifest.json');
      const header = parseJsonSafe(manifestRaw.toString('utf8'), 'ZIP manifest.json');
      if (header.format !== EXPORT_FORMAT) throw importFailed('ZIP manifest.format 不是 fca-export');
      // 复用 ZIP 解析逻辑，把 ZIP 内容按 jsonl 记录解析
      const records = { memories: [], entities: [], relations: [], tags: [], versions: [], layout_nodes: [], layout_views: [], identity: null, cognition: null };
      const mapping = { 'memories.jsonl': 'memory', 'entities.jsonl': 'entity', 'relations.jsonl': 'relation', 'tags.jsonl': 'tag', 'versions.jsonl': 'version', 'layout_nodes.jsonl': 'layout_node', 'layout_views.jsonl': 'layout_view' };
      for (const [fileName, kind] of Object.entries(mapping)) {
        const data = entries.get(fileName);
        if (!data) continue;
        for (const line of data.toString('utf8').split('\n')) {
          if (!line.trim()) continue;
          const parsed = parseJsonSafe(line, 'ZIP 内 JSONL 行');
          const payload = parsed.data !== undefined ? parsed.data : parsed;
          if (kind === 'memory') records.memories.push(payload);
          else if (kind === 'entity') records.entities.push(payload);
          else if (kind === 'relation') records.relations.push(payload);
          else if (kind === 'tag') records.tags.push(payload);
          else if (kind === 'version') records.versions.push(payload);
          else if (kind === 'layout_node') records.layout_nodes.push(payload);
          else if (kind === 'layout_view') records.layout_views.push(payload);
        }
      }
      const identityRaw = entries.get('identity.json');
      if (identityRaw) records.identity = parseJsonSafe(identityRaw.toString('utf8'), 'ZIP identity.json');
      const cognitionRaw = entries.get('cognition.json');
      if (cognitionRaw) records.cognition = parseJsonSafe(cognitionRaw.toString('utf8'), 'ZIP cognition.json');
      return { header, records, source: 'inline-zip' };
    }
    if (input.data !== undefined) {
      const data = input.data;
      if (typeof data === 'string') {
        const format = input.format ?? 'jsonl';
        if (format === 'json') return { ...recordsFromJsonBundle(parseJsonSafe(data, '导入 JSON 数据')) };
        const { header, records } = parseLinesToRecords(data.split('\n'));
        if (!header || header.format !== EXPORT_FORMAT) throw importFailed('JSONL 缺少 fca-export manifest');
        return { header, records, source: 'inline-jsonl' };
      }
      if (data && typeof data === 'object') {
        if (data.format === EXPORT_FORMAT) return { ...recordsFromJsonBundle(data), source: 'inline-json' };
        if (data.data && (data.data.memories || data.data.entities)) {
          return { ...recordsFromJsonBundle({ format: EXPORT_FORMAT, data: data.data, counts: data.counts }), source: 'inline-data' };
        }
      }
      throw importFailed('无法识别导入数据格式（需要 FCA 导出 JSON/JSONL/ZIP）');
    }
    throw badRequest('import 需要 path 或 data');
  }

  function importData(input, meta = {}) {
    const started = performance.now();
    const { header, records, source } = loadImportInput(input);
    if (header.format_version && !String(header.format_version).startsWith('1.')) {
      throw importFailed(`不支持的导出格式版本：${header.format_version}`);
    }
    const d = dbHolder.requireDb();
    const importBatchId = newId('event');
    const idMap = new Map();
    const stats = {
      imported: { memories: 0, entities: 0, relations: 0, tags: 0, versions: 0, layout_nodes: 0, layout_views: 0, identity: 0, cognition: 0 },
      skipped: { memories: 0, entities: 0, relations: 0, tags: 0, versions: 0, layout_nodes: 0, layout_views: 0 },
      remapped: { memories: 0, entities: 0, relations: 0, tags: 0 },
    };
    const outEvents = [];
    d.exec('BEGIN IMMEDIATE');
    try {
      // 1) tags
      const tagIdMap = new Map();
      for (const tag of records.tags) {
        if (!tag || typeof tag.name !== 'string' || !tag.name.trim()) {
          stats.skipped.tags += 1;
          continue;
        }
        const name = String(tag.name).trim();
        const existingByName = d.prepare('SELECT * FROM tags WHERE name = ? AND deleted_at IS NULL').get(name);
        if (existingByName) {
          tagIdMap.set(tag.id, existingByName.id);
          continue;
        }
        let id = typeof tag.id === 'string' ? tag.id : null;
        if (!id || d.prepare('SELECT 1 x FROM tags WHERE id = ?').get(id)) {
          id = newId('tag');
          stats.remapped.tags += 1;
        }
        const now = nowIso();
        d.prepare('INSERT INTO tags(id, name, color, created_at, updated_at, version, deleted_at) VALUES(?,?,?,?,?,1,NULL)').run(
          id,
          name,
          tag.color ?? null,
          now,
          now,
        );
        tagIdMap.set(tag.id, id);
        stats.imported.tags += 1;
      }

      // 2) entities
      const entityIdMap = new Map();
      for (const entity of records.entities) {
        if (!entity || typeof entity.name !== 'string' || !entity.name.trim() || typeof entity.kind !== 'string') {
          stats.skipped.entities += 1;
          continue;
        }
        const kind = entity.kind;
        const name = String(entity.name).trim();
        const existingByName = d
          .prepare('SELECT * FROM entities WHERE kind = ? AND name = ? AND deleted_at IS NULL')
          .get(kind, name);
        if (existingByName) {
          entityIdMap.set(entity.id, existingByName.id);
          continue;
        }
        let id = typeof entity.id === 'string' ? entity.id : null;
        if (!id || d.prepare('SELECT 1 x FROM entities WHERE id = ?').get(id)) {
          id = newId('entity');
          stats.remapped.entities += 1;
        }
        const now = nowIso();
        d.prepare(
          `INSERT INTO entities(id, kind, name, description, aliases, metadata, created_at, updated_at, version, deleted_at)
           VALUES(?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          id,
          kind,
          name,
          entity.description ?? '',
          JSON.stringify(entity.aliases ?? []),
          JSON.stringify(entity.metadata ?? {}),
          isIsoDate(entity.created_at) ? entity.created_at : now,
          isIsoDate(entity.updated_at) ? entity.updated_at : now,
          Number(entity.version) || 1,
          entity.deleted_at ?? null,
        );
        entityIdMap.set(entity.id, id);
        stats.imported.entities += 1;
      }

      // 3) memories
      const memoryIdMap = new Map();
      for (const mem of records.memories) {
        if (!mem || typeof mem.title !== 'string' || !mem.title.trim()) {
          stats.skipped.memories += 1;
          continue;
        }
        let id = typeof mem.id === 'string' ? mem.id : null;
        if (!id || d.prepare('SELECT 1 x FROM memories WHERE id = ?').get(id) || d.prepare('SELECT 1 x FROM hard_deleted_memories WHERE id = ?').get(id)) {
          id = newId('memory');
          stats.remapped.memories += 1;
        }
        const now = nowIso();
        const createdBy = mem.created_by ?? { kind: 'user', id: 'local' };
        const updatedBy = mem.updated_by ?? createdBy;
        const source = mem.source ?? { type: 'import' };
        d.prepare(
          `INSERT INTO memories(id, title, body, memory_type, occurred_at, occurred_precision, occurred_end_at,
            source_type, source_ref, source_note, credibility, importance, display_weight, origin, agent_generated, demo,
            created_by_kind, created_by_id, updated_by_kind, updated_by_id, created_at, updated_at, version, deleted_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          id,
          String(mem.title),
          mem.body ?? '',
          MEMORY_TYPES.includes(mem.memory_type) ? mem.memory_type : 'episodic',
          isIsoDate(mem.occurred_at) ? mem.occurred_at : null,
          mem.occurred_precision ?? 'unknown',
          isIsoDate(mem.occurred_end_at) ? mem.occurred_end_at : null,
          source.type ?? 'import',
          source.ref ?? null,
          source.note ?? null,
          Number.isFinite(Number(mem.credibility)) ? Number(mem.credibility) : 0.5,
          Number.isFinite(Number(mem.importance)) ? Number(mem.importance) : 0.5,
          Number.isFinite(Number(mem.display_weight)) ? Number(mem.display_weight) : 1.0,
          mem.origin ?? 'import',
          mem.agent_generated ? 1 : 0,
          mem.demo ? 1 : 0,
          createdBy.kind ?? 'user',
          createdBy.id ?? 'local',
          updatedBy.kind ?? 'user',
          updatedBy.id ?? 'local',
          isIsoDate(mem.created_at) ? mem.created_at : now,
          isIsoDate(mem.updated_at) ? mem.updated_at : now,
          Number(mem.version) || 1,
          isIsoDate(mem.deleted_at) ? mem.deleted_at : null,
        );
        memoryIdMap.set(mem.id, id);
        // tags
        const tagIds = Array.isArray(mem.tags) ? mem.tags : [];
        const tagNames = Array.isArray(mem.tag_names) ? mem.tag_names : [];
        tagIds.forEach((oldTagId, index) => {
          let mapped = tagIdMap.get(oldTagId);
          if (!mapped && tagNames[index]) {
            const byName = d.prepare('SELECT id FROM tags WHERE name = ? AND deleted_at IS NULL').get(tagNames[index]);
            mapped = byName?.id;
          }
          if (mapped) d.prepare('INSERT OR IGNORE INTO memory_tags(memory_id, tag_id) VALUES(?,?)').run(id, mapped);
        });
        // participants
        const participants = Array.isArray(mem.participants) ? mem.participants : [];
        const insertParticipant = d.prepare('INSERT OR IGNORE INTO memory_participants(memory_id, entity_id, role) VALUES(?,?,?)');
        for (const participant of participants) {
          let entityId = entityIdMap.get(participant.entity_id) ?? null;
          if (!entityId && participant.name) {
            const byName = d
              .prepare("SELECT id FROM entities WHERE kind = 'person' AND name = ? AND deleted_at IS NULL")
              .get(participant.name);
            entityId = byName?.id ?? null;
          }
          if (entityId) insertParticipant.run(id, entityId, participant.role ?? 'participant');
        }
        const project = mem.project ?? null;
        if (project && project.entity_id) {
          const mapped = entityIdMap.get(project.entity_id);
          if (mapped) d.prepare('INSERT OR REPLACE INTO memory_project(memory_id, entity_id) VALUES(?,?)').run(id, mapped);
        }
        if (mem.emotion) {
          d.prepare('INSERT OR REPLACE INTO memory_emotion(memory_id, valence, arousal, label) VALUES(?,?,?,?)').run(
            id,
            mem.emotion.valence ?? null,
            mem.emotion.arousal ?? null,
            mem.emotion.label ?? null,
          );
        }
        const prepared = events.prepare(d, {
          type: 'memory.imported',
          actor: meta.actor,
          source: meta.source,
          subject: { kind: 'memory', id },
          payload: { memory_id: id, source: sourceLabel(source, input), import_batch: importBatchId },
          trace_id: meta.traceId,
        });
        outEvents.push(prepared.event);
        stats.imported.memories += 1;
      }

      // 4) versions（在 tags/entities/memories 映射建立之后）
      for (const [oldId, newIdValue] of tagIdMap) idMap.set(oldId, newIdValue);
      for (const [oldId, newIdValue] of entityIdMap) idMap.set(oldId, newIdValue);
      for (const [oldId, newIdValue] of memoryIdMap) idMap.set(oldId, newIdValue);
      for (const version of records.versions) {
        if (!version || !version.memory_id || !memoryIdMap.has(version.memory_id)) {
          stats.skipped.versions += 1;
          continue;
        }
        const memoryId = memoryIdMap.get(version.memory_id);
        const snapshot = remapDeep(version.snapshot ?? null, idMap);
        const diff = remapDeep(version.diff ?? [], idMap);
        try {
          d.prepare(
            `INSERT OR IGNORE INTO memory_versions(ver_id, memory_id, version, change_kind, snapshot, diff, actor_kind, actor_id, source_event_id, created_at)
             VALUES(?,?,?,?,?,?,?,?,?,?)`,
          ).run(
            newId('version'),
            memoryId,
            Number(version.version) || 1,
            version.change_kind ?? 'import',
            JSON.stringify(snapshot),
            JSON.stringify(diff),
            version.actor?.kind ?? 'system',
            version.actor?.id ?? 'runtime',
            null,
            isIsoDate(version.created_at) ? version.created_at : nowIso(),
          );
          stats.imported.versions += 1;
        } catch {
          stats.skipped.versions += 1;
        }
      }

      // 5) relations
      const relationIdMap = new Map();
      for (const rel of records.relations) {
        if (!rel || !rel.from || !rel.to) {
          stats.skipped.relations += 1;
          continue;
        }
        const remapNode = (node) => {
          if (node.kind === 'memory') return memoryIdMap.get(node.id) ?? null;
          return entityIdMap.get(node.id) ?? null;
        };
        const fromId = remapNode(rel.from);
        const toId = remapNode(rel.to);
        if (!fromId || !toId) {
          stats.skipped.relations += 1;
          continue;
        }
        let id = typeof rel.id === 'string' ? rel.id : null;
        if (!id || d.prepare('SELECT 1 x FROM relations WHERE id = ?').get(id)) {
          id = newId('relation');
          stats.remapped.relations += 1;
        }
        const source = rel.source ?? { type: 'import' };
        d.prepare(
          `INSERT INTO relations(id, from_kind, from_id, to_kind, to_id, relation_type, directed, label, evidence,
            confidence, source_type, source_ref, source_note, weight, created_at, updated_at, version, deleted_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          id,
          rel.from.kind,
          fromId,
          rel.to.kind,
          toId,
          rel.relation_type ?? 'custom',
          rel.directed === false ? 0 : 1,
          rel.label ?? null,
          rel.evidence ?? null,
          Number.isFinite(Number(rel.confidence)) ? Number(rel.confidence) : 0.5,
          source.type ?? 'import',
          source.ref ?? null,
          source.note ?? null,
          Number.isFinite(Number(rel.weight)) ? Number(rel.weight) : 1.0,
          isIsoDate(rel.created_at) ? rel.created_at : nowIso(),
          isIsoDate(rel.updated_at) ? rel.updated_at : nowIso(),
          Number(rel.version) || 1,
          isIsoDate(rel.deleted_at) ? rel.deleted_at : null,
        );
        relationIdMap.set(rel.id, id);
        stats.imported.relations += 1;
      }

      // 6) layout
      let layoutChanged = false;
      for (const node of records.layout_nodes) {
        if (!node || !node.node_id) continue;
        const kind = node.node_kind;
        const mapped = kind === 'memory' ? memoryIdMap.get(node.node_id) : entityIdMap.get(node.node_id);
        if (!mapped) {
          stats.skipped.layout_nodes += 1;
          continue;
        }
        const exists = kind === 'memory'
          ? d.prepare('SELECT 1 x FROM memories WHERE id = ?').get(mapped)
          : d.prepare('SELECT 1 x FROM entities WHERE id = ?').get(mapped);
        if (!exists) {
          stats.skipped.layout_nodes += 1;
          continue;
        }
        d.prepare(
          `INSERT INTO layout_nodes(node_kind, node_id, x, y, z, pinned, cluster_id, updated_at) VALUES(?,?,?,?,?,?,?,?)
           ON CONFLICT(node_kind, node_id) DO UPDATE SET x=excluded.x, y=excluded.y, z=excluded.z, pinned=excluded.pinned,
             cluster_id=excluded.cluster_id, updated_at=excluded.updated_at`,
        ).run(
          kind,
          mapped,
          Number(node.x) || 0,
          Number(node.y) || 0,
          Number(node.z) || 0,
          node.pinned ? 1 : 0,
          node.cluster_id ?? null,
          isIsoDate(node.updated_at) ? node.updated_at : nowIso(),
        );
        stats.imported.layout_nodes += 1;
        layoutChanged = true;
      }
      for (const view of records.layout_views) {
        if (!view || !view.name) continue;
        const existing = d.prepare('SELECT view_id FROM layout_views WHERE name = ?').get(view.name);
        if (existing) {
          stats.skipped.layout_views += 1;
          continue;
        }
        let viewId = typeof view.view_id === 'string' ? view.view_id : null;
        if (!viewId || d.prepare('SELECT 1 x FROM layout_views WHERE view_id = ?').get(viewId)) viewId = newId('view');
        if (view.is_default) d.prepare('UPDATE layout_views SET is_default = 0').run();
        d.prepare(
          'INSERT INTO layout_views(view_id, name, is_default, camera, layer_config, created_at, updated_at) VALUES(?,?,?,?,?,?,?)',
        ).run(
          viewId,
          view.name,
          view.is_default ? 1 : 0,
          JSON.stringify(view.camera ?? {}),
          JSON.stringify(view.layer_config ?? {}),
          isIsoDate(view.created_at) ? view.created_at : nowIso(),
          isIsoDate(view.updated_at) ? view.updated_at : nowIso(),
        );
        stats.imported.layout_views += 1;
        layoutChanged = true;
      }
      if (layoutChanged) bumpLayoutVersion(d);

      // 7) identity / cognition（仅在当前为默认空档案时导入，避免覆盖用户数据）
      if (records.identity) {
        const current = d.prepare('SELECT * FROM identity LIMIT 1').get();
        const isDefault = current && current.version === 1 && current.display_name === '我' && (current.summary ?? '') === '';
        if (isDefault) {
          d.prepare(
            'UPDATE identity SET display_name=?, summary=?, values_json=?, preferences_json=?, boundaries_json=?, version=?, updated_at=? WHERE identity_id=?',
          ).run(
            records.identity.display_name ?? '我',
            records.identity.summary ?? '',
            JSON.stringify(records.identity.values ?? []),
            JSON.stringify(records.identity.preferences ?? {}),
            JSON.stringify(records.identity.boundaries ?? []),
            Number(records.identity.version) || 1,
            isIsoDate(records.identity.updated_at) ? records.identity.updated_at : nowIso(),
            current.identity_id,
          );
          stats.imported.identity = 1;
        }
      }
      if (records.cognition) {
        const current = d.prepare('SELECT * FROM cognition WHERE singleton = 1').get();
        const isDefault = current && current.mode === 'idle' && (current.focus ?? '') === '' && (current.attention_targets ?? '[]') === '[]';
        if (isDefault) {
          d.prepare(
            'UPDATE cognition SET focus=?, attention_targets=?, working_memory=?, mood_json=?, mode=?, note=?, updated_at=? WHERE singleton=1',
          ).run(
            records.cognition.focus ?? '',
            JSON.stringify(records.cognition.attention_targets ?? []),
            JSON.stringify(records.cognition.working_memory ?? []),
            records.cognition.mood ? JSON.stringify(records.cognition.mood) : null,
            records.cognition.mode ?? 'idle',
            records.cognition.note ?? '模拟状态，不代表主观感受',
            isIsoDate(records.cognition.updated_at) ? records.cognition.updated_at : nowIso(),
          );
          stats.imported.cognition = 1;
        }
      }

      // 8) 重建索引（事务内，保证一致）
      memory.rebuildIndexes();
      d.exec('COMMIT');
    } catch (err) {
      try {
        d.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      if (err && err.code === 'IMPORT_FAILED') throw err;
      throw importFailed(`导入失败：${err.message}`);
    }
    events.publish(outEvents);
    const tookMs = Math.round((performance.now() - started) * 1000) / 1000;
    logger?.info?.('导入完成', { source, ...stats.imported, took_ms: tookMs });
    return {
      imported_at: nowIso(),
      source,
      format_version: header.format_version ?? EXPORT_FORMAT_VERSION,
      import_batch: importBatchId,
      imported: stats.imported,
      skipped: stats.skipped,
      remapped: stats.remapped,
      took_ms: tookMs,
      counts_after: { memories: stats.imported.memories },
    };
  }

  function sourceLabel(source, input) {
    if (typeof source === 'string') return source;
    if (source && typeof source === 'object') return source.ref ?? source.note ?? null;
    return input?.path ? String(input.path) : 'inline';
  }

  return { exportData, importData, collectBundle };
}

// 导入时用于校验 memory_type 枚举（避免循环依赖）
const MEMORY_TYPES = ['working', 'episodic', 'semantic', 'procedural', 'autobiographical', 'project', 'relational', 'emotional'];
