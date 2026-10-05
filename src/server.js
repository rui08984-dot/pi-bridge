#!/usr/bin/env node
/**
 * pi-bridge —— 把本地 Pi 执行节点暴露为 MCP 工具，让 ZCode 能派活/查状态/取消。
 *
 * 暴露三个工具（刻意保持精简）：
 *   pi_execute  派一个子任务给本地模型，跑完回传结构化结果
 *   pi_status   列出所有在跑/已完成的任务状态表
 *   pi_cancel   取消指定任务
 *
 * 同时支持单次 CLI 模式便于命令行验收：
 *   node src/server.js exec "任务" --model=coding --dir=D:\repo
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

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 在跑任务表：taskId -> PiNode */
const nodes = new Map();
const MAX_NODES = 64;

/**
 * 异步任务表（2026-10-06）：taskId -> state
 *
 * 为什么需要：MCP 工具调用是「请求-响应」——同步模式下调用方发出 pi_execute 后
 * 整条验收链（执行/返工/升档）跑完才返回，期间调用方只能干等。
 * 异步模式让 pi_execute(async=true) **毫秒级**返回 taskId，调用方立刻能干别的活；
 * 验收链全部在后台照常跑，之后用 pi_result(taskId) 取完整结果。
 *
 * 结果同时落盘（~/.pi-bridge/tasks/），进程重启/换会话也能取回。
 * 同步模式（默认）不写这里，行为零变化。
 */
const asyncTasks = new Map();
const MAX_ASYNC_TASKS = 64;
const TASKS_DIR = join(homedir(), ".pi-bridge", "tasks");

/** 把异步任务记录落盘（结果单独存 .result.txt，读取时拼回）。落盘失败不影响主流程。 */
function persistTask(state) {
	try {
		mkdirSync(TASKS_DIR, { recursive: true });
		const rec = {
			taskId: state.taskId,
			task: String(state.task || "").slice(0, 300),
			status: state.status,
			phase: state.phase || "",
			modelHint: state.modelHint || "",
			startedAt: state.startedAt,
			finishedAt: state.finishedAt || null,
			pid: process.pid,
		};
		writeFileSync(join(TASKS_DIR, `${state.taskId}.json`), JSON.stringify(rec, null, 1), "utf8");
		if (state.resultText) writeFileSync(join(TASKS_DIR, `${state.taskId}.result.txt`), state.resultText, "utf8");
	} catch {
		/* 落盘失败不影响任务本身 */
	}
}

/** 从磁盘读回任务记录（进程重启/跨会话取结果的兜底）。taskId 校验防路径穿越。 */
function loadTaskFromDisk(taskId) {
	if (!/^t-[A-Za-z0-9_-]{1,64}$/.test(taskId)) return null;
	try {
		const rec = JSON.parse(readFileSync(join(TASKS_DIR, `${taskId}.json`), "utf8"));
		let resultText = null;
		try {
			resultText = readFileSync(join(TASKS_DIR, `${taskId}.result.txt`), "utf8");
		} catch {
			/* 结果文件可能还没写出 */
		}
		return { ...rec, resultText };
	} catch {
		return null;
	}
}

/** 控制磁盘记录数量（默认留最近 200 个）。 */
function pruneTaskFiles(maxFiles = 200) {
	try {
		const files = readdirSync(TASKS_DIR)
			.filter((f) => f.endsWith(".json"))
			.map((f) => {
				try {
					return { f, t: statSync(join(TASKS_DIR, f)).mtimeMs };
				} catch {
					return null;
				}
			})
			.filter(Boolean)
			.sort((a, b) => a.t - b.t);
		const excess = files.length - maxFiles;
		for (let i = 0; i < excess; i++) {
			try {
				unlinkSync(join(TASKS_DIR, files[i].f));
			} catch {}
			try {
				unlinkSync(join(TASKS_DIR, files[i].f.replace(/\.json$/, ".result.txt")));
			} catch {}
		}
	} catch {
		/* 目录不存在等，忽略 */
	}
}

/** 内存表淘汰：优先清已完结的最旧任务。 */
function evictAsyncTasks() {
	if (asyncTasks.size <= MAX_ASYNC_TASKS) return;
	const done = [...asyncTasks.values()].filter((s) => s.status !== "running").sort((a, b) => (a.finishedAt || 0) - (b.finishedAt || 0));
	for (const s of done) {
		if (asyncTasks.size <= MAX_ASYNC_TASKS) break;
		asyncTasks.delete(s.taskId);
	}
}

/** 取消专用错误：被拦截而非普通失败。 */
function cancelledError(taskId) {
	const e = new Error(`任务 ${taskId} 已被取消`);
	e.cancelled = true;
	return e;
}

/**
 * 并发闸门：**只管本地模型**。
 *
 * 本机 8GB VRAM，本地引擎一次只能跑一个 → 本地任务串行排队。
 * 但云端链（newapi）不占显存，**应当与本地模型真正并行**——
 * 所以闸门按 provider分流：local-* 进闸门，newapi 直接放行。
 *
 * 于是「一个本地 + 一个云端」是真并行的，不是排队。
 */
const MAX_CONCURRENT = Number(process.env.PI_BRIDGE_CONCURRENCY || 1);
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
			"【何时用】把子任务派给本地模型跑。本机 8GB 显卡上跑的是你自建的 NInfer/AtomicBot 量化模型（非 Ollama），不花 API 费、数据不出本机。",
			"适合：大批量文本处理、代码审查、跑测试/构建、日志分析、本地批量改代码。",
			"不适合：简单问答、几秒钟就能自己做完的小事——那种直接做更快。",
			"",
			"【重要·前置条件】本地模型引擎必须已经由用户手动启动（桌面快捷方式『启动本地AI-菜单』→ 选 9 或 10）。",
			"本工具**不会**替你启动引擎。若返回 unreachable，说明引擎没开——请让用户先启动，不要重试。",
			"",
			"【强烈建议】带 verify 参数。本地量化模型会说『我做完了』但工具可能没真执行；",
			"只有你给的验收命令跑出退出码 0 才算真完成。这是唯一可信的完成信号。",
			"",
			"【示例】",
			'pi_execute(task="给 src/utils.ts 补空值检查", verify="npm test")',
			'pi_execute(task="分析 logs/ 里的报错", mode="explore")   // 只读，不会改任何文件',
			'pi_execute(task="重构认证模块", model="bonsai", scope="src/auth/", rework=1)',
			"",
			"【并行】本地任务串行排队（显卡一次只能跑一个）；但可以用 model=cloud_* 派云端任务，它与本地真并行。",
			"",
			"【不想干等 → 异步模式】async=true：毫秒级返回 taskId，**你立刻能继续干自己的活**——",
			"执行/验收/返工/升档整套在后台照常跑，跑完后用 pi_result(taskId) 取完整结果。",
			'   例：pi_execute(task="…", verify="npm test", async=true)',
			'   之后：pi_result(taskId="t-xxx")  或  pi_result(taskId="t-xxx", waitMs=120000)（就地等 2 分钟）',
			"想边派活边干别的、或一次派多个任务 → 用 async=true；必须拿到结果才能往下走 → 用默认同步模式。",
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
						"不填 = 自动按任务类型路由到本地主力（27B）。",
						"",
						"本地（占显存，串行排队）：" + LOCAL_ALIASES.join(" / "),
						"　· bonsai = 27B 主力，最聪明也最慢（改一个文件约 80–190 秒）",
						"　· cloud_* 类名之外的本地别名还有更快的，但能力弱于 bonsai",
						"",
						"云端（不占显存，可与本地真并行，几秒返回）：" + CLOUD_ALIASES.join(" / "),
						"　· 只在『要快出结果』或『本地引擎没启动』时用",
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
				async: {
					type: "boolean",
					description:
						"true = 异步派发：毫秒级返回 taskId，不阻塞你，执行/验收/返工/升档全部在后台照常跑；" +
						"之后用 pi_result(taskId) 取完整结果。适合『派完就继续干自己的活』或一次派多个任务。" +
						"默认 false（同步等结果，与旧行为一致）。",
				},
			},
			required: ["task"],
		},
	},
	{
		name: "pi_status",
		description: [
			"查看所有 pi_execute 任务的实时状态表：taskId、模型、状态、耗时、当前正在调用的工具、工具调用数。",
			"含两节：tasks = 正在跑的（含排队的）；asyncTasks = 异步派发的（派发即返回的那些，完成后用 pi_result 取结果）。",
			"想在等待时向用户汇报进度、或想确认某个 taskId 是否还在跑时调用。",
		].join("\n"),
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "pi_result",
		description: [
			"取回**异步任务**（pi_execute 带 async=true 派发的）的最终结果。",
			"任务还在跑 → 返回进度（当前阶段/当前工具），可加 waitMs 就地等一会；",
			"任务已完成 → 返回完整结果（含验收结论、证据链、返工/升档轨迹——与同步模式一字不差）。",
			"结果存在内存 + 磁盘，**跨会话/进程重启也能取回**。",
			"",
			'例：pi_result(taskId="t-abc123")  或  pi_result(taskId="t-abc123", waitMs=120000)',
			"注意：同步派发的任务结果在 pi_execute 返回时就已经给你了，不需要用本工具。",
		].join("\n"),
		inputSchema: {
			type: "object",
			properties: {
				taskId: { type: "string", description: "异步任务的 taskId（来自 pi_execute(async=true) 的返回，或 pi_status 的 asyncTasks 一节）。" },
				waitMs: {
					type: "number",
					description: "可选：任务还在跑时就地等待的毫秒数（1–600000，默认 0=不等，立刻返回进度）。",
				},
				purge: { type: "boolean", description: "可选：取完后从内存表移除（磁盘记录仍按最近 200 个滚动保留）。默认 false。" },
			},
			required: ["taskId"],
		},
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
	// 异步任务视图（2026-10-06）：与节点表并列——它才是"派完就走"的入口
	const asyncRows = [...asyncTasks.values()].map((st) => ({
		taskId: st.taskId,
		model: st.modelHint || "-",
		status: st.status === "running" ? `running·${st.phase || ""}` : st.status,
		elapsedSec: Math.round(((st.finishedAt || Date.now()) - st.startedAt) / 1000),
		resultReady: !!st.resultText,
	}));
	return {
		active,
		maxConcurrent: MAX_CONCURRENT,
		note: "本机 8GB VRAM，同时只跑一个本地模型；多任务自动排队。异步任务见 asyncTasks 一节（派发即返回，完成后用 pi_result 取结果）。",
		total: rows.length + queued.length,
		running: rows.filter((r) => r.status === "running").length,
		queued: queued.length,
		tasks: rows,
		queue: queued,
		asyncTasks: asyncRows,
	};
}

/** 在指定模型上跑一次（不含回退逻辑）。返回 {res, node}。 */
async function runOnce({ taskId, prompt, workdir, m, timeoutMs, excludeTools, allowTools, onNode }) {
	const node = new PiNode({
		taskId,
		cwd: workdir,
		provider: m.provider,
		model: m.model,
		excludeTools,
		allowTools,
	});
	nodes.set(taskId, node);
	// 异步模式的钩子：把当前节点暴露给调用方（取消时要能中止它）
	if (typeof onNode === "function") {
		try {
			onNode(node);
		} catch {
			/* 钩子异常不影响任务 */
		}
	}
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

async function executeCore(args, ctl = {}) {
	const taskId = ctl.taskId || `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
	// 异步模式的三个钩子：取消探测 / 阶段上报 / 节点追踪。同步模式全部为空操作。
	const checkCancel = ctl.isCancelled || (() => false);
	const setPhase = ctl.onPhase || (() => {});
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

	const timeoutMs = args.timeoutMs || 600000;
	// 拍「前」快照：用来证明到底改了什么，而不是相信模型自述
	const before = verifyCmd || scope ? snapshot(workdir) : null;

	// 取消检查点 ①：开工前
	if (checkCancel()) throw cancelledError(taskId);
	setPhase("执行中（模型干活）");
	let attempt = await runOnce({ taskId, prompt, workdir, m, timeoutMs, excludeTools, onNode: ctl.onNode });

	// —— 自动回退 ——
	// 触发条件：① 主模型工具调用退化 ② 主模型引擎没起（你一次只跑一个引擎，
	// 这时若备选引擎在线就该顶上）。绝不交付假成功，也绝不因为换模型白等一轮。
	let fallbackNote = "";
	const wantFallback = !attempt.error && args.noFallback !== true && (needsFallback(attempt.res) || attempt.res?.status === "unreachable");
	if (wantFallback) {
		const chain = FALLBACK_CHAIN[primaryAlias] || [];
		for (const alt of chain) {
			if (checkCancel()) throw cancelledError(taskId);
			const altM = resolveModel(alt);
			if (!altM || altM.provider === m.provider) continue;
			// 引擎没起的情况：只有备选真的在线才值得重试
			if (attempt.res?.status === "unreachable" && !(await isEngineUp(alt))) continue;

			const why =
				attempt.res?.status === "unreachable"
					? `主力模型 ${primaryAlias} 的引擎未启动`
					: `主力模型 ${primaryAlias} 本轮工具调用退化（输出了 <​tool_call> 文本但未真正执行）`;
			fallbackNote = `\n\n♻️ ${why}，已自动改用 ${alt} 重跑。`;
			setPhase(`回退重跑（${alt}）`);
			attempt = await runOnce({ taskId: taskId + "-fb", prompt, workdir, m: altM, timeoutMs, excludeTools, onNode: ctl.onNode });
			if (!attempt.error && attempt.res?.status === "completed" && !attempt.res.toolCallDegraded) {
				m = altM;
				break;
			}
			fallbackNote = `\n\n♻️ ${why}，改用 ${alt} 后仍未成功。`;
		}
	}

	if (checkCancel()) throw cancelledError(taskId);

	if (attempt.error) {
		return text(
			`❌ 任务失败（${taskId}）：${attempt.error}` +
				(attempt.stderr ? `\n\nstderr:\n${attempt.stderr}` : "") +
				(attempt.error === "cancelled" ? "" : "\n\n提示：确认对应模型引擎已启动，且显存足够（本机 8GB 同时只宜跑一个）。"),
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
		if (checkCancel()) throw cancelledError(taskId);
		setPhase(round === 1 ? "验收中" : `验收第 ${round} 轮`);

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
		if (checkCancel()) throw cancelledError(taskId);
		setPhase(`返工第 ${round + 1} 轮（模型 ${aliasOf(m)}）`);
		const re = await runOnce({
			taskId: `${taskId}-rw${round}`,
			prompt: reworkPrompt,
			workdir,
			m,
			timeoutMs,
			excludeTools,
			onNode: ctl.onNode,
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

/**
 * 异步派发（2026-10-06）：毫秒级返回 taskId，验收/返工/升档在后台照常跑。
 *
 * 设计要点：
 *   · 后台任务跑的还是 executeCore —— 验收链与同步模式**完全同一条代码**，
 *     不存在"异步模式验收打了折"的问题；
 *   · 结果写内存表 + 落盘，pi_result 随时可取（进程重启也能捞回）；
 *   · 取消走 pi_cancel：置标记 + 中止当前节点，executeCore 在检查点抛 cancelled。
 */
function dispatchAsync(args) {
	const taskId = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
	const state = {
		taskId,
		task: args.task || "",
		status: "running",
		phase: "已派发，准备启动",
		modelHint: args.model || "(按任务类型路由)",
		startedAt: Date.now(),
		finishedAt: null,
		resultText: null,
		currentNodeId: null,
		cancelled: false,
	};
	asyncTasks.set(taskId, state);
	evictAsyncTasks();
	pruneTaskFiles();
	persistTask(state);

	// fire-and-forget：不 await。用 .catch 兜住所有异常，绝不让它变成 unhandled rejection。
	executeCore(args, {
		taskId,
		onPhase: (p) => {
			state.phase = p;
			persistTask(state);
		},
		onNode: (node) => {
			state.currentNodeId = node.taskId;
			state.modelHint = `${node.provider}/${node.model}`;
			persistTask(state);
		},
		isCancelled: () => state.cancelled,
	})
		.then((out) => {
			const txt = out?.content?.[0]?.text ?? "(无结果文本)";
			state.resultText = txt;
			// 结果头本身带结论（✅/❌），据此定终态；被取消则优先按取消算
			state.status = state.cancelled ? "cancelled" : txt.startsWith("❌") ? "failed" : "completed";
		})
		.catch((err) => {
			state.status = err?.cancelled ? "cancelled" : "failed";
			state.resultText = err?.cancelled
				? `🛑 任务 ${taskId} 已被取消（验收链未跑完）。`
				: `❌ 后台任务异常：${String(err).slice(0, 500)}`;
		})
		.finally(() => {
			state.finishedAt = Date.now();
			persistTask(state);
		});

	return text(
		`🚀 任务已派发（异步）｜taskId: ${taskId}\n` +
			`   模型：${state.modelHint}` +
			(args.verify ? `\n   验收：\`${String(args.verify).slice(0, 120)}\`（含返工/升档，后台自动跑）` : "") +
			`\n\n**你现在就可以继续干别的活**，不必等它。之后：\n` +
			`   · 取结果：pi_result(taskId="${taskId}")（没完成会给进度；结果会存住，跨会话也能取）\n` +
			`   · 看全部：pi_status（asyncTasks 一节）\n` +
			`   · 要停：pi_cancel(taskId="${taskId}")`,
	);
}

/** pi_result 的实现：内存优先、磁盘兜底；跑着可等可选。 */
async function piResult(args) {
	const taskId = String(args.taskId || "").trim();
	if (!taskId) return text("需要 taskId——异步任务的 taskId 来自 pi_execute(async=true) 的返回，或 pi_status 的 asyncTasks 一节。");

	let st = asyncTasks.get(taskId);
	let fromDisk = false;
	if (!st) {
		st = loadTaskFromDisk(taskId);
		fromDisk = true;
		if (!st) {
			return text(
				`未找到任务 ${taskId}。\n` +
					`· 异步任务的 taskId 来自 pi_execute(async=true) 的返回；\n` +
					`· 同步任务（默认）的结果在派发调用时就返回了，不在这里；\n` +
					`· 磁盘记录只保留最近 200 个。`,
			);
		}
	}

	// 可选就地等待（只在同一进程持有任务时有意义；上限 10 分钟）
	const waitMs = Math.min(Number(args.waitMs) || 0, 600000);
	if (st.status === "running" && waitMs > 0 && !fromDisk) {
		const deadline = Date.now() + waitMs;
		while (st.status === "running" && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 1000));
		}
	}

	if (st.status === "running") {
		const secs = Math.round(((st.finishedAt || Date.now()) - st.startedAt) / 1000);
		const node = st.currentNodeId ? nodes.get(st.currentNodeId) : null;
		const where = fromDisk ? `（磁盘记录，由 PID ${st.pid} 持有——若该进程已退出则任务可能已中断）` : "";
		return text(
			`⏳ 任务 ${taskId} 仍在运行（已 ${secs}s）｜阶段：${st.phase || "-"}` +
				(node?.currentTool ? `｜当前工具：${node.currentTool}` : "") +
				where +
				`\n完成后再次调用 pi_result(taskId="${taskId}")，或加 waitMs=毫秒数 就地等一会（上限 600000）。`,
		);
	}

	const body = st.resultText || "(无结果文本)";
	if (args.purge === true && !fromDisk) asyncTasks.delete(taskId);
	return text(`【异步任务 ${taskId}｜${st.status}｜${st.modelHint || "-"}】\n\n${body}`);
}

/** MCP 统一入口：async=true 走异步派发，其余与旧行为完全一致。 */
async function execute(args) {
	if (args?.async === true) return dispatchAsync(args);
	return executeCore(args);
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
			if (name === "pi_result") return await piResult(args || {});
			if (name === "pi_cancel") {
				// ② 异步任务：置取消标记（executeCore 在检查点抛 cancelled）+ 立即中止当前节点
				const ast = asyncTasks.get(args.taskId);
				if (ast) {
					if (ast.status !== "running") {
						return text(`任务 ${args.taskId} 已结束（${ast.status}），无需取消。可用 pi_result 取结果。`);
					}
					ast.cancelled = true;
					ast.phase = "取消中…";
					persistTask(ast);
					const an = ast.currentNodeId ? nodes.get(ast.currentNodeId) : null;
					if (an) {
						an.status = "cancelled";
						// 先 kill（立即断开，让 run() 的 settle 等待者被唤醒），
						// abort 命令只是尽力礼貌通知——绝不能 await 它：那条命令自带 10s 超时，
						// 串行等待会让"取消"这个动作本身卡 10 秒（实测踩过）。
						an.kill();
						an.cancel().catch(() => {});
					}
					return text(`已取消异步任务 ${args.taskId}（当前节点已中止，验收链不会再继续）。用 pi_result 取回完整状态。`);
				}
				// ② 排队中的任务：出队即可，不必等它拿到槽位
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
		const isAsync = flag("async") === "true";
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
			async: isAsync,
		});
		console.log(out.content[0].text);
		// 异步模式：CLI 进程退出后后台任务也随之结束（进程绑定），故提示用 --wait 或走 MCP
		if (isAsync) {
			const m = out.content[0].text.match(/taskId: (t-\S+)/);
			if (m) {
				const waitMs = flag("wait") ? Number(flag("wait")) : 0;
				const r = await piResult({ taskId: m[1], waitMs: waitMs || 600000 });
				console.log("\n" + r.content[0].text);
			}
		}
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