/** Toast copy shared by the TUI and GUI parts. */

export interface DiscoveryResult {
  providers: number
  models: number
  errors: number
}

export function resultMessage(result: DiscoveryResult): string {
  const summary = `${result.models} model(s) up to date`
  return result.errors > 0 ? `${summary}, ${result.errors} provider(s) failed` : summary
}

export function errorMessage(error: unknown): string {
  return `Discovery failed: ${error instanceof Error ? error.message : String(error)}`
}
