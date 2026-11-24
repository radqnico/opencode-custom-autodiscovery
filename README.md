# opencode-autodiscovery

An OpenCode **v2** server plugin that adds an optional `autodiscovery` option to provider entries in `opencode.json(c)`. When enabled on a custom-endpoint provider, the plugin reads that endpoint's model inventory and registers the models with OpenCode, enriching each one with context limits, capabilities, costs and variants when the endpoint or OpenCode's catalog knows about them.

## Install

The default installation is directly from this GitHub repository. Add it to `plugins` in your global or project config:

```jsonc title="opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:radqnico/opencode-custom-autodiscovery"],
}
```

OpenCode installs and caches the plugin automatically. The bare GitHub reference stays on the installed version; use `github:radqnico/opencode-custom-autodiscovery#main` to follow the branch, or pin a full commit hash for a reproducible install.

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
  "plugins": ["github:radqnico/opencode-custom-autodiscovery"],
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
| `catalog` | `true` | Use OpenCode's built-in model catalog to fill in missing metadata. |
| `debug` | `false` | Log discovery details to the server log. |
| `modelsPath` | auto | Override the discovery path (relative to `baseURL` or a full URL). |
| `extraPaths` | none | Additional discovery paths tried after the standard ones. |

## When discovery runs

The background server does **not** call the endpoint at startup: it only restores the last cached inventory. The TUI (`./tui`) and OpenCode Desktop GUI (`./gui-experimental`) parts call the server RPC `autodiscovery.refresh` as soon as a UI opens, so models are fetched for the location you are actually using. You can call the same RPC manually with `POST /api/rpc/autodiscovery/refresh`. Config changes reapply the cached inventory with the new filters, but do not trigger a network fetch.

## How discovery works

1. `GET {baseURL}/models` is tried first (plus `/v1/models`, `/api/tags` and `/api/v1/models` fallbacks). Standard OpenAI-compatible responses (`data[]`), Ollama/LM Studio responses (`models[]`) and plain string arrays are accepted. Every available credential is tried in order — config `apiKey`, configured `env` variables, then all saved OpenCode credentials for that provider (active one first) — stopping at the first one that returns a model list. This also works when a provider is connected through `/connect` instead of declaring its key in the config.
2. Each model ID is matched against OpenCode's built-in catalog by full ID and by its trailing segment, so gateway-prefixed IDs such as `cmd/claude-sonnet-5-5` inherit the catalog's limit, capabilities, cost and variants.
3. Endpoint metadata (`context_length`, `max_model_len`, `tool_call`, `modalities`, `reasoning_options`, `variants`, etc.) overrides catalog values where present. The plugin detects the provider's variant format automatically: inventories that declare `variants` / `reasoning_options` keep those variants, while IDs such as `model-high` are folded into variants of `model` only when both are present. Aliases with the same catalog name get a distinguishing segment in the display name instead of being hidden.
4. Models declared explicitly in the provider's `models` map take precedence over both.
5. The resulting inventory is registered with a provider transform. Providers with no usable models are added with `activation: "enabled"` so discovered models become selectable immediately. The last successful inventory is cached and restored until the next UI-driven refresh.

Filters apply only to autodiscovered models: models listed explicitly in the provider's `models` map are always kept, so hand-written entries never disappear because of a glob.

## Development

```sh
npm test        # unit tests plus a live OpenCode server integration check
npm run typecheck
```
