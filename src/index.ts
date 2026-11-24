import { existsSync, watch, type FSWatcher } from "node:fs"

import { configFilePaths, loadProviderOptions, type AutodiscoveryOptions, type ProviderConfig } from "./config.ts"
import {
  buildCatalogIndex,
  buildModelInfo,
  buildProviderInfo,
  fetchInventory,
  type CatalogIndex,
  type CatalogRecord,
  type ModelInfo,
  type ProviderInfo,
} from "./discovery.ts"
import { matchesFilters } from "./glob.ts"
import { Autodiscovery } from "./rpc.ts"

interface ProviderRecordView {
  provider: ProviderInfo
  models: ReadonlyMap<string, ModelInfo>
}

interface ProviderEditor {
  list(): readonly ProviderRecordView[]
  get(providerID: string): ProviderRecordView | undefined
  add(input: { info: ProviderInfo; models: readonly ModelInfo[] }): void
  update(providerID: string, update: (provider: Record<string, unknown>) => void): void
  models: { set(providerID: string, models: readonly ModelInfo[]): void }
}

interface ConnectionInfo {
  type: string
  id: string
  label?: string
  method?: string
}

interface PluginContext {
  location?: { directory?: string; project?: { canonical?: string } }
  options?: unknown
  provider: {
    transform(callback: (editor: ProviderEditor) => void): Promise<{ dispose(): Promise<void> }>
    reload(): Promise<void>
  }
  integration?: {
    get(input: { integrationID: string }): Promise<{ connections?: readonly ConnectionInfo[] }>
    connection: {
      active(integrationID: string): Promise<ConnectionInfo | undefined>
      resolve(connection: ConnectionInfo): Promise<unknown>
    }
  }
  rpc?: {
    register(
      definition: typeof Autodiscovery,
      handlers: { refresh(): Promise<{ providers: number; models: number; errors: number }> },
    ): Promise<{ dispose(): Promise<void> }>
  }
  event?: {
    subscribe(options?: { types?: string[]; signal?: AbortSignal }): AsyncIterable<{ type: string }>
  }
  storage?: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
  }
}

interface State {
  providerID: string
  options: AutodiscoveryOptions
  config: ProviderConfig
  info?: ProviderInfo
  models: ModelInfo[]
  endpoint?: string
  error?: string
}

function log(debug: boolean, ...values: unknown[]): void {
  if (debug) console.log("[autodiscovery]", ...values)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function credentialSecret(value: unknown): string | undefined {
  const credential = asRecord(value)
  if (credential.type === "key" && typeof credential.key === "string") return credential.key
  if (credential.type === "oauth" && typeof credential.access === "string") return credential.access
  if (typeof credential.token === "string") return credential.token
  return undefined
}

/** Config keys, environment variables and every saved OpenCode credential for the provider. */
async function credentialCandidates(
  ctx: PluginContext,
  state: State,
): Promise<string[]> {
  const secrets: string[] = []
  const add = (value: unknown) => {
    if (typeof value === "string" && value.length > 0 && !secrets.includes(value)) secrets.push(value)
  }
  const settings = { ...state.config.settings, ...asRecord(state.info?.settings) }
  add(settings.apiKey)
  add(settings.api_key)
  add(settings.token)
  for (const name of state.config.env ?? state.info?.env ?? []) add(process.env[name])

  const integrationID = state.info?.integrationID ?? state.providerID
  const integration = ctx.integration
  if (integration?.get && integration.connection?.resolve) {
    try {
      const active = await integration.connection.active(integrationID)
      if (active) add(credentialSecret(await integration.connection.resolve(active)))
      const info = await integration.get({ integrationID })
      for (const connection of info.connections ?? []) {
        add(credentialSecret(await integration.connection.resolve(connection)))
      }
    } catch (error) {
      console.warn(`[autodiscovery] ${state.providerID}: could not read saved credentials:`, error)
    }
  }
  return secrets
}

/** Same catalog name for several gateway aliases? Add a segment from each ID so the UI can tell them apart. */
function disambiguateNames(models: ModelInfo[]): void {
  const groups = new Map<string, ModelInfo[]>()
  for (const model of models) {
    const group = groups.get(model.name) ?? []
    group.push(model)
    groups.set(model.name, group)
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue
    for (const model of group) {
      const others = group.filter((other) => other !== model)
      const segments = model.id.split("/").slice(0, -1)
      const distinct = segments.find((segment) => others.every((other) => !other.id.split("/").includes(segment)))
      const suffix = distinct ?? (others.every((other) => other.id.split("/").length > segments.length) ? "short" : undefined)
      if (suffix && !model.name.endsWith(`(${suffix})`)) model.name = `${model.name} (${suffix})`
    }
  }
}

async function cachedModels(ctx: PluginContext, providerID: string): Promise<ModelInfo[] | undefined> {
  try {
    const value = await ctx.storage?.get(`autodiscovery:${providerID}`)
    return Array.isArray(value) ? (value as ModelInfo[]) : undefined
  } catch {
    return undefined
  }
}

async function saveModels(ctx: PluginContext, providerID: string, models: readonly ModelInfo[]): Promise<void> {
  try {
    await ctx.storage?.set(`autodiscovery:${providerID}`, models as unknown as Record<string, unknown>)
  } catch {
    // Caching is best effort.
  }
}

export default {
  id: "autodiscovery",
  async setup(ctx: PluginContext) {
    let catalog: CatalogIndex = { byID: new Map(), byTail: new Map() }
    let records: readonly CatalogRecord[] = []

    // Capture the source catalog first: transforms replay in registration order.
    await ctx.provider.transform((editor) => {
      records = editor.list().map((record) => ({
        provider: { ...record.provider },
        models: [...record.models.values()].map((model) => ({ ...model })),
      }))
      catalog = buildCatalogIndex(records)
    })

    const states = new Map<string, State>()
    const syncStates = async () => {
      for (const [providerID, entry] of loadProviderOptions(ctx)) {
        if (entry.options.enabled !== true) {
          states.delete(providerID)
          continue
        }
        const existing = states.get(providerID)
        const info = records.find((record) => record.provider.id === providerID)?.provider
          ?? existing?.info
          ?? buildProviderInfo(providerID, entry.config, entry.options)
        if (existing) {
          existing.options = entry.options
          existing.config = entry.config
          existing.info = info
        } else {
          states.set(providerID, {
            providerID,
            options: entry.options,
            config: entry.config,
            info,
            models: (await cachedModels(ctx, providerID)) ?? [],
          })
        }
      }
    }
    await syncStates()

    await ctx.provider.transform((editor) => {
      for (const state of states.values()) {
        const filters = state.options.filters
        const discovered = state.models.filter((model) => matchesFilters(model.id, filters))
        const discoveredIDs = new Set(state.models.map((model) => model.id))
        const existing = editor.get(state.providerID)
        const manual = (existing ? [...existing.models.values()] : [])
          .filter((model) => !discoveredIDs.has(model.id))

        if (!existing) {
          editor.add({
            info: buildProviderInfo(state.providerID, state.config, state.options, state.info),
            models: [...manual, ...discovered],
          })
          continue
        }

        editor.models.set(state.providerID, [...manual, ...discovered])
        if (state.options.baseURL) {
          editor.update(state.providerID, (provider) => {
            provider.settings = { ...(provider.settings as Record<string, unknown> | undefined), baseURL: state.options.baseURL }
          })
        }
      }
    })

    const reapply = async (): Promise<void> => {
      await syncStates()
      await ctx.provider.reload()
    }

    let refreshing: Promise<{ providers: number; models: number; errors: number }> | undefined
    const refresh = () => {
      if (refreshing) return refreshing
      refreshing = (async () => {
        await syncStates()
        let models = 0
        let errors = 0
        for (const state of states.values()) {
          const debug = state.options.debug === true
          try {
            const provider = state.info ?? buildProviderInfo(state.providerID, state.config, state.options)
            const credentials = await credentialCandidates(ctx, state)
            log(debug, `${state.providerID}: trying ${credentials.length} credential(s)`)
            const inventory = await fetchInventory(provider, state.config, state.options, debug, credentials)
            const previous = new Map(state.models.map((model) => [model.id, model]))
            const activeCatalog: CatalogIndex = state.options.catalog === false
              ? { byID: new Map(), byTail: new Map() }
              : catalog
            state.models = inventory.models.map((entry) => buildModelInfo(
              entry,
              state.providerID,
              activeCatalog,
              state.config.models?.[entry.id],
              previous.get(entry.id),
            ))
            disambiguateNames(state.models)
            state.endpoint = inventory.endpoint
            state.error = undefined
            models += state.models.length
            await saveModels(ctx, state.providerID, state.models)
            log(debug, `${state.providerID}: discovered ${state.models.length} model(s) from ${inventory.endpoint}`)
          } catch (error) {
            errors++
            state.error = error instanceof Error ? error.message : String(error)
            console.warn(`[autodiscovery] ${state.providerID}: discovery failed: ${state.error}`)
          }
        }
        await ctx.provider.reload()
        return { providers: states.size, models, errors }
      })().finally(() => {
        refreshing = undefined
      })
      return refreshing
    }

    const cleanup: (() => void)[] = []
    if (ctx.rpc?.register) {
      const registration = await ctx.rpc.register(Autodiscovery, { refresh })
      cleanup.push(() => void registration.dispose())
    }

    const watchers: FSWatcher[] = []
    let watchDebounce: ReturnType<typeof setTimeout> | undefined
    for (const file of configFilePaths(ctx)) {
      if (!existsSync(file)) continue
      try {
        watchers.push(watch(file, () => {
          if (watchDebounce) clearTimeout(watchDebounce)
          watchDebounce = setTimeout(() => void reapply().catch((error) => console.warn("[autodiscovery] config reload failed:", error)), 250)
        }))
      } catch {
        // Not all platforms can watch individual files.
      }
    }
    cleanup.push(() => {
      if (watchDebounce) clearTimeout(watchDebounce)
      watchers.forEach((watcher) => watcher.close())
    })

    const eventContext = ctx.event
    if (eventContext?.subscribe) {
      const controller = new AbortController()
      void (async () => {
        try {
          for await (const event of eventContext.subscribe({ types: ["config.updated"], signal: controller.signal })) {
            if (event.type === "config.updated") await reapply()
          }
        } catch (error) {
          if (!controller.signal.aborted) console.warn("[autodiscovery] event subscription failed:", error)
        }
      })()
      cleanup.push(() => controller.abort())
    }

    return () => cleanup.forEach((dispose) => dispose())
  },
}
