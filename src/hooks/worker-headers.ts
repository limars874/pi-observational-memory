import type { ResolveResult } from "../runtime.js";

type WorkerSessionContext = {
	sessionManager: {
		getSessionId?: () => string;
	};
};

export type ResolvedWorkerModel = Extract<ResolveResult, { ok: true }>;

/**
 * 为直接调用 pi-ai 的 worker 补齐 OpenCode Console Go 要求的 session headers。
 * 主 consolidation 与 compaction catch-up 必须共用这条路径，避免请求身份不一致。
 */
export function workerHeadersFor(ctx: WorkerSessionContext, resolved: ResolvedWorkerModel): ResolvedWorkerModel {
	const model = (resolved.model ?? {}) as { provider?: string; baseUrl?: string };
	if (
		model.provider !== "opencode"
		&& model.provider !== "opencode-go"
		&& !(typeof model.baseUrl === "string" && model.baseUrl.includes("opencode.ai"))
	) {
		return resolved;
	}
	const sessionId = ctx.sessionManager.getSessionId?.();
	if (!sessionId) return resolved;
	return {
		...resolved,
		headers: {
			...(resolved.headers ?? {}),
			"x-opencode-session": sessionId,
			"x-opencode-client": "pi",
		},
	};
}
