import { describe, expect, test } from "bun:test"

import type { SenpiModelPort } from "@oh-my-opencode/senpi-task"

import { createTaskChildPlanner, type TaskModelRegistry } from "./planner"

type FakeModel = SenpiModelPort & { readonly name?: string }

function model(provider: string, id: string): FakeModel {
  return { provider, id }
}

function registry(models: readonly FakeModel[]): TaskModelRegistry {
  return {
    getAvailable: () => models,
    find: (provider, modelId) =>
      models.find((candidate) => candidate.provider === provider && candidate.id === modelId),
  }
}

describe("createTaskChildPlanner runtime fallback", () => {
  test("#given a category with configured runtime fallbacks #when planned #then requested and ordered fallback metadata are preserved", () => {
    // given
    const planner = createTaskChildPlanner(
      {
        categories: {
          quick: {
            model: "apitopia/kimi-for-coding-highspeed-unlocked",
            reasoningEffort: "minimal",
            fallback_models: [
              { model: "quotio-openai/gpt-5.4-mini-fast", reasoningEffort: "minimal" },
              { model: "apitopia/z-ai/glm-5.2-ultrafast-unlocked", reasoningEffort: "none" },
            ],
          },
        },
      },
      {},
      () => registry([
        model("apitopia", "kimi-for-coding-highspeed-unlocked"),
        model("quotio-openai", "gpt-5.4-mini-fast"),
        model("apitopia", "z-ai/glm-5.2-ultrafast-unlocked"),
      ]),
    )

    // when
    const result = planner({
      prompt: "Finish quickly.",
      parent_session_id: "parent-1",
      depth: 0,
      category: "quick",
    })

    // then
    if (result.kind !== "resolved") throw new Error(`Expected resolved plan, got ${result.kind}`)
    expect(result.plan).toMatchObject({
      requested_model: {
        source: "category",
        provider: "apitopia",
        model_id: "kimi-for-coding-highspeed-unlocked",
      },
      fallback_models: [
        {
          source: "category",
          provider: "quotio-openai",
          model_id: "gpt-5.4-mini-fast",
          reasoning_effort: "minimal",
        },
        {
          source: "category",
          provider: "apitopia",
          model_id: "z-ai/glm-5.2-ultrafast-unlocked",
          reasoning_effort: "none",
        },
      ],
    })
  })
})
