/**
 * FCA Memory Atlas — Unity ↔ Electron 选中同步（纯函数）
 *
 * 协议（与 unity-renderer 约定）：
 *  - Unity → Electron：window.postMessage({ type:'fca-unity-select',
 *        payload:{ id, kind:'memory'|'entity', title, memoryType, arm, importance, selected } }, '*')
 *    clear/取消选中：payload { id:null, selected:false } 或 { clear:true }；
 *  - Electron → Unity：iframe.contentWindow.postMessage({ type:'fca-unity-command', command }, '*')，
 *    command = 'select:<nodeId>' | 'select:clear'（跨源时无法直接调用 FCA_NEBULA，故走 postMessage 契约）。
 *
 * 本模块只做解析/去重/防回声等纯逻辑，便于 unit test；DOM 与 store 操作留在 atlas.js。
 */

export const UNITY_SELECT_MESSAGE = 'fca-unity-select';
export const UNITY_COMMAND_MESSAGE = 'fca-unity-command';
export const UNITY_COMMAND_ACK_MESSAGE = 'fca-unity-command-ack';
export const UNITY_SELECT_COMMAND_PREFIX = 'select:';
export const UNITY_DEFAULT_ECHO_WINDOW_MS = 1500;
export const UNITY_DEFAULT_THROTTLE_MS = 80;

/** 解析 Unity → Electron 选中消息；支持 data.payload 包裹与扁平两种形态 */
export function parseUnitySelectMessage(data) {
  if (!data || typeof data !== 'object') return null;
  const payload = data.payload && typeof data.payload === 'object' ? data.payload : data;
  const explicitClear = payload.clear === true || payload.selected === false;
  const rawId = payload.id ?? payload.memoryId ?? payload.nodeId ?? payload.entityId ?? null;
  const clear = explicitClear || rawId === null || rawId === undefined || rawId === '';
  if (clear) {
    return { clear: true, id: null, kind: null, payload };
  }
  const id = typeof rawId === 'string' ? rawId.trim() : String(rawId);
  if (!id) return null;
  const declaredKind = payload.kind ?? payload.nodeKind ?? payload.typeKind ?? null;
  const kind = declaredKind === 'entity' || declaredKind === 'memory'
    ? declaredKind
    : id.startsWith('ent_')
      ? 'entity'
      : 'memory';
  return {
    clear: false,
    id,
    kind,
    title: payload.title ?? payload.label ?? null,
    memoryType: payload.memoryType ?? payload.memory_type ?? null,
    arm: payload.arm ?? null,
    importance: payload.importance ?? null,
    payload,
  };
}

/** 生成页面 → Unity 的 selection command */
export function buildUnitySelectCommand(primaryId) {
  const id = typeof primaryId === 'string' ? primaryId.trim() : '';
  return id ? `${UNITY_SELECT_COMMAND_PREFIX}${id}` : 'select:clear';
}

/** 构造跨源 postMessage 命令消息 */
export function buildUnityCommandMessage(command) {
  return { type: UNITY_COMMAND_MESSAGE, command: String(command || '') };
}

/**
 * 判断 Unity 发来的选中事件是否应被接受（防回声/防重复/防节流抖动）。
 * @returns {{accept:boolean, reason:string}}
 */
export function shouldAcceptUnitySelection(options = {}) {
  const {
    incoming,
    currentPrimaryId = null,
    lastSentId = null,
    lastSentAt = 0,
    lastAcceptedId = null,
    lastAcceptedAt = 0,
    now = Date.now(),
    echoWindowMs = UNITY_DEFAULT_ECHO_WINDOW_MS,
    throttleMs = UNITY_DEFAULT_THROTTLE_MS,
  } = options;
  if (!incoming || incoming.clear) return { accept: false, reason: 'clear' };
  if (!incoming.id) return { accept: false, reason: 'no-id' };
  if (incoming.id === currentPrimaryId) return { accept: false, reason: 'same-as-current' };
  // 回声：刚由 Electron 发往 Unity 的选中命令，Unity 回推同一 id 时忽略
  if (lastSentId && incoming.id === lastSentId && lastSentAt && now - lastSentAt <= echoWindowMs) {
    return { accept: false, reason: 'echo-of-own-command' };
  }
  if (lastAcceptedId && incoming.id === lastAcceptedId && lastAcceptedAt && now - lastAcceptedAt < throttleMs) {
    return { accept: false, reason: 'throttled-duplicate' };
  }
  return { accept: true, reason: 'ok' };
}

/** 从 command 提取被选中的 id（'select:<id>' → id；'select:clear' → null） */
export function parseUnityCommand(command) {
  const text = String(command || '').trim();
  if (!text.startsWith(UNITY_SELECT_COMMAND_PREFIX)) return { verb: text, id: null };
  const id = text.slice(UNITY_SELECT_COMMAND_PREFIX.length).trim();
  return { verb: 'select', id: id && id !== 'clear' ? id : null };
}
