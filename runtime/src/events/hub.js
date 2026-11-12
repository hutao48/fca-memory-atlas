// FCA Local Runtime — SSE Hub（契约 §6）：event: fca.event / id: <seq> / data / 15s heartbeat / Last-Event-ID 补发
import { nowIso } from '../core/time.js';

function frame({ event, data, id }) {
  let out = '';
  if (event) out += `event: ${event}\n`;
  if (data !== undefined) out += `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n`;
  if (id !== undefined && id !== null) out += `id: ${id}\n`;
  return `${out}\n`;
}

function parseLastEventId(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) return { seq: Number(s) };
  return { eventId: s };
}

/**
 * @param {{config: object, logger: object, eventStore: object, startedAtMs: number}} deps
 */
export function createSseHub({ config, logger, eventStore, startedAtMs = Date.now() }) {
  /** @type {Map<string, {id:string,res:import('node:http').ServerResponse,clientKind:string,types:Set<string>|null,connectedAt:string,lastSeq:number,traceId:string,remote:string}>} */
  const clients = new Map();
  const heartbeatMs = config.sseHeartbeatMs;
  const replayLimit = config.sseReplayLimit;
  let heartbeatTimer = null;

  function writeRaw(client, chunk) {
    try {
      client.res.write(chunk);
      return true;
    } catch {
      removeClient(client.id, 'write_error');
      return false;
    }
  }

  function sendHeartbeat(client) {
    return writeRaw(
      client,
      frame({ event: 'heartbeat', data: { ts: nowIso(), uptime_ms: Date.now() - startedAtMs } }),
    );
  }

  function sendEvent(client, event) {
    client.lastSeq = event.seq;
    return writeRaw(client, frame({ event: 'fca.event', data: event, id: event.seq }));
  }

  function startHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      for (const client of [...clients.values()]) sendHeartbeat(client);
    }, heartbeatMs);
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function removeClient(id, reason = 'closed') {
    const client = clients.get(id);
    if (!client) return null;
    clients.delete(id);
    try {
      client.res.end();
    } catch {
      /* ignore */
    }
    logger?.debug?.('SSE 客户端断开', { client_id: id, reason, client_kind: client.clientKind });
    try {
      eventStore?.emit?.(
        {
          type: 'system.client.disconnected',
          actor: { kind: 'system', id: 'runtime', display: '系统' },
          source: { kind: client.clientKind === 'dsh-plugin' ? 'dsh-plugin' : 'desktop', id: 'runtime' },
          subject: { kind: 'system', id: null },
          payload: { client_kind: client.clientKind, reason, connected_ms: Date.now() - new Date(client.connectedAt).getTime() },
        },
        {},
      );
    } catch {
      /* 数据库可能关闭中，忽略 */
    }
    return client;
  }

  /**
   * 注册 SSE 客户端并在独立连接上完成首帧/补发。
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {{clientKind?: string, lastEventId?: string, types?: string[]|null, traceId?: string}} options
   */
  function addClient(req, res, options = {}) {
    const id = `sse_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const clientKind = options.clientKind ?? 'desktop';
    const types = options.types && options.types.length > 0 ? new Set(options.types) : null;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
      'X-FCA-Trace-Id': options.traceId ?? '',
    });
    try {
      res.write(`retry: 3000\n\n`);
    } catch {
      /* ignore */
    }

    const client = {
      id,
      res,
      clientKind,
      types,
      connectedAt: nowIso(),
      lastSeq: 0,
      traceId: options.traceId ?? '',
      remote: req.socket?.remoteAddress ?? '',
    };
    clients.set(id, client);
    startHeartbeat();

    // 首帧必须是心跳或事件（Lead/QA 订阅后立即读取）
    sendHeartbeat(client);
    writeRaw(
      client,
      frame({
        event: 'fca.ready',
        data: {
          seq: eventStore.maxSeq(),
          heartbeat_ms: heartbeatMs,
          api_version: config.apiVersion,
          client_kind: clientKind,
          types: types ? [...types] : null,
        },
      }),
    );

    // 客户端连接审计事件（契约 §6：system.client.connected）
    try {
      eventStore?.emit?.(
        {
          type: 'system.client.connected',
          actor: { kind: 'system', id: 'runtime', display: '系统' },
          source: {
            kind: clientKind === 'dsh-plugin' ? 'dsh-plugin' : clientKind === 'desktop' ? 'desktop' : 'cli',
            id: 'runtime',
            version: config.productVersion,
          },
          subject: { kind: 'system', id: null },
          payload: { client_kind: clientKind, types: types ? [...types] : null, remote: client.remote },
        },
        {},
      );
    } catch (err) {
      logger?.warn?.('system.client.connected 事件写入失败', { error: err.message });
    }

    // Last-Event-ID 补发
    const parsed = parseLastEventId(options.lastEventId);    if (parsed) {
      try {
        let sinceSeq = parsed.seq ?? null;
        if (sinceSeq === null && parsed.eventId) {
          const evt = eventStore.getById(parsed.eventId);
          sinceSeq = evt ? evt.seq : null;
        }
        const bounds = eventStore.bounds();
        if (sinceSeq !== null) {
          const oldestAvailable = bounds.min_seq;
          const gap = oldestAvailable !== null && sinceSeq < oldestAvailable - 1;
          if (gap) {
            writeRaw(
              client,
              frame({
                event: 'fca.resync',
                data: {
                  reason: 'event_history_unavailable',
                  requested_last_event_id: parsed.seq ?? parsed.eventId,
                  earliest_available_seq: oldestAvailable,
                  max_seq: bounds.max_seq,
                },
              }),
            );
          } else {
            const events = eventStore.listAfterSeq(sinceSeq, { limit: replayLimit });
            for (const event of events) {
              if (types && !types.has(event.type)) continue;
              sendEvent(client, event);
            }
            if (events.length >= replayLimit) {
              writeRaw(
                client,
                frame({ event: 'fca.resync', data: { reason: 'replay_limit_reached', max_seq: bounds.max_seq } }),
              );
            }
          }
        }
      } catch (err) {
        logger?.warn?.('SSE 补发失败，客户端应全量重同步', { error: err.message });
        writeRaw(client, frame({ event: 'fca.resync', data: { reason: 'replay_failed' } }));
      }
    }

    req.on('close', () => removeClient(id, 'request_close'));
    req.on('aborted', () => removeClient(id, 'aborted'));
    res.on('error', () => removeClient(id, 'response_error'));
    res.on('close', () => removeClient(id, 'response_close'));
    logger?.debug?.('SSE 客户端连接', { client_id: id, client_kind: clientKind, types: types ? [...types] : null });
    return client;
  }

  function broadcast(event) {
    if (clients.size === 0) return 0;
    let sent = 0;
    for (const client of [...clients.values()]) {
      if (client.types && !client.types.has(event.type)) continue;
      if (sendEvent(client, event)) sent += 1;
    }
    return sent;
  }

  /** 关闭所有 SSE 连接（shutdown 时调用；先广播 system.stopped 再结束）。 */
  function closeAll({ reason = 'shutdown' } = {}) {
    stopHeartbeat();
    for (const client of [...clients.values()]) {
      writeRaw(client, frame({ event: 'fca.shutdown', data: { reason, ts: nowIso() } }));
      removeClient(client.id, reason);
    }
  }

  function count() {
    return clients.size;
  }

  function snapshot() {
    return [...clients.values()].map((c) => ({
      client_id: c.id,
      client_kind: c.clientKind,
      connected_at: c.connectedAt,
      last_seq: c.lastSeq,
      remote: c.remote,
    }));
  }

  return { addClient, broadcast, closeAll, count, snapshot, stopHeartbeat };
}
