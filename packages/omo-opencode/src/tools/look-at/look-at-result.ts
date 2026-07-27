import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { ToolAttachment, ToolResult } from "@opencode-ai/plugin/tool"
import { LOOK_AT_TITLE, MULTIMODAL_LOOKER_AGENT } from "./constants"
import type { LookAtFilePart, LookAtInputPart } from "./look-at-input-preparer"
import type { LookAtRouteDecision } from "./look-at-route"

function formatModel(decision: LookAtRouteDecision): string {
  if (!decision.model) return "unknown"
  return `${decision.model.providerID}/${decision.model.modelID}`
}

function toToolAttachment(part: LookAtFilePart): ToolAttachment {
  const url = part.url.startsWith("file:")
    ? `data:${part.mime};base64,${readFileSync(fileURLToPath(part.url)).toString("base64")}`
    : part.url

  return {
    type: "file",
    mime: part.mime,
    url,
    filename: part.filename,
  }
}

export function createDirectLookAtResult(
  inputParts: readonly LookAtInputPart[],
  goal: string,
  decision: LookAtRouteDecision,
): ToolResult {
  const attachments = inputParts
    .filter((part): part is LookAtFilePart => part.type === "file")
    .map(toToolAttachment)
  const text = inputParts
    .filter((part) => part.type === "text")
    .map((part) => part.text)

  return {
    title: LOOK_AT_TITLE,
    output: [
      "Media attached for direct analysis in the current model.",
      `Goal: ${goal}`,
      ...text,
    ].join("\n\n"),
    metadata: {
      route: "direct",
      model: formatModel(decision),
    },
    attachments,
  }
}

export function createLookAtTextResult(
  output: string,
  decision: LookAtRouteDecision,
): ToolResult {
  return {
    title: LOOK_AT_TITLE,
    output,
    metadata: {
      route: decision.route,
      model: formatModel(decision),
      ...(decision.route === "delegated" ? { agent: MULTIMODAL_LOOKER_AGENT } : {}),
    },
  }
}
