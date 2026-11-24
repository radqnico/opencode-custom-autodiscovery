import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import { errorDetail } from "./errors.ts"

export interface AutodiscoveryOptions {
  enabled?: boolean
  filters?: readonly string[]
  baseURL?: string
  headers?: Record<string, string>
  timeoutMs?: number
  catalog?: boolean
  debug?: boolean
  modelsPath?: string
  extraPaths?: readonly string[]
}

export interface ProviderConfig {
  name?: string
  package?: string
  canonical?: string
  env?: readonly string[]
  settings?: Record<string, unknown>
  headers?: Record<string, string>
  body?: Record<string, unknown>
  models?: Record<string, Record<string, unknown>>
  autodiscovery?: AutodiscoveryOptions
}

export interface ProviderOptions {
  providerID: string
  options: AutodiscoveryOptions
  config: ProviderConfig
}

interface ConfigDocument {
  path: string
  info: Record<string, unknown>
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** JSONC -> JSON: strip line/block comments and trailing commas, respecting strings. */
export function parseJsonc(text: string): unknown {
  let stripped = ""
  let inString = false
  let escaped = false
  let i = 0
  while (i < text.length) {
    const char = text[i]!
    if (inString) {
      stripped += char
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      i++
      continue
    }
    if (char === '"') {
      inString = true
      stripped += char
      i++
      continue
    }
    if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        stripped += " "
        i++
      }
      continue
    }
    if (char === "/" && text[i + 1] === "*") {
      stripped += "  "
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        stripped += text[i] === "\n" ? "\n" : " "
        i++
      }
      if (i < text.length) {
        stripped += "  "
        i += 2
      }
      continue
    }
    stripped += char
    i++
  }

  let result = ""
  inString = false
  escaped = false
  for (i = 0; i < stripped.length; i++) {
    const char = stripped[i]!
    if (inString) {
      result += char
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      result += char
      continue
    }
    if (char === ",") {
      let next = i + 1
      while (next < stripped.length && /\s/.test(stripped[next]!)) next++
      if (stripped[next] === "}" || stripped[next] === "]") continue
    }
    result += char
  }
  return JSON.parse(result)
}

export function resolveEnv(value: string): string {
  return value
    .replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => process.env[name] ?? match)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => process.env[name] ?? match)
    .replace(/\{file:([^}]+)\}/g, (match, file: string) => {
      try {
        return readFileSync(file.startsWith("~/") ? path.join(homedir(), file.slice(2)) : file, "utf8")
      } catch {
        return ""
      }
    })
}

function resolveDeep(value: unknown): unknown {
  if (typeof value === "string") return resolveEnv(value)
  if (Array.isArray(value)) return value.map(resolveDeep)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, resolveDeep(entry)]))
  }
  return value
}

function configPaths(directory: string): string[] {
  const dirs: string[] = []
  let current = path.resolve(directory)
  while (true) {
    dirs.unshift(current)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  const direct: string[] = []
  const nested: string[] = []
  for (const dir of dirs) {
    for (const name of ["opencode.json", "opencode.jsonc"]) {
      direct.push(path.join(dir, name))
      nested.push(path.join(dir, ".opencode", name))
    }
  }
  return [...direct, ...nested]
}

export function configFilePaths(ctx: { location?: { directory?: string; project?: { canonical?: string } } }): string[] {
  const paths: string[] = []
  if (process.env.OPENCODE_CONFIG) {
    const explicit = path.resolve(resolveEnv(process.env.OPENCODE_CONFIG))
    if (existsSync(explicit)) {
      paths.push(existsSync(path.join(explicit, "opencode.jsonc"))
        ? path.join(explicit, "opencode.jsonc")
        : existsSync(path.join(explicit, "opencode.json"))
          ? path.join(explicit, "opencode.json")
          : explicit)
    }
  }
  for (const base of ["/etc/opencode", path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), "opencode")]) {
    for (const name of ["opencode.json", "opencode.jsonc"]) paths.push(path.join(base, name))
  }
  const directories = [ctx.location?.directory, ctx.location?.project?.canonical].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  )
  for (const directory of directories) paths.push(...configPaths(directory))
  return [...new Set(paths)]
}

function loadDocuments(ctx: { location?: { directory?: string; project?: { canonical?: string } } }): ConfigDocument[] {
  const paths = configFilePaths(ctx)
  const documents: ConfigDocument[] = []
  const inline = process.env.OPENCODE_CONFIG_CONTENT
  if (inline) {
    try {
      documents.push({ path: "<OPENCODE_CONFIG_CONTENT>", info: record(parseJsonc(inline)) })
    } catch (error) {
      console.warn(`[autodiscovery] invalid OPENCODE_CONFIG_CONTENT: ${errorDetail(error)}`)
    }
  }
  const seen = new Set<string>()
  for (const file of paths) {
    if (seen.has(file) || !existsSync(file)) continue
    seen.add(file)
    try {
      documents.push({ path: file, info: record(parseJsonc(readFileSync(file, "utf8"))) })
    } catch (error) {
      console.warn(`[autodiscovery] could not parse ${file}: ${errorDetail(error)}`)
    }
  }
  return documents
}

function autodiscoveryFrom(value: unknown): AutodiscoveryOptions {
  const raw = record(value)
  const options: AutodiscoveryOptions = {}
  for (const key of ["enabled", "filters", "baseURL", "headers", "timeoutMs", "catalog", "debug", "modelsPath", "extraPaths"] as const) {
    if (raw[key] !== undefined) {
      ;(options as Record<string, unknown>)[key] = resolveDeep(raw[key])
    }
  }
  return options
}

function isOptionObject(value: unknown): boolean {
  const raw = record(value)
  return ["enabled", "filters", "baseURL", "modelsPath", "extraPaths", "timeoutMs"].some((key) => key in raw)
}

/** Read the raw config (including fields the core schema drops) and plugin options. */
export function loadProviderOptions(ctx: {
  location?: { directory?: string; project?: { canonical?: string } }
  options?: unknown
}): Map<string, ProviderOptions> {
  const found = new Map<string, ProviderOptions>()
  const add = (providerID: string, options: AutodiscoveryOptions, config?: ProviderConfig) => {
    const existing = found.get(providerID)
    found.set(providerID, {
      providerID,
      options: { ...existing?.options, ...options },
      config: { ...existing?.config, ...config },
    })
  }

  for (const document of loadDocuments(ctx)) {
    const providers = record(document.info.providers)
    for (const [providerID, value] of Object.entries(providers)) {
      const raw = record(value)
      const settings = record(raw.settings)
      const nested = autodiscoveryFrom(settings.autodiscovery)
      const topLevel = autodiscoveryFrom(raw.autodiscovery)
      const options = { ...nested, ...topLevel }
      if (Object.keys(options).length === 0) continue
      add(providerID, options, {
        name: typeof raw.name === "string" ? raw.name : undefined,
        package: typeof raw.package === "string" ? raw.package : undefined,
        canonical: typeof raw.canonical === "string" ? raw.canonical : undefined,
        env: Array.isArray(raw.env) ? (raw.env as string[]) : undefined,
        settings: record(resolveDeep(raw.settings)),
        headers: record(raw.headers) as Record<string, string>,
        body: record(raw.body),
        models: record(raw.models) as ProviderConfig["models"],
      })
    }
  }

  const options = record(ctx.options)
  const nested = record(options.autodiscovery)
  const sources = [record(options.providers), nested]
  for (const source of sources) {
    for (const [providerID, value] of Object.entries(source)) {
      if (isOptionObject(value)) add(providerID, autodiscoveryFrom(value))
    }
  }
  for (const [providerID, value] of Object.entries(options)) {
    if (providerID !== "providers" && providerID !== "autodiscovery" && isOptionObject(value)) {
      add(providerID, autodiscoveryFrom(value))
    }
  }

  return found
}
