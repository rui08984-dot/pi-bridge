#!/usr/bin/env node
/**
 * pi-bridge —— 把 Pi 执行节点暴露为 MCP 工具，让任意 MCP 客户端（ZCode / Claude Code / Codex …）能派活、查状态、取消。
 *
 * 暴露三个工具（刻意保持精简）：
 *   pi_execute  派一个子任务给指定模型，跑完回传结构化结果
 *   pi_status   列出所有在跑/已完成的任务状态表
 *   pi_cancel   取消指定任务
 *
 * 同时支持单次 CLI 模式便于命令行验收：
 *   node src/server.js exec "任务" --model=coding --dir=/path/to/repo
 *
 * 配置：全部路径与模型表都可外置（见 README「配置」），代码不含个人环境硬编码。
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { PiNode } from "./pi-node.js";
import { composePrompt, getProjectBrief } from "./context.js";
import {
	resolveModel,
	listAliases,
	aliasOf,
	isEngineUp,
	isLocal,
	escalatedAliasFor,
	TASK_ROUTING,
	FALLBACK_CHAIN,
	MODEL_ALIASES,
} from "./models.js";
import { runVerify, snapshot, diffSnapshots, checkScope, buildReworkPrompt, buildEvidence } from "./verify.js";
import { MAX_CONCURRENT as CFG_MAX_CONCURRENT, DEFAULT_TIMEOUT_MS } from "./config.js";

/** 在跑任务表：taskId -> PiNode */
const nodes = new Map();
const MAX_NODES = 64;

/**
 * 并发闸门：**只管本地模型**。
 *
 * 本地引擎一次只能跑一个（典型是单张显卡跑量化模型）→ 本地任务串行排队。
 * 云端/网关模型不占本地显存，**应当与本地模型真正并行**——
 * 所以闸门按 provider 分流：local-* 进闸门，其它直接放行。
 *
 * 于是「一个本地 + 一个云端」是真并行的，不是排队。
 * 上游用大显存机器时可调大：config 的 maxConcurrent 或环境变量 PI_BRIDGE_CONCURRENCY。
 */
const MAX_CONCURRENT = CFG_MAX_CONCURRENT;
let active = 0;
const waiting = []; // {taskId, modelLabel, resolve, reject, cancelled}

function acquire(taskId, modelLabel) {
	if (active < MAX_CONCURRENT) {
		active++;
		return Promise.resolve();
	}
	return new Promise((resolve, reject) => {
		const slot = { taskId, modelLabel, resolve, reject, cancelled: false };
		waiting.push(slot);
		emitQueue();
	});
}

function release() {
	active = Math.max(0, active - 1);
	while (waiting.length && active < MAX_CONCURRENT) {
		const slot = waiting.shift();
		if (slot.cancelled) {
			slot.reject(new Error("任务在排队中被取消"));
			continue;
		}
		active++;
		slot.resolve();
	}
	emitQueue();
}

function cancelQueued(taskId) {
	const slot = waiting.find((w) => w.taskId === taskId);
	if (slot) {
		slot.cancelled = true;
		waiting.splice(waiting.indexOf(slot), 1);
		return true;
	}
	return false;
}

function emitQueue() {
	if (typeof process.stderr.write === "function") {
		process.stderr.write(`[pi-bridge] active=${active} queued=${waiting.length}\n`);
	}
}

const LOCAL_ALIASES = Object.keys(MODEL_ALIASES).filter((a) => isLocal(MODEL_ALIASES[a]));
const CLOUD_ALIASES = Object.keys(MODEL_ALIASES).filter((a) => !isLocal(MODEL_ALIASES[a]));

const TOOLS = [
	{
		name: "pi_execute",
		description: [
			"【何时用】把子任务派给另一个模型跑（本地自建模型，或你配置的云端/网关模型）。",
			"适合：大批量文本处理、代码审查、跑测试/构建、日志分析、批量改代码——这些活派出去能给主会话省 token。",
			"不适合：简单问答、几秒钟就能自己做完的小事——那种直接做更快。",
			"",
			"【重要·前置条件】被派活的模型端点必须已就绪：",
			"  · 本地模型 = 你需要先手动启动它的推理引擎（本工具不会替你拉进程）；",
			"  · 云端模型 = 网关/API 可达即可（通常无需额外启动）。",
			"若返回 unreachable，说明端点没起来——先启动它，不要反复重试。",
			"",
			"【强烈建议】带 verify 参数。弱模型会说『我做完了』但工具可能没真执行；",
			"只有你给的验收命令跑出退出码 0 才算真完成。这是唯一可信的完成信号。",
			"",
			"【示例】",
			'pi_execute(task="给 src/utils.ts 补空值检查", verify="npm test")',
			'pi_execute(task="分析 logs/ 里的报错", mode="explore")   // 只读，不会改任何文件',
			'pi_execute(task="重构认证模块", model=bonsai, scope="src/auth/", rework=1)',
			"",
			"【并行】占显存的本地任务串行排队；不占显存的模型（云端/网关）可与本地真并行。",
			"【经济性】推荐「弱模型打头阵 + 验收兜底 + 升档重试」：便宜模型有大概率一次做对，",
			"做不对时 rework 会自动升档到更强的模型（详见 escalate 参数）。",
		].join("\n"),
		inputSchema: {
			type: "object",
			properties: {
				task: {
					type: "string",
					description: "任务描述。说清三件事：要做什么、改哪些文件、做到什么程度算完成。",
				},
				model: {
					type: "string",
					description: [
						"不填 = 自动按任务类型路由到默认模型。",
						"",
						"本地（占显存，串行排队）：" + LOCAL_ALIASES.join(" / "),
						"云端/网关（不占本地显存，可与本地真并行）：" + CLOUD_ALIASES.join(" / "),
						"",
						"任务类型关键词（也可直接填，自动路由）：" + Object.keys(TASK_ROUTING).join(" / "),
					].join("\n"),
				},
				workdir: {
					type: "string",
					description: "工作目录，模型的所有文件操作都在这里发生。默认当前项目根。相对路径以此为基准。",
				},
				files: {
					type: "array",
					items: { type: "string" },
					description: "相关文件路径。**只传路径，不传内容**——模型会自己去读，别把代码塞进来。",
				},
				constraints: {
					type: "string",
					description: "额外约束：技术栈、代码风格、明确禁止做的事。",
				},
				timeoutMs: {
					type: "number",
					description:
						"超时毫秒，默认 600000（10 分钟）。本地 27B 慢：改一个文件约 80–190 秒，" +
						"跑大型重构可能要几分钟，默认值够用；只有跑超大任务时才需要调大。",
				},
				includeContext: {
					type: "boolean",
					description:
						"是否把项目状态简报（SessionRelay 看板/决策）一起带给模型，默认 true。" +
						"让子任务开局就知道项目现在什么状态。只在任务与本项目完全无关时关掉。",
				},
				verify: {
					type: "string",
					description: [
						"验收命令——**最重要的参数**。派活后系统会真实执行一次，退出码 0 才算完成。",
						"Windows 示例：\"npm test\"、\"if exist out.json (exit 0) else (exit 1)\"",
						"不填 = 不验收，等于只能相信模型自述（本地模型会假完成，建议尽量填）。",
					].join("\n"),
				},
				rework: {
					type: "number",
					description:
						"验收不通过时自动把『命令的实际报错输出』打回给模型重试几次（0-3，默认 0）。" +
						"默认每轮返工自动**升档**到更强的模型（如 ornith9b→ornith35b→bonsai→cloud_best）；" +
						"1 意味着最多跑两轮、时间翻倍。任务简单时保持 0。",
				},
				escalate: {
					type: "boolean",
					description:
						"返工是否升档（默认 true）。true = 验收不过时下一轮换更强的模型重试；" +
						"false = 原地用同一个模型重试（旧行为）。仅在 rework>0 时有意义。",
				},
				scope: {
					type: "array",
					items: { type: "string" },
					description:
						"限定可改动的路径，如 [\"src/auth/\"]。改了范围外的文件会被判失败。" +
						"改动范围明确时务必填，能防模型乱改。",
				},
				mode: {
					type: "string",
					enum: ["implement", "explore"],
					description:
						"implement=可写（默认）。" +
						"explore=只读：write/edit 在**进程层面**被禁用，模型物理上写不了任何文件。" +
						"只要分析/调研/理解代码就用 explore，绝不会误改文件。",
				},
			},
			required: ["task"],
		},
	},
	{
		name: "pi_status",
		description: [
			"查看所有 pi_execute 任务的实时状态表：taskId、模型、状态、耗时、当前正在调用的工具、工具调用数。",
			"含排队情况——本地模型串行排队，queue 字段显示还有几个在等。",
			"云端任务也会出现在 tasks 里（它们不占显卡，可与本地同时跑）。",
			"想在等待时向用户汇报进度、或想确认某个 taskId 是否还在跑时调用。",
		].join("\n"),
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "pi_cancel",
		description: [
			"取消一个 pi_execute 任务。",
			"排队中的任务会直接出队（不占用显卡槽位）；正在跑的任务会中断当前执行。",
			"只在任务跑偏、用户要求停止、或排队太久想插队时用。",
		].join("\n"),
		inputSchema: {
			type: "object",
			properties: { taskId: { type: "string", description: "要取消的任务 ID，从 pi_status 或派活返回值里拿。" } },
			required: ["taskId"],
		},
	},
];

function text(s) {
	return { content: [{ type: "text", text: typeof s === "string" ? s : JSON.stringify(s, null, 2) }] };
}

function statusTable() {
	const rows = [...nodes.values()].map((n) => ({
		taskId: n.taskId,
		model: `${n.provider}/${n.model}`,
		status: n.status,
		elapsedSec: Math.round(n.elapsedMs / 1000),
		currentTool: n.currentTool || "-",
		toolCalls: n.events.filter((e) => e.type === "tool_execution_start").length,
		cwd: n.cwd,
	}));
	//排队中的还没建节点，单独列出——否则 ZCode 派出多任务后看不到「还有几个在等」
	const queued = waiting
		.filter((w) => !w.cancelled)
		.map((w, i) => ({ position: i + 1, taskId: w.taskId, model: w.modelLabel, status: "queued" }));
	return {
		active,
		maxConcurrent: MAX_CONCURRENT,
		note: "占本地显存的模型（local-*）串行排队；不占显存的模型不限并发",
		total: rows.length + queued.length,
		running: rows.filter((r) => r.status === "running").length,
		queued: queued.length,
		tasks: rows,
		queue: queued,
	};
}

/** 在指定模型上跑一次（不含回退逻辑）。返回 {res, node}。 */
async function runOnce({ taskId, prompt, workdir, m, timeoutMs, excludeTools, allowTools }) {
	const node = new PiNode({
		taskId,
		cwd: workdir,
		provider: m.provider,
		model: m.model,
		excludeTools,
		allowTools,
	});
	nodes.set(taskId, node);
	if (nodes.size > MAX_NODES) {
		const oldest = [...nodes.entries()].find(([, n]) => n.status !== "running");
		if (oldest) {
			oldest[1].kill();
			nodes.delete(oldest[0]);
		}
	}

	// 单模型闸门：**仅本地模型**排队。云端链不占显存，直接放行与本地并行。
	const gated = isLocal(m);
	if (gated) {
		try {
			await acquire(taskId, `${m.provider}/${m.model}`);
		} catch (err) {
			nodes.delete(taskId);
			return { error: String(err) };
		}
		if (node.status === "cancelled") {
			release();
			nodes.delete(taskId);
			return { error: "cancelled" };
		}
	}

	try {
		node.spawn();
		const res = await node.run(prompt, { timeoutMs });
		node.kill();
		return { res };
	} catch (err) {
		node.kill();
		return { error: String(err).slice(0, 500), stderr: node.stderr.slice(-500) };
	} finally {
		if (gated) release();
	}
}

/** 该结果是否值得换一个模型重试。 */
function needsFallback(res) {
	if (!res) return false;
	// 工具调用退化 = 主模型这次没真干活，换个引擎重跑有意义
	if (res.toolCallDegraded) return true;
	return false;
}

async function execute(args) {
	const taskId = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
	const workdir = args.workdir || process.cwd();

	// 模型选择：显式别名 > 任务类型路由 > 默认（主力 Bonsai）
	let m = args.model ? resolveModel(args.model) : null;
	if (args.model && !m) {
		return text(
			`❌ 未知模型别名「${args.model}」。\n可用别名：${listAliases().map((a) => a.alias).join(" / ")}\n` +
				`或任务类型：${Object.keys(TASK_ROUTING).join(" / ")}`,
		);
	}
	if (!m) m = resolveModel("coding");
	const primaryAlias = args.model && MODEL_ALIASES[args.model] ? args.model : aliasOf(m);

	// —— 验收配置（全部可选，不填= 零行为变化、零 token 开销）——
	const verifyCmd = args.verify || null;
	const scope = args.scope && args.scope.length ? args.scope : null;
	const maxRework = Number.isFinite(args.rework) ? Math.max(0, Math.min(3, args.rework)) : 0;
	// 返工升档（2026-10-06）：默认开——第一轮验收不过时，第二轮换**更强**的模型重试，
	// 而不是原地重试同一个（弱）模型。escalate=false 则退回原来的原地重试行为。
	const escalate = args.escalate !== false;
	// explore = 只读：写工具从**进程层面**拿掉，模型调不到，不是靠提示词自觉
	const explore = args.mode === "explore";
	const excludeTools = explore ? ["write", "edit", "notebook_edit"] : null;

	const prompt = await composePrompt({
		task: args.task,
		context: { workdir },
		files: args.files,
		constraints: args.constraints,
		projectBrief: args.includeContext === false ? null : await getProjectBrief(workdir),
		explore,
		scope,
		verifyCmd,
	});

	const timeoutMs = args.timeoutMs || DEFAULT_TIMEOUT_MS;
	// 拍「前」快照：用来证明到底改了什么，而不是相信模型自述
	const before = verifyCmd || scope ? snapshot(workdir) : null;

	let attempt = await runOnce({ taskId, prompt, workdir, m, timeoutMs, excludeTools });

	// —— 自动回退 ——
	// 触发条件：① 主模型工具调用退化 ② 主模型引擎没起（你一次只跑一个引擎，
	// 这时若备选引擎在线就该顶上）。绝不交付假成功，也绝不因为换模型白等一轮。
	let fallbackNote = "";
	const wantFallback = !attempt.error && args.noFallback !== true && (needsFallback(attempt.res) || attempt.res?.status === "unreachable");
	if (wantFallback) {
		const chain = FALLBACK_CHAIN[primaryAlias] || [];
		for (const alt of chain) {
			const altM = resolveModel(alt);
			if (!altM || altM.provider === m.provider) continue;
			// 引擎没起的情况：只有备选真的在线才值得重试
			if (attempt.res?.status === "unreachable" && !(await isEngineUp(alt))) continue;

			const why =
				attempt.res?.status === "unreachable"
					? `主力模型 ${primaryAlias} 的引擎未启动`
					: `主力模型 ${primaryAlias} 本轮工具调用退化（输出了 <​tool_call> 文本但未真正执行）`;
			fallbackNote = `\n\n♻️ ${why}，已自动改用 ${alt} 重跑。`;
			attempt = await runOnce({ taskId: taskId + "-fb", prompt, workdir, m: altM, timeoutMs, excludeTools });
			if (!attempt.error && attempt.res?.status === "completed" && !attempt.res.toolCallDegraded) {
				m = altM;
				break;
			}
			fallbackNote = `\n\n♻️ ${why}，改用 ${alt} 后仍未成功。`;
		}
	}

	if (attempt.error) {
		return text(
			`❌ 任务失败（${taskId}）：${attempt.error}` +
				(attempt.stderr ? `\n\nstderr:\n${attempt.stderr}` : "") +
				(attempt.error === "cancelled" ? "" : "\n\n提示：确认对应模型端点已就绪（本地模型需先启动推理引擎），且显存/内存足够。"),
		);
	}

	// —— 验收 + 返工循环（含升档）——
	// 借鉴 Fusion：模型说「我做完了」不算数，命令跑出来才算。
	// 升档（2026-10-06）：验收不过 → 下一轮换**更强的**模型重试，而不是原地重试同一个弱模型。
	let verifyResult = null;
	let scopeResult = null;
	let evidence = null;
	const rounds = [];
	const escalations = []; // 记录升档轨迹：{from, to}

	for (let round = 1; round <= maxRework + 1; round++) {
		if (!before) break; // 没配验收/范围，直接收工

		const after = snapshot(workdir);
		verifyResult = verifyCmd ? await runVerify(verifyCmd, workdir) : null;
		scopeResult = scope ? checkScope([...diffSnapshots(before, after).created, ...diffSnapshots(before, after).modified], scope, workdir) : null;
		evidence = buildEvidence({ before, after, root: workdir, verifyResult, scopeResult, res: attempt.res });

		const ok = (!verifyResult || verifyResult.passed) && (!scopeResult || scopeResult.ok);
		rounds.push({ round, verifyPassed: verifyResult?.passed ?? null, scopeOk: scopeResult?.ok ?? null });

		if (ok) break;
		if (round > maxRework) break;

		// 升档：这一轮验收没过，换更强的模型再来。
		// 从「本轮实际用的模型」推下一档，链走完停在最强档（原地重试）。
		if (escalate) {
			const currentAlias = aliasOf(m);
			const nextAlias = escalatedAliasFor(currentAlias);
			if (nextAlias) {
				const nextM = resolveModel(nextAlias);
				if (nextM) {
					escalations.push({ from: currentAlias, to: nextAlias });
					m = nextM;
				}
			}
		}

		// 打回把验收的实际输出给它，让它改而不是重写。
		const reworkPrompt = buildReworkPrompt({
			originalTask: args.task,
			verifyResult,
			scopeResult,
			evidence,
			round: round + 1,
			maxRounds: maxRework + 1,
		});
		const re = await runOnce({
			taskId: `${taskId}-rw${round}`,
			prompt: reworkPrompt,
			workdir,
			m,
			timeoutMs,
			excludeTools,
		});
		if (re.error) break;
		attempt = re;
	}

	const res = attempt.res;

	// —— 验收结论优先于模型自述 ——
	// 关键：模型说「完成了」不算数。配了 verify/scope 却没通过 → 明确报失败。
	const verifyFailed = verifyResult && !verifyResult.passed;
	const scopeFailed = scopeResult && !scopeResult.ok;
	const verified = !!(verifyResult || scopeResult);
	const verifiedOk = verified && !verifyFailed && !scopeFailed;

	const bad = res.status !== "completed" || verifyFailed || scopeFailed;
	const header = bad
		? `❌ 任务 ${verifyFailed ? "验收未通过" : scopeFailed ? "改动越界" : res.status}｜模型 ${res.model}｜耗时 ${Math.round(res.elapsedMs / 1000)}s｜工具调用 ${res.toolCallCount}次`
		: `✅ 任务完成${verified ? "（验收通过）" : ""}｜模型 ${res.model}｜耗时 ${Math.round(res.elapsedMs / 1000)}s｜工具调用 ${res.toolCallCount}次`;

	let warn = "";
	if (verifyFailed) {
		warn =
			`\n\n🚨 **验收未通过——模型说完成了，但命令跑出来不是这样**。\n` +
			`   验收命令：\`${verifyResult.command}\`（退出码 ${verifyResult.exitCode}）\n` +
			`   \`\`\`\n${(verifyResult.output || "(无输出)").slice(0, 1200)}\n\`\`\`\n` +
			(rounds.length > 1 ? `   已返工 ${rounds.length - 1} 次仍未通过。` : "   可加大 rework 参数让它自动返工（会自动升档到更强的模型）。");
	} else if (scopeFailed) {
		warn =
			`\n\n🚨 **改动越界**：这些文件不在允许范围内——\n` +
			scopeResult.violations.map((v) => `   - ${v}`).join("\n");
	} else if (verifiedOk && res.status === "completed") {
		warn = `\n\n✅ **验收通过**${verifyResult ? `（\`${verifyResult.command}\`）` : ""}`;
	}
	// 升档轨迹：中途换过更强模型时明说，别让它静默发生
	let escalateNote = "";
	if (escalations.length) {
		escalateNote =
			`\n\n⬆️ **返工升档**：` +
			escalations.map((e) => `${e.from} → ${e.to}`).join("，") +
			(rounds.at(-1)?.verifyPassed ? `（升档后验收通过）` : `（升档后仍未通过）`);
	}
	if (res.status === "unreachable") {
		warn = `\n\n🚨 **任务没有真正执行**。${res.hint}`;
	} else if (res.toolCallDegraded) {
		warn =
			`\n\n🚨 **工具调用未真正执行**：模型把调用输出成了纯文本（<​tool_call>…），引擎未解析成结构化调用。\n` +
			`   已尝试回退但仍失败——这需要动文件/跑命令的任务，请显式指定 model=ornith35b。`;
	} else if (res.status === "timeout") {
		warn = `\n\n⏱️ 超时未完成。若模型偏慢，调大 timeoutMs。`;
	}

	// 证据链：模型说改了什么 vs 实际改了什么
	let evidenceBlock = "";
	if (evidence) {
		const lines = [];
		if (evidence.changed.length) {
			lines.push(`改动 ${evidence.changed.length} 个文件：`);
			for (const f of evidence.changed.slice(0, 12)) lines.push(`   ~ ${f}`);
			if (evidence.changed.length > 12) lines.push(`   … 另 ${evidence.changed.length - 12} 个`);
		} else if (verifyCmd || scope) {
			lines.push(
				res.status === "completed"
					? "⚠️ **实际没有改动任何文件**（若任务本该产出文件，说明工具没真正执行）"
					: "（任务未完成，无改动可报）",
			);
		}
		if (evidence.commands.length) {
			lines.push(`执行命令 ${evidence.commands.length} 条：`);
			for (const cmd of evidence.commands.slice(0, 6)) lines.push(`   $ ${String(cmd).slice(0, 110)}`);
		}
		if (evidence.toolDenied?.length) {
			lines.push(`⛔ 被拒绝的工具调用 ${evidence.toolDenied.length} 次：${[...new Set(evidence.toolDenied.map((d) => d.tool))].join(", ")}（只读模式生效）`);
		}
		if (rounds.length > 1) {
			lines.push(`轮次：${rounds.map((r) => `#${r.round}${r.verifyPassed === false ? " 验收✗" : r.verifyPassed ? " 验收✓" : ""}${r.scopeOk === false ? " 越界✗" : ""}`).join(" → ")}`);
		}
		if (lines.length) evidenceBlock = `\n\n【证据链】\n${lines.join("\n")}`;
	}

	return text(
		header +
			(res.tokens ? `｜token ${res.tokens.total}` : "") +
			fallbackNote +
			escalateNote +
			warn +
			evidenceBlock +
			`\n\n【结果】\n${res.finalText || "(无文本输出)"}` +
			(res.toolCalls.length
				? `\n\n【工具轨迹】\n` + res.toolCalls.map((c, i) => `${i + 1}. ${c.tool}(${JSON.stringify(c.args).slice(0, 120)})`).join("\n")
				: ""),
	);
}

// —— MCP 模式 ——
async function main() {
	const server = new Server(
		{ name: "pi-bridge", version: "0.1.0" },
		{ capabilities: { tools: {} } },
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const { name, arguments: args } = req.params;
		try {
			if (name === "pi_execute") return await execute(args || {});
			if (name === "pi_status") return text(statusTable());
			if (name === "pi_cancel") {
				// 排队中的任务：出队即可，不必等它拿到槽位
				if (cancelQueued(args.taskId)) {
					const qn = nodes.get(args.taskId);
					qn?.kill();
					nodes.delete(args.taskId);
					return text(`已取消排队任务 ${args.taskId}（未开始执行）`);
				}
				const n = nodes.get(args.taskId);
				if (!n) return text(`未找到任务 ${args.taskId}`);
				n.status = "cancelled";
				await n.cancel();
				n.kill();
				return text(`已取消 ${args.taskId}`);
			}
			return text(`未知工具 ${name}`);
		} catch (err) {
			return text(`错误：${String(err)}`);
		}
	});

	await server.connect(new StdioServerTransport());
}

// —— CLI 模式（验收用）——
async function cli() {
	const argv = process.argv.slice(2);
	const [cmd, ...rest] = argv;
	const flag = (n) => {
		const a = rest.find((x) => x.startsWith(`--${n}=`));
		return a ? a.split("=").slice(1).join("=") : undefined;
	};
	if (cmd === "exec") {
		const task = rest.filter((x) => !x.startsWith("--")).join(" ");
		const dir = flag("dir") || process.cwd();
		const model = flag("model");
		const out = await execute({
			task,
			workdir: dir,
			model,
			files: flag("files") ? flag("files").split(",") : undefined,
			includeContext: flag("ctx") !== "false",
			verify: flag("verify"),
			rework: flag("rework") ? Number(flag("rework")) : undefined,
			escalate: flag("escalate") !== "false", // 默认升档；--escalate=false 关闭
			scope: flag("scope") ? flag("scope").split(",") : undefined,
			mode: flag("mode"),
		});
		console.log(out.content[0].text);
		process.exit(0);
	}
	console.log(`pi-bridge

  node src/server.js                      以 MCP stdio server 运行（ZCode 接入用）
  node src/server.js exec "任务" --model=coding --dir=D:\\repo   命令行跑一次

验收与约束（借鉴 DSH Fusion，全部可选）：
  --verify="命令"          派活后真跑一次，退出码 0 才算完成（模型自述不算数）
  --rework=1               验收不过自动返工（默认 0，最多 3）；默认每轮升档到更强模型
  --escalate=false         返工时不升档，原地用同一模型重试
  --scope=src/,docs/       限定可改文件范围，越界即判失败
  --mode=explore           只读：write/edit 从进程层面禁用，模型调不到

可用模型别名：${listAliases().map((a) => a.alias).join(", ")}
任务类型路由：${Object.entries(TASK_ROUTING).map(([k, v]) => `${k}→${v}`).join(", ")}`);
}

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
	if (process.argv[2] === "exec") cli();
	else main();
}