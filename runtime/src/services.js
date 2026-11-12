// FCA Local Runtime — 服务装配（HTTP server 与 CLI 离线操作共用）
import { createTagService } from './catalog/tags.js';
import { createEntityService } from './catalog/entities.js';
import { createRelationService } from './catalog/relations.js';
import { createMemoryService } from './memory/store.js';
import { createSearchService } from './memory/search.js';
import { createIdentityService } from './identity/index.js';
import { createCognitionService } from './cognition/index.js';
import { createLayoutService } from './layout/index.js';
import { createGraphService } from './graph/index.js';
import { createTimelineService } from './timeline/index.js';
import { createBackupService } from './backup/index.js';
import { createExchangeService } from './exchange/index.js';
import { createSystemService } from './system/index.js';

/** 构造全部业务服务（依赖倒置：dbHolder/events/logger/config 由调用方注入）。 */
export function buildServices({ config, logger, dbHolder, events, hub = null, state = null }) {
  const effectiveState = state ?? {
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    shuttingDown: false,
    errorStats: { count: 0, last: null },
  };
  const tags = createTagService({ dbHolder });
  const entities = createEntityService({ dbHolder, events, logger });
  const relations = createRelationService({ dbHolder, events, logger });
  const memory = createMemoryService({ dbHolder, events, logger, config, tags, entities, relations });
  const search = createSearchService({ dbHolder, logger });
  const identity = createIdentityService({ dbHolder, events });
  const cognition = createCognitionService({ dbHolder, events });
  const layout = createLayoutService({ dbHolder, events, logger });
  const graph = createGraphService({ dbHolder, layout, config });
  const timeline = createTimelineService({ dbHolder });
  const backup = createBackupService({ dbHolder, config, logger, events });
  const exchange = createExchangeService({
    dbHolder,
    config,
    logger,
    memory,
    entities,
    relations,
    identity,
    cognition,
    events,
  });
  const system = createSystemService({ config, dbHolder, logger, state: effectiveState, hub });
  return { tags, entities, relations, memory, search, identity, cognition, layout, graph, timeline, backup, exchange, system };
}
