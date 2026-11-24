/** Server RPC called by the TUI and Desktop GUI parts when a UI opens. */
export const Autodiscovery = {
  id: "autodiscovery",
  methods: {
    refresh: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          providers: { type: "number" },
          models: { type: "number" },
          errors: { type: "number" },
        },
        required: ["providers", "models", "errors"],
        additionalProperties: false,
      },
    },
  },
  events: {},
} as const
