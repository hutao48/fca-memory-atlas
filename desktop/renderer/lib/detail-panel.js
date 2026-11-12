/**
 * FCA Memory Atlas — 右侧详情面板
 * 契约：lib/contracts.md §2.4 ctx.detail（Shell 内置面板）
 *
 * 真实数据来源：GET /memory/{id}（memory + relations + layout + versions_count）、
 * GET /memory/{id}/versions、GET /entities/{id}。无数据时显示加载/错误态，不展示伪造内容。
 */

import { icon } from '../ui/icons.js';
import {
  buildHierarchySummary,
  shortId,
  toChildMemoryItem,
} from './hierarchy.js';

export function createDetailPanel(options) {
  const { api, store, ui, format, events, bridge, toast, log, actions } = options;
  const scroll = document.getElementById('detail-scroll');
  const empty = document.getElementById('detail-empty');
  const titleEl = document.getElementById('right-title');

  let currentId = null;
  let currentMemory = null;
  let currentPayload = null;
  let requestToken = 0;
  let currentTab = 'detail';
  let versionsState = { status: 'idle', items: [], error: null };
  let customCleanup = null;
  // 子 Agent 会话层级 UI 状态（插件 v0.3 tags/relations 驱动）
  let hierarchyState = { memoryId: null, expanded: false, loading: false, items: null, error: null, summary: null };

  function resetHierarchyState() {
    hierarchyState = { memoryId: null, expanded: false, loading: false, items: null, error: null, summary: null };
  }

  function hierarchyNodes() {
    const graph = store.getState().graph.data;
    return graph && Array.isArray(graph.nodes) ? graph.nodes : [];
  }

  function setTitle(text) {
    if (titleEl) titleEl.textContent = text || '详情';
  }

  function setStatus(status, extra = {}) {
    store.patch({ detail: { status, targetId: currentId, ...extra } });
    events.emit('detail:changed', { targetId: currentId, status });
  }

  function resetVersions() {
    versionsState = { status: 'idle', items: [], error: null };
  }

  function clear() {
    currentId = null;
    currentMemory = null;
    currentPayload = null;
    requestToken += 1;
    resetVersions();
    resetHierarchyState();
    if (customCleanup) {
      try {
        customCleanup();
      } catch {
        /* ignore */
      }
      customCleanup = null;
    }
    if (scroll) {
      scroll.innerHTML = '';
      if (empty) {
        empty.hidden = false;
        scroll.appendChild(empty);
      }
    }
    setTitle('详情');
    setStatus('idle', { memory: null, relations: [], versionsCount: 0, layout: null, targetId: null });
  }

  function showLoading(label = '正在读取记忆…') {
    if (!scroll) return;
    if (customCleanup) {
      customCleanup();
      customCleanup = null;
    }
    scroll.innerHTML = '';
    scroll.appendChild(ui.el('div', { class: 'detail__loading' }, [ui.spinner({ label })]));
  }

  async function show(id) {
    if (!id) return clear();
    const graph = store.getState().graph.data;
    const node = graph && graph.nodes ? graph.nodes.find((n) => n.id === id) : null;
    if (node && node.kind === 'entity') return showEntity(id);
    currentId = id;
    requestToken += 1;
    const token = requestToken;
    resetVersions();
    resetHierarchyState();
    if (empty) empty.hidden = true;
    showLoading();
    setTitle('载入中…');
    setStatus('loading');
    try {
      const payload = await api.getMemory(id);
      if (token !== requestToken) return;
      if (!payload || !payload.memory) throw new Error('GET /memory/{id} 响应缺少 memory 字段');
      currentMemory = payload.memory;
      currentPayload = payload;
      if (typeof options.cacheTagNames === 'function') options.cacheTagNames(payload.memory);
      setTitle('记忆详情');
      setStatus('ready', {
        memory: payload.memory,
        relations: payload.relations || [],
        versionsCount: payload.versions_count || 0,
        layout: payload.layout || null,
        related: null,
        error: null,
      });
      renderActiveTab();
    } catch (error) {
      if (token !== requestToken) return;
      currentMemory = null;
      setStatus('error', { error: { code: error.code || 'UNKNOWN', message: api.userMessage(error), traceId: error.traceId || null } });
      setTitle('详情');
      scroll.innerHTML = '';
      scroll.appendChild(
        ui.el('div', {}, [
          ui.el('div', { class: 'detail__error', text: `读取记忆失败：${api.userMessage(error)}` }),
          error.traceId ? ui.el('div', { class: 'detail__error', text: `trace id：${error.traceId}` }) : null,
          ui.el('div', { class: 'detail__actions' }, [
            ui.button({ label: '重试', icon: 'refresh', variant: 'secondary', size: 'sm', onClick: () => show(id) }),
            ui.button({ label: '关闭', variant: 'ghost', size: 'sm', onClick: () => clear() }),
          ]),
        ]),
      );
    }
  }

  function refresh() {
    if (currentId) show(currentId);
  }

  function updateFavorite(id, isFav) {
    const btn = document.getElementById('detail-fav-btn');
    if (btn && currentId === id) {
      btn.classList.toggle('is-active', Boolean(isFav));
      btn.title = isFav ? '取消收藏' : '收藏';
      const iconSpan = btn.querySelector('.icon');
      if (iconSpan) btn.replaceChild(icon(isFav ? 'star-filled' : 'star', { size: 15 }), iconSpan);
    }
  }

  // ------------------------------------------------------------------ 记忆详情
  function buildHeader(memory) {
    const typeLabel = format.memoryTypeLabel(memory.memory_type);
    const deleted = Boolean(memory.deleted_at);
    const actionsRow = ui.el('div', { class: 'detail__actions' });
    const focusBtn = ui.button({ label: '在星图中聚焦', icon: 'compass', variant: 'secondary', size: 'sm', onClick: () => actions.focusNode(memory.id, 2) });
    const favorite = actions.isFavorite(memory.id);
    const favBtn = ui.iconButton({ icon: favorite ? 'star-filled' : 'star', label: favorite ? '取消收藏' : '收藏', size: 'sm', onClick: () => actions.toggleFavorite(memory.id) });
    favBtn.id = 'detail-fav-btn';
    favBtn.classList.toggle('is-active', favorite);
    const editBtn = ui.button({ label: '编辑', icon: 'edit', variant: 'ghost', size: 'sm', onClick: () => actions.openEditor(memory.id), title: '在记忆编辑器中打开（Editor 视图）' });
    const copyBtn = ui.iconButton({ icon: 'copy', label: '复制 ID', size: 'sm', onClick: () => actions.copyText(memory.id) });
    actionsRow.append(focusBtn, favBtn, editBtn, copyBtn);
    if (deleted) {
      const restoreBtn = ui.button({
        label: '恢复记忆',
        icon: 'restore',
        variant: 'secondary',
        size: 'sm',
        onClick: async () => {
          try {
            await api.restoreMemory(memory.id);
            toast('记忆已恢复', { type: 'success' });
            refresh();
            events.emit('graph:refresh-request', { reason: 'restore' });
          } catch (error) {
            toast(`恢复失败：${api.userMessage(error)}`, { type: 'error' });
          }
        },
      });
      actionsRow.append(restoreBtn);
    } else {
      const deleteBtn = ui.button({
        label: '删除',
        icon: 'trash',
        variant: 'ghost',
        size: 'sm',
        onClick: () => actions.deleteMemory(memory.id),
      });
      actionsRow.append(deleteBtn);
    }

    const eyebrow = ui.el('div', { class: 'detail__eyebrow' }, [
      ui.tag({ label: typeLabel, tone: format.memoryTypeColor(memory.memory_type) }),
      memory.agent_generated ? ui.badge({ label: 'AI 生成', tone: 'gold', icon: 'sparkles' }) : null,
      memory.origin === 'agent' ? ui.badge({ label: 'Agent 自动', tone: 'accent' }) : null,
      memory.origin === 'revised' ? ui.badge({ label: '人工修订', tone: 'green' }) : null,
      deleted ? ui.badge({ label: '已删除（回收站）', tone: 'danger', icon: 'trash' }) : null,
    ]);

    const subtitleParts = [];
    if (memory.occurred_at) subtitleParts.push(`${format.datetime(memory.occurred_at)}（${format.precisionLabel(memory.occurred_precision)}）`);
    else subtitleParts.push('发生时间未知');
    subtitleParts.push(`更新于 ${format.relativeTime(memory.updated_at)}`);

    const header = ui.el('div', { class: 'detail__header' }, [
      eyebrow,
      ui.el('div', { class: 'detail__title', text: memory.title || '（无标题）' }),
      ui.el('div', { class: 'detail__subtitle', text: subtitleParts.join(' · ') }),
      actionsRow,
    ]);
    return header;
  }

  function buildTabs() {
    const tabs = ui.tabs({
      tabs: [
        { id: 'detail', label: '详情', icon: 'file' },
        { id: 'relations', label: `关系${currentPayload && currentPayload.relations ? ` (${currentPayload.relations.length})` : ''}`, icon: 'relation' },
        { id: 'history', label: '历史', icon: 'history' },
      ],
      active: currentTab,
      onChange: (tab) => {
        currentTab = tab;
        renderActiveTab();
      },
    });
    return tabs;
  }

  function metaCell(label, value, extra) {
    return ui.el('div', { class: 'detail__meta-cell' }, [
      ui.el('div', { class: 'detail__meta-label', text: label }),
      ui.el('div', { class: 'detail__meta-value', text: value, title: value }),
      extra || null,
    ]);
  }

  function meter(label, value, color) {
    const pct = Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100);
    return ui.el('div', { class: 'detail__meta-cell' }, [
      ui.el('div', { class: 'detail__meta-label', text: label }),
      ui.el('div', { class: 'detail__meta-value', text: `${Number(value || 0).toFixed(2)} · ${pct}%` }),
      ui.el('div', { class: 'detail__meter' }, [ui.el('div', { class: 'detail__meter-fill', style: { width: `${pct}%`, background: color } })]),
    ]);
  }

  function renderDetailTab() {
    const memory = currentMemory;
    if (!memory) return;
    const body = ui.el('div', { class: 'detail__body' });

    if (memory.deleted_at) {
      body.appendChild(ui.el('div', { class: 'detail__deleted-banner' }, [icon('alert', { size: 13 }), `已于 ${format.datetime(memory.deleted_at)} 删除，可在回收站恢复`]));
    }

    // 正文
    body.appendChild(
      ui.el('div', { class: 'detail__section' }, [
        ui.el('div', { class: 'detail__section-title' }, [ui.el('span', { text: '记忆正文' }), ui.el('span', { class: 'fca-muted', text: `${(memory.body || '').length} 字` })]),
        ui.el('div', { class: 'detail__text', text: memory.body || '（无正文）' }),
      ]),
    );

    // 元数据
    const metaGrid = ui.el('div', { class: 'detail__meta-grid' }, [
      meter('重要度 importance', memory.importance, 'linear-gradient(90deg, rgba(127,184,217,.5), var(--fca-accent))'),
      meter('可信度 credibility', memory.credibility, 'linear-gradient(90deg, rgba(127,200,169,.45), var(--fca-green))'),
      meter('显示权重 display_weight', (Number(memory.display_weight) || 0) / 2, 'linear-gradient(90deg, rgba(216,185,120,.45), var(--fca-gold))'),
      metaCell('来源', format.sourceTypeLabel(memory.source && memory.source.type), null),
      metaCell('来源引用', memory.source && memory.source.ref ? String(memory.source.ref) : '—'),
      metaCell('来源备注', memory.source && memory.source.note ? String(memory.source.note) : '—'),
      metaCell('创建者', memory.created_by ? `${memory.created_by.kind}:${memory.created_by.id}` : '—'),
      metaCell('版本', `v${memory.version}`, null),
    ]);
    body.appendChild(ui.el('div', { class: 'detail__section' }, [ui.el('div', { class: 'detail__section-title' }, [ui.el('span', { text: '属性' })]), metaGrid]));

    // 标签
    const tagIds = Array.isArray(memory.tags) ? memory.tags : [];
    const tagNameList = Array.isArray(memory.tag_names) ? memory.tag_names : [];
    if (tagIds.length) {
      const tagsRow = ui.el('div', { class: 'fca-row', style: { flexWrap: 'wrap', gap: '4px' } });
      tagIds.forEach((tagId, index) => {
        tagsRow.appendChild(ui.tag({ label: tagNameList[index] || tagId.replace(/^tag_/, '#'), tone: 'cyan', title: tagId }));
      });
      body.appendChild(ui.el('div', { class: 'detail__section' }, [ui.el('div', { class: 'detail__section-title' }, [ui.el('span', { text: '标签' })]), tagsRow]));
    }

    // 人物 / 项目
    const participants = Array.isArray(memory.participants) ? memory.participants : [];
    if (participants.length) {
      const list = ui.el('div', { class: 'detail__list' });
      for (const participant of participants) {
        const row = ui.el('button', { class: 'detail__list-item', type: 'button', title: participant.entity_id }, [
          icon('users', { size: 14 }),
          ui.el('span', { class: 'fca-grow fca-truncate', text: participant.name || participant.entity_id }),
          participant.role ? ui.el('span', { class: 'fca-muted', text: participant.role }) : null,
        ]);
        if (participant.entity_id) row.addEventListener('click', () => showEntity(participant.entity_id));
        list.appendChild(row);
      }
      body.appendChild(ui.el('div', { class: 'detail__section' }, [ui.el('div', { class: 'detail__section-title' }, [ui.el('span', { text: '参与人物' })]), list]));
    }
    if (memory.project) {
      const row = ui.el('button', { class: 'detail__list-item', type: 'button' }, [
        icon('folder', { size: 14 }),
        ui.el('span', { class: 'fca-grow fca-truncate', text: memory.project.name || memory.project.entity_id }),
        ui.el('span', { class: 'fca-muted', text: '项目' }),
      ]);
      if (memory.project.entity_id) row.addEventListener('click', () => showEntity(memory.project.entity_id));
      body.appendChild(ui.el('div', { class: 'detail__section' }, [ui.el('div', { class: 'detail__section-title' }, [ui.el('span', { text: '所属项目' })]), row]));
    }
    if (memory.emotion) {
      body.appendChild(
        ui.el('div', { class: 'detail__section' }, [
          ui.el('div', { class: 'detail__section-title' }, [ui.el('span', { text: '情绪' })]),
          ui.el('div', { class: 'fca-row', style: { flexWrap: 'wrap', gap: '4px' } }, [
            ui.tag({ label: memory.emotion.label || '未命名', tone: 'rose' }),
            ui.tag({ label: `效价 ${Number(memory.emotion.valence ?? 0).toFixed(2)}`, tone: 'neutral' }),
            ui.tag({ label: `唤醒 ${Number(memory.emotion.arousal ?? 0).toFixed(2)}`, tone: 'neutral' }),
          ]),
        ]),
      );
    }

    // 标识
    body.appendChild(
      ui.el('div', { class: 'detail__section' }, [
        ui.el('div', { class: 'detail__section-title' }, [ui.el('span', { text: '标识' })]),
        ui.el('div', { class: 'fca-mono fca-muted', style: { lineHeight: '1.9', userSelect: 'text' } }, [
          ui.el('div', { text: `id: ${memory.id}` }),
          ui.el('div', { text: `created_at: ${format.datetime(memory.created_at)}` }),
          ui.el('div', { text: `updated_at: ${format.datetime(memory.updated_at)}` }),
          ui.el('div', { text: `occurred_at: ${memory.occurred_at ? format.datetime(memory.occurred_at) : 'null'}` }),
        ]),
      ]),
    );

    // 子 Agent 会话层级（插件 v0.3 写入 tags `children:*`/`parent:*` 或层级 relations；无层级数据时自动隐藏）
    const hierarchyHost = ui.el('div', { class: 'detail__hierarchy-host', 'data-testid': 'detail-hierarchy-host' });
    body.appendChild(hierarchyHost);
    renderHierarchySection(hierarchyHost, memory, currentPayload);
    return body;
  }

  /* -------------------------------- 子 Agent 会话层级 -------------------------------- */

  function renderHierarchySection(host, memory, payload) {
    if (!host || !memory) return;
    const summary = buildHierarchySummary(memory, payload && payload.relations, hierarchyNodes());
    if (!summary.hasHierarchy) {
      host.hidden = true;
      host.innerHTML = '';
      return;
    }
    host.hidden = false;
    if (hierarchyState.memoryId !== memory.id) {
      hierarchyState = { memoryId: memory.id, expanded: false, loading: false, items: null, error: null, summary };
    } else {
      hierarchyState.summary = summary;
    }
    host.innerHTML = '';
    const section = ui.el('div', { class: 'detail__section detail__hierarchy', 'data-testid': 'detail-hierarchy' });
    section.appendChild(
      ui.el('div', { class: 'detail__section-title' }, [
        icon('brain', { size: 13 }),
        ui.el('span', { text: `子 Agent 记忆（${summary.childCount}）` }),
        summary.parentCount ? ui.el('span', { class: 'fca-muted', text: `父记忆 ${summary.parentCount}` }) : null,
      ]),
    );

    if (summary.parents.length) {
      const parentList = ui.el('div', { class: 'detail__hierarchy-parents' });
      for (const entry of summary.parents) parentList.appendChild(renderHierarchyEntry(entry, '父记忆'));
      section.appendChild(parentList);
    }

    if (summary.childCount > 0) {
      const toggle = ui.el('button', { type: 'button', class: 'detail__hierarchy-toggle', 'data-testid': 'detail-hierarchy-toggle', 'aria-expanded': hierarchyState.expanded ? 'true' : 'false' }, [
        ui.el('span', { class: 'detail__hierarchy-caret', text: hierarchyState.expanded ? '▾' : '▸' }),
        ui.el('span', { text: hierarchyState.expanded ? `收起子 Agent 记忆（${summary.childCount}）` : `展开子 Agent 记忆（${summary.childCount}）` }),
      ]);
      toggle.addEventListener('click', () => {
        hierarchyState.expanded = !hierarchyState.expanded;
        if (hierarchyState.expanded && !hierarchyState.items && !hierarchyState.loading) loadHierarchyChildren(host, memory, payload);
        else renderHierarchySection(host, memory, payload);
      });
      section.appendChild(toggle);
      const listHost = ui.el('div', { class: 'detail__hierarchy-list', hidden: !hierarchyState.expanded, 'data-testid': 'detail-hierarchy-list' });
      if (hierarchyState.expanded) {
        if (hierarchyState.loading) listHost.appendChild(ui.el('div', { class: 'detail__loading' }, [ui.spinner({ label: '读取子 Agent 记忆…' })]));
        else if (hierarchyState.error) listHost.appendChild(ui.el('div', { class: 'detail__error', text: hygieneText(hierarchyState.error) }));
        else if (Array.isArray(hierarchyState.items) && hierarchyState.items.length) {
          for (const item of hierarchyState.items) listHost.appendChild(renderHierarchyChild(item));
        }
      }
      section.appendChild(listHost);
    }
    host.appendChild(section);
  }

  /** 对象值安全转文本，避免 [object Object] */
  function hygieneText(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  function renderHierarchyEntry(entry, label) {
    const node = entry.node || null;
    const id = entry.id || (node && node.id) || null;
    const title = node ? node.label || id : id || entry.ref;
    const row = ui.el('button', { type: 'button', class: 'detail__hierarchy-parent', title: `${label} ${id || entry.ref}` }, [
      icon('relation', { size: 13 }),
      ui.el('span', { class: 'fca-grow fca-truncate', text: title }),
      ui.el('span', { class: 'fca-muted', text: label }),
    ]);
    row.addEventListener('click', () => {
      if (entry.resolved && id) {
        if (node && node.kind === 'entity') showEntity(id);
        else actions.openMemory(id);
      } else {
        toast(`未在图中找到 ${entry.ref}（可能尚未同步）`, { type: 'warn' });
      }
    });
    return row;
  }

  async function loadHierarchyChildren(host, memory, payload) {
    const summary = hierarchyState.summary || buildHierarchySummary(memory, payload && payload.relations, hierarchyNodes());
    hierarchyState.loading = true;
    hierarchyState.error = null;
    renderHierarchySection(host, memory, payload);
    const token = requestToken;
    const resolvedIds = summary.children.map((entry) => entry.id).filter(Boolean).slice(0, 30);
    const items = [];
    await Promise.all(
      resolvedIds.map(async (id) => {
        const entry = summary.children.find((item) => item.id === id) || {};
        try {
          const result = await api.getMemory(id);
          items.push(toChildMemoryItem(result && result.memory ? result.memory : null, entry.node));
        } catch {
          items.push(toChildMemoryItem(null, entry.node) || { id, title: id, type: null, time: null, bodyPreview: '' });
        }
      }),
    );
    for (const entry of summary.children) {
      if (!entry.id) items.push({ id: null, ref: entry.ref, title: `未索引子会话 ${entry.ref}`, type: null, time: null, bodyPreview: '' });
    }
    items.sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));
    if (token !== requestToken) return;
    hierarchyState.items = items;
    hierarchyState.loading = false;
    renderHierarchySection(host, memory, payload);
  }

  function renderHierarchyChild(item) {
    const testid = item.id ? `detail-hierarchy-child-${item.id}` : `detail-hierarchy-unresolved-${item.ref}`;
    const row = ui.el('button', { type: 'button', class: 'detail__hierarchy-child', 'data-testid': testid, title: item.id || item.ref || '' }, [
      icon('sparkles', { size: 13 }),
      ui.el('div', { class: 'detail__hierarchy-child-main' }, [
        ui.el('div', { class: 'detail__hierarchy-child-title fca-truncate', text: item.title || item.id || item.ref || '' }),
        ui.el('div', {
          class: 'detail__hierarchy-child-meta fca-muted',
          text: [item.type ? format.memoryTypeLabel(item.type) : null, item.time ? format.datetime(item.time) : null].filter(Boolean).join(' · ') || shortId(item.id || item.ref || ''),
        }),
        item.bodyPreview ? ui.el('div', { class: 'detail__hierarchy-child-preview', text: item.bodyPreview }) : null,
      ]),
      item.id ? icon('forward', { size: 12 }) : null,
    ]);
    if (item.id) row.addEventListener('click', () => actions.openMemory(item.id));
    else row.addEventListener('click', () => toast('该子会话记忆尚未索引到图中', { type: 'info', duration: 3000 }));
    return row;
  }

  function otherSide(relation) {
    const memoryId = currentId;
    const from = relation.from || {};
    const to = relation.to || {};
    if (from.id === memoryId) return to;
    if (to.id === memoryId) return from;
    return null;
  }

  function renderRelationsTab() {
    const body = ui.el('div', { class: 'detail__body' });
    const relations = (currentPayload && currentPayload.relations) || [];
    const header = ui.el('div', { class: 'detail__section-title' }, [ui.el('span', { text: `关联关系 · ${relations.length}` }), ui.el('span', { class: 'fca-muted', text: '点击跳转' })]);
    body.appendChild(header);
    if (!relations.length) {
      body.appendChild(ui.el('div', { class: 'fca-muted', style: { fontSize: '12px', padding: '8px 0' }, text: '该记忆暂无关联关系。' }));
      return body;
    }
    const list = ui.el('div', { class: 'detail__list' });
    for (const relation of relations) {
      const other = otherSide(relation);
      const otherId = other ? other.id : null;
      const label = actions.getNodeLabel(otherId) || otherId || '未知节点';
      const row = ui.el('button', { class: 'detail__list-item', type: 'button', title: relation.id }, [
        icon('relation', { size: 14 }),
        ui.el('span', { class: 'detail__relation-type', text: relation.label || format.relationTypeLabel(relation.relation_type) }),
        ui.el('span', { class: 'fca-grow fca-truncate', text: label }),
        ui.el('span', { class: 'fca-muted', text: other ? format.nodeKindLabel(other.kind) : '' }),
      ]);
      if (otherId) {
        row.addEventListener('click', () => {
          if (other.kind === 'memory') actions.openMemory(otherId);
          else showEntity(otherId);
        });
      }
      list.appendChild(row);
    }
    body.appendChild(list);
    return body;
  }

  async function loadVersions() {
    if (!currentId) return;
    const token = requestToken;
    versionsState = { status: 'loading', items: [], error: null };
    renderActiveTab();
    try {
      const result = await api.getVersions(currentId, { limit: 100 });
      if (token !== requestToken) return;
      const items = Array.isArray(result && result.items) ? result.items : Array.isArray(result) ? result : [];
      versionsState = { status: 'ready', items, error: null };
    } catch (error) {
      if (token !== requestToken) return;
      versionsState = { status: 'error', items: [], error: api.userMessage(error), traceId: error.traceId };
    }
    renderActiveTab();
  }

  function renderHistoryTab() {
    const body = ui.el('div', { class: 'detail__body' });
    if (versionsState.status === 'idle') {
      body.appendChild(ui.el('div', { class: 'fca-muted', style: { fontSize: '12px', padding: '8px 0' }, text: '正在加载版本历史…' }));
      loadVersions();
      return body;
    }
    if (versionsState.status === 'loading') {
      body.appendChild(ui.el('div', { class: 'detail__loading' }, [ui.spinner({ label: '加载版本历史…' })]));
      return body;
    }
    if (versionsState.status === 'error') {
      body.appendChild(ui.el('div', { class: 'detail__error', text: `版本历史加载失败：${versionsState.error}` }));
      return body;
    }
    if (!versionsState.items.length) {
      body.appendChild(ui.el('div', { class: 'fca-muted', style: { fontSize: '12px', padding: '8px 0' }, text: '暂无版本记录。' }));
      return body;
    }
    for (const version of versionsState.items) {
      const row = ui.el('button', { class: 'detail__version-row', type: 'button', title: '查看该版本快照' }, [
        ui.el('span', { class: 'detail__version-badge', text: `v${version.version}` }),
        ui.el('span', { class: 'detail__version-kind', text: format.changeKindLabel(version.change_kind) }),
        ui.el('span', { class: 'fca-grow fca-truncate fca-muted', text: version.actor ? `${version.actor.kind}:${version.actor.id}` : '' }),
        ui.el('span', { class: 'detail__version-time', text: format.datetime(version.created_at) }),
      ]);
      row.addEventListener('click', () => showVersionSnapshot(version));
      body.appendChild(row);
    }
    return body;
  }

  function showVersionSnapshot(version) {
    const snapshot = version.snapshot || {};
    ui.dialog({
      title: `版本 v${version.version} · ${format.changeKindLabel(version.change_kind)}`,
      subtitle: `${format.datetime(version.created_at)} · ${version.ver_id || ''}`,
      width: 620,
      content: ui.el('div', {}, [
        ui.el('div', { class: 'fca-form-field__label', text: snapshot.title || '（无标题）' }),
        ui.el('div', {
          class: 'detail__text',
          style: { maxHeight: '360px' },
          text: snapshot.body || '（该版本无正文快照）',
        }),
      ]),
      actions: [{ label: '关闭', variant: 'secondary' }],
    });
  }

  function renderActiveTab() {
    if (!scroll) return;
    if (!currentPayload) return;
    scroll.innerHTML = '';
    const container = ui.el('div', { class: 'detail' });
    container.appendChild(buildHeader(currentMemory));
    const tabsEl = buildTabs();
    tabsEl.style.margin = '0 var(--fca-space-4)';
    container.appendChild(ui.el('div', { style: { padding: '12px 16px 0' } }, [tabsEl]));
    let tabBody = null;
    if (currentTab === 'detail') tabBody = renderDetailTab();
    else if (currentTab === 'relations') tabBody = renderRelationsTab();
    else tabBody = renderHistoryTab();
    container.appendChild(tabBody);
    scroll.appendChild(container);
  }

  // ------------------------------------------------------------------ 实体详情
  async function showEntity(id) {
    if (!id) return clear();
    currentId = id;
    requestToken += 1;
    const token = requestToken;
    if (empty) empty.hidden = true;
    showLoading('正在读取实体…');
    setTitle('实体详情');
    try {
      const result = await api.getEntity(id);
      if (token !== requestToken) return;
      const entity = result && result.entity ? result.entity : result;
      if (!entity) throw new Error('实体不存在');
      if (entity.name) actions.cacheEntityLabel(id, entity.name);
      let relations = [];
      try {
        const relRes = await api.listRelations({ node_kind: 'entity', node_id: id });
        relations = Array.isArray(relRes && relRes.items) ? relRes.items : Array.isArray(relRes) ? relRes : [];
      } catch {
        relations = [];
      }
      if (token !== requestToken) return;
      const body = ui.el('div', { class: 'detail' });
      body.appendChild(
        ui.el('div', { class: 'detail__header' }, [
          ui.el('div', { class: 'detail__eyebrow' }, [
            ui.tag({ label: format.entityKindLabel(entity.kind), tone: 'violet' }),
            ui.badge({ label: '实体', tone: 'accent' }),
            entity.deleted_at ? ui.badge({ label: '已删除', tone: 'danger' }) : null,
          ]),
          ui.el('div', { class: 'detail__title', text: entity.name || id }),
          ui.el('div', { class: 'detail__subtitle', text: `创建于 ${format.datetime(entity.created_at)} · 版本 v${entity.version || 1}` }),
          ui.el('div', { class: 'detail__actions' }, [
            ui.button({ label: '在星图中聚焦', icon: 'compass', variant: 'secondary', size: 'sm', onClick: () => actions.focusNode(id, 2) }),
            ui.iconButton({ icon: 'copy', label: '复制 ID', size: 'sm', onClick: () => actions.copyText(id) }),
          ]),
        ]),
      );
      const detailBody = ui.el('div', { class: 'detail__body' }, [
        entity.description ? ui.el('div', { class: 'detail__text', text: entity.description }) : null,
        ui.el('div', { class: 'detail__meta-grid', style: { marginTop: '10px' } }, [
          ui.el('div', { class: 'detail__meta-cell' }, [ui.el('div', { class: 'detail__meta-label', text: '实体 ID' }), ui.el('div', { class: 'detail__meta-value', text: id, title: id })]),
          ui.el('div', { class: 'detail__meta-cell' }, [ui.el('div', { class: 'detail__meta-label', text: '别名' }), ui.el('div', { class: 'detail__meta-value', text: (entity.aliases || []).join('、') || '—' })]),
        ]),
        relations.length
          ? ui.el('div', { class: 'detail__section', style: { marginTop: '14px' } }, [
              ui.el('div', { class: 'detail__section-title' }, [ui.el('span', { text: `关联记忆/实体 · ${relations.length}` })]),
              ui.el('div', { class: 'detail__list' }, relations.map((relation) => {
                const other = relation.from && relation.from.id === id ? relation.to : relation.from;
                const otherId = other ? other.id : null;
                const row = ui.el('button', { class: 'detail__list-item', type: 'button' }, [
                  icon('relation', { size: 14 }),
                  ui.el('span', { class: 'detail__relation-type', text: relation.label || format.relationTypeLabel(relation.relation_type) }),
                  ui.el('span', { class: 'fca-grow fca-truncate', text: actions.getNodeLabel(otherId) || otherId || '' }),
                ]);
                if (otherId) row.addEventListener('click', () => (other.kind === 'memory' ? actions.openMemory(otherId) : showEntity(otherId)));
                return row;
              })),
            ])
          : null,
      ]);
      body.appendChild(detailBody);
      scroll.innerHTML = '';
      scroll.appendChild(body);
      setStatus('ready', { memory: null, relations, versionsCount: 0, layout: null, related: { kind: 'entity', id, name: entity.name } });
    } catch (error) {
      if (token !== requestToken) return;
      setStatus('error', { error: { code: error.code || 'UNKNOWN', message: api.userMessage(error) } });
      scroll.innerHTML = '';
      scroll.appendChild(ui.el('div', { class: 'detail__error', text: `读取实体失败：${api.userMessage(error)}` }));
    }
  }

  // ------------------------------------------------------------------ 自定义内容（ctx.detail.show）
  /** 把 relations.js / search.js 等传入的 action 描述对象渲染成按钮（修复 [object Object]） */
  function normalizeCustomActions(customActions) {
    const nodes = [];
    (Array.isArray(customActions) ? customActions : []).forEach((action, index) => {
      if (!action) return;
      if (action instanceof Node) {
        nodes.push(action);
        return;
      }
      if (typeof action !== 'object') return;
      const label = action.label || action.text || `操作 ${index + 1}`;
      if (typeof ui.button !== 'function') return;
      const btn = ui.button({
        label,
        icon: action.icon,
        variant: action.variant || (index === 0 ? 'primary' : 'secondary'),
        size: 'sm',
        disabled: Boolean(action.disabled),
        title: action.title || (action.kbd ? `${label} (${action.kbd})` : label),
      });
      btn.dataset.testid = action.testid || `detail-action-${index}`;
      btn.addEventListener('click', async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        try {
          const result = action.onClick ? action.onClick(btn) : undefined;
          if (result && typeof result.then === 'function') await result;
          if (action.closeOnClick) clear();
        } catch (error) {
          const message = error && error.message ? error.message : String(error);
          if (typeof toast === 'function') toast(`操作失败：${message}`, { type: 'error', duration: 5000 });
          if (log && typeof log.error === 'function') log.error('detail.action', message);
        } finally {
          if (!action.closeOnClick) btn.disabled = false;
        }
      });
      nodes.push(btn);
    });
    return nodes;
  }

  function showCustom(payload = {}) {
    const { title, subtitle, content, actions: customActions, testid } = payload;
    if (customCleanup) {
      try {
        customCleanup();
      } catch {
        /* ignore */
      }
      customCleanup = null;
    }
    currentId = null;
    currentMemory = null;
    currentPayload = null;
    requestToken += 1;
    resetVersions();
    if (empty) empty.hidden = true;
    setTitle(title || '详情');
    setStatus('ready', { memory: null, relations: [], versionsCount: 0, layout: null, targetId: null, custom: true });
    if (!scroll) return;
    scroll.innerHTML = '';
    const actionNodes = normalizeCustomActions(customActions);
    const header = ui.el('div', { class: 'detail__header' }, [
      title ? ui.el('div', { class: 'detail__title', text: title }) : null,
      subtitle ? ui.el('div', { class: 'detail__subtitle', text: subtitle }) : null,
      actionNodes.length ? ui.el('div', { class: 'detail__actions' }, actionNodes) : null,
    ]);
    scroll.appendChild(header);

    // 关键修复：为函数式 content 提供真实 host 容器（relations.js/search.js 的 content 都是 `(host) => …`），
    // 同时兼容 content 为 DOM Node / 字符串；返回值若未挂到 host 上也自动挂载，避免内容丢失。
    const host = ui.el('div', { class: 'detail__custom', 'data-testid': testid || 'detail-custom' });
    if (content instanceof Node) {
      host.appendChild(content);
    } else if (typeof content === 'function') {
      let rendered = null;
      try {
        rendered = content(host);
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        host.appendChild(ui.el('div', { class: 'detail__error', text: `详情渲染失败：${message}` }));
        if (log && typeof log.error === 'function') log.error('detail.custom', message);
      }
      if (rendered instanceof Node) {
        if (!host.contains(rendered)) host.appendChild(rendered);
      } else if (typeof rendered === 'function') {
        customCleanup = rendered;
      } else if (typeof rendered === 'string' && rendered.trim()) {
        host.appendChild(ui.el('div', { class: 'detail__text', text: rendered }));
      }
    } else if (typeof content === 'string' && content.trim()) {
      host.appendChild(ui.el('div', { class: 'detail__text', text: content }));
    }
    scroll.appendChild(host);
  }

  return {
    show,
    showEntity,
    showCustom,
    clear,
    refresh,
    updateFavorite,
    getCurrentId: () => currentId,
  };
}
