import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Static } from "typebox";
import { hashId } from "../../ids.js";
import { logAgentStreamError } from "../stream-errors.js";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "../../model-budget.js";
import { OBSERVER_SYSTEM } from "./prompts.js";
import { nowTimestamp, truncateRecordContent } from "../../serialize.js";
import type { Observation, ObserverFailureReason, Relevance } from "../../session-ledger/index.js";
import { observationLineTokenCount } from "../../tokens.js";

interface RunObserverArgs {
	model: Model<any>;
	apiKey?: string;
	headers?: Record<string, string>;
	sessionId?: string;
	priorReflections: string[];
	priorObservations: string[];
	chunk: string;
	allowedSourceEntryIds: string[];
	signal?: AbortSignal;
	agentLoop?: typeof agentLoop;
	maxTurns?: number;
	thinkingLevel?: ModelThinkingLevel;
}

const RelevanceSchema = Type.Union([
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("critical"),
]);

export const OBSERVATION_TIMESTAMP_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}$";

const RecordObservationsSchema = Type.Object({
	observations: Type.Array(
		Type.Object({
			timestamp: Type.String({
				pattern: OBSERVATION_TIMESTAMP_PATTERN,
				description: "Observation time in local 'YYYY-MM-DD HH:MM' format.",
			}),
			content: Type.String({
				minLength: 1,
				description: "Single-line plain prose. No markdown, no tags, no embedded timestamp.",
			}),
			relevance: RelevanceSchema,
			sourceEntryIds: Type.Array(
				Type.String({ minLength: 1 }),
				{
					minItems: 1,
					description:
						"Exact source entry ids from the chunk that directly support this observation. " +
						"Use only ids shown in '[Source entry id: ...]' labels; never invent ids.",
				},
			),
		}),
		{ description: "Batch of new observations. Use an empty array to explicitly confirm that the chunk warrants no new observations." },
	),
});

type RecordObservationsArgs = Static<typeof RecordObservationsSchema>;

type ObserverAttemptState = {
	toolCalls: number;
	explicitEmpty: boolean;
	rejected: number;
};

export type ObserverOutcome =
	| { kind: "recorded"; observations: Observation[]; attempts: number }
	| { kind: "empty"; attempts: number }
	| { kind: "failed"; reason: ObserverFailureReason; attempts: number; rejected: number };

/**
 * Thrown when the agent loop ends with an API/stream failure (`stopReason`
 * `"error"`/`"aborted"`) without recording anything. agent-core returns such
 * runs normally, so without this the caller cannot tell a hard failure from a
 * deliberate empty result (#32).
 */
export class ObserverStreamError extends Error {
	readonly stopReason: string;
	constructor(stopReason: string, errorMessage?: string) {
		super(`observer stream ended with stopReason "${stopReason}"${errorMessage ? `: ${errorMessage}` : ""}`);
		this.name = "ObserverStreamError";
		this.stopReason = stopReason;
	}
}

function joinOrEmpty(items: string[]): string {
	return items.length ? items.join("\n") : "(none yet)";
}

export function normalizeSourceEntryIds(
	sourceEntryIds: readonly string[] | undefined,
	allowedSourceEntryIds: readonly string[],
): string[] | undefined {
	if (!sourceEntryIds || sourceEntryIds.length === 0) return undefined;
	const allowedOrder = new Map<string, number>();
	for (let i = 0; i < allowedSourceEntryIds.length; i++) allowedOrder.set(allowedSourceEntryIds[i], i);

	const seen = new Set<string>();
	for (const id of sourceEntryIds) {
		if (!allowedOrder.has(id)) return undefined;
		seen.add(id);
	}
	if (seen.size === 0) return undefined;
	return Array.from(seen).sort((a, b) => (allowedOrder.get(a) ?? 0) - (allowedOrder.get(b) ?? 0));
}

export async function runObserver(args: RunObserverArgs): Promise<ObserverOutcome> {
	const { model, apiKey, headers, sessionId, priorReflections, priorObservations, chunk, allowedSourceEntryIds, signal } = args;
	const conversation = chunk.trim();
	if (!conversation) return { kind: "failed", reason: "no_structured_outcome", attempts: 0, rejected: 0 };

	const accumulated = new Map<string, Observation>();
	let activeAttempt: ObserverAttemptState | undefined;

	const recordObservations: AgentTool<typeof RecordObservationsSchema> = {
		name: "record_observations",
		label: "Record observations",
		description:
			"Record a batch of new observations distilled from the conversation chunk. " +
			"Call this multiple times as needed. If the chunk warrants no new observations, " +
			"call once with an empty observations array; plain text alone is not a valid outcome.",
		parameters: RecordObservationsSchema,
		execute: async (_id, params: RecordObservationsArgs) => {
			if (!activeAttempt) throw new Error("record_observations called outside an observer attempt");
			activeAttempt.toolCalls++;
			if (params.observations.length === 0) activeAttempt.explicitEmpty = true;
			let added = 0;
			let duplicates = 0;
			let rejected = 0;
			for (const obs of params.observations) {
				const sourceEntryIds = normalizeSourceEntryIds(obs.sourceEntryIds, allowedSourceEntryIds);
				if (!sourceEntryIds) {
					rejected++;
					continue;
				}
				const content = truncateRecordContent(obs.content);
				const id = hashId(content);
				if (accumulated.has(id)) {
					duplicates++;
					continue;
				}
				accumulated.set(id, {
					id,
					content,
					timestamp: obs.timestamp,
					relevance: obs.relevance as Relevance,
					sourceEntryIds,
					tokenCount: observationLineTokenCount({
						id,
						timestamp: obs.timestamp,
						relevance: obs.relevance,
						content,
					}),
				});
				added++;
			}
			activeAttempt.rejected += rejected;
			const rejectedPart = rejected > 0
				? ` ${rejected} observation${rejected === 1 ? "" : "s"} rejected for missing or invalid sourceEntryIds.`
				: "";
			const ack = params.observations.length === 0
				? "Explicit empty outcome recorded. End the run now."
				: `Recorded ${added} new observation${added === 1 ? "" : "s"} ` +
					(duplicates > 0 ? `(${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped).` : ".") +
					rejectedPart +
					` Total so far this run: ${accumulated.size}. Continue if the chunk still has uncovered content; otherwise end the run.`;
			return { content: [{ type: "text", text: ack }], details: { added, duplicates, rejected, total: accumulated.size } };
		},
	};

	const now = nowTimestamp();
	const userText = `Current local time: ${now}

CURRENT REFLECTIONS:
${joinOrEmpty(priorReflections)}

CURRENT OBSERVATIONS:
${joinOrEmpty(priorObservations)}

Compress the following new conversation chunk into observations by calling record_observations one or more times. Do not restate facts already present in current reflections or current observations. Prefer inline conversation timestamps when assigning times; fall back to the current local time above only if no message timestamp applies. If there is nothing new to record, call record_observations with {"observations": []}. A plain-text response without that tool call is a failed outcome.

NEW CONVERSATION CHUNK:
${conversation}`;

	const prompts: Message[] = [
		{
			role: "user",
			content: [{ type: "text", text: userText }],
			timestamp: Date.now(),
		},
	];

	const reasoning = (model as { reasoning?: unknown }).reasoning;
	const thinkingLevel = args.thinkingLevel ?? "low";
	const effectiveMaxTurns = args.maxTurns && args.maxTurns > 0 ? args.maxTurns : undefined;
	const loop = args.agentLoop ?? agentLoop;

	const runAttempt = async (attemptPrompts: Message[]): Promise<{
		state: ObserverAttemptState;
		streamError?: { stopReason: string; errorMessage?: string };
	}> => {
		const state: ObserverAttemptState = { toolCalls: 0, explicitEmpty: false, rejected: 0 };
		activeAttempt = state;
		let turnCount = 0;
		const config: AgentLoopConfig = {
			model,
			apiKey,
			headers,
			sessionId,
			maxTokens: boundedMaxTokens(model, AGENT_LOOP_MAX_TOKENS),
			convertToLlm: (msgs) => msgs as Message[],
			toolExecution: "sequential",
			...(reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
			...(effectiveMaxTurns !== undefined
				? {
					shouldStopAfterTurn: () => {
						turnCount++;
						return turnCount >= effectiveMaxTurns;
					},
				}
				: {}),
		};
		const context: AgentContext = {
			systemPrompt: OBSERVER_SYSTEM,
			messages: [],
			tools: [recordObservations as AgentTool<any>],
		};
		let streamError: { stopReason: string; errorMessage?: string } | undefined;
		try {
			const stream = loop(attemptPrompts, context, config, signal, streamSimple);
			for await (const event of stream) {
				logAgentStreamError("observer", event);
				const message = (event as { message?: { role?: string; stopReason?: string; errorMessage?: string } }).message;
				if (message?.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) {
					streamError = { stopReason: message.stopReason, errorMessage: message.errorMessage };
				}
			}
			await stream.result();
			return { state, streamError };
		} finally {
			activeAttempt = undefined;
		}
	};

	const classifyAttempt = (
		state: ObserverAttemptState,
		streamError: { stopReason: string; errorMessage?: string } | undefined,
		attempts: number,
	): ObserverOutcome => {
		if (accumulated.size > 0) {
			return { kind: "recorded", observations: Array.from(accumulated.values()), attempts };
		}
		if (streamError) throw new ObserverStreamError(streamError.stopReason, streamError.errorMessage);
		if (state.rejected > 0) {
			return { kind: "failed", reason: "rejected_observations", attempts, rejected: state.rejected };
		}
		if (state.toolCalls > 0 && state.explicitEmpty) return { kind: "empty", attempts };
		return { kind: "failed", reason: "no_structured_outcome", attempts, rejected: 0 };
	};

	const firstAttempt = await runAttempt(prompts);
	const firstOutcome = classifyAttempt(firstAttempt.state, firstAttempt.streamError, 1);
	if (firstOutcome.kind !== "failed" || firstOutcome.reason !== "no_structured_outcome") return firstOutcome;

	const correction: Message = {
		role: "user",
		content: [{
			type: "text",
			text: `CORRECTIVE RETRY: Your previous response did not produce the required structured outcome. Call record_observations now. Use {"observations": []} if the chunk warrants no new observations; do not answer with plain text only.\n\n${userText}`,
		}],
		timestamp: Date.now(),
	};
	const secondAttempt = await runAttempt([correction]);
	return classifyAttempt(secondAttempt.state, secondAttempt.streamError, 2);
}
