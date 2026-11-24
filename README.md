# opencode-autodiscovery

An OpenCode **v2** server plugin that adds an optional `autodiscovery` option to provider entries in `opencode.json(c)`. When enabled on a custom-endpoint provider, the plugin reads that endpoint's model inventory and registers the models with OpenCode, enriching each one with context limits, capabilities, costs and variants when the endpoint or OpenCode's catalog knows about them.

## Install

OpenCode resolves bare plugin names from the npm registry. After publishing this package, add it to `plugins` in your global or project config:

```jsonc title="opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-autodiscovery"],
}
```

For a checkout of this repository, or for a copy installed with `npm pack` / `npm install`, use a local path or `file://` URL instead. OpenCode does not resolve bare names from a project's `node_modules`:

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-autodiscovery"],
}
```

```jsonc
{
  "plugins": ["file:///absolute/path/to/node_modules/opencode-autodiscovery"],
}
```

OpenCode watches config files, so no restart is needed after editing.

## Configure a provider

```jsonc title="opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-autodiscovery"],
  "providers": {
    "gateway": {
      "name": "My gateway",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "https://gateway.example.com/v1",
        "apiKey": "{env:GATEWAY_API_KEY}",
      },
      "autodiscovery": {
        "enabled": true,
        "filters": ["*command-code*", "auto*"],
      },
    },
  },
}
```

The provider's models no longer need to be listed by hand. `/models` shows the discovered ones, e.g. `gateway/auto-command-code-large`.

`autodiscovery` is read from the raw config file because the built-in config schema does not declare it. If you prefer a schema-clean file, the identical option can be nested inside `settings` instead:

```jsonc
{
  "providers": {
    "gateway": {
      "settings": {
        "baseURL": "https://gateway.example.com/v1",
        "autodiscovery": { "enabled": true, "filters": ["auto*"] },
      },
    },
  },
}
```

Plugin options are also accepted as an override:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-autodiscovery",
      "options": { "providers": { "gateway": { "enabled": true, "filters": ["auto*"] } } },
    },
  ],
}
```

## Options

| Field | Default | Purpose |
| --- | --- | --- |
| `enabled` | `false` | Must be `true` before a provider is touched. |
| `filters` | none | Glob patterns. When present, only matching model IDs are shown. `!pattern` excludes; `*`, `**`, `?`, `[abc]` and `{a,b}` are supported. |
| `baseURL` | provider `settings.baseURL` | Alternative endpoint for discovery only. |
| `headers` | provider headers | Extra headers for the discovery request. |
| `timeoutMs` | `10000` | Per-request timeout. |
| `refreshIntervalMs` | `300000` | Background refresh interval. |
| `catalog` | `true` | Use OpenCode's built-in model catalog to fill in missing metadata. |
| `debug` | `false` | Log discovery details to the server log. |
| `modelsPath` | auto | Override the discovery path (relative to `baseURL` or a full URL). |
| `extraPaths` | none | Additional discovery paths tried after the standard ones. |

## How discovery works

1. `GET {baseURL}/models` is tried first (plus `/v1/models`, `/api/tags` and `/api/v1/models` fallbacks). Standard OpenAI-compatible responses (`data[]`), Ollama/LM Studio responses (`models[]`) and plain string arrays are accepted. Provider API keys and headers are forwarded.
2. Each model ID is matched against OpenCode's built-in catalog by full ID and by its trailing segment, so gateway-prefixed IDs such as `cmd/claude-sonnet-5-5` inherit the catalog's limit, capabilities, cost and variants.
3. Endpoint metadata (`context_length`, `max_model_len`, `tool_call`, `modalities`, `reasoning_options`, `variants`, etc.) overrides catalog values where present.
4. Models declared explicitly in the provider's `models` map take precedence over both.
5. The resulting inventory is registered with a provider transform. Providers with no usable models are added with `activation: "enabled"` so discovered models become selectable immediately. Refreshes run on config changes and in the background; the last successful inventory is cached and reused if an endpoint is temporarily unavailable.

Filters apply only to autodiscovered models: models listed explicitly in the provider's `models` map are always kept, so hand-written entries never disappear because of a glob.

## Development

```sh
npm test        # unit tests plus a live OpenCode server integration check
npm run typecheck
```
