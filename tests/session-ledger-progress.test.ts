import { describe, expect, it } from "vitest";

import {
	contextTokensFromUsage,
	earlierCoverageMarkerId,
	entryIndexById,
	isSourceEntry,
	latestCoverageIndex,
	latestCoverageMarkerId,
	latestObservationCoverageIndex,
	latestObservationCoverageMarkerId,
	latestObserverFailureForCoverage,
	rawTokensAfterIndex,
	rawTokensSinceDropCoverage,
	rawTokensSinceLastCompaction,
	rawTokensSinceObservationCoverage,
	rawTokensSinceReflectionCoverage,
	realTokensSinceAnchor,
	realTokensSinceObservationCoverage,
} from "../src/session-ledger/index.js";
import {
	V3_OBSERVATIONS_DROPPED,
	V3_OBSERVATIONS_RECORDED,
	V3_REFLECTIONS_RECORDED,
	branchSummary,
	compactionEntry,
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	observerCompletedEntry,
	observerFailedEntry,
	oldV2ObservationEntry,
	reflection,
	rawMessage,
	reflectionsRecordedEntry,
	textCustomMessage,
} from "./fixtures/session.js";

function assistantUsageEntry(id: string, totalTokens: number, stopReason = "stop") {
	return rawMessage(id, "assistant", {
		message: {
			role: "assistant",
			content: [{ type: "text", text: "assistant" }],
			stopReason,
			usage: { totalTokens },
		},
	});
}

describe("session-ledger V3 progress helpers", () => {
	it("detects only raw/source entries as source entries", () => {
		expect(isSourceEntry(textCustomMessage("raw-1", "abcd"))).toBe(true);
		expect(isSourceEntry(branchSummary("sum-1", "abcd"))).toBe(true);
		expect(isSourceEntry(observationsRecordedEntry("om-1", {
			observations: [observation("aaaaaaaaaaaa")],
			coversUpToId: "raw-1",
		}))).toBe(false);
		expect(isSourceEntry(compactionEntry("cmp-1"))).toBe(false);
	});

	it("builds a branch id to index map", () => {
		const entries = [textCustomMessage("raw-1", "abcd"), textCustomMessage("raw-2", "efgh")];
		expect(entryIndexById(entries).get("raw-1")).toBe(0);
		expect(entryIndexById(entries).get("raw-2")).toBe(1);
	});

	it("reads provider context usage without inventing partial totals", () => {
		expect(contextTokensFromUsage({ totalTokens: 120 })).toBe(120);
		expect(contextTokensFromUsage({ input: 40, output: 20, cacheRead: 30, cacheWrite: 10 })).toBe(100);
		expect(contextTokensFromUsage({ input: 40, output: 20, cacheRead: 30 })).toBeUndefined();
		expect(contextTokensFromUsage({ totalTokens: -1 })).toBeUndefined();
	});

	it("measures real context growth from the usage at the coverage anchor", () => {
		const entries = [
			assistantUsageEntry("raw-1", 100),
			observationsRecordedEntry("om-1", {
				observations: [observation("aaaaaaaaaaaa")],
				coversUpToId: "raw-1",
			}),
			textCustomMessage("raw-2", "new source"),
			assistantUsageEntry("raw-3", 160),
		];

		expect(realTokensSinceAnchor(entries, undefined, 160)).toBe(160);
		expect(realTokensSinceAnchor(entries, V3_OBSERVATIONS_RECORDED, 160)).toBe(60);
	});

	it("uses the post-compaction usage baseline when the coverage anchor predates compaction", () => {
		const entries = [
			assistantUsageEntry("raw-1", 100),
			observationsRecordedEntry("om-1", {
				observations: [observation("aaaaaaaaaaaa")],
				coversUpToId: "raw-1",
			}),
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-2" }),
			textCustomMessage("raw-2", "kept source"),
			assistantUsageEntry("raw-3", 40),
		];

		expect(realTokensSinceAnchor(entries, V3_OBSERVATIONS_RECORDED, 40)).toBe(0);
	});

	it("ignores failed assistant usage and falls back when no valid baseline exists", () => {
		const entries = [
			assistantUsageEntry("raw-1", 500, "error"),
			observationsRecordedEntry("om-1", {
				observations: [observation("aaaaaaaaaaaa")],
				coversUpToId: "raw-1",
			}),
			textCustomMessage("raw-2", "source"),
		];

		expect(realTokensSinceAnchor(entries, V3_OBSERVATIONS_RECORDED, 600)).toBeUndefined();
	});

	it("counts raw tokens after a branch index and ignores memory/compaction entries", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-1", { observations: [observation("aaaaaaaaaaaa")], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-2" }),
			branchSummary("sum-1", "cccccccccccc"),
		];

		expect(rawTokensAfterIndex(entries, 0)).toBe(5); // raw-2: 2 + sum-1: 3
		expect(rawTokensAfterIndex(entries, 1)).toBe(5);
		expect(rawTokensAfterIndex(entries, 2)).toBe(3);
	});

	it("uses independent coverage clocks for observations, reflections, and drops", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [observation("aaaaaaaaaaaa")], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])], coversUpToId: "raw-2" }),
			textCustomMessage("raw-3", "cccccccccccc"),
			observationsDroppedEntry("om-drop-1", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "om-eeeeeeeeeeee" }),
			textCustomMessage("raw-4", "dddddddddddddddd"),
		];

		expect(rawTokensSinceObservationCoverage(entries)).toBe(9); // raw-2 + raw-3 + raw-4
		expect(rawTokensSinceReflectionCoverage(entries)).toBe(7); // raw-3 + raw-4
		expect(rawTokensSinceDropCoverage(entries)).toBe(7); // covers ledger entry om-eeeeeeeeeeee, raw after it
	});

	it("advances observation coverage through explicit empty completion", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-obs", {
				observations: [observation("aaaaaaaaaaaa")],
				coversUpToId: "raw-1",
			}),
			textCustomMessage("raw-2", "bbbbbbbb"),
			observerCompletedEntry("om-empty", "raw-2"),
			textCustomMessage("raw-3", "cccccccccccc"),
		];

		expect(latestObservationCoverageIndex(entries)).toBe(2);
		expect(latestObservationCoverageMarkerId(entries)).toBe("raw-2");
		expect(rawTokensSinceObservationCoverage(entries)).toBe(3);
	});

	it("uses explicit empty completion as a real-token coverage anchor", () => {
		const entries = [
			assistantUsageEntry("raw-1", 100),
			observerCompletedEntry("om-empty", "raw-1"),
			assistantUsageEntry("raw-2", 150),
		];

		expect(realTokensSinceObservationCoverage(entries, 150)).toBe(50);
	});

	it("ignores malformed, orphaned, and non-source empty completion markers", () => {
		const recorded = observationsRecordedEntry("om-recorded", {
			observations: [observation("aaaaaaaaaaaa")],
			coversUpToId: "raw-1",
		});
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			recorded,
			observerCompletedEntry("om-before-source", "raw-2"),
			textCustomMessage("raw-2", "bbbbbbbb"),
			observerCompletedEntry("om-orphan", "missing"),
			observerCompletedEntry("om-non-source", "om-recorded"),
			observerCompletedEntry("om-malformed", "raw-2", { data: { outcome: "recorded", coversUpToId: "raw-2" } }),
		];

		expect(latestObservationCoverageMarkerId(entries)).toBe("raw-1");
		expect(rawTokensSinceObservationCoverage(entries)).toBe(2);
	});

	it("returns only valid failure state for the current coverage", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observerFailedEntry("failed-old", { coversUpToId: "raw-1", coverageId: "older" }),
			observerFailedEntry("failed-current", { coversUpToId: "raw-1", retryAt: 61_000, consecutiveFailures: 2 }),
			observerFailedEntry("failed-orphan", { coversUpToId: "missing", retryAt: 91_000, consecutiveFailures: 3 }),
			textCustomMessage("raw-2", "bbbb"),
			observerFailedEntry("failed-covered", { coversUpToId: "raw-2", coverageId: "raw-1", retryAt: 121_000, consecutiveFailures: 4 }),
			observerFailedEntry("failed-same-boundary", { coversUpToId: "raw-2", coverageId: "raw-2", retryAt: 151_000, consecutiveFailures: 5 }),
			observerFailedEntry("failed-orphan-coverage", { coversUpToId: "raw-2", coverageId: "missing", retryAt: 181_000, consecutiveFailures: 6 }),
		];

		expect(latestObserverFailureForCoverage(entries, undefined)).toMatchObject({
			coversUpToId: "raw-1",
			retryAt: 61_000,
			consecutiveFailures: 2,
		});
		expect(latestObserverFailureForCoverage(entries, "raw-1")).toMatchObject({
			coversUpToId: "raw-2",
			retryAt: 121_000,
			consecutiveFailures: 4,
		});
		expect(latestObserverFailureForCoverage(entries, "different")).toBeUndefined();
	});

	it("lets coversUpToId point to a memory ledger entry", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])], coversUpToId: "raw-1" }),
			observationsDroppedEntry("om-drop-1", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "om-eeeeeeeeeeee" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];

		expect(latestCoverageIndex(entries, V3_OBSERVATIONS_DROPPED)).toBe(1);
		expect(rawTokensSinceDropCoverage(entries)).toBe(2);
	});

	it("chooses the max covered branch position, not merely latest ledger entry order", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			textCustomMessage("raw-2", "bbbbbbbb"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [observation("aaaaaaaaaaaa")], coversUpToId: "raw-2" }),
			observationsRecordedEntry("om-bbbbbbbbbbbb", { observations: [observation("bbbbbbbbbbbb")], coversUpToId: "raw-1" }),
			textCustomMessage("raw-3", "cccccccccccc"),
		];

		expect(latestCoverageIndex(entries, V3_OBSERVATIONS_RECORDED)).toBe(1);
		expect(latestCoverageMarkerId(entries, V3_OBSERVATIONS_RECORDED)).toBe("raw-2");
		expect(rawTokensSinceObservationCoverage(entries)).toBe(3);
	});

	it("returns latest inner coverage marker and earlier marker by branch index", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			textCustomMessage("raw-2", "bbbbbbbb"),
			textCustomMessage("raw-3", "cccccccccccc"),
			observationsRecordedEntry("om-obs", { observations: [observation("aaaaaaaaaaaa")], coversUpToId: "raw-3" }),
			reflectionsRecordedEntry("om-ref", { reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])], coversUpToId: "raw-2" }),
		];

		expect(latestCoverageMarkerId(entries, V3_OBSERVATIONS_RECORDED)).toBe("raw-3");
		expect(latestCoverageMarkerId(entries, V3_REFLECTIONS_RECORDED)).toBe("raw-2");
		expect(earlierCoverageMarkerId(entries, "raw-3", "raw-2")).toBe("raw-2");
		expect(earlierCoverageMarkerId(entries, "raw-1", undefined)).toBe("raw-1");
		expect(earlierCoverageMarkerId(entries, "missing", "raw-2")).toBe("raw-2");
		expect(earlierCoverageMarkerId(entries, "missing-a", "missing-b")).toBeUndefined();
	});

	it("ignores invalid coverage markers and old V2 markers without throwing", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			oldV2ObservationEntry("v2-obs"),
			observationsRecordedEntry("om-obs-invalid", { observations: [observation("aaaaaaaaaaaa")], coversUpToId: "missing" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];

		expect(() => rawTokensSinceObservationCoverage(entries)).not.toThrow();
		expect(rawTokensSinceObservationCoverage(entries)).toBe(3);
		expect(latestCoverageIndex(entries, V3_REFLECTIONS_RECORDED)).toBe(-1);
	});

	it("counts raw tokens since the latest Pi compaction without throwing on old memory details", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-1" }),
			oldV2ObservationEntry("v2-obs"),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];

		expect(rawTokensSinceLastCompaction(entries)).toBe(3); // raw-1 + raw-2 from live tail starting at firstKeptEntryId
	});
});
