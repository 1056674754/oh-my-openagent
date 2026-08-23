import { z } from "zod"
import { FallbackModelMixedArraySchema } from "./fallback-models"

const CircuitBreakerConfigSchema = z.object({
  enabled: z.boolean().optional(),
  maxToolCalls: z.number().int().min(10).optional(),
  consecutiveThreshold: z.number().int().min(5).optional(),
})

const QuotaRoutingRuleSchema = z.object({
  enabled: z.boolean().default(true),
  quotaProvider: z.literal("zhipuai-coding-plan").default("zhipuai-coding-plan"),
  windowSeconds: z.number().int().positive().default(5 * 60 * 60),
  gracePeriodSeconds: z.number().int().nonnegative().default(60 * 60),
  paceThresholdRatio: z.number().positive().max(1).default(0.95),
  refreshIntervalSeconds: z.number().int().positive().default(60),
  requestTimeoutMs: z.number().int().min(1_000).default(5_000),
  fallbackModels: FallbackModelMixedArraySchema.min(1),
}).superRefine((rule, context) => {
  if (rule.gracePeriodSeconds >= rule.windowSeconds) {
    context.addIssue({
      code: "custom",
      message: "gracePeriodSeconds must be shorter than windowSeconds",
      path: ["gracePeriodSeconds"],
    })
  }
})

export type QuotaRoutingRule = z.infer<typeof QuotaRoutingRuleSchema>

export const BackgroundTaskConfigSchema = z.object({
  defaultConcurrency: z.number().min(1).optional(),
  providerConcurrency: z.record(z.string(), z.number().min(0)).optional(),
  modelConcurrency: z.record(z.string(), z.number().min(0)).optional(),
  quotaRouting: z.record(z.string(), QuotaRoutingRuleSchema).optional(),
  maxDepth: z.number().int().min(1).optional(),
  /** Stale timeout in milliseconds - interrupt tasks with no activity for this duration (default: 180000 = 3 minutes, minimum: 60000 = 1 minute) */
  staleTimeoutMs: z.number().min(60000).optional(),
  /** Timeout for tasks that never received any progress update, falling back to startedAt (default: 1800000 = 30 minutes, minimum: 60000 = 1 minute) */
  messageStalenessTimeoutMs: z.number().min(60000).optional(),
  /** Absolute TTL for non-terminal tasks in milliseconds (default: 1800000 = 30 minutes, minimum: 300000 = 5 minutes). Tasks exceeding this age from their last activity (or startedAt if no progress) are pruned. */
  taskTtlMs: z.number().min(300000).optional(),
  /** Timeout for tasks whose session has completely disappeared from the status registry (default: 60000 = 1 minute, minimum: 10000 = 10 seconds). When a session is gone (likely crashed), this shorter timeout is used instead of the normal stale timeout. */
  sessionGoneTimeoutMs: z.number().min(10000).optional(),
  /** Delay before removing completed/cancelled/errored tasks from memory in milliseconds (default: 600000 = 10 minutes, minimum: 60000 = 1 minute). */
  taskCleanupDelayMs: z.number().min(60000).optional(),
  syncPollTimeoutMs: z.number().min(60000).optional(),
  /** Maximum tool calls per subagent task before circuit breaker triggers (default: 200, minimum: 10). Prevents runaway loops from burning unlimited tokens. */
  maxToolCalls: z.number().int().min(10).optional(),
  circuitBreaker: CircuitBreakerConfigSchema.optional(),
})

export type BackgroundTaskConfig = z.infer<typeof BackgroundTaskConfigSchema>
