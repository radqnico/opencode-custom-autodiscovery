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
          results: {
            type: "array",
            items: {
              type: "object",
              properties: {
                providerID: { type: "string" },
                models: { type: "number" },
                error: { type: "string" },
              },
              required: ["providerID", "models"],
              additionalProperties: false,
            },
          },
        },
        required: ["providers", "models", "errors", "results"],
        additionalProperties: false,
      },
    },
  },
  events: {},
} as const
