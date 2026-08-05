import { z } from "zod"

export const RuntimeFallbackConfigSchema = z.object({
  /** Enable runtime fallback (default: false) */
  enabled: z.boolean().optional(),
  /** HTTP status codes that trigger fallback (default: [429, 500, 502, 503, 504]) */
  retry_on_errors: z.array(z.number()).optional(),
  /** Maximum fallback attempts per session (default: 3) */
  max_fallback_attempts: z.number().min(1).max(20).optional(),
  /** Cooldown in seconds before retrying a failed model (default: 60) */
  cooldown_seconds: z.number().min(0).optional(),
  /** Session-level timeout in seconds to advance fallback when provider hangs (default: 30). Set to 0 to disable timeout escalation and message.updated auto-retry signal detection. */
  timeout_seconds: z.number().min(0).optional(),
  /** Show toast notification when switching to fallback model (default: true) */
  notify_on_fallback: z.boolean().optional(),
  restore_primary_after_cooldown: z.boolean().optional(),
  /**
   * Number of opencode native retry attempts to tolerate on the current model
   * before swapping to a fallback. Preserves KV cache for transient rate limits.
   * 0 = swap on first retry signal (legacy behavior). (default: 3)
   */
  same_model_retries_before_swap: z.number().min(0).max(15).optional(),
  /**
   * Error types that bypass the retry budget and trigger immediate model swap.
   * Values from RuntimeFallbackErrorType: "quota_exceeded", "missing_api_key",
   * "invalid_api_key", "model_not_found", "context_overflow", "abort".
   * (default: ["quota_exceeded"])
   */
  immediate_swap_on_errors: z.array(z.enum([
    "quota_exceeded", "missing_api_key", "invalid_api_key",
    "model_not_found", "context_overflow", "abort",
  ])).optional(),
  /**
   * Per-provider override for same_model_retries_before_swap.
   * Keyed by providerID (first segment of "providerID/modelID", e.g. "bailian", "zhipuai-coding-plan", "openai").
   * (default: {})
   */
  provider_overrides: z.record(
    z.string(),
    z.object({
      same_model_retries_before_swap: z.number().min(0).max(15).optional(),
    }),
  ).optional(),
})

export type RuntimeFallbackConfig = z.infer<typeof RuntimeFallbackConfigSchema>
