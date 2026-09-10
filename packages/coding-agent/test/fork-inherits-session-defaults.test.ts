/**
 * Fork inheritance regression: fork hands the current model/thinking level to
 * the runtime factory, so a branch with no messages (fork "before" the first
 * user entry) still starts on the source model instead of falling through to
 * initial-model resolution.
 *
 * No API key required: the model is set explicitly and no prompt is sent.
 * The fixture model is deliberately NOT zai's per-provider default
 * (glm-5.3) — otherwise the no-inherit path would resolve to the same model
 * and the regression would be indistinguishable.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel, type Usage } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const FORK_MODEL = getModel("zai", "glm-5.3-flash")!;
const INITIAL_MODEL = getModel("zai", "glm-5.3")!;

function createUsage(): Usage {
	return {
		input: 1,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 1,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("fork inherits session defaults", () => {
	let runtimeHost: AgentSessionRuntime;
	let tempDir: string;
	let sessionManager: SessionManager;
	/** Every factory invocation, in order — assertions read the replacement calls. */
	const factoryCalls: Array<{ model?: unknown; thinkingLevel?: unknown }> = [];

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-fork-inherit-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await runtimeHost?.dispose();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	async function createRuntimeHost() {
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		// A stored (fake) key lets setModel pass its auth check; nothing is ever
		// sent — no prompt runs in this suite.
		await authStorage.modify("zai", async () => ({ type: "api_key", key: "fork-test-key" }));
		const servicesOptions = {
			agentDir: tempDir,
			authStorage,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
			factoryCalls.push({ model: options.model, thinkingLevel: options.thinkingLevel });
			const services = await createAgentSessionServices({
				...servicesOptions,
				cwd: options.cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager: options.sessionManager,
					...(options.sessionStartEvent !== undefined
						? { sessionStartEvent: options.sessionStartEvent }
						: {}),
					...(options.model !== undefined ? { model: options.model } : {}),
					...(options.thinkingLevel !== undefined
						? { thinkingLevel: options.thinkingLevel }
						: {}),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		sessionManager = SessionManager.create(tempDir);
		runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager,
		});
		runtimeHost.session.subscribe(() => {});
		return runtimeHost;
	}

	function seedOneTurn(): string {
		const userEntryId = sessionManager.appendMessage({ role: "user", content: "seed turn", timestamp: 1 });
		sessionManager.appendMessage({
			role: "assistant",
			content: [],
			api: INITIAL_MODEL.api,
			provider: INITIAL_MODEL.provider,
			model: INITIAL_MODEL.id,
			usage: createUsage(),
			stopReason: "stop",
			timestamp: 2,
		});
		return userEntryId;
	}

	it("passes the current model and thinking level to the replacement factory", async () => {
		await createRuntimeHost();
		const session = runtimeHost.session;
		await session.setModel(FORK_MODEL);

		const userEntryId = seedOneTurn();
		const forkable = session.getUserMessagesForForking();
		expect(forkable.length).toBeGreaterThan(0);
		expect(forkable[0]!.entryId).toBe(userEntryId);

		factoryCalls.length = 0;
		const result = await runtimeHost.fork(userEntryId, { position: "before" });
		expect(result.cancelled).toBe(false);

		expect(factoryCalls.length).toBe(1);
		const replacement = factoryCalls[0]!;
		expect(replacement.model).toBe(FORK_MODEL);
		expect(replacement.thinkingLevel).toBe(session.thinkingLevel);
	});

	it("replacement session runs on the inherited model even though the branch has no messages", async () => {
		await createRuntimeHost();
		const session = runtimeHost.session;
		await session.setModel(FORK_MODEL);

		const userEntryId = seedOneTurn();

		await runtimeHost.fork(userEntryId, { position: "before" });

		// Fork "before" the only user entry leaves a message-less branch; the
		// inherited model must still win over initial-model resolution (which
		// would pick zai's per-provider default glm-5.3, not glm-5.3-flash).
		expect(runtimeHost.session.messages.length).toBe(0);
		expect(runtimeHost.session.model?.provider).toBe(FORK_MODEL.provider);
		expect(runtimeHost.session.model?.id).toBe(FORK_MODEL.id);
	});
});
