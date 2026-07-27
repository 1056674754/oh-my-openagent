import { describe, expect, test } from "bun:test"
import {
  parseKimiQuotaPayload,
  parseZhipuQuotaPayload,
  ProviderQuotaUsageLoader,
} from "./quota-usage-loader"

describe("parseKimiQuotaPayload", () => {
  test("#given weekly and 300-minute usage #when parsed #then returns two windows", () => {
    const snapshot = parseKimiQuotaPayload({
      usage: { limit: 1_000, remaining: 170, resetTime: "2026-07-29T00:00:00Z" },
      limits: [
        {
          window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
          detail: { limit: 1_000, remaining: 210, resetTime: 1_800_000_000 },
        },
      ],
    })

    expect(snapshot).toEqual({
      windows: [
        { windowSeconds: 604_800, usedPercent: 83, resetAtMs: Date.parse("2026-07-29T00:00:00Z") },
        { windowSeconds: 18_000, usedPercent: 79, resetAtMs: 1_800_000_000_000 },
      ],
    })
  })

  test("#given remaining usage outside the limit #when parsed #then rejects the malformed window", () => {
    expect(parseKimiQuotaPayload({
      usage: { limit: 100, remaining: -900, resetTime: "2026-07-29T00:00:00Z" },
    })).toBeNull()
  })

  test("#given too many quota windows #when parsed #then rejects the oversized collection", () => {
    expect(parseKimiQuotaPayload({ limits: Array.from({ length: 21 }, () => ({})) })).toBeNull()
  })
})

describe("parseZhipuQuotaPayload", () => {
  test("#given a legacy token limit without unit metadata #when parsed #then uses the known five-hour window", () => {
    const snapshot = parseZhipuQuotaPayload({
      data: {
        limits: [
          { type: "TOKENS_LIMIT", percentage: 35, nextResetTime: 1_800_000_000 },
        ],
      },
    })

    expect(snapshot).toEqual({
      windows: [{ windowSeconds: 18_000, usedPercent: 35, resetAtMs: 1_800_000_000_000 }],
    })
  })

  test("#given a token limit #when parsed #then returns its five-hour window", () => {
    const snapshot = parseZhipuQuotaPayload({
      data: {
        limits: [
          { type: "TOKENS_LIMIT", percentage: 35, nextResetTime: 1_800_000_000, unit: 3, number: 5 },
        ],
      },
    })

    expect(snapshot).toEqual({
      windows: [{ windowSeconds: 18_000, usedPercent: 35, resetAtMs: 1_800_000_000_000 }],
    })
  })

  test("#given an out-of-range percentage #when parsed #then rejects the untrusted window", () => {
    const snapshot = parseZhipuQuotaPayload({
      data: {
        limits: [
          { type: "TOKENS_LIMIT", percentage: 10_000, nextResetTime: 1_800_000_000, unit: 3, number: 5 },
        ],
      },
    })

    expect(snapshot).toBeNull()
  })

  test("#given an unsupported reset unit #when parsed #then rejects instead of guessing five hours", () => {
    const snapshot = parseZhipuQuotaPayload({
      data: {
        limits: [
          { type: "TOKENS_LIMIT", percentage: 35, nextResetTime: 1_800_000_000, unit: 99, number: 5 },
        ],
      },
    })

    expect(snapshot).toBeNull()
  })
})

describe("ProviderQuotaUsageLoader", () => {
  test("#given Z.AI and BigModel quota providers #when loaded #then uses each provider's regional endpoint", async () => {
    const urls: string[] = []
    const loader = new ProviderQuotaUsageLoader({
      client: { config: { get: async () => ({ data: {} }) } } as never,
      readAuthFile: async () => ({
        "zai-coding-plan": { token: "zai-token" },
        "zhipuai-coding-plan": { token: "zhipu-token" },
      }),
      fetch: async (input) => {
        urls.push(String(input))
        return new Response(JSON.stringify({
          data: {
            limits: [
              { type: "TOKENS_LIMIT", percentage: 35, nextResetTime: Date.now() + 60_000, unit: 3, number: 5 },
            ],
          },
        }), { status: 200 })
      },
    })

    await loader.load({ quotaProvider: "zai-coding-plan", refreshIntervalSeconds: 60, requestTimeoutMs: 5_000 })
    await loader.load({ quotaProvider: "zhipuai-coding-plan", refreshIntervalSeconds: 60, requestTimeoutMs: 5_000 })

    expect(urls).toEqual([
      "https://api.z.ai/api/monitor/usage/quota/limit",
      "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
    ])
  })

  test("#given only the other region's credential #when loading Z.AI #then fails open without sending it", async () => {
    let fetchCalled = false
    const loader = new ProviderQuotaUsageLoader({
      client: { config: { get: async () => ({ data: {} }) } } as never,
      readAuthFile: async () => ({
        "zhipuai-coding-plan": { token: "china-token" },
      }),
      fetch: async () => {
        fetchCalled = true
        return new Response(null, { status: 500 })
      },
    })

    const snapshot = await loader.load({
      quotaProvider: "zai-coding-plan",
      refreshIntervalSeconds: 60,
      requestTimeoutMs: 5_000,
    })

    expect(snapshot).toBeNull()
    expect(fetchCalled).toBeFalse()
  })

  test("#given a provider API key uses a foreign base URL #when quota loads #then does not disclose the key", async () => {
    let fetchCalled = false
    const loader = new ProviderQuotaUsageLoader({
      client: {
        config: {
          get: async () => ({
            data: {
              provider: {
                "kimi-for-coding": {
                  options: { apiKey: "proxy-key", baseURL: "https://proxy.example.invalid/v1" },
                },
              },
            },
          }),
        },
      } as never,
      readAuthFile: async () => ({ "kimi-for-coding": { token: "auth-sentinel" } }),
      fetch: async () => {
        fetchCalled = true
        return new Response(null, { status: 500 })
      },
    })

    const snapshot = await loader.load({
      quotaProvider: "kimi-for-coding",
      refreshIntervalSeconds: 60,
      requestTimeoutMs: 5_000,
    })

    expect(snapshot).toBeNull()
    expect(fetchCalled).toBeFalse()
  })

  test("#given a provider API key uses a foreign top-level API #when quota loads #then blocks all credentials", async () => {
    let fetchCalled = false
    const loader = new ProviderQuotaUsageLoader({
      client: {
        config: {
          get: async () => ({
            data: {
              provider: {
                "kimi-for-coding": {
                  api: "https://proxy.example.invalid/v1",
                  options: { apiKey: "config-key" },
                },
              },
            },
          }),
        },
      } as never,
      readAuthFile: async () => ({ "kimi-for-coding": { token: "auth-key" } }),
      fetch: async () => {
        fetchCalled = true
        return new Response(null, { status: 500 })
      },
    })

    expect(await loader.load({
      quotaProvider: "kimi-for-coding",
      refreshIntervalSeconds: 60,
      requestTimeoutMs: 5_000,
    })).toBeNull()
    expect(fetchCalled).toBeFalse()
  })

  test("#given a model uses a foreign API #when quota loads #then blocks all credentials", async () => {
    let fetchCalled = false
    const loader = new ProviderQuotaUsageLoader({
      client: {
        config: {
          get: async () => ({
            data: {
              provider: {
                "kimi-for-coding": {
                  models: { k3: { provider: { api: "https://proxy.example.invalid/v1" } } },
                  options: { apiKey: "config-key" },
                },
              },
            },
          }),
        },
      } as never,
      readAuthFile: async () => ({ "kimi-for-coding": { token: "auth-key" } }),
      fetch: async () => {
        fetchCalled = true
        return new Response(null, { status: 500 })
      },
    })

    expect(await loader.load({
      quotaProvider: "kimi-for-coding",
      refreshIntervalSeconds: 60,
      requestTimeoutMs: 5_000,
    })).toBeNull()
    expect(fetchCalled).toBeFalse()
  })

  test("#given a provider uses a custom implementation #when quota loads #then blocks all credentials", async () => {
    let fetchCalled = false
    const loader = new ProviderQuotaUsageLoader({
      client: {
        config: {
          get: async () => ({
            data: {
              provider: {
                "kimi-for-coding": {
                  npm: "@custom/proxy",
                  options: { apiKey: "config-key" },
                },
              },
            },
          }),
        },
      } as never,
      readAuthFile: async () => ({ "kimi-for-coding": { token: "auth-key" } }),
      fetch: async () => {
        fetchCalled = true
        return new Response(null, { status: 500 })
      },
    })

    expect(await loader.load({
      quotaProvider: "kimi-for-coding",
      refreshIntervalSeconds: 60,
      requestTimeoutMs: 5_000,
    })).toBeNull()
    expect(fetchCalled).toBeFalse()
  })

  test("#given a model uses a custom implementation #when quota loads #then blocks all credentials", async () => {
    let fetchCalled = false
    const loader = new ProviderQuotaUsageLoader({
      client: {
        config: {
          get: async () => ({
            data: {
              provider: {
                "kimi-for-coding": {
                  models: { k3: { provider: { npm: "@custom/proxy" } } },
                  options: { apiKey: "config-key" },
                },
              },
            },
          }),
        },
      } as never,
      readAuthFile: async () => ({ "kimi-for-coding": { token: "auth-key" } }),
      fetch: async () => {
        fetchCalled = true
        return new Response(null, { status: 500 })
      },
    })

    expect(await loader.load({
      quotaProvider: "kimi-for-coding",
      refreshIntervalSeconds: 60,
      requestTimeoutMs: 5_000,
    })).toBeNull()
    expect(fetchCalled).toBeFalse()
  })

  test("#given a provider has a non-string base URL #when quota loads #then blocks all credentials", async () => {
    let fetchCalled = false
    const loader = new ProviderQuotaUsageLoader({
      client: {
        config: {
          get: async () => ({
            data: {
              provider: {
                "kimi-for-coding": { options: { apiKey: "config-key", baseURL: true } },
              },
            },
          }),
        },
      } as never,
      readAuthFile: async () => ({ "kimi-for-coding": { token: "auth-key" } }),
      fetch: async () => {
        fetchCalled = true
        return new Response(null, { status: 500 })
      },
    })

    expect(await loader.load({
      quotaProvider: "kimi-for-coding",
      refreshIntervalSeconds: 60,
      requestTimeoutMs: 5_000,
    })).toBeNull()
    expect(fetchCalled).toBeFalse()
  })

  test("#given a provider has an empty base URL #when quota loads #then blocks all credentials", async () => {
    let fetchCalled = false
    const loader = new ProviderQuotaUsageLoader({
      client: {
        config: {
          get: async () => ({
            data: { provider: { "kimi-for-coding": { options: { apiKey: "config-key", baseURL: "" } } } },
          }),
        },
      } as never,
      readAuthFile: async () => ({ "kimi-for-coding": { token: "auth-key" } }),
      fetch: async () => {
        fetchCalled = true
        return new Response(null, { status: 500 })
      },
    })

    expect(await loader.load({
      quotaProvider: "kimi-for-coding",
      refreshIntervalSeconds: 60,
      requestTimeoutMs: 5_000,
    })).toBeNull()
    expect(fetchCalled).toBeFalse()
  })

  test("#given a provider has malformed options #when quota loads #then does not fall back to auth", async () => {
    let fetchCalled = false
    const loader = new ProviderQuotaUsageLoader({
      client: {
        config: { get: async () => ({ data: { provider: { "kimi-for-coding": { options: true } } } }) },
      } as never,
      readAuthFile: async () => ({ "kimi-for-coding": { token: "auth-key" } }),
      fetch: async () => {
        fetchCalled = true
        return new Response(null, { status: 500 })
      },
    })

    expect(await loader.load({
      quotaProvider: "kimi-for-coding",
      refreshIntervalSeconds: 60,
      requestTimeoutMs: 5_000,
    })).toBeNull()
    expect(fetchCalled).toBeFalse()
  })

  test("#given the provider config container is malformed #when quota loads #then blocks auth fallback", async () => {
    let fetchCalled = false
    const loader = new ProviderQuotaUsageLoader({
      client: { config: { get: async () => ({ data: { provider: true } }) } } as never,
      readAuthFile: async () => ({ "kimi-for-coding": { token: "auth-key" } }),
      fetch: async () => {
        fetchCalled = true
        return new Response(null, { status: 500 })
      },
    })

    expect(await loader.load({
      quotaProvider: "kimi-for-coding",
      refreshIntervalSeconds: 60,
      requestTimeoutMs: 5_000,
    })).toBeNull()
    expect(fetchCalled).toBeFalse()
  })

  test("#given provider config lookup fails #when auth has a key #then fails open without using it", async () => {
    let fetchCalled = false
    const loader = new ProviderQuotaUsageLoader({
      client: { config: { get: async () => { throw new Error("config unavailable") } } } as never,
      readAuthFile: async () => ({ "kimi-for-coding": { token: "auth-key" } }),
      fetch: async () => {
        fetchCalled = true
        return new Response(null, { status: 500 })
      },
    })

    expect(await loader.load({
      quotaProvider: "kimi-for-coding",
      refreshIntervalSeconds: 60,
      requestTimeoutMs: 5_000,
    })).toBeNull()
    expect(fetchCalled).toBeFalse()
  })

  test("#given SDK config lookup returns an error envelope #when auth has a key #then does not use it", async () => {
    let fetchCalled = false
    const loader = new ProviderQuotaUsageLoader({
      client: {
        config: { get: async () => ({ data: undefined, error: { message: "config unavailable" } }) },
      } as never,
      readAuthFile: async () => ({ "kimi-for-coding": { token: "auth-key" } }),
      fetch: async () => {
        fetchCalled = true
        return new Response(null, { status: 500 })
      },
    })

    expect(await loader.load({
      quotaProvider: "kimi-for-coding",
      refreshIntervalSeconds: 60,
      requestTimeoutMs: 5_000,
    })).toBeNull()
    expect(fetchCalled).toBeFalse()
  })

  test("#given a declared oversized response #when loaded #then fails open without parsing it", async () => {
    const loader = new ProviderQuotaUsageLoader({
      client: { config: { get: async () => ({ data: {} }) } } as never,
      readAuthFile: async () => ({ "kimi-for-coding": { token: "test-token" } }),
      fetch: async () => new Response("{}", {
        status: 200,
        headers: { "content-length": String(1024 * 1024 + 1) },
      }),
    })

    const snapshot = await loader.load({
      quotaProvider: "kimi-for-coding",
      refreshIntervalSeconds: 60,
      requestTimeoutMs: 5_000,
    })

    expect(snapshot).toBeNull()
  })

  test("#given a slower shared lookup #when a shorter-timeout caller joins #then honors the caller deadline", async () => {
    const loader = new ProviderQuotaUsageLoader({
      client: { config: { get: () => new Promise(() => {}) } } as never,
    })
    const slowCaller = loader.load({
      quotaProvider: "kimi-for-coding",
      refreshIntervalSeconds: 60,
      requestTimeoutMs: 100,
    })
    const startedAt = Date.now()
    const shortCaller = await loader.load({
      quotaProvider: "kimi-for-coding",
      refreshIntervalSeconds: 60,
      requestTimeoutMs: 20,
    })

    expect(shortCaller).toBeNull()
    expect(Date.now() - startedAt).toBeLessThan(80)
    await slowCaller
  })

  test("#given provider config resolution hangs #when the lookup times out #then fails open", async () => {
    let fetchCalled = false
    const loader = new ProviderQuotaUsageLoader({
      client: { config: { get: () => new Promise(() => {}) } } as never,
      readAuthFile: async () => ({ "kimi-for-coding": { token: "test-token" } }),
      fetch: async () => {
        fetchCalled = true
        return new Response(null, { status: 500 })
      },
    })

    const startedAt = Date.now()
    const result = await loader.load({
      quotaProvider: "kimi-for-coding",
      refreshIntervalSeconds: 60,
      requestTimeoutMs: 1_000,
    })

    expect(result).toBeNull()
    expect(fetchCalled).toBeFalse()
    expect(Date.now() - startedAt).toBeLessThan(1_500)
  })

  test("#given a cached over-quota snapshot #when refresh fails #then fails open instead of returning stale usage", async () => {
    let nowMs = Date.UTC(2026, 6, 22, 10, 0, 0)
    let requestCount = 0
    const loader = new ProviderQuotaUsageLoader({
      client: { config: { get: async () => ({ data: {} }) } } as never,
      now: () => nowMs,
      readAuthFile: async () => ({ "kimi-for-coding": { token: "test-token" } }),
      fetch: async () => {
        requestCount += 1
        if (requestCount > 1) throw new Error("network down")
        return new Response(JSON.stringify({
          usage: {
            limit: 100,
            remaining: 10,
            resetTime: nowMs + 7 * 24 * 60 * 60 * 1_000,
          },
        }), { status: 200 })
      },
    })

    const first = await loader.load({
      quotaProvider: "kimi-for-coding",
      refreshIntervalSeconds: 60,
      requestTimeoutMs: 5_000,
    })
    nowMs += 61_000
    const afterFailure = await loader.load({
      quotaProvider: "kimi-for-coding",
      refreshIntervalSeconds: 60,
      requestTimeoutMs: 5_000,
    })
    const failureCooldown = await loader.load({
      quotaProvider: "kimi-for-coding",
      refreshIntervalSeconds: 60,
      requestTimeoutMs: 5_000,
    })

    expect(first?.windows[0]?.usedPercent).toBe(90)
    expect(afterFailure).toBeNull()
    expect(failureCooldown).toBeNull()
    expect(requestCount).toBe(2)
  })

  test("#given rules with different refresh intervals #when one refresh fails #then neither can reuse stale usage", async () => {
    let nowMs = Date.UTC(2026, 6, 22, 10, 0, 0)
    let requestCount = 0
    const loader = new ProviderQuotaUsageLoader({
      client: { config: { get: async () => ({ data: {} }) } } as never,
      now: () => nowMs,
      readAuthFile: async () => ({ "kimi-for-coding": { token: "test-token" } }),
      fetch: async () => {
        requestCount += 1
        if (requestCount > 1) throw new Error("network down")
        return new Response(JSON.stringify({
          usage: {
            limit: 100,
            remaining: 0,
            resetTime: nowMs + 7 * 24 * 60 * 60 * 1_000,
          },
        }), { status: 200 })
      },
    })

    const initial = await loader.load({
      quotaProvider: "kimi-for-coding",
      refreshIntervalSeconds: 60,
      requestTimeoutMs: 5_000,
    })
    nowMs += 61_000
    const shortIntervalFailure = await loader.load({
      quotaProvider: "kimi-for-coding",
      refreshIntervalSeconds: 60,
      requestTimeoutMs: 5_000,
    })
    const longIntervalAfterFailure = await loader.load({
      quotaProvider: "kimi-for-coding",
      refreshIntervalSeconds: 120,
      requestTimeoutMs: 5_000,
    })

    expect(initial?.windows[0]?.usedPercent).toBe(100)
    expect(shortIntervalFailure).toBeNull()
    expect(longIntervalAfterFailure).toBeNull()
    expect(requestCount).toBe(2)
  })
})
