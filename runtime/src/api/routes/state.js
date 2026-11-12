// GET /api/v1/state（身份、认知、计数、同步状态、能力清单、catalogs）
import { reply } from '../../server/respond.js';
import { collectCounts } from '../../persistence/db.js';

export function registerStateRoutes({ router, services, config, holder, events, hub, state }) {
  router.add('GET', '/api/v1/state', (ctx) => {
    const d = holder.requireDb();
    const identity = services.identity.get();
    const cognition = services.cognition.get();
    const counts = collectCounts(d);
    const eventsBounds = events.bounds();
    const tags = services.tags.catalog(d, { limit: 200 });
    const projects = d
      .prepare(
        `SELECT e.id AS entity_id, e.name,
                (SELECT count(*) FROM memory_project mp JOIN memories m ON m.id = mp.memory_id
                 WHERE mp.entity_id = e.id AND m.deleted_at IS NULL) AS count
         FROM entities e WHERE e.kind = 'project' AND e.deleted_at IS NULL
         ORDER BY count DESC, e.name ASC LIMIT 200`,
      )
      .all()
      .map((row) => ({ entity_id: row.entity_id, name: row.name, count: Number(row.count) }));
    const llmConfigured = (() => {
      try {
        return Number(d.prepare('SELECT count(*) c FROM llm_providers WHERE enabled = 1').get()?.c ?? 0) > 0;
      } catch {
        return false;
      }
    })();
    const capabilities = {
      api_version: config.apiVersion,
      product_version: config.productVersion,
      fulltext: 'fts5-bigram-v1',
      semantic: 'local-hash-v1',
      semantic_note: '本地确定性哈希 embedding，非神经网络模型，完全离线',
      layout: 'force_v1',
      sse: true,
      backup: true,
      restore: true,
      export: ['json', 'jsonl', 'zip'],
      import: ['json', 'jsonl', 'zip'],
      llm: { configured: llmConfigured, offline_queue: true },
      demo_seed: true,
      db: 'sqlite-wal',
      auth: 'bearer-loopback',
    };
    return reply({
      identity,
      cognition,
      counts,
      catalogs: { tags, projects },
      sync: {
        last_event_seq: eventsBounds.max_seq ?? 0,
        event_count: eventsBounds.count,
        layout_version: holder.layoutVersion(),
        sse_clients: hub ? hub.count() : 0,
        db_initialized: holder.isInitialized,
        schema_version: holder.schemaVersion,
      },
      capabilities,
      version: config.productVersion,
      product_version: config.productVersion,
      api_version: config.apiVersion,
      uptime_ms: Date.now() - state.startedAtMs,
      updated_at: new Date().toISOString(),
    });
  }, { description: '身份/认知/计数/同步状态/能力清单/catalogs' });
}
