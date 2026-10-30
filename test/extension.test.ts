/**
 * End to end through omp's real session runtime: the extension loads into a
 * main session, `/referee` starts a run, and scripted models play the agent and
 * the referee. Proves the stop gate holds the agent until the referee passes,
 * and that the guards around reviews neither trap the agent nor let it loop.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { createAgentSession, type ExtensionAPI, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { getAgentDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import referee from "../src/index";
import { RUN_ENTRY_TYPE, restoreRun } from "../src/run";
import type { RefereeRun } from "../src/types";

const API = "test-referee-extension";
const OBJECTIVE = "Make a.txt say beta.";
const SUMMARY = "Read a.txt and compared it with the objective.";
const REFUSED = "Nothing changed since review";

type Script = ((context: Context) => AssistantMessage)[];

function reply(message: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: API,
		provider: "fake",
		model: "main",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...message,
	};
}

function say(text: string) {
	return () => reply({ content: [{ type: "text", text }] });
}

function call(name: string, args: Record<string, unknown>) {
	return () =>
		reply({
			content: [{ type: "toolCall", id: `call-${Bun.randomUUIDv7()}`, name, arguments: args }],
			stopReason: "toolUse",
		});
}

/** A provider failure omp does not retry. */
function outage() {
	return () => reply({ content: [], stopReason: "error", errorMessage: "provider exploded" });
}

const review = (claim: string) => call("referee_review", { kind: "complete", claim, evidence: "read a.txt" });
const rule = (verdict: "pass" | "fail") =>
	call(
		"referee_verdict",
		verdict === "fail"
			? { verdict, summary: SUMMARY, findings: ["a.txt still says alpha."] }
			: { verdict, summary: SUMMARY },
	);

function toolNames(context: Context | undefined): string[] {
	return (context?.tools ?? []).map(tool => tool.name);
}

function messagesText(context: Context | undefined): string {
	return JSON.stringify(context?.messages ?? []);
}

interface Outcome {
	main: Context[];
	referee: Context[];
	run: RefereeRun | undefined;
	snapshots: number;
}

describe("referee extension", () => {
	let root: string;
	let project: string;
	let previousAgentDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let settings: Settings;

	beforeAll(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-referee-extension-"));
		project = path.join(root, "project");
		await Bun.write(path.join(project, "a.txt"), "alpha\n");
		previousAgentDir = getAgentDir();
		const agentDir = path.join(root, "agent");
		setAgentDir(agentDir);
		await Bun.write(path.join(agentDir, "referee.json"), JSON.stringify({ model: "fake/referee" }));
		// The extension reads the host's global settings, as it does inside omp.
		settings = await Settings.init({
			agentDir,
			cwd: project,
			inMemory: true,
			overrides: { "compaction.enabled": false },
		});
		authStorage = await AuthStorage.create(path.join(root, "auth.db"));
		authStorage.keys.setRuntime("fake", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
		const spec = {
			api: API,
			reasoning: false,
			input: ["text" as const],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 64_000,
			maxTokens: 2048,
		};
		modelRegistry.registerProvider("fake", {
			api: API,
			baseUrl: "http://127.0.0.1:9/v1",
			apiKey: "test-key",
			models: [
				{ id: "main", name: "Main fake", ...spec },
				{ id: "referee", name: "Referee fake", ...spec },
			],
		});
	});

	afterAll(async () => {
		clearCustomApis();
		resetSettingsForTest();
		setAgentDir(previousAgentDir);
		authStorage.close();
		await removeWithRetries(root);
	});

	/** Start a run of {@link OBJECTIVE} and play both scripts until the session settles for good. */
	async function play(main: Script, judge: Script): Promise<Outcome> {
		const mainContexts: Context[] = [];
		const refereeContexts: Context[] = [];
		// The last settle: an `agent_end` that schedules no further turn once the main script is spent.
		const settled = Promise.withResolvers<void>();
		const probe = (pi: ExtensionAPI) => {
			pi.on("agent_end", event => {
				if (main.length === 0 && event.willContinue !== true) settled.resolve();
			});
		};
		registerCustomApi(API, (_model, context) => {
			const stream = new AssistantMessageEventStream();
			const names = toolNames(context);
			// Auxiliary requests (title generation) carry no tools and take no scripted reply.
			const lane = names.includes("referee_verdict") ? "referee" : names.length > 0 ? "main" : undefined;
			if (lane === "main") mainContexts.push(context);
			if (lane === "referee") refereeContexts.push(context);
			const next = lane === "main" ? main.shift() : lane === "referee" ? judge.shift() : undefined;
			const message = next ? next(context) : reply({ content: [{ type: "text", text: "idle" }] });
			queueMicrotask(() => {
				if (message.stopReason === "error") {
					stream.push({ type: "error", reason: "error", error: message });
					return;
				}
				stream.push({ type: "start", partial: message });
				message.content.forEach((block, contentIndex) => {
					if (block.type !== "toolCall") return;
					stream.push({ type: "toolcall_start", contentIndex, partial: message });
					stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: message });
				});
				stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
			});
			return stream;
		});

		const { session } = await createAgentSession({
			cwd: project,
			sessionManager: SessionManager.inMemory(project),
			model: modelRegistry.find("fake", "main") as Model<Api>,
			modelRegistry,
			authStorage,
			settings,
			extensions: [referee, probe],
			disableExtensionDiscovery: true,
			hasUI: false,
			enableMCP: false,
			enableLsp: false,
			skills: [],
			promptTemplates: [],
		});
		// Bind the extension's runtime actions the way print mode does; without a mode nothing is wired.
		const extensionErrors: string[] = [];
		await initializeExtensions(session, {
			mode: "print",
			reportSendError: (_action, error) => extensionErrors.push(error.message),
			reportRuntimeError: error => extensionErrors.push(error.error),
		});
		try {
			await session.prompt(`/referee ${OBJECTIVE}`);
			await settled.promise;
			expect(extensionErrors).toEqual([]);
			expect(judge).toHaveLength(0);
			const entries = session.sessionManager.getEntries();
			return {
				main: mainContexts,
				referee: refereeContexts,
				run: restoreRun(entries),
				snapshots: entries.filter(entry => entry.type === "custom" && entry.customType === RUN_ENTRY_TYPE).length,
			};
		} finally {
			await session.dispose();
			for (const ref of AgentRegistry.global().list()) {
				if (ref.id.startsWith("Referee")) AgentRegistry.global().unregister(ref.id);
			}
		}
	}

	it("holds the agent until the referee passes, refuses an unchanged re-review, then lets it stop", async () => {
		const outcome = await play(
			[
				// Stops at once without asking for a review: the gate sends it back.
				say("All done."),
				review("a.txt says beta."),
				// Asks again without doing anything in between: refused before the referee runs.
				review("a.txt says beta, really."),
				call("read", { path: "a.txt" }),
				review("a.txt says beta."),
				say("The referee passed it."),
			],
			[rule("fail"), say("Ruled."), rule("pass"), say("Ruled.")],
		);
		const { main } = outcome;
		// The review tool is offered from the first turn of the run.
		expect(toolNames(main[0])).toContain("referee_review");
		expect(messagesText(main[0])).toContain(OBJECTIVE);
		// The first stop was refused with the objective restated.
		expect(messagesText(main[1])).toContain("The referee has not passed the objective");
		expect(messagesText(main[1])).toContain("No review has judged this objective yet");
		// The referee judged the claim and failed it; the agent saw the findings.
		expect(messagesText(outcome.referee[0])).toContain("a.txt says beta.");
		expect(messagesText(main[2])).toContain("a.txt still says alpha.");
		// An unchanged re-review never reached the referee.
		expect(messagesText(main[3])).toContain(`${REFUSED} 1 failed`);
		// The second review ran in the same referee session, so it saw the first.
		expect(messagesText(outcome.referee[2])).toContain("Review 1: completion claim");
		// After the pass the tool is gone and the stop went through: no further turns.
		expect(toolNames(main[5])).not.toContain("referee_review");
		expect(main).toHaveLength(6);
		expect(outcome.referee).toHaveLength(4);
		expect(outcome.run?.status).toBe("passed");
		expect(outcome.run?.reviews.map(entry => entry.verdict)).toEqual(["fail", "pass"]);
		expect(outcome.snapshots).toBeGreaterThan(1);
	}, 30_000);

	it("retries a review the referee failed to finish without demanding new work, even after a fail", async () => {
		const outcome = await play(
			[
				review("a.txt says beta."),
				call("read", { path: "a.txt" }),
				review("a.txt says beta now."),
				// The referee errored; asking again right away must reach it.
				review("a.txt says beta now."),
				say("The referee passed it."),
			],
			[rule("fail"), say("Ruled."), outage(), rule("pass"), say("Ruled.")],
		);
		expect(messagesText(outcome.main[3])).toContain("could not finish review 2");
		expect(messagesText(outcome.main[4])).not.toContain(REFUSED);
		expect(outcome.run?.reviews.map(entry => entry.outcome)).toEqual(["verdict", "error", "verdict"]);
		expect(outcome.run?.status).toBe("passed");
	}, 30_000);

	it("pauses a run whose agent only repeats refused reviews between stops", async () => {
		const outcome = await play(
			[
				review("a.txt says beta."),
				say("Done."),
				// From here on every review is refused, so no stop shows progress.
				review("a.txt says beta."),
				say("Done."),
				review("a.txt says beta."),
				say("Done."),
				review("a.txt says beta."),
				say("Done."),
			],
			[rule("fail"), say("Ruled.")],
		);
		expect(outcome.referee).toHaveLength(2);
		expect(messagesText(outcome.main.at(-1))).toContain(REFUSED);
		// A blocked stop restates the referee's last ruling: its summary and findings.
		expect(messagesText(outcome.main[2])).toContain(SUMMARY);
		expect(messagesText(outcome.main[2])).toContain("a.txt still says alpha.");
		expect(outcome.run?.status).toBe("paused");
		expect(outcome.run?.pauseReason).toBe("stalled");
		expect(outcome.main).toHaveLength(8);
	}, 30_000);
});
