/**
 * omp-referee: `/referee <objective>` starts a goal loop the main agent cannot
 * leave until a second model, the referee, verifies the objective is met.
 *
 * A `session_stop` hook keeps the agent working while a run is active. The
 * agent asks for a ruling with `referee_review`, which runs the referee in its
 * own session (tools have no time limit; stop hooks do) and applies the
 * verdict: `pass` ends the run, `fail` returns findings, `escalate` lets the
 * agent stop to ask the user. `/referee edit` changes the objective, and
 * `/referee status` asks the referee where things stand without interrupting
 * the agent. Every change is journaled in the session; a run restored from
 * disk comes back paused.
 */
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionUISelectOption,
	getAgentDir,
} from "@oh-my-pi/pi-coding-agent";
import { formatModelString } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import type { LocalProtocolOptions } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { formatSessionHistoryMarkdown } from "@oh-my-pi/pi-coding-agent/session/session-history-format";
import { AgentOutputManager } from "@oh-my-pi/pi-coding-agent/task/output-manager";
import { type AutocompleteItem, matchesKey, Text } from "@oh-my-pi/pi-tui";
import { escapeXmlText, formatDuration, prompt, Snowflake } from "@oh-my-pi/pi-utils";
import {
	BUDGET_KEYS,
	type BudgetKey,
	DEFAULT_STALL_LIMIT,
	defaultRefereeModel,
	type RefereeConfig,
	type ResolvedRefereeModel,
	readRefereeConfig,
	resolveBudgets,
	resolveRefereeModel,
	writeRefereeConfig,
} from "./config";
import { RefereePanel } from "./panel";
import reviewToolDescription from "./prompts/tools/review.md" with { type: "text" };
import updatePrompt from "./prompts/update.md" with { type: "text" };
import { createReviewer, type RefereeSessionOptions, runStatusCheck } from "./referee";
import {
	activityLabel,
	formatCost,
	oneLine,
	reviewDigest,
	reviewResultText,
	runOverview,
	runStatusLabel,
	runUsageLabel,
	statusLineText,
	stopBlockedReason,
	VERDICT_LABELS,
} from "./render";
import {
	addSpend,
	budgetExhausted,
	createRun,
	decideStop,
	editObjective,
	isLive,
	pauseRun,
	RUN_ENTRY_TYPE,
	recordReview,
	restoreRun,
	resumeRun,
	setRefereeModel,
	stopRun,
} from "./run";
import { REVIEW_TOOL_NAME, refereeVerdictToolkit, textResult, validateReviewInput } from "./tools";
import type { RefereeActivity, RefereeReviewer, RefereeReviewResult, RefereeRun, ReviewRecord } from "./types";

/** Visible run updates (start, edit, resume, pause, stop); the content tells the agent, the card tells the user. */
const UPDATE_MESSAGE_TYPE = "referee-update";
const STATUS_KEY = "referee";
const PANEL_KEY = "referee-panel";
const SPINNER_INTERVAL_MS = 100;
/** Tail of the main conversation a status check sees. */
const MAX_ACTIVITY_CHARS = 16_000;
/** Objective lines an update card shows before it is expanded. */
const PREVIEW_LINES = 6;
/** Findings a collapsed review result lists. */
const PREVIEW_FINDINGS = 3;

const NO_LIVE_RUN = "No referee run is active. Start one with /referee <objective>.";

type UpdateKind = "start" | "edit" | "resume" | "pause" | "stop";

const UPDATE_LABELS: Record<UpdateKind, string> = {
	start: "objective set",
	edit: "objective changed",
	resume: "resumed",
	pause: "paused",
	stop: "stopped",
};

interface UpdateDetails {
	kind: UpdateKind;
	objective: string;
	objectiveVersion: number;
	refereeModel: string;
}

interface ReviewToolDetails {
	/** The referee's current step, on partial results. */
	activity?: RefereeActivity;
	/** The finished review. */
	review?: ReviewRecord;
	model?: string;
}

/** `/referee` subcommands, in completion order; a `usage` means the subcommand takes an argument. */
const SUBCOMMANDS: { name: string; description: string; usage?: string }[] = [
	{ name: "set", description: "Start a run with this objective", usage: "<objective>" },
	{ name: "edit", description: "Change the objective of the live run", usage: "[objective]" },
	{ name: "status", description: "Ask the referee where the objective stands", usage: "[question]" },
	{ name: "show", description: "Show the objective and every review" },
	{ name: "pause", description: "Let the agent stop until /referee resume" },
	{ name: "resume", description: "Re-arm a paused run" },
	{ name: "stop", description: "End the run" },
	{ name: "model", description: "Choose the referee model", usage: "[selector | default]" },
];

const START = "▶ Set the objective and start";
const STATUS = "? Ask the referee for a status update";
const EDIT = "✎ Edit the objective";
const SHOW = "≡ Show the objective and reviews";
const PAUSE = "⏸ Pause";
const RESUME = "▶ Resume";
const STOP = "■ Stop the run";
const MODEL = "⚙ Referee model…";
const BUDGETS = "⚙ Budgets…";
const EDIT_RUN = "Edit the live run's objective";
const REPLACE_RUN = "Stop the live run and start a new one";
const DEFAULT_MODEL = "Default";

const BUDGET_LABELS: Record<BudgetKey, string> = {
	maxReviews: "Max reviews",
	maxCostUsd: "Max referee spend (USD)",
	stallLimit: "Stall limit",
};

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** `/referee` completions: subcommand names, until the first space. */
function subcommandCompletions(prefix: string): AutocompleteItem[] | null {
	// Nothing until a letter is typed, so Enter on a bare `/referee ` still opens the menu.
	if (!prefix || /\s/.test(prefix)) return null;
	const typed = prefix.toLowerCase();
	const items = SUBCOMMANDS.filter(sub => sub.name.startsWith(typed)).map(sub => ({
		value: sub.usage ? `${sub.name} ` : sub.name,
		label: sub.name,
		description: sub.description,
		hint: `${sub.name.slice(typed.length)}${sub.usage ? ` ${sub.usage}` : ""}` || undefined,
	}));
	return items.length > 0 ? items : null;
}

/** The conversation so far, newest last; optional context, so failures yield none. */
function conversationTail(ctx: ExtensionContext): string | undefined {
	try {
		const { messages } = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
		const history = formatSessionHistoryMarkdown(messages).trim();
		if (!history) return undefined;
		return history.length > MAX_ACTIVITY_CHARS ? history.slice(-MAX_ACTIVITY_CHARS) : history;
	} catch {
		return undefined;
	}
}

/** Where referee sessions persist: the session's artifacts dir, else the agent dir. */
function storage(ctx: ExtensionContext): { artifactsDir: string; localProtocolOptions?: LocalProtocolOptions } {
	const artifactsDir = ctx.sessionManager.getArtifactsDir();
	return artifactsDir
		? { artifactsDir, localProtocolOptions: ctx.localProtocolOptions }
		: { artifactsDir: path.join(getAgentDir(), "referee") };
}

/** An agent id unique across the artifacts dir and the live registry, e.g. `Referee`, `Referee-2`. */
async function allocateAgentId(artifactsDir: string, base: string): Promise<string> {
	const outputs = new AgentOutputManager(() => artifactsDir);
	await outputs.reserve(
		AgentRegistry.global()
			.list()
			.map(ref => ref.id),
	);
	return outputs.allocate(base);
}

interface ReviewerState {
	instance: RefereeReviewer;
	runId: string;
	model: string;
	/** Objective version of this session's latest review; undefined before its first. */
	lastVersion?: number;
}

export default function referee(pi: ExtensionAPI): void {
	const type = pi.arktype;
	const verdictTool = refereeVerdictToolkit(type);
	const reviewSchema = type({
		kind: type("'complete' | 'blocked'").describe("complete: the objective is achieved; blocked: you need the user"),
		claim: type("string").describe("what you did and why it meets the objective, or what blocks you"),
		"evidence?": type("string").describe("commands you ran with their results, files changed, how to verify"),
		"question?": type("string").describe("blocked only: what you need from the user"),
	});
	let config: RefereeConfig = {};
	let run: RefereeRun | undefined;
	let reviewer: ReviewerState | undefined;
	/** The review in flight; one at a time. */
	let reviewing: AbortController | undefined;
	let reviewActivity: RefereeActivity | undefined;
	let statusCheck: AbortController | undefined;
	let panel: { view: RefereePanel; timer?: Timer; unsubscribe: () => void } | undefined;
	/** Main-agent tool calls since the gate last saw a stop. */
	let toolsSinceStop = 0;
	/** Whether the agent ran any tool besides `referee_review` since the last review started. */
	let changedSinceReview = true;

	/** The footer status; headless hosts have no footer (and may have no theme). */
	function showStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!isLive(run)) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const text = statusLineText(run, reviewActivity);
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(run.status === "active" ? "accent" : "warning", text));
	}

	/** `referee_review` is offered only while a run is active. */
	async function syncReviewTool(): Promise<void> {
		const wanted = run?.status === "active";
		const active = pi.getActiveTools();
		if (active.includes(REVIEW_TOOL_NAME) === wanted) return;
		await pi.setActiveTools(
			wanted ? [...active, REVIEW_TOOL_NAME] : active.filter(name => name !== REVIEW_TOOL_NAME),
		);
	}

	/** Make `next` the session's run: journal it, then refresh the status line and the review tool. */
	async function commit(next: RefereeRun, ctx: ExtensionContext): Promise<void> {
		run = next;
		pi.appendEntry(RUN_ENTRY_TYPE, next);
		showStatus(ctx);
		await syncReviewTool();
	}

	/** Tell the agent (content) and the user (card) about a run change; armed changes start a turn when idle. */
	function sendUpdate(kind: UpdateKind, current: RefereeRun): void {
		const armed = current.status === "active" && kind !== "pause" && kind !== "stop";
		const withObjective = kind !== "pause" && kind !== "stop";
		pi.sendMessage<UpdateDetails>(
			{
				customType: UPDATE_MESSAGE_TYPE,
				content: prompt.render(updatePrompt, {
					[kind]: true,
					version: current.objectiveVersion,
					objective: withObjective ? escapeXmlText(current.objective) : undefined,
					armed,
				}),
				display: true,
				// Extension-written text: agent attribution keeps it out of the user's editable queue.
				attribution: "agent",
				details: {
					kind,
					objective: current.objective,
					objectiveVersion: current.objectiveVersion,
					refereeModel: current.refereeModel,
				},
			},
			{ triggerTurn: armed },
		);
	}

	function sessionOptions(
		ctx: ExtensionContext,
		model: ResolvedRefereeModel,
		agentId: string,
		localProtocolOptions: LocalProtocolOptions | undefined,
	): RefereeSessionOptions {
		return {
			cwd: ctx.cwd,
			settings: pi.pi.settings,
			modelRegistry: ctx.modelRegistry,
			model: model.model,
			thinking: model.thinking,
			instructions: config.instructions,
			localProtocolOptions,
			parentAgentId: ctx.agent.id || MAIN_AGENT_ID,
			agentId,
		};
	}

	function chooseRefereeModel(ctx: ExtensionContext): ResolvedRefereeModel {
		if (config.model) return resolveRefereeModel(config.model, ctx.modelRegistry, pi.pi.settings);
		return defaultRefereeModel(
			pi.pi.settings,
			ctx.modelRegistry.getAvailable(),
			model => ctx.models.family(model),
			ctx.model,
		);
	}

	/** The run's reviewer session, opened on first use and replaced when the run or its model changes. */
	async function ensureReviewer(ctx: ExtensionContext, current: RefereeRun): Promise<ReviewerState> {
		if (reviewer?.runId === current.id && reviewer.model === current.refereeModel) return reviewer;
		await disposeReviewer();
		const model = resolveRefereeModel(current.refereeModel, ctx.modelRegistry, pi.pi.settings);
		const { artifactsDir, localProtocolOptions } = storage(ctx);
		const agentId = await allocateAgentId(artifactsDir, "Referee");
		const instance = await createReviewer({
			...sessionOptions(ctx, model, agentId, localProtocolOptions),
			sessionFile: path.join(artifactsDir, `${agentId}.jsonl`),
			verdictTool,
		});
		reviewer = { instance, runId: current.id, model: current.refereeModel };
		return reviewer;
	}

	async function disposeReviewer(): Promise<void> {
		const current = reviewer;
		reviewer = undefined;
		await current?.instance.dispose();
	}

	function openPanel(ctx: ExtensionContext, title: string, onCancel?: () => void): RefereePanel {
		closePanel(ctx);
		const view = new RefereePanel(title, ctx.ui.theme);
		const unsubscribe = ctx.ui.onTerminalInput(data => {
			if (!matchesKey(data, "escape")) return undefined;
			if (!view.settled) onCancel?.();
			closePanel(ctx);
			return { consume: true };
		});
		panel = { view, unsubscribe };
		if (onCancel) panel.timer = ctx.setInterval(() => view.tick(), SPINNER_INTERVAL_MS);
		ctx.ui.setWidget(PANEL_KEY, view.widget, { placement: "aboveEditor" });
		return view;
	}

	function stopPanelSpinner(ctx: ExtensionContext, view: RefereePanel): void {
		if (panel?.view !== view || !panel.timer) return;
		ctx.clearTimer(panel.timer);
		panel.timer = undefined;
	}

	function closePanel(ctx: ExtensionContext): void {
		const current = panel;
		if (!current) return;
		panel = undefined;
		if (current.timer) ctx.clearTimer(current.timer);
		current.unsubscribe();
		ctx.ui.setWidget(PANEL_KEY, undefined);
	}

	/** Load the run journaled on the current branch; `pauseActive` pauses one that was active. */
	async function restore(ctx: ExtensionContext, pauseActive: boolean): Promise<void> {
		reviewing?.abort();
		statusCheck?.abort();
		closePanel(ctx);
		await disposeReviewer();
		toolsSinceStop = 0;
		changedSinceReview = true;
		run = restoreRun(ctx.sessionManager.getBranch());
		if (run?.status === "active" && pauseActive) {
			await commit(pauseRun(run, "restored", Date.now()), ctx);
			ctx.ui.notify(
				`Referee run restored paused: ${oneLine(run.objective, 60)} (/referee resume re-arms it)`,
				"info",
			);
			return;
		}
		showStatus(ctx);
		await syncReviewTool();
	}

	pi.registerMessageRenderer<UpdateDetails>(UPDATE_MESSAGE_TYPE, (message, { expanded }, theme) => {
		const details = message.details;
		if (!details) return undefined;
		const head = `${theme.fg("accent", "⚖ Referee")} ${UPDATE_LABELS[details.kind]}`;
		if (details.kind === "pause" || details.kind === "stop") return new Text(head, 1, 0);
		const lines = details.objective.split("\n");
		const shown =
			expanded || lines.length <= PREVIEW_LINES
				? lines
				: [...lines.slice(0, PREVIEW_LINES), theme.fg("dim", `… ${lines.length - PREVIEW_LINES} more lines`)];
		return new Text(
			[`${head} ${theme.fg("dim", `· v${details.objectiveVersion} · ${details.refereeModel}`)}`, ...shown].join(
				"\n",
			),
			1,
			0,
		);
	});

	pi.registerTool<typeof reviewSchema, ReviewToolDetails>({
		name: REVIEW_TOOL_NAME,
		label: "Referee review",
		description: prompt.render(reviewToolDescription),
		parameters: reviewSchema,
		defaultInactive: true,
		loadMode: "essential",
		approval: "read",
		async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<ReviewToolDetails>> {
			const input = validateReviewInput(params);
			if (typeof input === "string") return textResult(input, true);
			const current = run;
			if (current?.status !== "active") {
				return textResult(
					current?.status === "paused"
						? "The referee run is paused; the user re-arms it with /referee resume."
						: "No referee run is active.",
					true,
				);
			}
			if (reviewing) return textResult("A review is already running; wait for its ruling.", true);
			const exhausted = budgetExhausted(current, resolveBudgets(config));
			if (exhausted) {
				await commit(pauseRun(current, "budget", Date.now()), ctx);
				ctx.ui.notify(`Referee paused: ${exhausted}. /referee resume continues with a fresh budget.`, "warning");
				return textResult(
					`The referee run is paused because ${exhausted}. Stop and tell the user where the objective stands; they can resume the run.`,
				);
			}
			// Only a fail with nothing done since blocks a re-review; an errored or cancelled one is retried as is.
			const previous = current.reviews.at(-1);
			if (
				!changedSinceReview &&
				previous?.outcome === "verdict" &&
				previous.verdict === "fail" &&
				previous.objectiveVersion === current.objectiveVersion
			) {
				return textResult(
					`Nothing changed since review ${previous.index} failed. Address its findings, or gather fresh evidence with your tools, before asking again.`,
					true,
				);
			}

			const controller = new AbortController();
			reviewing = controller;
			changedSinceReview = false;
			// A review that runs is progress for the stall detector; a refused one is not.
			toolsSinceStop += 1;
			const index = current.reviews.length + 1;
			const startedAt = Date.now();
			const model = current.refereeModel;
			const onActivity = (activity: RefereeActivity) => {
				reviewActivity = activity;
				showStatus(ctx);
				onUpdate?.({
					content: [{ type: "text", text: `Referee: ${activityLabel(activity)}` }],
					details: { activity, model },
				});
			};
			let result: RefereeReviewResult;
			try {
				const state = await ensureReviewer(ctx, current);
				result = await state.instance.review(
					{
						index,
						kind: input.kind,
						objective: current.objective,
						objectiveVersion: current.objectiveVersion,
						objectiveChanged: state.lastVersion !== undefined && state.lastVersion !== current.objectiveVersion,
						history:
							state.lastVersion === undefined && current.reviews.length > 0
								? reviewDigest(current.reviews)
								: undefined,
						claim: input.claim,
						evidence: input.evidence,
						question: input.question,
					},
					onActivity,
					signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
				);
				state.lastVersion = current.objectiveVersion;
			} catch (error) {
				result = { error: errorText(error), usage: { tokens: 0, costUsd: 0 } };
			} finally {
				reviewing = undefined;
				reviewActivity = undefined;
			}

			const latest = run;
			if (latest?.id !== current.id) return textResult("The referee run ended during the review.");
			const edited = latest.objectiveVersion !== current.objectiveVersion;
			const base = {
				index,
				kind: input.kind,
				objectiveVersion: current.objectiveVersion,
				startedAt,
				durationMs: Date.now() - startedAt,
				tokens: result.usage.tokens,
				costUsd: result.usage.costUsd,
			};
			const record: ReviewRecord = result.verdict
				? { ...base, outcome: "verdict", ...result.verdict }
				: result.aborted
					? {
							...base,
							outcome: edited ? "stale" : "aborted",
							summary: edited ? "The objective changed during the review." : "The review was cancelled.",
							findings: [],
						}
					: { ...base, outcome: "error", summary: result.error ?? "The review failed.", findings: [] };
			const next = recordReview(latest, record, Date.now());
			const recorded = next.reviews[next.reviews.length - 1]!;
			await commit(next, ctx);
			if (next.status === "passed") {
				await disposeReviewer();
				ctx.ui.notify(`Referee passed the objective (${runUsageLabel(next)}).`, "info");
			} else if (next.status === "paused" && latest.status === "active") {
				ctx.ui.notify(
					`Referee paused: the referee failed ${next.reviewErrors} reviews in a row (${oneLine(recorded.summary, 80)}). Fix it with /referee model, then /referee resume.`,
					"warning",
				);
			}
			return {
				content: [{ type: "text", text: reviewResultText(next, recorded) }],
				details: { review: recorded, model },
			};
		},
		renderCall(args, _options, theme) {
			const claim = args.kind === "blocked" ? "blocked claim" : "completion claim";
			return new Text(
				`${theme.fg("accent", "⚖ Referee review")} ${theme.fg("dim", claim)}${args.claim ? ` ${theme.fg("muted", oneLine(args.claim, 100))}` : ""}`,
				0,
				0,
			);
		},
		renderResult(result, { expanded, isPartial, spinnerFrame }, theme) {
			const details = result.details;
			const review = details?.review;
			if (!review) {
				if (isPartial) {
					const frames = theme.getSpinnerFrames("activity");
					const spinner = frames[(spinnerFrame ?? 0) % frames.length] ?? "·";
					const step = details?.activity ? activityLabel(details.activity) : "starting";
					return new Text(
						`${theme.fg("accent", spinner)} ${theme.fg("muted", `${details?.model ?? "referee"} · ${step}`)}`,
						0,
						0,
					);
				}
				const text = result.content.map(block => (block.type === "text" ? block.text : "")).join("");
				return new Text(theme.fg(result.isError ? "error" : "muted", expanded ? text : oneLine(text, 200)), 0, 0);
			}
			const meta = theme.fg(
				"dim",
				`· review ${review.index} · ${formatDuration(review.durationMs)} · ${formatCost(review.costUsd)}${details?.model ? ` · ${details.model}` : ""}`,
			);
			let head: string;
			if (review.outcome === "verdict" && review.verdict) {
				const color = review.verdict === "pass" ? "success" : review.verdict === "fail" ? "error" : "warning";
				head = theme.fg(color, theme.bold(VERDICT_LABELS[review.verdict]));
			} else if (review.outcome === "stale") {
				head = theme.fg("warning", "STALE: the objective changed");
			} else if (review.outcome === "error") {
				head = theme.fg("error", "REFEREE ERROR");
			} else {
				head = theme.fg("dim", "CANCELLED");
			}
			const lines = [`${head} ${meta}`, expanded ? review.summary : oneLine(review.summary, 200)];
			const findings = expanded ? review.findings : review.findings.slice(0, PREVIEW_FINDINGS);
			for (const finding of findings)
				lines.push(`${theme.fg("error", "•")} ${expanded ? finding : oneLine(finding, 160)}`);
			if (findings.length < review.findings.length) {
				lines.push(theme.fg("dim", `… ${review.findings.length - findings.length} more findings`));
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	pi.on("session_stop", async (_event, ctx) => {
		const current = run;
		if (current?.status !== "active") return undefined;
		// Plan mode converges on the user; the referee never holds a planning turn.
		if (ctx.sessionModes?.getState().plan.status === "active") return undefined;
		const { stallLimit } = resolveBudgets(config);
		const decision = decideStop(current, toolsSinceStop > 0, stallLimit, Date.now());
		toolsSinceStop = 0;
		if (decision.run && decision.run !== current) await commit(decision.run, ctx);
		if (decision.action === "allow") return undefined;
		if (decision.action === "stall") {
			ctx.ui.notify(
				`Referee paused: the agent stopped ${stallLimit} times in a row without doing anything. /referee resume re-arms it.`,
				"warning",
			);
			return undefined;
		}
		return {
			decision: "block",
			reason: stopBlockedReason(current),
		};
	});

	pi.on("tool_execution_start", (event, ctx) => {
		// `referee_review` counts itself once it actually runs.
		if (ctx.agent.kind !== "main" || event.toolName === REVIEW_TOOL_NAME) return;
		toolsSinceStop += 1;
		changedSinceReview = true;
	});

	pi.on("session.compacting", (_event, ctx) => {
		if (ctx.agent.kind !== "main" || !isLive(run)) return undefined;
		return {
			context: [
				`A referee run is ${run.status} on this objective (version ${run.objectiveVersion}). Keep it verbatim in the summary:\n<referee-objective version="${run.objectiveVersion}">\n${escapeXmlText(run.objective)}\n</referee-objective>`,
			],
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		// Subagent copies of this extension share the screen; only the main session owns runs.
		if (ctx.agent.kind !== "main") return;
		try {
			config = await readRefereeConfig();
		} catch {
			// The command reports an unreadable config when it reads it.
		}
		await restore(ctx, true);
	});

	pi.on("session_switch", async (_event, ctx) => {
		if (ctx.agent.kind === "main") await restore(ctx, true);
	});

	pi.on("session_branch", async (_event, ctx) => {
		if (ctx.agent.kind === "main") await restore(ctx, false);
	});

	pi.on("session_tree", async (_event, ctx) => {
		if (ctx.agent.kind === "main") await restore(ctx, false);
	});

	pi.on("session_shutdown", async () => {
		reviewing?.abort();
		statusCheck?.abort();
		await disposeReviewer();
	});

	pi.registerCommand("referee", {
		description: "Keep the agent on an objective until a second model verifies it (bare: menu)",
		getArgumentCompletions: subcommandCompletions,
		handler: async (args, ctx) => {
			try {
				config = await readRefereeConfig();
			} catch (error) {
				ctx.ui.notify(errorText(error), "error");
				return;
			}
			const text = args.trim();
			if (!text) return menu(ctx);
			const match = /^(\S+)\s*([\s\S]*)$/.exec(text)!;
			const sub = SUBCOMMANDS.find(entry => entry.name === match[1]!.toLowerCase())?.name;
			const rest = match[2]!.trim();
			switch (sub) {
				case "set":
					if (rest) return start(ctx, rest);
					await startFromEditor(ctx);
					return;
				case "edit":
					return edit(ctx, rest);
				case "status":
					return status(ctx, rest);
				case "show":
					return show(ctx);
				case "pause":
					return pause(ctx);
				case "resume":
					return resume(ctx);
				case "stop":
					return stop(ctx);
				case "model":
					return chooseModel(ctx, rest);
				default:
					return start(ctx, text);
			}
		},
	});

	async function menu(ctx: ExtensionCommandContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify(run ? `Referee: ${runStatusLabel(run)} · ${oneLine(run.objective, 80)}` : NO_LIVE_RUN, "info");
			return;
		}
		for (;;) {
			const current = run;
			const options: ExtensionUISelectOption[] = isLive(current)
				? [
						{ label: STATUS, description: "Ask without interrupting the agent" },
						{ label: EDIT, description: oneLine(current.objective, 80) },
						current.status === "active"
							? { label: PAUSE, description: "Let the agent stop until you resume" }
							: { label: RESUME, description: runStatusLabel(current) },
						{ label: SHOW, description: runUsageLabel(current) },
						{ label: STOP, description: "End the run" },
					]
				: [{ label: START, description: "Write the objective; the agent starts at once" }];
			options.push(
				{ label: MODEL, description: config.model ?? "default: omp's advisor role" },
				{ label: BUDGETS, description: budgetSummary() },
			);
			const choice = await ctx.ui.select(
				isLive(current) ? `Referee: ${runStatusLabel(current)}` : "Referee: no run",
				options,
			);
			if (choice === undefined) return;
			try {
				switch (choice) {
					case START:
						if (await startFromEditor(ctx)) return;
						break;
					case STATUS: {
						const question = await ctx.ui.input("Ask the referee", "Enter for a general status update");
						if (question === undefined) break;
						return status(ctx, question.trim());
					}
					case EDIT:
						return edit(ctx, "");
					case SHOW:
						return show(ctx);
					case PAUSE:
						return pause(ctx);
					case RESUME:
						return resume(ctx);
					case STOP:
						if (current && (await ctx.ui.confirm("Stop the referee run?", oneLine(current.objective, 80)))) {
							return stop(ctx);
						}
						break;
					case MODEL:
						await chooseModel(ctx, "");
						break;
					case BUDGETS:
						await editBudgets(ctx);
						break;
				}
			} catch (error) {
				ctx.ui.notify(`Could not save the referee config: ${errorText(error)}`, "error");
			}
		}
	}

	/** Ask for an objective in the editor and start; false when the user cancels. */
	async function startFromEditor(ctx: ExtensionCommandContext): Promise<boolean> {
		if (!ctx.hasUI) {
			ctx.ui.notify("Usage: /referee <objective>", "warning");
			return false;
		}
		const objective = (
			await ctx.ui.editor("Referee objective: what must be true when the agent is done?", "")
		)?.trim();
		if (!objective) return false;
		await start(ctx, objective);
		return true;
	}

	async function start(ctx: ExtensionCommandContext, objective: string): Promise<void> {
		if (isLive(run)) {
			if (!ctx.hasUI) {
				ctx.ui.notify(
					"A referee run is live: /referee edit <objective> changes its objective; /referee stop ends it.",
					"warning",
				);
				return;
			}
			const choice = await ctx.ui.select(`A referee run is ${run.status}: ${oneLine(run.objective, 60)}`, [
				{ label: EDIT_RUN, description: "Keep its reviews; earlier rulings stop applying" },
				{ label: REPLACE_RUN, description: "Its reviews end with it" },
			]);
			if (choice === EDIT_RUN) return applyEdit(ctx, objective);
			if (choice !== REPLACE_RUN) return;
		}
		const modes = ctx.sessionModes?.getState();
		const blocking = modes?.plan.status === "active" ? "plan" : modes?.goal.status === "active" ? "goal" : undefined;
		if (blocking) {
			ctx.ui.notify(`Leave ${blocking} mode before starting the referee.`, "warning");
			return;
		}
		let model: ResolvedRefereeModel;
		try {
			model = chooseRefereeModel(ctx);
		} catch (error) {
			ctx.ui.notify(errorText(error), "error");
			return;
		}
		// The dialog above can outlive the old run; end whatever is live now.
		if (isLive(run)) {
			reviewing?.abort();
			await commit(stopRun(run, Date.now()), ctx);
		}
		await disposeReviewer();
		let next: RefereeRun;
		try {
			next = createRun({ id: String(Snowflake.next()), objective, refereeModel: model.selector, now: Date.now() });
		} catch (error) {
			ctx.ui.notify(errorText(error), "warning");
			return;
		}
		toolsSinceStop = 0;
		changedSinceReview = true;
		await commit(next, ctx);
		sendUpdate("start", next);
		ctx.ui.notify(`Referee on (${model.selector}). /referee status asks it where things stand.`, "info");
	}

	async function edit(ctx: ExtensionCommandContext, text: string): Promise<void> {
		if (!isLive(run)) {
			ctx.ui.notify(NO_LIVE_RUN, "warning");
			return;
		}
		if (text) return applyEdit(ctx, text);
		if (!ctx.hasUI) {
			ctx.ui.notify("Usage: /referee edit <objective>", "warning");
			return;
		}
		const edited = await ctx.ui.editor(`Edit the referee objective (v${run.objectiveVersion})`, run.objective);
		if (edited?.trim()) await applyEdit(ctx, edited);
	}

	async function applyEdit(ctx: ExtensionContext, objective: string): Promise<void> {
		if (!isLive(run)) {
			ctx.ui.notify(NO_LIVE_RUN, "warning");
			return;
		}
		let next: RefereeRun;
		try {
			next = editObjective(run, objective, Date.now());
		} catch (error) {
			ctx.ui.notify(errorText(error), "warning");
			return;
		}
		if (next === run) {
			ctx.ui.notify("The objective is unchanged.", "info");
			return;
		}
		// A review in flight judges the old objective.
		reviewing?.abort();
		changedSinceReview = true;
		await commit(next, ctx);
		sendUpdate("edit", next);
		ctx.ui.notify(`Referee objective updated (v${next.objectiveVersion}).`, "info");
	}

	async function pause(ctx: ExtensionContext): Promise<void> {
		if (run?.status !== "active") {
			ctx.ui.notify(run?.status === "paused" ? "The referee run is already paused." : NO_LIVE_RUN, "info");
			return;
		}
		reviewing?.abort();
		const next = pauseRun(run, "user", Date.now());
		await commit(next, ctx);
		sendUpdate("pause", next);
		ctx.ui.notify("Referee paused: the agent may stop. /referee resume re-arms it.", "info");
	}

	async function resume(ctx: ExtensionContext): Promise<void> {
		if (run?.status !== "paused") {
			ctx.ui.notify(run?.status === "active" ? "The referee run is already active." : NO_LIVE_RUN, "info");
			return;
		}
		toolsSinceStop = 0;
		changedSinceReview = true;
		const next = resumeRun(run, Date.now());
		await commit(next, ctx);
		sendUpdate("resume", next);
		ctx.ui.notify("Referee resumed.", "info");
	}

	async function stop(ctx: ExtensionContext): Promise<void> {
		if (!isLive(run)) {
			ctx.ui.notify(NO_LIVE_RUN, "info");
			return;
		}
		reviewing?.abort();
		const next = stopRun(run, Date.now());
		await commit(next, ctx);
		await disposeReviewer();
		sendUpdate("stop", next);
		ctx.ui.notify("Referee stopped.", "info");
	}

	function show(ctx: ExtensionContext): void {
		if (!run) {
			ctx.ui.notify(NO_LIVE_RUN, "info");
			return;
		}
		if (ctx.mode !== "tui") {
			ctx.ui.notify(runOverview(run), "info");
			return;
		}
		openPanel(ctx, `Referee: ${runStatusLabel(run)}`).finish(runOverview(run));
	}

	/** Ask the referee where the objective stands, in the background; the answer shows in the panel, like /btw. */
	async function status(ctx: ExtensionCommandContext, question: string): Promise<void> {
		const current = run;
		if (!current) {
			ctx.ui.notify(NO_LIVE_RUN, "warning");
			return;
		}
		if (statusCheck) {
			ctx.ui.notify("A status check is already running; esc cancels it.", "info");
			return;
		}
		let model: ResolvedRefereeModel;
		try {
			model = resolveRefereeModel(current.refereeModel, ctx.modelRegistry, pi.pi.settings);
		} catch (error) {
			ctx.ui.notify(errorText(error), "error");
			return;
		}
		const controller = new AbortController();
		statusCheck = controller;
		const view =
			ctx.mode === "tui"
				? openPanel(ctx, question ? `Referee status: ${question}` : "Referee status", () => controller.abort())
				: undefined;
		const report = (text: string, failed: boolean) => {
			if (view) {
				if (failed) view.fail(text);
				else view.finish(text);
			} else {
				ctx.ui.notify(failed ? `Referee status failed: ${text}` : text, failed ? "error" : "info");
			}
		};
		// Runs in the background so the editor stays usable.
		void (async () => {
			try {
				const { artifactsDir, localProtocolOptions } = storage(ctx);
				const agentId = await allocateAgentId(artifactsDir, "RefereeStatus");
				const result = await runStatusCheck(
					sessionOptions(ctx, model, agentId, localProtocolOptions),
					{
						objective: current.objective,
						objectiveVersion: current.objectiveVersion,
						reviews: reviewDigest(current.reviews),
						activity: conversationTail(ctx),
						question: question || undefined,
					},
					activity => view?.setActivity(activity),
					controller.signal,
				);
				if (run?.id === current.id && result.usage.costUsd > 0) {
					await commit(addSpend(run, result.usage.costUsd, Date.now()), ctx);
				}
				if (result.aborted) return;
				report(result.error ?? result.text, result.error !== undefined);
			} catch (error) {
				report(errorText(error), true);
			} finally {
				if (statusCheck === controller) statusCheck = undefined;
				if (view) stopPanelSpinner(ctx, view);
			}
		})();
	}

	async function chooseModel(ctx: ExtensionCommandContext, selector: string): Promise<void> {
		let choice = selector;
		if (!choice) {
			if (!ctx.hasUI) {
				ctx.ui.notify(
					`Referee model: ${config.model ?? "default"}. Usage: /referee model <selector | default>`,
					"info",
				);
				return;
			}
			const picked = await ctx.ui.select("Referee model (type to filter)", [
				{ label: DEFAULT_MODEL, description: "omp's advisor role, preferring another family than the main model" },
				...ctx.modelRegistry
					.getAvailable()
					.map(model => ({ label: formatModelString(model), description: model.name })),
			]);
			if (picked === undefined) return;
			choice = picked === DEFAULT_MODEL ? "default" : picked;
		}
		const useDefault = choice.toLowerCase() === "default";
		let model: ResolvedRefereeModel;
		try {
			if (useDefault) {
				delete config.model;
				model = chooseRefereeModel(ctx);
			} else {
				model = resolveRefereeModel(choice, ctx.modelRegistry, pi.pi.settings);
				config.model = choice;
			}
			await writeRefereeConfig(config);
		} catch (error) {
			ctx.ui.notify(errorText(error), "error");
			config = await readRefereeConfig().catch(() => config);
			return;
		}
		if (isLive(run)) await commit(setRefereeModel(run, model.selector, Date.now()), ctx);
		ctx.ui.notify(`Referee model: ${model.selector}${useDefault ? " (default)" : ""}`, "info");
	}

	function budgetValue(key: BudgetKey): string {
		if (key === "stallLimit") return String(config.stallLimit ?? `${DEFAULT_STALL_LIMIT} (default)`);
		const value = config[key];
		if (value === undefined) return "unlimited";
		return key === "maxCostUsd" ? formatCost(value) : String(value);
	}

	function budgetSummary(): string {
		const reviews = config.maxReviews ? `at most ${config.maxReviews} reviews` : "unlimited reviews";
		const spend = config.maxCostUsd ? `at most ${formatCost(config.maxCostUsd)}` : "unlimited spend";
		return `${reviews} · ${spend} · stall limit ${budgetValue("stallLimit")}`;
	}

	async function editBudgets(ctx: ExtensionCommandContext): Promise<void> {
		const choice = await ctx.ui.select(
			"Referee budgets (each active stretch of a run; resuming starts them over)",
			BUDGET_KEYS.map(key => ({ label: BUDGET_LABELS[key], description: budgetValue(key) })),
		);
		const key = BUDGET_KEYS.find(candidate => BUDGET_LABELS[candidate] === choice);
		if (!key) return;
		const hint =
			key === "stallLimit"
				? `tool-free stops in a row before the run pauses; empty restores ${DEFAULT_STALL_LIMIT}`
				: "0 or empty means unlimited";
		const raw = await ctx.ui.input(`${BUDGET_LABELS[key]}: ${hint} (now ${budgetValue(key)})`);
		if (raw === undefined) return;
		const value = Number(raw.trim() || "0");
		if (!Number.isFinite(value) || value < 0) {
			ctx.ui.notify("Enter a non-negative number.", "error");
			return;
		}
		if (key === "maxCostUsd") {
			if (value > 0) config.maxCostUsd = value;
			else delete config.maxCostUsd;
		} else if (value >= 1) {
			config[key] = Math.ceil(value);
		} else {
			delete config[key];
		}
		await writeRefereeConfig(config);
	}
}
