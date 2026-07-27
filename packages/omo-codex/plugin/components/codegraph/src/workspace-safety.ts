import {
	decideCodegraphWorkspaceUse,
	inspectCodegraphWorkspace,
	type CodegraphAutoInitPolicy,
	type CodegraphWorkspaceUseDecision,
} from "../../../../../utils/src/codegraph/workspace-policy.ts";
import type { CodegraphConfig } from "./hook-types.js";

export function decideCodexCodegraphWorkspaceUse(
	workspace: string,
	config: CodegraphConfig,
	fallbackPolicy: CodegraphAutoInitPolicy = "safe",
): CodegraphWorkspaceUseDecision {
	const inspection = inspectCodegraphWorkspace(workspace, {
		...(config.max_index_db_bytes === undefined
			? {}
			: { maxIndexDbBytes: config.max_index_db_bytes }),
	});
	return decideCodegraphWorkspaceUse(inspection, config.auto_init ?? fallbackPolicy);
}
