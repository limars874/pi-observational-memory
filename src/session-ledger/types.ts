export const OM_OBSERVATIONS_RECORDED = "om.observations.recorded";
export const OM_OBSERVER_COMPLETED = "om.observer.completed";
export const OM_OBSERVER_FAILED = "om.observer.failed";
export const OM_REFLECTIONS_RECORDED = "om.reflections.recorded";
export const OM_OBSERVATIONS_DROPPED = "om.observations.dropped";
export const OM_FOLDED = "om.folded";

export const RELEVANCE_VALUES = ["low", "medium", "high", "critical"] as const;
export type Relevance = (typeof RELEVANCE_VALUES)[number];

export const MEMORY_ID_PATTERN = /^[a-f0-9]{12}$/;

export type Entry = {
	type: string;
	id: string;
	timestamp?: string;
	message?: unknown;
	content?: unknown;
	customType?: string;
	summary?: unknown;
	fromId?: string;
	data?: unknown;
	details?: unknown;
	firstKeptEntryId?: string;
};

export type Observation = {
	id: string;
	content: string;
	timestamp: string;
	relevance: Relevance;
	sourceEntryIds: string[];
	tokenCount: number;
};

export type Reflection = {
	id: string;
	content: string;
	supportingObservationIds: string[];
	tokenCount: number;
};

export type ObservationsRecordedEntryData = {
	observations: Observation[];
	coversUpToId: string;
};

export type ObserverCompletedEntryData = {
	outcome: "empty";
	coversUpToId: string;
};

export const OBSERVER_FAILURE_BACKOFF_BASE_MS = 30_000;
export const OBSERVER_FAILURE_BACKOFF_MAX_MS = 15 * 60_000;
export const OBSERVER_FAILURE_DETAIL_MAX_CHARS = 2_000;

export const OBSERVER_FAILURE_REASONS = [
	"no_structured_outcome",
	"rejected_observations",
	"stream_error",
	"execution_error",
] as const;
export type ObserverFailureReason = (typeof OBSERVER_FAILURE_REASONS)[number];

export type ObserverFailedEntryData = {
	reason: ObserverFailureReason;
	coversUpToId: string;
	coverageId?: string;
	failedAt: number;
	retryAt: number;
	consecutiveFailures: number;
	detail?: string;
};

export type ReflectionsRecordedEntryData = {
	reflections: Reflection[];
	coversUpToId: string;
};

export type ObservationsDroppedEntryData = {
	observationIds: string[];
	coversUpToId: string;
};

export type MemoryDetails = {
	type: typeof OM_FOLDED;
	version: 1;
	fullFold: boolean;
	observations: Observation[];
	reflections: Reflection[];
	/**
	 * Entry through which this summary folded the ledger. Differs from the
	 * compaction's `firstKeptEntryId` when the hook moved the cut to retain
	 * unobserved source. A later compaction uses it as the maintenance boundary
	 * for drops and reflections, so it applies exactly what this fold applied.
	 */
	foldThroughEntryId?: string;
};

export type V3MemoryCustomType =
	| typeof OM_OBSERVATIONS_RECORDED
	| typeof OM_REFLECTIONS_RECORDED
	| typeof OM_OBSERVATIONS_DROPPED;

export function isRelevance(value: unknown): value is Relevance {
	return typeof value === "string" && (RELEVANCE_VALUES as readonly string[]).includes(value);
}

export function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

export function isNonEmptyStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

export function isMemoryId(value: unknown): value is string {
	return typeof value === "string" && MEMORY_ID_PATTERN.test(value);
}

function isTokenCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isObserverFailureReason(value: unknown): value is ObserverFailureReason {
	return typeof value === "string" && (OBSERVER_FAILURE_REASONS as readonly string[]).includes(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}

export function isObservation(value: unknown): value is Observation {
	if (!isPlainRecord(value)) return false;
	return (
		isMemoryId(value.id) &&
		isNonEmptyString(value.content) &&
		isNonEmptyString(value.timestamp) &&
		isRelevance(value.relevance) &&
		isNonEmptyStringArray(value.sourceEntryIds) &&
		isTokenCount(value.tokenCount)
	);
}

export function isReflection(value: unknown): value is Reflection {
	if (!isPlainRecord(value)) return false;
	return (
		isMemoryId(value.id) &&
		isNonEmptyString(value.content) &&
		!/\r|\n/.test(value.content) &&
		isNonEmptyStringArray(value.supportingObservationIds) &&
		isTokenCount(value.tokenCount)
	);
}

export function isObservationsRecordedData(value: unknown): value is ObservationsRecordedEntryData {
	if (!isPlainRecord(value)) return false;
	return (
		Array.isArray(value.observations) &&
		value.observations.length > 0 &&
		value.observations.every(isObservation) &&
		isNonEmptyString(value.coversUpToId)
	);
}

export function isObserverCompletedData(value: unknown): value is ObserverCompletedEntryData {
	if (!isPlainRecord(value)) return false;
	return value.outcome === "empty" && isNonEmptyString(value.coversUpToId);
}

export function isObserverFailedData(value: unknown): value is ObserverFailedEntryData {
	if (!isPlainRecord(value)) return false;
	return (
		isObserverFailureReason(value.reason) &&
		isNonEmptyString(value.coversUpToId) &&
		(value.coverageId === undefined || isNonEmptyString(value.coverageId)) &&
		typeof value.failedAt === "number" &&
		Number.isFinite(value.failedAt) &&
		value.failedAt >= 0 &&
		typeof value.retryAt === "number" &&
		Number.isFinite(value.retryAt) &&
		value.retryAt >= value.failedAt &&
		value.retryAt - value.failedAt <= OBSERVER_FAILURE_BACKOFF_MAX_MS &&
		typeof value.consecutiveFailures === "number" &&
		Number.isInteger(value.consecutiveFailures) &&
		value.consecutiveFailures >= 1 &&
		(value.detail === undefined || (isNonEmptyString(value.detail) && value.detail.length <= OBSERVER_FAILURE_DETAIL_MAX_CHARS))
	);
}

export function isReflectionsRecordedData(value: unknown): value is ReflectionsRecordedEntryData {
	if (!isPlainRecord(value)) return false;
	return (
		Array.isArray(value.reflections) &&
		value.reflections.length > 0 &&
		value.reflections.every(isReflection) &&
		isNonEmptyString(value.coversUpToId)
	);
}

export function isObservationsDroppedData(value: unknown): value is ObservationsDroppedEntryData {
	if (!isPlainRecord(value)) return false;
	return isNonEmptyStringArray(value.observationIds) && isNonEmptyString(value.coversUpToId);
}

export function isMemoryDetails(value: unknown): value is MemoryDetails {
	if (!isPlainRecord(value)) return false;
	return (
		value.type === OM_FOLDED &&
		value.version === 1 &&
		typeof value.fullFold === "boolean" &&
		Array.isArray(value.observations) &&
		value.observations.every(isObservation) &&
		Array.isArray(value.reflections) &&
		value.reflections.every(isReflection) &&
		(value.foldThroughEntryId === undefined || typeof value.foldThroughEntryId === "string")
	);
}

export function isObservationsRecordedEntry(entry: Entry): entry is Entry & {
	type: "custom";
	customType: typeof OM_OBSERVATIONS_RECORDED;
	data: ObservationsRecordedEntryData;
} {
	return entry.type === "custom" && entry.customType === OM_OBSERVATIONS_RECORDED && isObservationsRecordedData(entry.data);
}

export function isObserverCompletedEntry(entry: Entry): entry is Entry & {
	type: "custom";
	customType: typeof OM_OBSERVER_COMPLETED;
	data: ObserverCompletedEntryData;
} {
	return entry.type === "custom" && entry.customType === OM_OBSERVER_COMPLETED && isObserverCompletedData(entry.data);
}

export function isObserverFailedEntry(entry: Entry): entry is Entry & {
	type: "custom";
	customType: typeof OM_OBSERVER_FAILED;
	data: ObserverFailedEntryData;
} {
	return entry.type === "custom" && entry.customType === OM_OBSERVER_FAILED && isObserverFailedData(entry.data);
}

export function isReflectionsRecordedEntry(entry: Entry): entry is Entry & {
	type: "custom";
	customType: typeof OM_REFLECTIONS_RECORDED;
	data: ReflectionsRecordedEntryData;
} {
	return entry.type === "custom" && entry.customType === OM_REFLECTIONS_RECORDED && isReflectionsRecordedData(entry.data);
}

export function isObservationsDroppedEntry(entry: Entry): entry is Entry & {
	type: "custom";
	customType: typeof OM_OBSERVATIONS_DROPPED;
	data: ObservationsDroppedEntryData;
} {
	return entry.type === "custom" && entry.customType === OM_OBSERVATIONS_DROPPED && isObservationsDroppedData(entry.data);
}

export function buildObservationsRecordedData(
	observations: Observation[],
	coversUpToId: string,
): ObservationsRecordedEntryData | undefined {
	if (observations.length === 0 || !isNonEmptyString(coversUpToId)) return undefined;
	return { observations, coversUpToId };
}

export function buildObserverCompletedData(coversUpToId: string): ObserverCompletedEntryData | undefined {
	if (!isNonEmptyString(coversUpToId)) return undefined;
	return { outcome: "empty", coversUpToId };
}

export function buildObserverFailedData(
	data: ObserverFailedEntryData,
): ObserverFailedEntryData | undefined {
	return isObserverFailedData(data) ? data : undefined;
}

export function buildReflectionsRecordedData(
	reflections: Reflection[],
	coversUpToId: string,
): ReflectionsRecordedEntryData | undefined {
	if (reflections.length === 0 || !isNonEmptyString(coversUpToId)) return undefined;
	return { reflections, coversUpToId };
}

export function buildObservationsDroppedData(
	observationIds: string[],
	coversUpToId: string,
): ObservationsDroppedEntryData | undefined {
	if (observationIds.length === 0 || !isNonEmptyString(coversUpToId)) return undefined;
	return { observationIds, coversUpToId };
}
