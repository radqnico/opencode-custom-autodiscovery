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

interface PluginContext {
  location?: { directory?: string; project?: { canonical?: string } }
  options?: unknown
  provider: {
    transform(callback: (editor: ProviderEditor) => void): Promise<{ dispose(): Promise<void> }>
    reload(): Promise<void>
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

const DEFAULT_INTERVAL = 5 * 60 * 1000

function log(debug: boolean, ...values: unknown[]): void {
  if (debug) console.log("[autodiscovery]", ...values)
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

    let refreshing: Promise<void> | undefined
    const refresh = (): Promise<void> => {
      if (refreshing) return refreshing
      refreshing = (async () => {
        await syncStates()
        for (const state of states.values()) {
          const debug = state.options.debug === true
          try {
            const inventory = await fetchInventory(state.info ?? buildProviderInfo(state.providerID, state.config, state.options), state.config, state.options, debug)
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
            state.endpoint = inventory.endpoint
            state.error = undefined
            await saveModels(ctx, state.providerID, state.models)
            log(debug, `${state.providerID}: discovered ${state.models.length} model(s) from ${inventory.endpoint}`)
          } catch (error) {
            state.error = error instanceof Error ? error.message : String(error)
            console.warn(`[autodiscovery] ${state.providerID}: discovery failed: ${state.error}`)
          }
        }
        await ctx.provider.reload()
      })().finally(() => {
        refreshing = undefined
      })
      return refreshing
    }

    await refresh()

    const cleanup: (() => void)[] = []
    const watchers: FSWatcher[] = []
    let watchDebounce: ReturnType<typeof setTimeout> | undefined
    for (const file of configFilePaths(ctx)) {
      if (!existsSync(file)) continue
      try {
        watchers.push(watch(file, () => {
          if (watchDebounce) clearTimeout(watchDebounce)
          watchDebounce = setTimeout(() => void refresh().catch((error) => console.warn("[autodiscovery] config refresh failed:", error)), 250)
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
            if (event.type === "config.updated") await refresh()
          }
        } catch (error) {
          if (!controller.signal.aborted) console.warn("[autodiscovery] event subscription failed:", error)
        }
      })()
      cleanup.push(() => controller.abort())
    }

    const intervals = [...states.values()].map((state) => state.options.refreshIntervalMs).filter((value): value is number => typeof value === "number" && value > 0)
    const interval = intervals.length > 0 ? Math.min(...intervals) : DEFAULT_INTERVAL
    const timer = setInterval(() => void refresh().catch((error) => console.warn("[autodiscovery] refresh failed:", error)), interval)
    cleanup.push(() => clearInterval(timer))

    return () => cleanup.forEach((dispose) => dispose())
  },
}
