/**
 * FCA Memory Atlas — 右侧详情面板
 * 契约：lib/contracts.md §2.4 ctx.detail（Shell 内置面板）
 *
 * 真实数据来源：GET /memory/{id}（memory + relations + layout + versions_count）、
 * GET /memory/{id}/versions、GET /entities/{id}。无数据时显示加载/错误态，不展示伪造内容。
 */

import { icon } from '../ui/icons.js';

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
    return body;
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
  function showCustom(payload = {}) {
    const { title, subtitle, content, actions: customActions } = payload;
    if (customCleanup) {
      customCleanup();
      customCleanup = null;
    }
    currentId = null;
    requestToken += 1;
    if (empty) empty.hidden = true;
    setTitle(title || '详情');
    scroll.innerHTML = '';
    const header = ui.el('div', { class: 'detail__header' }, [
      title ? ui.el('div', { class: 'detail__title', text: title }) : null,
      subtitle ? ui.el('div', { class: 'detail__subtitle', text: subtitle }) : null,
      customActions && customActions.length ? ui.el('div', { class: 'detail__actions' }, customActions) : null,
    ]);
    scroll.appendChild(header);
    if (content instanceof Node) scroll.appendChild(content);
    else if (typeof content === 'function') {
      const rendered = content();
      if (rendered instanceof Node) scroll.appendChild(rendered);
    }
    setStatus('ready');
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
