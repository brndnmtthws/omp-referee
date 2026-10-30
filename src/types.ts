/** Shared types for omp-referee: the run state, reviews, verdicts, and the referee runtime contract. */

/** What the main agent asks the referee to judge. */
export type ReviewKind = "complete" | "blocked";

/** The referee's ruling: `pass`/`fail` answer a completion claim, `escalate`/`fail` a blocked claim. */
export type Verdict = "pass" | "fail" | "escalate";

/**
 * `active`: the stop gate holds the agent until the referee passes the objective.
 * `paused`: the gate is open; `/referee resume` re-arms it.
 * `passed` and `stopped` are terminal.
 */
export type RunStatus = "active" | "paused" | "passed" | "stopped";

/** Why a run is paused. */
export type PauseReason = "user" | "restored" | "stalled" | "budget" | "error";

/** How a review ended: a verdict, or why it has none. */
export type ReviewOutcome = "verdict" | "stale" | "error" | "aborted";

export interface ReviewRecord {
	/** 1-based, in request order. */
	index: number;
	kind: ReviewKind;
	outcome: ReviewOutcome;
	/** Present when `outcome` is `verdict`. */
	verdict?: Verdict;
	/** The referee's summary, or the reason the review has no verdict. */
	summary: string;
	/** Unmet requirements, for a `fail`. */
	findings: string[];
	/** Objective version the review judged. */
	objectiveVersion: number;
	startedAt: number;
	durationMs: number;
	tokens: number;
	costUsd: number;
}

/** One refereed objective, persisted as a session entry after every change. */
export interface RefereeRun {
	id: string;
	objective: string;
	/** Starts at 1; every edit bumps it, which voids verdicts on older versions. */
	objectiveVersion: number;
	status: RunStatus;
	/** Present while paused. */
	pauseReason?: PauseReason;
	/** Model selector the referee runs on, e.g. `openai/gpt-5.2:high`. */
	refereeModel: string;
	createdAt: number;
	updatedAt: number;
	reviews: ReviewRecord[];
	/** Reviews since the run started or last resumed; `maxReviews` bounds it. */
	reviewsSinceResume: number;
	/** Referee spend since the run started or last resumed; `maxCostUsd` bounds it. */
	costSinceResume: number;
	/** Total referee spend (reviews and status checks). */
	costUsd: number;
	/** Set by an `escalate` verdict: the next stop goes through so the agent can ask the user. */
	stopAllowed: boolean;
	/** Stops in a row the gate blocked while the agent ran no tool in between. */
	idleStops: number;
	/** Reviews in a row that failed to produce a verdict because the referee errored. */
	reviewErrors: number;
}

/** Limits on one active stretch of a run; unset means unlimited. */
export interface RefereeBudgets {
	maxReviews?: number;
	maxCostUsd?: number;
	/** Consecutive tool-free stops after which the run pauses instead of blocking again. */
	stallLimit: number;
}

export interface RefereeUsage {
	tokens: number;
	costUsd: number;
}

/** What the referee is doing right now, for the status line and the review tool's live view. */
export interface RefereeActivity {
	state: "thinking" | "tool" | "retrying" | "compacting" | "idle";
	/** Tool name for `tool`; the provider error for `retrying`. */
	tool?: string;
	detail?: string;
	toolCount: number;
	/** When the referee entered this step (ms epoch). */
	since: number;
}

/** One review, as the referee's prompt renders it; text fields are raw and escaped by the prompt builder. */
export interface RefereeReviewRequest {
	index: number;
	kind: ReviewKind;
	objective: string;
	objectiveVersion: number;
	/** True when the objective changed since this referee session's previous review. */
	objectiveChanged: boolean;
	/** Digest of earlier reviews, for a referee session that has not seen them. */
	history?: string;
	claim: string;
	evidence?: string;
	question?: string;
}

export interface RefereeVerdictRecord {
	verdict: Verdict;
	summary: string;
	findings: string[];
}

export interface RefereeReviewResult {
	verdict?: RefereeVerdictRecord;
	error?: string;
	aborted?: boolean;
	usage: RefereeUsage;
}

export interface RefereeStatusRequest {
	objective: string;
	objectiveVersion: number;
	/** Markdown digest of the run's reviews. */
	reviews: string;
	/** Tail of the main conversation, newest last. */
	activity?: string;
	question?: string;
}

export interface RefereeStatusResult {
	text: string;
	error?: string;
	aborted?: boolean;
	usage: RefereeUsage;
}

/** The referee's persistent review session for one run. */
export interface RefereeReviewer {
	readonly agentId: string;
	readonly sessionFile: string | undefined;
	review(
		request: RefereeReviewRequest,
		onActivity: (activity: RefereeActivity) => void,
		signal?: AbortSignal,
	): Promise<RefereeReviewResult>;
	dispose(): Promise<void>;
}
