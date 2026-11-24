import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import http from "node:http"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { parseJsonc, loadProviderOptions } from "../src/config.ts"
import { globToRegExp, matchesFilters } from "../src/glob.ts"
import { buildCatalogIndex, buildModelInfo, extractMetadata } from "../src/discovery.ts"

const models = [
  {
    id: "auto-coder",
    context_length: 200000,
    max_completion_tokens: 32000,
    tool_call: true,
    reasoning_options: [{ type: "effort", values: ["low", "high"] }],
    modalities: { input: ["text", "image"], output: ["text"] },
  },
  {
    id: "cmd/command-code-large",
    max_model_len: 65536,
    max_tokens: 8192,
    supported_features: ["tools"],
    variants: [{ id: "fast", settings: { reasoningEffort: "low" } }],
  },
  { id: "other-model" },
  {
    id: "claude-sonnet-5-5",
    owned_by: "catalog-test",
  },
]

function unitTests() {
  assert.deepEqual(
    parseJsonc(`{
      // comment
      "a": 1, /* block */
      "b": [1, 2,],
      "c": "text, with } and //",
    }`),
    { a: 1, b: [1, 2], c: "text, with } and //" },
  )

  assert.ok(globToRegExp("*command-code*").test("cmd/command-code-large"))
  assert.ok(globToRegExp("auto*").test("auto-coder"))
  assert.ok(globToRegExp("auto*").test("auto/nested/model"))
  assert.ok(globToRegExp("auto/**").test("auto/nested/model"))
  assert.ok(globToRegExp("cmd/{alpha,command-code-x}").test("cmd/command-code-x"))
  assert.ok(globToRegExp("model[").test("model["))
  assert.equal(matchesFilters("other-model", ["*command-code*", "auto*"]), false)
  assert.equal(matchesFilters("auto-coder", ["*command-code*", "auto*"]), true)
  assert.equal(matchesFilters("auto-coder", ["*", "!auto*"]), false)
  assert.equal(matchesFilters("anything", []), true)

  const catalog = buildCatalogIndex([{
    provider: { id: "anthropic", name: "Anthropic", activation: "auto", package: "x" },
    models: [{
      id: "claude-sonnet-5-5",
      modelID: "claude-sonnet-5-5",
      providerID: "anthropic",
      name: "Claude Sonnet 5.5",
      capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
      variants: [{ id: "high", settings: { reasoningEffort: "high" } }],
      time: { released: 1 },
      cost: [{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }],
      status: "active",
      enabled: true,
      limit: { context: 1000000, output: 64000 },
    }],
  }])

  const meta = extractMetadata(models[0])
  assert.equal(meta.context, 200000)
  assert.equal(meta.output, 32000)
  assert.equal(meta.tools, true)
  assert.deepEqual(meta.variants.map((variant) => variant.id), ["low", "high"])

  const built = buildModelInfo({ id: "auto-coder", raw: models[0] }, "gw", catalog)
  assert.equal(built.limit.context, 200000)
  assert.deepEqual(built.capabilities.input, ["text", "image"])
  assert.deepEqual(built.variants.map((variant) => variant.id), ["low", "high"])

  const inherited = buildModelInfo({ id: "claude-sonnet-5-5", raw: models[3] }, "gw", catalog, { limit: { context: 1234 } })
  assert.equal(inherited.name, "Claude Sonnet 5.5")
  assert.equal(inherited.limit.context, 1234)
  assert.equal(inherited.limit.output, 64000)
  assert.equal(inherited.cost.length, 1)
  assert.ok(inherited.variants.some((variant) => variant.id === "high"))

  const prefixed = buildModelInfo({ id: "cmd/claude-sonnet-5-5", raw: { id: "cmd/claude-sonnet-5-5" } }, "gw", catalog)
  assert.equal(prefixed.limit.context, 1000000)
  assert.equal(prefixed.capabilities.tools, true)

  const root = mkdtempSync(path.join(os.tmpdir(), "opencode-ad-unit-"))
  process.env.XDG_CONFIG_HOME = path.join(root, "config")
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    providers: {
      testgw: { settings: { baseURL: "http://localhost/v1" }, autodiscovery: { enabled: true, filters: ["auto*"] } },
      plain: { settings: { baseURL: "http://localhost/v1" } },
    },
  })
  const loaded = loadProviderOptions({ location: { directory: root }, options: {} })
  assert.deepEqual(loaded.get("testgw")?.options.filters, ["auto*"])
  assert.equal(loaded.get("testgw")?.options.enabled, true)
  assert.equal(loaded.has("plain"), false)

  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    providers: {
      testgw: { settings: { baseURL: "http://localhost/v1", autodiscovery: { enabled: true, filters: ["nested*"] } } },
    },
  })
  assert.deepEqual(loadProviderOptions({ location: { directory: root }, options: {} }).get("testgw")?.options.filters, ["nested*"])
  delete process.env.OPENCODE_CONFIG_CONTENT

  console.log("unit checks passed")
}

async function integrationTest() {
  const root = mkdtempSync(path.join(os.tmpdir(), "opencode-ad-integration-"))
  const configDir = path.join(root, "config", "opencode")
  const projectDir = path.join(root, "project")
  const pluginPath = path.resolve(import.meta.dirname, "..")
  mkdirSync(configDir, { recursive: true })
  mkdirSync(projectDir, { recursive: true })
  const port = 49900 + Math.floor(Math.random() * 400)
  const opencodePort = port + 1

  const writeConfig = (filters) => writeFileSync(path.join(configDir, "opencode.jsonc"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    plugins: [pluginPath],
    providers: {
      testgw: {
        name: "Test Gateway",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${port}/v1` },
        autodiscovery: { enabled: true, filters },
        models: { "manual-keep": { name: "Manual Keep", limit: { context: 11111 } } },
      },
    },
  }, null, 2))

  const mock = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json")
    if (request.url === "/v1/models") {
      response.end(JSON.stringify({ object: "list", data: models }))
    } else {
      response.statusCode = 404
      response.end("{}")
    }
  })
  await new Promise((resolve) => mock.listen(port, "127.0.0.1", resolve))

  writeConfig(["*command-code*", "auto*"])

  const server = spawn("opencode", ["serve", "--port", String(opencodePort), "--print-logs"], {
    cwd: projectDir,
    env: { ...process.env, XDG_CONFIG_HOME: path.join(root, "config") },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  server.stdout.on("data", (chunk) => { output += chunk })
  server.stderr.on("data", (chunk) => { output += chunk })

  const baseURL = `http://127.0.0.1:${opencodePort}`
  try {
    let password
    for (let attempt = 0; attempt < 200; attempt++) {
      const match = output.match(/server password (\S+)/)
      if (match) {
        password = match[1]
        break
      }
      if (server.exitCode !== null) throw new Error(`server exited early: ${output}`)
      await delay(100)
    }
    assert.ok(password, `password not found in server output: ${output}`)
    const headers = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }
    const api = async (route) => {
      const response = await fetch(`${baseURL}${route}`, { headers })
      if (response.status !== 200) throw new Error(`${route}: ${response.status} ${await response.text().catch(() => "")}`)
      return response.json()
    }

    const waitForModels = async (ids) => {
      for (let attempt = 0; attempt < 150; attempt++) {
        const result = await api("/api/model")
        const found = result.data.filter((model) => model.providerID === "testgw").map((model) => model.id).sort()
        if (JSON.stringify(found) === JSON.stringify([...ids].sort())) return result.data
        await delay(200)
      }
      const result = await api("/api/model")
      throw new Error(`models never matched ${JSON.stringify(ids)}; got ${JSON.stringify(result.data.filter((m) => m.providerID === "testgw").map((m) => m.id))}\nserver output:\n${output}`)
    }

    const first = await waitForModels(["auto-coder", "cmd/command-code-large", "manual-keep"])
    assert.equal(first.find((model) => model.id === "manual-keep").limit.context, 11111)
    const auto = first.find((model) => model.id === "auto-coder")
    assert.equal(auto.limit.context, 200000)
    assert.equal(auto.limit.output, 32000)
    assert.equal(auto.capabilities.tools, true)
    assert.deepEqual(auto.capabilities.input, ["text", "image"])
    assert.deepEqual(auto.variants.map((variant) => variant.id), ["low", "high"])
    const command = first.find((model) => model.id === "cmd/command-code-large")
    assert.equal(command.limit.context, 65536)
    assert.deepEqual(command.variants.map((variant) => variant.id), ["fast"])
    console.log("integration check 1 passed: filtered discovery with endpoint metadata")

    writeConfig(["claude*"])
    await delay(1200)
    const second = await waitForModels(["claude-sonnet-5-5", "manual-keep"])
    const inherited = second.find((model) => model.id === "claude-sonnet-5-5")
    assert.equal(inherited.name, "Claude Sonnet 5.5")
    assert.equal(inherited.limit.context, 1000000)
    assert.ok(inherited.variants.some((variant) => variant.id === "high"))
    assert.equal(inherited.cost.length, 1)
    console.log("integration check 2 passed: config reload applies new filters and catalog enrichment")
  } finally {
    server.kill("SIGTERM")
    await new Promise((resolve) => mock.close(resolve))
  }
}

unitTests()
await integrationTest()
console.log("all checks passed")
