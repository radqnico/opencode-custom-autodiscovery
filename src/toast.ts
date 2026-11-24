/** Toast copy shared by the TUI and GUI parts. */

export interface ProviderResult {
  providerID: string
  models: number
  error?: string
}

export interface DiscoveryResult {
  providers: number
  models: number
  errors: number
  results: readonly ProviderResult[]
}

/**
 * RPC and platform errors do not always arrive as Error instances — a thrown
 * plain object stringifies to "[object Object]". Pull out the human-readable
 * part so toasts and provider results never show that placeholder.
 */
export function errorDetail(error: unknown, depth = 0): string {
  if (error instanceof Error) {
    const message = error.message || error.name
    const cause = (error as Error & { cause?: unknown }).cause
    if (cause && depth < 3) {
      const detail = errorDetail(cause, depth + 1)
      if (detail && detail !== message && detail !== "[object Object]") return `${message}: ${detail}`
    }
    return message
  }
  if (typeof error === "string") return error
  if (error !== null && typeof error === "object" && depth < 3) {
    const record = error as Record<string, unknown>
    for (const key of ["message", "description", "error", "reason", "detail", "data", "cause"]) {
      const value = record[key]
      if (typeof value === "string" && value.length > 0) return value
      if (value !== null && typeof value === "object") {
        const nested = errorDetail(value, depth + 1)
        if (nested && nested !== "[object Object]") return nested
      }
    }
    try {
      const json = JSON.stringify(record)
      if (json && json !== "{}" && json !== "[]") return json
    } catch {
      // Circular or otherwise non-serializable values fall through.
    }
  }
  return String(error)
}

export function resultMessage(result: DiscoveryResult): string {
  return result.results.map((entry) =>
    `${entry.providerID}: ${entry.models} models loaded${entry.error ? ` (${entry.error})` : ""}`,
  ).join("\n")
}

export function errorMessage(error: unknown): string {
  return `Discovery failed: ${errorDetail(error)}`
}
