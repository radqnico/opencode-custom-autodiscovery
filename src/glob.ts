/** Glob matching for model IDs. Supports `*`, `**`, `?`, `[...]` and `{a,b}`. */
export type Filters = readonly string[]

function escapeRegex(char: string): string {
  return /[\\^$.+()|[\]{}]/.test(char) ? `\\${char}` : char
}

function compileSegment(pattern: string): string {
  let out = ""
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        i++
        if (pattern[i + 1] === "/") {
          i++
          out += "(?:.*/)?"
        } else {
          out += ".*"
        }
      } else {
        out += ".*"
      }
      continue
    }
    if (char === "?") {
      out += "."
      continue
    }
    if (char === "[") {
      const end = pattern.indexOf("]", i + 1)
      if (end > i + 1) {
        const body = pattern.slice(i + 1, end)
        out += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`
        i = end
        continue
      }
    }
    if (char === "{") {
      let depth = 1
      let end = i + 1
      for (; end < pattern.length && depth > 0; end++) {
        if (pattern[end] === "{") depth++
        if (pattern[end] === "}") depth--
      }
      if (depth === 0) {
        const options: string[] = []
        let current = ""
        let inner = 0
        for (const part of pattern.slice(i + 1, end - 1)) {
          if (part === "{") inner++
          if (part === "}") inner--
          if (part === "," && inner === 0) {
            options.push(current)
            current = ""
          } else {
            current += part
          }
        }
        options.push(current)
        out += `(?:${options.map(compileSegment).join("|")})`
        i = end - 1
        continue
      }
    }
    out += escapeRegex(char)
  }
  return out
}

const cache = new Map<string, RegExp>()

export function globToRegExp(pattern: string): RegExp {
  const cached = cache.get(pattern)
  if (cached) return cached
  const compiled = new RegExp(`^${compileSegment(pattern)}$`)
  cache.set(pattern, compiled)
  return compiled
}

function normalize(filters: Filters | string | undefined): readonly string[] {
  if (filters === undefined) return []
  const values = typeof filters === "string" ? [filters] : filters
  return values.map((value) => String(value).trim()).filter((value) => value.length > 0)
}

/**
 * A model is shown when it matches at least one positive pattern and no
 * negative (`!`) pattern. An empty filter list means "show everything".
 */
export function matchesFilters(id: string, filters: Filters | string | undefined): boolean {
  const patterns = normalize(filters)
  if (patterns.length === 0) return true
  const positive = patterns.filter((pattern) => !pattern.startsWith("!"))
  const negative = patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1))
  if (positive.length > 0 && !positive.some((pattern) => globToRegExp(pattern).test(id))) return false
  return !negative.some((pattern) => globToRegExp(pattern).test(id))
}
