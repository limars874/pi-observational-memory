import { describe, expect, it } from "vitest";

import {
	OBSERVER_FAILURE_BACKOFF_MAX_MS,
	OBSERVER_FAILURE_DETAIL_MAX_CHARS,
	OM_FOLDED,
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_OBSERVER_COMPLETED,
	OM_OBSERVER_FAILED,
	OM_REFLECTIONS_RECORDED,
	buildObservationsDroppedData,
	buildObservationsRecordedData,
	buildObserverCompletedData,
	buildObserverFailedData,
	buildReflectionsRecordedData,
	isMemoryDetails,
	isObservationsDroppedData,
	isObservationsDroppedEntry,
	isObservationsRecordedData,
	isObservationsRecordedEntry,
	isObservation,
	isObserverCompletedData,
	isObserverCompletedEntry,
	isObserverFailedData,
	isObserverFailedEntry,
	isReflection,
	isReflectionsRecordedData,
	isReflectionsRecordedEntry,
} from "../src/session-ledger/index.js";
import {
	memoryDetails,
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	observerCompletedEntry,
	observerFailedEntry,
	oldV2CompactionDetails,
	oldV2ObservationEntry,
	reflection,
	reflectionsRecordedEntry,
} from "./fixtures/session.js";

describe("session-ledger V3 type guards and builders", () => {
	it("exports the V3 custom type constants", () => {
		expect(OM_OBSERVATIONS_RECORDED).toBe("om.observations.recorded");
		expect(OM_OBSERVER_COMPLETED).toBe("om.observer.completed");
		expect(OM_OBSERVER_FAILED).toBe("om.observer.failed");
		expect(OM_REFLECTIONS_RECORDED).toBe("om.reflections.recorded");
		expect(OM_OBSERVATIONS_DROPPED).toBe("om.observations.dropped");
		expect(OM_FOLDED).toBe("om.folded");
	});

	it("accepts valid V3 observation records and rejects observations without source ids", () => {
		expect(isObservation(observation("aaaaaaaaaaaa"))).toBe(true);
		expect(isObservation({ ...observation("bbbbbbbbbbbb"), sourceEntryIds: [] })).toBe(false);
		expect(isObservation({ ...observation("cccccccccccc"), sourceEntryIds: undefined })).toBe(false);
		expect(isObservation({ ...observation("dddddddddddd"), tokenCount: undefined })).toBe(false);
	});

	it("accepts explicit empty completion and bounded observer failure data", () => {
		const completed = { outcome: "empty", coversUpToId: "raw-1" };
		const failed = {
			reason: "no_structured_outcome" as const,
			coversUpToId: "raw-1",
			failedAt: 1_000,
			retryAt: 31_000,
			consecutiveFailures: 1,
		};

		expect(isObserverCompletedData(completed)).toBe(true);
		expect(isObserverCompletedData({ ...completed, outcome: "failed" })).toBe(false);
		expect(isObserverFailedData(failed)).toBe(true);
		expect(isObserverFailedData({
			...failed,
			retryAt: failed.failedAt + OBSERVER_FAILURE_BACKOFF_MAX_MS + 1,
		})).toBe(false);
		expect(isObserverFailedData({
			...failed,
			detail: "x".repeat(OBSERVER_FAILURE_DETAIL_MAX_CHARS + 1),
		})).toBe(false);
		expect(buildObserverCompletedData("raw-1")).toEqual(completed);
		expect(buildObserverCompletedData("")).toBeUndefined();
		expect(buildObserverFailedData(failed)).toEqual(failed);
	});

	it("accepts valid V3 reflection records", () => {
		expect(isReflection(reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]))).toBe(true);
		expect(isReflection({ ...reflection("ffffffffffff"), supportingObservationIds: undefined })).toBe(false);
		expect(isReflection({ ...reflection("111111111111"), tokenCount: undefined })).toBe(false);
	});

	it("accepts non-empty V3 ledger entry data", () => {
		const obsData = { observations: [observation("aaaaaaaaaaaa")], coversUpToId: "raw-1" };
		const refData = { reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])], coversUpToId: "raw-2" };
		const dropData = { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "ref-entry-1" };

		expect(isObservationsRecordedData(obsData)).toBe(true);
		expect(isReflectionsRecordedData(refData)).toBe(true);
		expect(isObservationsDroppedData(dropData)).toBe(true);
	});

	it("rejects empty ledger entry data so no empty progress entries can be appended", () => {
		expect(isObservationsRecordedData({ observations: [], coversUpToId: "raw-1" })).toBe(false);
		expect(isReflectionsRecordedData({ reflections: [], coversUpToId: "raw-1" })).toBe(false);
		expect(isObservationsDroppedData({ observationIds: [], coversUpToId: "raw-1" })).toBe(false);
	});

	it("builders return undefined for empty arrays and data for non-empty arrays", () => {
		expect(buildObservationsRecordedData([], "raw-1")).toBeUndefined();
		expect(buildReflectionsRecordedData([], "raw-1")).toBeUndefined();
		expect(buildObservationsDroppedData([], "raw-1")).toBeUndefined();

		expect(buildObservationsRecordedData([observation("aaaaaaaaaaaa")], "raw-1")).toEqual({
			observations: [observation("aaaaaaaaaaaa")],
			coversUpToId: "raw-1",
		});
		expect(buildReflectionsRecordedData([reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])], "raw-1")).toEqual({
			reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])],
			coversUpToId: "raw-1",
		});
		expect(buildObservationsDroppedData(["aaaaaaaaaaaa"], "ref-entry-1")).toEqual({
			observationIds: ["aaaaaaaaaaaa"],
			coversUpToId: "ref-entry-1",
		});
	});

	it("recognizes V3 memory entries", () => {
		expect(isObservationsRecordedEntry(observationsRecordedEntry("om-aaaaaaaaaaaa", {
			observations: [observation("aaaaaaaaaaaa")],
			coversUpToId: "raw-1",
		}))).toBe(true);
		expect(isObserverCompletedEntry(observerCompletedEntry("om-empty", "raw-1"))).toBe(true);
		expect(isObserverFailedEntry(observerFailedEntry("om-failed", { coversUpToId: "raw-1" }))).toBe(true);
		expect(isReflectionsRecordedEntry(reflectionsRecordedEntry("om-eeeeeeeeeeee", {
			reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])],
			coversUpToId: "raw-1",
		}))).toBe(true);
		expect(isObservationsDroppedEntry(observationsDroppedEntry("om-drop-1", {
			observationIds: ["aaaaaaaaaaaa"],
			coversUpToId: "om-eeeeeeeeeeee",
		}))).toBe(true);
	});

	it("accepts flat V3 folded memory details", () => {
		expect(isMemoryDetails(memoryDetails({
			fullFold: true,
			observations: [observation("aaaaaaaaaaaa")],
			reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])],
		}))).toBe(true);
	});

	it("ignores old V2 observation entries and old V2 compaction details", () => {
		expect(isObservationsRecordedEntry(oldV2ObservationEntry("v2-entry"))).toBe(false);
		expect(isMemoryDetails(oldV2CompactionDetails())).toBe(false);
	});
});
