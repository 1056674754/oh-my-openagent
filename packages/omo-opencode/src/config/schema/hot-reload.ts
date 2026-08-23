import { z } from "zod"

export const HotReloadConfigSchema = z.object({
  enabled: z.boolean().default(true),
  watch_omo_config: z.boolean().default(true),
  debounce_ms: z.number().int().min(100).default(500),
})

export type HotReloadConfig = z.infer<typeof HotReloadConfigSchema>
