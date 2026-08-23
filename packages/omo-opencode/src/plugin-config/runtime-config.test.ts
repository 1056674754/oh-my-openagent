import { describe, expect, mock, test } from "bun:test"
import { OhMyOpenCodeConfigSchema } from "../config"
import { applyRuntimePluginConfig } from "./runtime-config"

describe("applyRuntimePluginConfig", () => {
  test("preserves nested model mapping references while replacing their values", () => {
    const current = OhMyOpenCodeConfigSchema.parse({
      agents: {
        oracle: { model: "zhipuai-coding-plan/glm-5.2" },
      },
      categories: {
        deep: { model: "zhipuai-coding-plan/glm-5.2" },
      },
    })
    const agents = current.agents
    const categories = current.categories
    const next = OhMyOpenCodeConfigSchema.parse({
      agents: {
        oracle: { model: "openai/gpt-5.6-sol" },
      },
      categories: {
        deep: { model: "bailian/deepseek-v4-pro" },
      },
    })

    applyRuntimePluginConfig({ current, next })

    expect(current.agents).toBe(agents)
    expect(current.categories).toBe(categories)
    expect(current.agents?.oracle?.model).toBe("openai/gpt-5.6-sol")
    expect(current.categories?.deep?.model).toBe("bailian/deepseek-v4-pro")
  })

  test("removes deleted values, adds new values, and updates background routing", () => {
    const current = OhMyOpenCodeConfigSchema.parse({
      categories: {
        deep: { model: "zhipuai-coding-plan/glm-5.2" },
      },
      background_task: {
        defaultConcurrency: 2,
      },
    })
    const next = OhMyOpenCodeConfigSchema.parse({
      categories: {
        quick: { model: "openai/gpt-5.4-mini" },
      },
      background_task: {
        defaultConcurrency: 4,
      },
    })
    const updateBackgroundTaskConfig = mock(() => {})

    applyRuntimePluginConfig({ current, next, updateBackgroundTaskConfig })

    expect(current.categories?.deep).toBeUndefined()
    expect(current.categories?.quick?.model).toBe("openai/gpt-5.4-mini")
    expect(updateBackgroundTaskConfig).toHaveBeenCalledWith(current.background_task)
  })
})
