/**
 * Turn any thrown value into a clear, human-readable message. OpenCode's RPC,
 * platform APIs and third-party packages can reject with plain objects, nested
 * `cause` chains, circular structures or nothing at all — none of which should
 * ever reach a toast or a log line as "[object Object]".
 */

const ERROR_KEYS = ["message", "description", "error", "reason", "detail", "data", "cause"]

function safeStringify(value: object): string | undefined {
  const seen = new WeakSet<object>()
  try {
    const text = JSON.stringify(value, (_key, entry: unknown) => {
      if (typeof entry === "bigint") return `${entry}n`
      if (entry !== null && typeof entry === "object") {
        if (seen.has(entry)) return "[circular]"
        seen.add(entry)
      }
      return entry
    })
    return text && text !== "{}" && text !== "[]" ? text : undefined
  } catch {
    return undefined
  }
}

export function errorDetail(error: unknown, depth = 0): string {
  try {
    if (error === null || error === undefined) return "unknown error"
    if (typeof error === "string") return error.trim() || "empty error message"
    if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") return String(error)
    if (typeof error === "symbol") return error.toString()
    if (typeof error === "function") return `function ${error.name || "anonymous"}`
    if (depth > 4) return "nested error"

    if (error instanceof Error) {
      const message = error.message || error.name || "Error"
      const cause = (error as Error & { cause?: unknown }).cause
      if (cause !== undefined && cause !== null) {
        const detail = errorDetail(cause, depth + 1)
        if (detail && detail !== message) return `${message}: ${detail}`
      }
      return message
    }

    const record = error as Record<string, unknown>
    for (const key of ERROR_KEYS) {
      const value = record[key]
      if (value === undefined || value === error) continue
      const detail = errorDetail(value, depth + 1)
      if (detail && detail !== "unknown error") return detail
    }
    const json = safeStringify(record)
    if (json) return json
    const tag = Object.prototype.toString.call(record).slice(8, -1)
    return tag && tag !== "Object" ? `${tag} (no readable message)` : "[unreadable error]"
  } catch {
    return "[unreadable error]"
  }
}

/** Add a subject so a bare message still says what went wrong. */
export function describeFailure(subject: string, error: unknown): string {
  return `${subject}: ${errorDetail(error)}`
}
