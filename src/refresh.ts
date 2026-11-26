/**
 * The TUI and Desktop GUI can open before the background server has finished
 * loading plugins and registering our RPC. Treat that specific race as a
 * transient condition instead of showing a failure toast on every startup.
 */

import { errorDetail } from "./errors.ts"
import { Autodiscovery } from "./rpc.ts"
import type { DiscoveryResult } from "./toast.ts"

const UNAVAILABLE = /\brpc\b[\s\S]{0,80}\b(?:unavailable|not registered|not found)\b|\b(?:unavailable|not registered)\b[\s\S]{0,80}\brpc\b/i

export interface RpcClient {
  rpc(definition: typeof Autodiscovery): { refresh(input: { invalidate?: boolean }): Promise<DiscoveryResult> }
}

/** True only for the "RPC is unavailable: autodiscovery" class of startup errors. */
export function isRpcUnavailable(error: unknown): boolean {
  return UNAVAILABLE.test(errorDetail(error))
}

export interface RetryOptions {
  attempts?: number
  delayMs?: number
  invalidate?: boolean
}

/**
 * Read `client` through the getter on every attempt: it changes when the server
 * restarts. All other errors are rethrown immediately so they stay actionable.
 */
export async function refreshWithRetry(
  client: () => RpcClient,
  { attempts = 24, delayMs = 250, invalidate = false }: RetryOptions = {},
): Promise<DiscoveryResult> {
  let last: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await client().rpc(Autodiscovery).refresh(invalidate ? { invalidate: true } : {})
    } catch (error) {
      last = error
      if (!isRpcUnavailable(error) || attempt === attempts) throw error
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
    }
  }
  throw last
}
