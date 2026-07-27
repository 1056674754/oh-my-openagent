import { z } from "zod"
import { DEFAULT_CODEGRAPH_MAX_INDEX_DB_BYTES } from "@oh-my-opencode/utils"

export const CodegraphConfigSchema = z.object({
  auto_init: z.union([z.literal("safe"), z.boolean()]).default("safe"),
  auto_provision: z.boolean().default(true),
  enabled: z.boolean().default(true),
  install_dir: z.string().optional(),
  max_index_db_bytes: z.number().int().positive().default(DEFAULT_CODEGRAPH_MAX_INDEX_DB_BYTES),
  telemetry: z.boolean().optional(),
  watch_debounce_ms: z.number().nonnegative().optional(),
})

export type CodegraphConfig = z.infer<typeof CodegraphConfigSchema>
