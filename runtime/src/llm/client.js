// FCA Local Runtime — LLM Provider HTTP 客户端（OpenAI-compatible /chat/completions，零第三方依赖）
// 错误分类（供路由层决定排队重试还是如实报错）：
//   configuration: 400/401/403/404/422 —— 配置/密钥/模型名不对，排队重试无意义，必须如实报错；
//   transient:     408/425/429/5xx/网络错误/超时 —— 入离线队列，按退避重试。
import { PRODUCT_VERSION } from '../config/index.js';

export const CHAT_COMPLETIONS_PATH = '/chat/completions';

export class LlmCallError extends Error {
  /**
   * @param {'configuration'|'transient'} classification
   * @param {string} code 契约 §7 错误码（LLM_NOT_CONFIGURED / LLM_UNAVAILABLE）
   * @param {string} message
   * @param {object} [details]
   */
  constructor(classification, code, message, details = {}) {
    super(message);
    this.name = 'LlmCallError';
    this.classification = classification;
    this.code = code;
    this.details = details;
    this.reason = details.reason ?? null;
  }
}

/** 由 provider.base_url 推导 chat/completions 完整 URL；允许直接配置完整端点。 */
export function buildChatUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || !/^https?:\/\//i.test(baseUrl.trim())) {
    throw new LlmCallError('configuration', 'LLM_NOT_CONFIGURED', 'Provider 未配置合法的 Base URL（需要 http(s) URL）', {
      reason: 'invalid_base_url',
    });
  }
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return /\/chat\/completions$/i.test(trimmed) ? trimmed : `${trimmed}${CHAT_COMPLETIONS_PATH}`;
}

export function classifyHttpStatus(status) {
  if (status === 400 || status === 401 || status === 403 || status === 404 || status === 422) return 'configuration';
  if (status === 408 || status === 425 || status === 429) return 'transient';
  if (status >= 500) return 'transient';
  return 'transient';
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new LlmCallError('configuration', 'BAD_REQUEST', 'messages 必须是非空数组');
  }
  return messages.map((message, index) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new LlmCallError('configuration', 'BAD_REQUEST', `messages[${index}] 必须是对象`);
    }
    const role = String(message.role ?? '');
    if (!['system', 'user', 'assistant'].includes(role)) {
      throw new LlmCallError('configuration', 'BAD_REQUEST', `messages[${index}].role 必须是 system|user|assistant`);
    }
    let content = message.content;
    if (Array.isArray(content)) {
      // 仅支持纯文本 part 数组，避免把二进制/图片上传给第三方
      content = content
        .map((part) => (part && typeof part === 'object' && typeof part.text === 'string' ? part.text : ''))
        .filter(Boolean)
        .join('\n');
    }
    if (typeof content !== 'string') {
      throw new LlmCallError('configuration', 'BAD_REQUEST', `messages[${index}].content 必须是字符串`);
    }
    const maxChars = 60_000;
    return { role, content: content.length > maxChars ? content.slice(0, maxChars) : content };
  });
}

function extractText(data) {
  const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
  const message = choice?.message ?? null;
  const text = typeof message?.content === 'string'
    ? message.content
    : typeof choice?.text === 'string'
      ? choice.text
      : typeof data?.content === 'string'
        ? data.content
        : null;
  const reasoning = typeof message?.reasoning_content === 'string' ? message.reasoning_content : null;
  return { text: text && text.trim() ? text : null, reasoning, finishReason: choice?.finish_reason ?? null };
}

/**
 * 创建 LLM 客户端。fetchImpl 可注入（测试用），默认为全局 fetch；真实调用仍是标准 HTTP。
 */
export function createLlmClient({ fetchImpl = globalThis.fetch, logger = null } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('createLlmClient 需要可用的 fetch');

  /**
   * @param {{id:string,name:string,kind:string,baseUrl:string,model:string,timeoutMs:number,apiKey:string|null}} provider
   * @param {Array<{role:string,content:string}>} messages
   * @param {{max_tokens?:number, temperature?:number, timeoutMs?:number}} [options]
   */
  async function chat(provider, messages, options = {}) {
    const url = buildChatUrl(provider.baseUrl);
    const safeMessages = sanitizeMessages(messages);
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : Number(provider.timeoutMs) || 30_000;
    const body = { model: provider.model, messages: safeMessages, stream: false };
    if (Number.isFinite(Number(options.max_tokens)) && Number(options.max_tokens) > 0) {
      body.max_tokens = Math.min(32_768, Math.floor(Number(options.max_tokens)));
    }
    if (Number.isFinite(Number(options.temperature)) && Number(options.temperature) >= 0 && Number(options.temperature) <= 2) {
      body.temperature = Number(options.temperature);
    }
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': `fca-runtime/${PRODUCT_VERSION}`,
    };
    if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        const aborted = err?.name === 'AbortError' || controller.signal.aborted;
        throw new LlmCallError(
          'transient',
          'LLM_UNAVAILABLE',
          aborted ? `LLM API 调用超时（>${timeoutMs}ms）` : `LLM API 网络不可达：${err?.message ?? String(err)}`,
          { reason: aborted ? 'timeout' : 'network_error', provider_id: provider.id, url },
        );
      }
      const elapsed = Date.now() - started;
      const rawText = await response.text().catch(() => '');
      let data = null;
      try {
        data = rawText ? JSON.parse(rawText) : null;
      } catch {
        data = null;
      }
      if (!response.ok) {
        const classification = classifyHttpStatus(response.status);
        const providerMessage =
          (data && (data.error?.message ?? data.message)) || rawText.slice(0, 300) || `HTTP ${response.status}`;
        const code = classification === 'configuration' ? 'LLM_NOT_CONFIGURED' : 'LLM_UNAVAILABLE';
        throw new LlmCallError(classification, code, `LLM API 返回 HTTP ${response.status}：${providerMessage}`, {
          reason: classification === 'configuration' ? 'provider_rejected' : 'provider_unavailable',
          provider_id: provider.id,
          provider_name: provider.name,
          provider_http_status: response.status,
          elapsed_ms: elapsed,
          url,
        });
      }
      const extracted = extractText(data);
      if (!extracted.text) {
        throw new LlmCallError('transient', 'LLM_UNAVAILABLE', 'LLM API 响应中没有文本内容（未伪装成功）', {
          reason: 'empty_response',
          provider_id: provider.id,
          provider_http_status: response.status,
          elapsed_ms: elapsed,
          url,
        });
      }
      logger?.debug?.('LLM API 调用成功', {
        provider_id: provider.id,
        model: provider.model,
        elapsed_ms: elapsed,
        usage: data?.usage ?? null,
      });
      return {
        text: extracted.text,
        reasoning: extracted.reasoning,
        finish_reason: extracted.finishReason,
        model: data?.model ?? provider.model,
        usage: data?.usage ?? null,
        provider: { id: provider.id, name: provider.name, kind: provider.kind },
        elapsed_ms: elapsed,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return { chat, buildChatUrl };
}
