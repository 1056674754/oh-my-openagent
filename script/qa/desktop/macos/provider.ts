import registerMockProvider, {
  loadMockScript,
  stepToAssistantMessage,
} from "../../../../packages/omo-senpi/scripts/qa/mock-provider/index"

/**
 * The existing scripted provider emits an empty toolcall_start.partial.content;
 * Senpi's RPC JSON encoder needs the tool id and name in that first partial.
 * Adapt only the macOS lane's provider stream, without changing shared QA.
 */
export default function registerMacosProvider(pi: Parameters<typeof registerMockProvider>[0]): void {
  let cursor = 0
  registerMockProvider({
    registerProvider(id, provider) {
      pi.registerProvider(id, {
        ...provider,
        streamSimple(model, context, options) {
          const script = loadMockScript(context.cwd ?? process.cwd())
          const step = script.steps[Math.min(cursor, script.steps.length - 1)]
          cursor += 1
          const toolCall = step === undefined ? undefined : stepToAssistantMessage(step, cursor).content[0]
          const stream = provider.streamSimple(model, context, options)
          return {
            result: () => stream.result(),
            async *[Symbol.asyncIterator]() {
              for await (const event of stream) {
                if (event !== null && typeof event === "object" && "type" in event &&
                  event.type === "toolcall_start" && toolCall?.type === "toolCall") {
                  yield { ...event, partial: {
                    ...("partial" in event && typeof event.partial === "object" && event.partial !== null
                      ? event.partial : {}),
                    content: [toolCall],
                  } }
                } else yield event
              }
            },
          }
        },
      })
    },
  })
}
