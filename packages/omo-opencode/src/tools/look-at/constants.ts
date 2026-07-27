export const MULTIMODAL_LOOKER_AGENT = "multimodal-looker" as const

export const LOOK_AT_TITLE = "Media Summary" as const

export const LOOK_AT_DESCRIPTION = `Media Summary fallback for models that cannot accept images directly. This tool spawns a separate multimodal subagent and can be slow. Prefer a provider-native vision or MCP image-analysis tool when one is available. If the current model supports image input, use Read so the media is analyzed directly in the current session. Do not use this fallback for visual precision, aesthetic evaluation, or exact measurements.`
