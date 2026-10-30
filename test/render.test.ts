import { describe, expect, it } from "bun:test";
import { stopBlockedReason } from "../src/render";
import { createRun } from "../src/run";
import type { RefereeRun, ReviewRecord } from "../src/types";

const SUMMARY = "Ran bun test and read a.txt; beta is not there yet.";

function freshRun(): RefereeRun {
	return createRun({ id: "run-1", objective: "Make a.txt say beta.", refereeModel: "fake/referee", now: 1 });
}

function record(run: RefereeRun, overrides: Partial<ReviewRecord> = {}): ReviewRecord {
	return {
		index: run.reviews.length + 1,
		kind: "complete",
		outcome: "verdict",
		summary: SUMMARY,
		findings: [],
		objectiveVersion: run.objectiveVersion,
		startedAt: 2,
		durationMs: 10,
		tokens: 100,
		costUsd: 0.01,
		...overrides,
	};
}

/** The referee's words inside a stop-blocked reason, or undefined when it carries none. */
function feedback(reason: string): string | undefined {
	return /<referee-feedback>\n([\s\S]*?)\n<\/referee-feedback>/.exec(reason)?.[1];
}

describe("stop-blocked reason", () => {
	it("restates the objective, with no feedback before any review", () => {
		const reason = stopBlockedReason(freshRun());
		expect(reason).toContain("Make a.txt say beta.");
		expect(feedback(reason)).toBeUndefined();
	});

	it("carries the referee's summary and findings", () => {
		const run = freshRun();
		run.reviews.push(record(run, { verdict: "fail", findings: ["a.txt still says alpha."] }));
		const words = feedback(stopBlockedReason(run));
		expect(words).toContain(SUMMARY);
		expect(words).toContain("a.txt still says alpha.");
	});

	it("speaks for the newest review, not an older fail", () => {
		const run = freshRun();
		run.reviews.push(record(run, { verdict: "fail", findings: ["a.txt still says alpha."] }));
		run.reviews.push(record(run, { outcome: "error", summary: "injected referee outage" }));
		const words = feedback(stopBlockedReason(run));
		expect(words).toContain("injected referee outage");
		expect(words).not.toContain("a.txt still says alpha.");
	});

	it("ignores reviews of an older objective version", () => {
		const run = freshRun();
		run.reviews.push(record(run, { verdict: "fail", findings: ["old finding"] }));
		run.objectiveVersion = 2;
		expect(feedback(stopBlockedReason(run))).toBeUndefined();
	});

	it("escapes the objective and the referee's text", () => {
		const run = createRun({ id: "run-2", objective: "Make a < b && c > d.", refereeModel: "fake/referee", now: 1 });
		run.reviews.push(record(run, { verdict: "fail", findings: ['the command printed "<x>"'] }));
		const reason = stopBlockedReason(run);
		expect(reason).toContain("Make a &lt; b &amp;&amp; c &gt; d.");
		expect(reason).toContain("&lt;x&gt;");
	});
});
