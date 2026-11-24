import type { AutodiscoveryOptions, ProviderConfig } from "./config.ts"

export interface ModelInfo {
  id: string
  modelID: string
  providerID: string
  name: string
  family?: string
  type?: string
  capabilities: { tools: boolean; input: string[]; output: string[]; temperature?: boolean }
  variants: Record<string, unknown>[]
  time: { released: number }
  cost: Record<string, unknown>[]
  status: string
  enabled: boolean
  limit: { context: number; input?: number; output: number }
  settings?: Record<string, unknown>
  headers?: Record<string, string>
  body?: Record<string, unknown>
  compatibility?: Record<string, unknown>
  package?: string
}

export interface ProviderInfo {
  id: string
  name: string
  activation: string
  package: string
  settings?: Record<string, unknown>
  headers?: Record<string, string>
  body?: Record<string, unknown>
  variants?: unknown
  canonical?: string
  integrationID?: string
  env?: readonly string[]
}

export interface CatalogRecord {
  provider: ProviderInfo
  models: readonly ModelInfo[]
}

export interface CatalogIndex {
  byID: Map<string, ModelInfo>
  byTail: Map<string, ModelInfo>
}

export interface RawModel {
  id: string
  raw: Record<string, unknown>
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value)
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.replace(/[$,_\s]/g, ""))
    if (Number.isFinite(parsed)) return Math.floor(parsed)
  }
  return undefined
}

function pick(source: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = source[key]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

function pickNumber(source: Record<string, unknown>, keys: readonly string[]): number | undefined {
  return num(pick(source, keys))
}

function nested(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown>[] {
  return keys.map((key) => obj(source[key])).filter((value) => Object.keys(value).length > 0)
}

function firstNestedNumber(source: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const child of nested(source, keys)) {
    const value = pickNumber(child, [
      "context", "context_length", "context_window", "max_model_len", "max_context", "max_tokens",
    ])
    if (value !== undefined) return value
  }
  return undefined
}

const CONTEXT_KEYS = [
  "context", "context_length", "context_window", "context_window_tokens", "max_context",
  "max_context_length", "max_model_len", "max_sequence_length", "max_position_embeddings",
]
const OUTPUT_KEYS = ["output", "max_output_tokens", "max_completion_tokens", "max_tokens", "output_token_limit", "max_new_tokens"]
const TOOL_KEYS = ["tools", "tool_call", "tool_calling", "function_calling", "supports_tools", "supports_tool_use"]
const FEATURE_KEYS = ["supported_features", "features", "capabilities", "feature_support"]

function normalizeID(id: string): string {
  return id.trim().toLowerCase()
}

function tail(id: string): string {
  const parts = id.split("/")
  return parts[parts.length - 1] ?? id
}

export function buildCatalogIndex(records: readonly CatalogRecord[]): CatalogIndex {
  const byID = new Map<string, ModelInfo>()
  const byTail = new Map<string, ModelInfo>()
  const insert = (key: string, model: ModelInfo) => {
    if (key && !byID.has(key)) byID.set(key, model)
  }
  for (const record of records) {
    for (const model of record.models) {
      const info = clone(model)
      insert(normalizeID(model.id), info)
      insert(normalizeID(model.modelID), info)
      insert(normalizeID(`${record.provider.id}/${model.id}`), info)
      const key = normalizeID(tail(model.id))
      if (key && !byTail.has(key)) byTail.set(key, info)
    }
  }
  return { byID, byTail }
}

export function lookupCatalog(index: CatalogIndex, id: string): ModelInfo | undefined {
  const direct = index.byID.get(normalizeID(id))
  if (direct) return direct
  const last = normalizeID(tail(id))
  const byTail = index.byTail.get(last)
  if (byTail) return byTail
  const base = last.replace(/-(?:fast|lite|thinking|nothink|flash|exp)$/, "")
  return index.byTail.get(base)
}

function modelID(entry: Record<string, unknown>, fallback: string): string {
  const value = pick(entry, ["id", "name", "model", "model_id", "modelID"])
  return typeof value === "string" && value.length > 0 ? value : fallback
}

function parseInventory(payload: unknown): RawModel[] {
  const source = obj(payload)
  const entries = arr(pick(source, ["data", "models", "items", "results"]) ?? payload)
  const models: RawModel[] = []
  for (const entry of entries) {
    if (typeof entry === "string") {
      models.push({ id: entry, raw: { id: entry } })
      continue
    }
    const raw = obj(entry)
    const id = modelID(raw, "")
    if (!id) continue
    // Ollama-style cards describe embeddings separately.
    const kind = pick(raw, ["type", "model_type", "capability"])
    if (typeof kind === "string" && /embed/i.test(kind)) continue
    models.push({ id, raw })
  }
  return models
}

function url(base: string, suffix: string): string {
  if (/^https?:\/\//i.test(suffix)) return suffix
  return `${base.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`
}

function candidates(baseURL: string, options: AutodiscoveryOptions): string[] {
  const base = baseURL.replace(/\/+$/, "").replace(/\/models$/, "")
  const paths: string[] = []
  if (options.modelsPath) paths.push(url(base, options.modelsPath))
  if (/\/v\d+$/.test(base)) {
    paths.push(`${base}/models`)
  } else {
    paths.push(`${base}/v1/models`, `${base}/models`)
  }
  for (const extra of options.extraPaths ?? []) paths.push(url(base, extra))
  const root = base.replace(/(?:\/v\d+)?$/, "")
  paths.push(`${root}/api/tags`, `${root}/api/v1/models`)
  return [...new Set(paths)]
}

function authHeaders(secret: string | undefined, provider: ProviderInfo, config: ProviderConfig, options: AutodiscoveryOptions): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(config.headers ?? {}),
    ...(provider.headers ?? {}),
    ...(options.headers ?? {}),
  }
  if (secret && !Object.keys(headers).some((key) => key.toLowerCase() === "authorization")) {
    headers.Authorization = `Bearer ${secret}`
  }
  return headers
}

function configuredSecrets(provider: ProviderInfo, config: ProviderConfig): string[] {
  const settings = { ...config.settings, ...obj(provider.settings) }
  const secrets: string[] = []
  const add = (value: unknown) => {
    if (typeof value === "string" && value.length > 0 && !secrets.includes(value)) secrets.push(value)
  }
  add(pick(settings, ["apiKey", "api_key", "token"]))
  for (const name of config.env ?? provider.env ?? []) add(process.env[name])
  return secrets
}

export interface DiscoverySource {
  models: RawModel[]
  endpoint: string
}

/**
 * Fetch the endpoint's model inventory. Every candidate credential is tried on
 * each endpoint until one returns a usable list; the first successful credential
 * wins and the remaining candidates are skipped.
 */
export async function fetchInventory(
  provider: ProviderInfo,
  config: ProviderConfig,
  options: AutodiscoveryOptions,
  debug = false,
  credentials: readonly string[] = [],
): Promise<DiscoverySource> {
  const baseURL = options.baseURL
    ?? pick({ ...config.settings, ...obj(provider.settings) }, ["baseURL", "base_url", "url"])
  if (typeof baseURL !== "string" || baseURL.length === 0) throw new Error("provider has no baseURL")
  const secrets: (string | undefined)[] = [...new Set<string | undefined>([...credentials, ...configuredSecrets(provider, config)])]
  if (secrets.length === 0) secrets.push(undefined)
  const timeout = options.timeoutMs ?? 10_000
  const failures: string[] = []
  let empty: DiscoverySource | undefined

  for (const endpoint of candidates(baseURL, options)) {
    for (const [index, secret] of secrets.entries()) {
      try {
        const response = await fetch(endpoint, {
          headers: authHeaders(secret, provider, config, options),
          signal: AbortSignal.timeout(timeout),
        })
        if (!response.ok) {
          failures.push(`${new URL(endpoint).pathname}:${response.status}/credential-${index + 1}`)
          continue
        }
        const models = parseInventory(await response.json())
        if (debug) console.log(`[autodiscovery] ${provider.id}: ${models.length} models from ${endpoint} using credential ${index + 1}`)
        if (models.length > 0) return { models, endpoint }
        if (options.modelsPath || (options.extraPaths?.length ?? 0) > 0) return { models, endpoint }
        empty ??= { models, endpoint }
      } catch (error) {
        failures.push(`${new URL(endpoint).pathname}:error/credential-${index + 1}`)
        if (debug) console.warn(`[autodiscovery] ${provider.id}: ${endpoint} failed with credential ${index + 1}:`, error)
      }
    }
  }
  if (empty) return empty
  throw new Error(`no model inventory from ${baseURL} (${failures.slice(-12).join(", ")})`)
}

function media(value: unknown, fallback: string[]): string[] {
  const list = arr(value).filter((entry): entry is string => typeof entry === "string")
  const result = [...new Set(list.map((entry) => entry.toLowerCase()))]
  if (result.length === 0) return fallback
  if (!result.includes("text")) result.unshift("text")
  return result
}

interface Metadata {
  context?: number
  inputLimit?: number
  output: number
  tools?: boolean
  input: string[]
  outputMedia: string[]
  variants: Record<string, unknown>[]
  cost?: Record<string, unknown>
  name?: string
  family?: string
  status?: string
  released?: number
}

export function extractMetadata(raw: Record<string, unknown>, catalog?: ModelInfo): Metadata {
  const sources = [raw, ...nested(raw, ["meta", "metadata", "modelinfo", "model_info", "info", "limits", "limit"])]
  const context = sources.map((source) => pickNumber(source, CONTEXT_KEYS) ?? firstNestedNumber(source, ["top_provider", "max"])).find((value) => value !== undefined)
  const output = sources.map((source) => pickNumber(source, OUTPUT_KEYS) ?? pickNumber(obj(source.top_provider), ["max_completion_tokens", "max_tokens"])).find((value) => value !== undefined)

  let tools: boolean | undefined
  for (const source of [raw, ...nested(raw, FEATURE_KEYS), ...nested(raw, ["meta", "metadata", "modelinfo"])]) {
    const value = pick(source, TOOL_KEYS) ?? (Array.isArray(pick(source, ["supported_features", "features"]))
      ? arr(pick(source, ["supported_features", "features"])).some((entry) => typeof entry === "string" && /tool|function_call/i.test(entry))
      : undefined)
    if (typeof value === "boolean") {
      tools = value
      break
    }
  }

  const mediaSources = [raw, ...nested(raw, ["meta", "metadata", "modelinfo"])]
  const inputSource = mediaSources.map((source) => pick(source, ["input", "modalities", "input_modalities", "input_types"])).find((value) => value !== undefined)
  const outputSource = mediaSources.map((source) => pick(source, ["output", "modalities", "output_modalities", "output_types"])).find((value) => value !== undefined)
  const input = media(obj(inputSource).input ?? inputSource, catalog?.capabilities.input ?? ["text"])
  const outputMedia = media(obj(outputSource).output ?? outputSource, catalog?.capabilities.output ?? ["text"])
  if (pick(raw, ["attachment", "vision", "image", "supports_image"]) === true && !input.includes("image")) input.push("image")
  if (pick(raw, ["audio", "supports_audio"]) === true && !input.includes("audio")) input.push("audio")

  const variants: Record<string, unknown>[] = []
  for (const value of arr(pick(raw, ["variants"]))) {
    const variant = obj(value)
    if (typeof variant.id === "string") variants.push(variant)
  }
  for (const option of arr(pick(raw, ["reasoning_options", "reasoningOptions"]))) {
    const entry = obj(option)
    if (entry.type === "effort") {
      for (const effort of arr(entry.values)) {
        if (typeof effort === "string") variants.push({ id: effort, settings: { reasoningEffort: effort } })
      }
    } else if (entry.type === "toggle") {
      variants.push({ id: "none", settings: { reasoningEffort: "none" } })
    }
  }

  const costRaw = pick(raw, ["cost", "pricing", "price"])
  let cost: Record<string, unknown> | undefined
  if (costRaw !== undefined) {
    const price = obj(costRaw)
    const read = pick(price, ["cache_read", "cacheRead", "input_cached"])
    cost = {
      input: pick(price, ["input", "prompt"]) ?? 0,
      output: pick(price, ["output", "completion"]) ?? 0,
      cache: { read: read ?? 0, write: pick(price, ["cache_write", "cacheWrite"]) ?? 0 },
    }
  }

  const releasedRaw = pick(raw, ["release_date", "releaseDate", "created", "created_at", "last_updated"])
  const released = typeof releasedRaw === "number"
    ? releasedRaw
    : typeof releasedRaw === "string" && /^\d{4}-\d{2}/.test(releasedRaw)
      ? Date.parse(`${releasedRaw.slice(0, 10)}T00:00:00Z`)
      : num(releasedRaw)

  return {
    context,
    inputLimit: sources.map((source) => pickNumber(source, ["max_input_tokens", "input_token_limit", "prompt_tokens"])).find((value) => value !== undefined),
    output: output ?? catalog?.limit.output ?? 32_000,
    tools,
    input,
    outputMedia,
    variants,
    cost,
    name: typeof raw.name === "string" ? raw.name : undefined,
    family: typeof raw.family === "string" ? raw.family : undefined,
    status: typeof raw.status === "string" ? raw.status : undefined,
    released,
  }
}

function emptyModel(providerID: string, id: string): ModelInfo {
  return {
    id,
    modelID: id,
    providerID,
    name: id,
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 200_000, output: 32_000 },
  }
}

/** Merge endpoint metadata, catalog defaults and explicit config overrides into a model definition. */
export function buildModelInfo(
  discovered: RawModel,
  providerID: string,
  catalog: CatalogIndex,
  configOverride?: Record<string, unknown>,
  existing?: ModelInfo,
): ModelInfo {
  const reference = lookupCatalog(catalog, discovered.id) ?? existing
  const model: ModelInfo = {
    ...emptyModel(providerID, discovered.id),
    ...clone(reference ?? {}),
    id: discovered.id,
    modelID: typeof discovered.raw.modelID === "string" ? discovered.raw.modelID : discovered.id,
    providerID,
  }
  const meta = extractMetadata(discovered.raw, reference)
  model.name = meta.name ?? reference?.name ?? discovered.id
  if (meta.family) model.family = meta.family
  if (meta.status) model.status = meta.status
  if (meta.released) model.time = { released: meta.released }
  model.limit = {
    ...model.limit,
    context: meta.context ?? (meta.inputLimit && meta.output ? meta.inputLimit + meta.output : model.limit.context),
    output: meta.output,
    ...(meta.inputLimit ? { input: meta.inputLimit } : {}),
  }
  model.capabilities = {
    ...model.capabilities,
    tools: meta.tools ?? model.capabilities.tools,
    input: meta.input,
    output: meta.outputMedia,
  }
  if (meta.variants.length > 0) {
    const ids = new Set(meta.variants.map((variant) => variant.id))
    model.variants = [...model.variants.filter((variant) => !ids.has(variant.id)), ...meta.variants]
  }
  if (meta.cost) model.cost = [meta.cost]

  if (configOverride) {
    for (const key of ["name", "family", "modelID", "type", "settings", "headers", "body", "compatibility", "package"]) {
      if (configOverride[key] !== undefined) {
        ;(model as unknown as Record<string, unknown>)[key] = clone(configOverride[key])
      }
    }
    if (configOverride.limit) model.limit = { ...model.limit, ...obj(configOverride.limit) }
    if (configOverride.capabilities) model.capabilities = { ...model.capabilities, ...obj(configOverride.capabilities) }
    if (Array.isArray(configOverride.variants)) {
      const ids = new Set(configOverride.variants.map((variant) => obj(variant).id))
      model.variants = [...model.variants.filter((variant) => !ids.has(variant.id)), ...configOverride.variants.map((variant) => clone(obj(variant)))]
    }
    if (configOverride.cost !== undefined) model.cost = Array.isArray(configOverride.cost) ? configOverride.cost.map((value) => clone(obj(value))) : [clone(obj(configOverride.cost))]
    if (configOverride.disabled === true) model.enabled = false
    const reasoning = obj(obj(configOverride.capabilities).reasoning)
    if (reasoning.supported === true && Array.isArray(reasoning.effort)) {
      for (const effort of reasoning.effort) {
        if (typeof effort === "string" && !model.variants.some((variant) => variant.id === effort)) {
          model.variants.push({ id: effort, settings: { reasoningEffort: effort } })
        }
      }
    }
  }
  return model
}

export function buildProviderInfo(providerID: string, config: ProviderConfig, options: AutodiscoveryOptions, fallback?: ProviderInfo): ProviderInfo {
  const settings = { ...config.settings, ...obj(fallback?.settings) }
  if (options.baseURL) settings.baseURL = options.baseURL
  return {
    id: providerID,
    name: config.name ?? fallback?.name ?? providerID,
    activation: "enabled",
    package: config.package ?? fallback?.package ?? "@opencode/ai/providers/openai-compatible",
    canonical: config.canonical ?? fallback?.canonical,
    settings,
    headers: { ...config.headers, ...fallback?.headers, ...options.headers },
    body: { ...config.body, ...fallback?.body },
  }
}
