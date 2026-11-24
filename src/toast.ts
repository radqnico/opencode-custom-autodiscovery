/** Toast copy shared by the TUI and GUI parts. */

import { errorDetail } from "./errors.ts"

export { errorDetail } from "./errors.ts"

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

export function resultMessage(result: DiscoveryResult): string {
  return result.results.map((entry) =>
    `${entry.providerID}: ${entry.models} models loaded${entry.error ? ` (${entry.error})` : ""}`,
  ).join("\n")
}

export function errorMessage(error: unknown): string {
  return `Discovery failed: ${errorDetail(error)}`
}
