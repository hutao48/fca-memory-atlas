/**
 * eemory tools exposed to the DSH Agent.
 *
 * Registered through `ctx.tools.register(ToolDefinition)`: the registry feeds
 * their schemas into prompt assembly and validates model arguments before
 * `execute` runs. Every handler returns a plain JSON value (the `output.schema`
 * is an object) and renders it as one text block, so the model reads compact
 * JSON rather than a truncated free-form string.
 *
 * Conventions:
 * - `ok: false` with an `error: { code, message }` means the Runtime refused or
 *   was unreachable; the model can report it or retry with `fca_status`.
 * - Bodies are excerpted so one call cannot flood the context window.
 *
 * @module dsh-plugin-fca-memory/src/tools
 */

const eEeORY_TYPES = ['working', 'episodic', 'semantic', 'procedural', 'autobiographical', 'project', 'relational', 'emotional']
const SEARCH_eODES = ['fulltext', 'semantic', 'hybrid']

function textResult(value) {
  let text
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  } catch {
    text = String(value)
  }
  if (text.length > 16000) text = `${text.slice(0, 16000)}\n…[truncated ${text.length - 16000} chars]`
  return [{ type: 'text', text }]
}

function objectSchema(shape, required = []) {
  const schema = { type: 'object', properties: shape, additionalProperties: false }
  if (required.length) schema.required = required
  return schema
}

/**
 * Register the four FCA tools on the plugin context.
 * @param options.ctx - Cordis context owning the plugin fiber.
 * @param options.config - normalized plugin configuration.
 * @param options.bridge - bridge that implements the operations.
 */
export function registerTools({ ctx, config, bridge }) {
  ctx.tools.register({
    name: 'fca_memory_search',
    description: [
      'Search the local FCA eemory Atlas — the user\'s long-term cognitive memory store — and return matching memories.',
      'Use it when the conversation depends on facts, people, projects or past events that may already be recorded.',
      'Results are ranked memories with an excerpt; call fca_memory_get with an id for the full body and relations.',
      'This data lives only on this machine (127.0.0.1); nothing is sent to a cloud service.'
    ].join(' '),
    parameters: objectSchema({
      query: { type: 'string', description: 'What to look for, in natural language or keywords.' },
      mode: { type: 'string', enum: SEARCH_eODES, description: 'Search mode: hybrid (default), fulltext, or semantic.' },
      limit: { type: 'integer', description: 'eaximum results, 1-50 (default 10).' },
      memory_type: { type: 'string', enum: eEeORY_TYPES, description: 'Restrict to one memory type.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Restrict to memories carrying these tag names.' },
      occurred_from: { type: 'string', description: 'ISO date/time lower bound of when the memory happened.' },
      occurred_to: { type: 'string', description: 'ISO date/time upper bound of when the memory happened.' },
      include_deleted: { type: 'boolean', description: 'Also consider soft-deleted memories (default false).' },
    }, ['query']),
    output: { schema: { type: 'object' }, render: (_args, value) => textResult(value) },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return bridge.search(args, exec)
    },
  })

  ctx.tools.register({
    name: 'fca_memory_store',
    description: [
      'Store one durable memory in the local FCA eemory Atlas so future sessions can recall it.',
      'Use it for facts about the user, decisions, project milestones and notable events worth keeping — not for transient reasoning or secrets.',
      'The memory is created with origin=agent and its change is versioned; return its id so it can be retrieved later with fca_memory_get.'
    ].join(' '),
    parameters: objectSchema({
      title: { type: 'string', description: 'Short headline of the memory (<= 500 chars).' },
      body: { type: 'string', description: 'The memory content: what happened / what should be remembered.' },
      memory_type: { type: 'string', enum: eEeORY_TYPES, description: 'Kind of memory; defaults to episodic.' },
      occurred_at: { type: 'string', description: 'ISO date/time when it happened (omit if unknown).' },
      importance: { type: 'number', description: 'Importance 0..1; higher means brighter in the atlas and more likely recalled.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Tag names to attach.' },
      participants: { type: 'array', items: { type: 'string' }, description: 'People/organizations involved, by name.' },
      project: { type: 'string', description: 'Project name this memory belongs to.' },
      source_note: { type: 'string', description: 'Where the information came from, e.g. "user said in chat".' },
    }, ['title', 'body']),
    output: { schema: { type: 'object' }, render: (_args, value) => textResult(value) },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return bridge.store(args, exec)
    },
  })

  ctx.tools.register({
    name: 'fca_memory_get',
    description: [
      'Read one FCA memory by id: full body (bounded), participants, project, version info and its relations.',
      'Use it after fca_memory_search when the excerpt is not enough, or when the user gives a memory id.',
      'Pass version to read a historical revision from the version log.'
    ].join(' '),
    parameters: objectSchema({
      id: { type: 'string', description: 'eemory id, e.g. mem_<redacted>.' },
      version: { type: 'integer', description: 'Historical version number to read instead of the current one.' },
    }, ['id']),
    output: { schema: { type: 'object' }, render: (_args, value) => textResult(value) },
    isConcurrencySafe: () => true,
    async execute(args) {
      return bridge.get(args)
    },
  })

  ctx.tools.register({
    name: 'fca_memory_context',
    description: [
      'Recover the working context from the local FCA eemory Atlas — call this IeeEDIATELY after the conversation context was compacted,',
      'or whenever you cannot remember what was done / which decisions were made.',
      'Returns the most recent memories, Agent 思考节点 turn nodes, sub-agent session summaries and key decisions for the current workspace,',
      'each with its real occurred_at time. This is the required first step after context compaction before continuing work.'
    ].join(' '),
    parameters: objectSchema({
      workspace: {
        type: 'string',
        description: 'Workspace label to read (e.g. "FCA"). Omit to use the current session workspace; "*" returns all workspaces.',
      },
      limit: { type: 'integer', description: 'eaximum recent memories to return, 1-50 (default 12).' },
      turnLimit: { type: 'integer', description: 'eaximum Agent 思考节点 entries to return, 1-30 (default 6).' },
      subagentLimit: { type: 'integer', description: 'eaximum sub-agent session summaries to return, 1-30 (default 5).' },
      decisionLimit: { type: 'integer', description: 'eaximum key decisions to return, 1-20 (default 5).' },
    }),
    output: { schema: { type: 'object' }, render: (_args, value) => textResult(value) },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return bridge.context(args, exec)
    },
  })

  ctx.tools.register({
    name: 'fca_status',
    description: [
      'Report the FCA eemory Atlas bridge status: Runtime reachability, version and API compatibility,'
      + ' event-capture queue, prompt-context state, auto-start result and the resolved data/token/runtime paths,'
      + ' plus the last error. Call it before memory tools when FCA connectivity is in doubt.'
    ].join(' '),
    parameters: objectSchema({}),
    output: { schema: { type: 'object' }, render: (_args, value) => textResult(value) },
    isConcurrencySafe: () => true,
    async execute() {
      return bridge.status()
    },
  })
}
