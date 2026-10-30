/**
 * The referee's agent sessions. A run's reviewer is one persistent, persisted
 * session, so each review sees the earlier ones; every status check gets a
 * fresh in-memory session. Both run on the configured referee model with
 * inspection tools and `bash` for diagnostics, never edit or write tools.
 */
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	type CustomTool,
	createAgentSession,
	createSubagentSettings,
	type ModelRegistry,
	SessionManager,
	type Settings,
} from "@oh-my-pi/pi-coding-agent";
import type { LocalProtocolOptions } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { formatToolCallPrimaryArg } from "@oh-my-pi/pi-coding-agent/session/session-history-format";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { escapeXmlText, logger, prompt } from "@oh-my-pi/pi-utils";
import nudgeVerdictPrompt from "./prompts/nudge-verdict.md" with { type: "text" };
import refereeSystemPrompt from "./prompts/referee-system.md" with { type: "text" };
import reviewPrompt from "./prompts/review.md" with { type: "text" };
import statusPrompt from "./prompts/status.md" with { type: "text" };
import type { VerdictSlot } from "./tools";
import type {
	RefereeActivity,
	RefereeReviewer,
	RefereeReviewRequest,
	RefereeReviewResult,
	RefereeStatusRequest,
	RefereeStatusResult,
	RefereeUsage,
} from "./types";

/** Built-in tools the referee gets alongside `referee_verdict`. */
export const REFEREE_TOOL_NAMES = ["read", "grep", "glob", "ast_grep", "web_search", "bash"] as const;

/** Extra prompts a reviewer gets when its turn ends without a verdict. */
const VERDICT_NUDGES = 2;

export interface RefereeSessionOptions {
	cwd: string;
	settings: Settings;
	modelRegistry: ModelRegistry;
	model: Model<Api>;
	thinking?: ConfiguredThinkingLevel;
	/** Extra guidance from the config, appended to the referee's system prompt. */
	instructions?: string;
	localProtocolOptions?: LocalProtocolOptions;
	parentAgentId?: string;
	/** Agent-registry id, unique among live agents; the transcript is `history://<agentId>`. */
	agentId: string;
}

export interface ReviewerOptions extends RefereeSessionOptions {
	/** Session file; the review transcript persists there. */
	sessionFile: string;
	verdictTool: (slot: VerdictSlot) => CustomTool;
}

interface TurnResult {
	text: string;
	error?: string;
	aborted?: boolean;
}

interface RefereeAgent {
	runTurn(text: string, onActivity: (activity: RefereeActivity) => void, signal?: AbortSignal): Promise<TurnResult>;
	usage(): RefereeUsage;
	dispose(): Promise<void>;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function assistantText(message: AssistantMessage | undefined): string {
	if (!message) return "";
	return message.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("")
		.trim();
}

async function openRefereeAgent(
	options: RefereeSessionOptions,
	setup: {
		sessionManager: SessionManager;
		mode: "review" | "status";
		customTools: CustomTool[];
		/** Park the registry ref on dispose so `history://<agentId>` keeps resolving. */
		park: boolean;
	},
): Promise<RefereeAgent> {
	const { agentId } = options;
	const rolePrompt = prompt.render(refereeSystemPrompt, {
		status: setup.mode === "status",
		instructions: options.instructions,
	});
	const agentRegistry = AgentRegistry.global();
	let session: AgentSession;
	try {
		const created = await createAgentSession({
			cwd: options.cwd,
			sessionManager: setup.sessionManager,
			model: options.model,
			thinkingLevel: options.thinking,
			modelRegistry: options.modelRegistry,
			authStorage: options.modelRegistry.authStorage,
			// The ruling must come from the chosen model: a fallback or context promotion could switch
			// to another one, even the agent's own, while the ruling still names the chosen model.
			settings: createSubagentSettings(options.settings, {
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
				"retry.modelFallback": false,
				"contextPromotion.enabled": false,
			}),
			toolNames: [...REFEREE_TOOL_NAMES, ...setup.customTools.map(tool => tool.name)],
			restrictToolNames: true,
			allowRestrictedCustomTools: true,
			customTools: setup.customTools,
			hasUI: false,
			// The referee idles between reviews; warm-up requests would cost money outside its budget.
			cacheWarming: false,
			enableMCP: false,
			enableIrc: false,
			enableLsp: false,
			spawns: "",
			taskDepth: 1,
			disableExtensionDiscovery: true,
			skills: [],
			promptTemplates: [],
			slashCommands: [],
			agentId,
			agentDisplayName: setup.mode === "status" ? "Referee status" : "Referee",
			agentName: "referee",
			parentTaskPrefix: agentId,
			parentAgentId: options.parentAgentId,
			agentRegistry,
			localProtocolOptions: options.localProtocolOptions,
			systemPrompt: defaultPrompt =>
				defaultPrompt.length === 0
					? [rolePrompt]
					: [...defaultPrompt.slice(0, -1), rolePrompt, defaultPrompt[defaultPrompt.length - 1]!],
		});
		session = created.session;
	} catch (error) {
		throw new Error(`Failed to start the referee session: ${errorText(error)}`, { cause: error });
	}
	// createAgentSession registers the referee as running; it runs only during its turns.
	agentRegistry.setStatus(agentId, "idle");
	// Keep the ref, so history:// still reads the transcript, but detach the live session: omp
	// delivers agent messages to any registered live session, so the agent could steer its referee.
	agentRegistry.detachSession(agentId);

	let tokens = 0;
	let costUsd = 0;
	let toolCount = 0;
	let turnAssistant: AssistantMessage | undefined;
	let abortCall: Promise<void> | undefined;
	let disposeCall: Promise<void> | undefined;
	let turnRunning = false;
	let report: (activity: RefereeActivity) => void = () => {};
	// The live view, plus the Agent Hub and history:// gist (the registry ignores it outside a turn).
	const activity = (state: RefereeActivity["state"], tool?: string, detail?: string) => {
		report({ state, tool, detail, toolCount, since: Date.now() });
		agentRegistry.setActivity(
			agentId,
			state === "tool" ? `running ${tool}${detail ? ` ${detail}` : ""}` : detail ? `${state} ${detail}` : state,
		);
	};

	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		switch (event.type) {
			case "message_start":
				if (event.message.role === "assistant") activity("thinking");
				break;
			case "message_end": {
				const message = event.message;
				if (message.role !== "assistant") break;
				turnAssistant = message;
				tokens += (message.usage?.input ?? 0) + (message.usage?.output ?? 0) + (message.usage?.cacheWrite ?? 0);
				costUsd += message.usage?.cost?.total ?? 0;
				break;
			}
			case "tool_execution_start":
				toolCount += 1;
				activity("tool", event.toolName, formatToolCallPrimaryArg(event.toolName, event.args));
				break;
			case "tool_execution_end":
				activity("thinking");
				break;
			case "auto_retry_start":
				activity(
					"retrying",
					undefined,
					`${event.attempt}/${event.maxAttempts}: ${event.errorMessage.replace(/\s+/g, " ").trim().slice(0, 160)}`,
				);
				break;
			case "auto_compaction_start":
				activity("compacting");
				break;
			case "auto_compaction_end":
				activity("thinking");
				break;
			default:
				break;
		}
	});

	const abort = async (): Promise<void> => {
		if (!turnRunning) return;
		abortCall ??= session.abort().catch(error => {
			logger.warn("Referee session abort failed", { agentId, error: errorText(error) });
		});
		await abortCall;
	};

	return {
		async runTurn(text, onActivity, signal) {
			if (disposeCall) return { text: "", error: "The referee session is closed." };
			if (signal?.aborted) return { text: "", aborted: true };
			report = onActivity;
			turnAssistant = undefined;
			abortCall = undefined;
			turnRunning = true;
			agentRegistry.setStatus(agentId, "running");
			activity("thinking");
			const onAbort = () => void abort();
			signal?.addEventListener("abort", onAbort, { once: true });
			const before = session.getLastAssistantMessage();
			let error: string | undefined;
			try {
				await session.prompt(text, { attribution: "agent", expandPromptTemplates: false });
				await session.waitForIdle();
			} catch (err) {
				error = errorText(err);
			} finally {
				turnRunning = false;
				signal?.removeEventListener("abort", onAbort);
				// Disposal parks the ref; a turn unwinding afterwards must not revive it as idle.
				if (!disposeCall) agentRegistry.setStatus(agentId, "idle");
			}
			const latest = session.getLastAssistantMessage();
			const message = latest !== before ? latest : turnAssistant;
			const aborted = abortCall !== undefined || message?.stopReason === "aborted";
			if (!error && message?.stopReason === "error") error = message.errorMessage || "Model request failed";
			activity("idle");
			return aborted ? { text: assistantText(message), aborted } : { text: assistantText(message), error };
		},
		usage: () => ({ tokens, costUsd }),
		dispose() {
			disposeCall ??= (async () => {
				await abort();
				unsubscribe();
				try {
					if (setup.park) {
						// Flip the ref before dispose so the SDK dispose wrapper skips its
						// unregister, then detach the dead session.
						agentRegistry.setStatus(agentId, "parked");
						await session.dispose();
						agentRegistry.detachSession(agentId);
					} else {
						await session.dispose();
					}
				} catch (error) {
					logger.warn("Referee session dispose failed", { agentId, error: errorText(error) });
				}
			})();
			return disposeCall;
		},
	};
}

/** Open a run's reviewer: a persistent referee session that records rulings through `referee_verdict`. */
export async function createReviewer(options: ReviewerOptions): Promise<RefereeReviewer> {
	const slot: VerdictSlot = {};
	const sessionManager = await SessionManager.open(options.sessionFile, undefined, undefined, {
		initialCwd: options.cwd,
		suppressBreadcrumb: true,
	});
	const agent = await openRefereeAgent(options, {
		sessionManager,
		mode: "review",
		customTools: [options.verdictTool(slot)],
		park: true,
	});
	return {
		agentId: options.agentId,
		sessionFile: options.sessionFile,
		async review(request: RefereeReviewRequest, onActivity, signal): Promise<RefereeReviewResult> {
			const before = agent.usage();
			const open: NonNullable<VerdictSlot["review"]> = { index: request.index, kind: request.kind };
			slot.review = open;
			try {
				let turn = await agent.runTurn(renderReviewPrompt(request), onActivity, signal);
				for (
					let nudge = 0;
					nudge < VERDICT_NUDGES && !open.verdict && !turn.error && !turn.aborted && !signal?.aborted;
					nudge++
				) {
					turn = await agent.runTurn(
						prompt.render(nudgeVerdictPrompt, { index: request.index }),
						onActivity,
						signal,
					);
				}
				const after = agent.usage();
				const usage = { tokens: after.tokens - before.tokens, costUsd: after.costUsd - before.costUsd };
				if (open.verdict) return { verdict: open.verdict, usage };
				if (turn.aborted || signal?.aborted) return { aborted: true, usage };
				return { error: turn.error ?? "The referee ended its turn without recording a ruling.", usage };
			} finally {
				slot.review = undefined;
			}
		},
		dispose: () => agent.dispose(),
	};
}

/** The referee's review prompt; every untrusted text is XML-escaped inside its tag. */
export function renderReviewPrompt(request: RefereeReviewRequest): string {
	return prompt.render(reviewPrompt, {
		index: request.index,
		blocked: request.kind === "blocked",
		objectiveChanged: request.objectiveChanged,
		objectiveVersion: request.objectiveVersion,
		objective: escapeXmlText(request.objective),
		history: request.history ? escapeXmlText(request.history) : undefined,
		claim: escapeXmlText(request.claim),
		evidence: request.evidence ? escapeXmlText(request.evidence) : undefined,
		question: request.question ? escapeXmlText(request.question) : undefined,
	});
}

/** Ask the referee where the objective stands, in a throwaway session; it gives no ruling. */
export async function runStatusCheck(
	options: RefereeSessionOptions,
	request: RefereeStatusRequest,
	onActivity: (activity: RefereeActivity) => void,
	signal?: AbortSignal,
): Promise<RefereeStatusResult> {
	const agent = await openRefereeAgent(options, {
		sessionManager: SessionManager.inMemory(options.cwd),
		mode: "status",
		customTools: [],
		park: false,
	});
	try {
		const text = prompt.render(statusPrompt, {
			objectiveVersion: request.objectiveVersion,
			objective: escapeXmlText(request.objective),
			reviews: escapeXmlText(request.reviews),
			activity: request.activity ? escapeXmlText(request.activity) : undefined,
			question: request.question ? escapeXmlText(request.question) : undefined,
		});
		const turn = await agent.runTurn(text, onActivity, signal);
		const result: RefereeStatusResult = { text: turn.text, usage: agent.usage() };
		if (turn.aborted) result.aborted = true;
		else if (turn.error) result.error = turn.error;
		else if (!turn.text) result.error = "The referee returned no answer.";
		return result;
	} finally {
		await agent.dispose();
	}
}
