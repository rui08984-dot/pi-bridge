/**
 * PiNode —— 单个 Pi RPC 进程的生命周期封装。
 *
 * 协议要点（对照 Pi 官方 docs/rpc.md 实测校正，勿凭记忆改）：
 *   - 字段名是 `message`，**不是** `content`
 *   - 命令带 `id` 才回带 `id` 的 `{"type":"response"}`；事件流无 id
 *   - agent_settled 才是「彻底干完」（agent_end 后可能还有重试/压缩/队列续跑）
 *   - 取消是 `{"type":"abort"}`；运行中追加指令是 steer/follow_up（需streamingBehavior）
 *   - 严格 JSONL：只按 \n 切分。Node readline 会在 U+2028/U+2029 处误切，禁用
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { PI_EXE } from "./config.js";

export class PiNode extends EventEmitter {
	constructor({ taskId, cwd, provider, model = "local-model", thinking = null, excludeTools = null, allowTools = null }) {
		super();
		this.taskId = taskId || `t-${randomUUID().slice(0, 8)}`;
		this.cwd = cwd;
		this.provider = provider;
		this.model = model;
		this.thinking = thinking;
		/**
		 * 工具限制 —— 程序级保证，不靠提示词自觉。
		 * 借鉴 Fusion 的「Lead 不写代码」：explore 模式直接把写工具从进程里拿掉，
		 * 模型想调也调不到。Pi 原生支持 --exclude-tools / --tools。
		 */
		this.excludeTools = excludeTools;
		this.allowTools = allowTools;
		this.proc = null;
		this.buf = "";
		this.pending = new Map(); // id -> {resolve, reject}
		this.events = []; // 事件留档，供结构化返回
		this.status = "queued";
		this.startedAt = null;
		this.endedAt = null;
		this.currentTool = null;
		this.settledWaiters = [];
		this.stderr = "";
		this.modelApplied = false;
		this._seq = 0;
	}

	get elapsedMs() {
		if (!this.startedAt) return 0;
		return (this.endedAt || Date.now()) - this.startedAt;
	}

	spawn() {
		const args = ["--mode", "rpc", "--no-session", "--provider", this.provider, "--model", this.model];
		// 工具白/黑名单：写在命令行，进程一启动就生效，模型无从绕过
		if (this.allowTools?.length) args.push("--tools", this.allowTools.join(","));
		if (this.excludeTools?.length) args.push("--exclude-tools", this.excludeTools.join(","));
		this.proc = spawn(PI_EXE, args, {
			cwd: this.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			env: { ...process.env, NO_PROXY: "*", HTTP_PROXY: "", HTTPS_PROXY: "" },
		});
		this.proc.stdout.on("data", (b) => this._onData(b));
		this.proc.stderr.on("data", (b) => {
			this.stderr = (this.stderr + b.toString()).slice(-4000);
			this.emit("log", b.toString());
		});
		this.proc.on("error", (err) => {
			this.status = "error";
			this.emit("node-error", { taskId: this.taskId, error: String(err) });
		});
		this.proc.on("exit", (code) => {
			// 退出码 134 / -4058 一类 = 运行时申请显存失败（本地大模型加载后余量极小）。
			// 实测踩过：引擎把显存吃满后，pi 进程连启动都起不来，stderr 却是空的——
			// 光看「引擎在线」会被误导，必须专门提示。
			if (code !== 0 && code !== null) {
				this.exitHint =
					code === -4058 || code === 134
						? `pi 进程启动即退出（exit=${code}），这是运行时申请显存失败。` +
						  `本地引擎加载后显存余量不足时就会这样。` +
						  `处理：关掉其它占显存的程序，或换更小的模型/量化档。`
						: null;
			}
			// 非正常收尾（被 cancel/崩溃）时唤醒等待者，避免永久挂起
			if (this.status === "running") this.status = code === 0 ? "completed" : "failed";
			this.endedAt = this.endedAt || Date.now();
			this._wakeSettled();
			this.emit("exit", { taskId: this.taskId, code });
		});
		this.status = "idle";
		this.startedAt = Date.now();
		return this;
	}

	_onData(buf) {
		this.buf += buf.toString();
		let idx;
		while ((idx = this.buf.indexOf("\n")) >= 0) {
			const line = this.buf.slice(0, idx).trim();
			this.buf = this.buf.slice(idx + 1);
			if (!line) continue;
			let msg;
			try {
				msg = JSON.parse(line);
			} catch {
				this.emit("log", `non-json: ${line.slice(0, 200)}`);
				continue;
			}
			if (msg.type === "response" && msg.id && this.pending.has(msg.id)) {
				const p = this.pending.get(msg.id);
				this.pending.delete(msg.id);
				msg.success ? p.resolve(msg) : p.reject(new Error(msg.error || "rpc command failed"));
			} else {
				this._onEvent(msg);
			}
		}
	}

	_onEvent(e) {
		this.events.push(e);
		if (this.events.length > 500) this.events.shift(); // 防无界增长
		switch (e.type) {
			case "agent_start":
				this.status = "running";
				break;
			case "tool_execution_start":
				this.currentTool = e.toolName;
				break;
			case "tool_execution_end":
				this.currentTool = null;
				break;
			case "agent_settled":
				this.status = "completed";
				this.endedAt = this.endedAt || Date.now();
				this._wakeSettled();
				break;
			case "extension_error":
				this.emit("node-error", { taskId: this.taskId, error: e.message || "extension error" });
				break;
		}
		this.emit("pi-event", { taskId: this.taskId, event: e });
	}

	_wakeSettled() {
		const ws = this.settledWaiters.splice(0);
		for (const w of ws) w();
	}

	_send(command, { timeoutMs = 120000 } = {}) {
		const id = `r${++this._seq}`;
		const payload = JSON.stringify({ id, type: command.type, ...command.payload }) + "\n";
		// 引擎没起时 pi 会直接退出，写 stdin 抛 EPIPE——翻译成人话，别把栈喷给用户
		if (this.proc.exitCode !== null) {
			return Promise.reject(new Error(this.exitHint || `pi 进程已退出（exit=${this.proc.exitCode}）。引擎多半没启动。`));
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`rpc timeout: ${command.type}`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (m) => {
					clearTimeout(timer);
					resolve(m);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			});
			this.proc.stdin.write(payload, (err) => {
				if (err) {
					clearTimeout(timer);
					this.pending.delete(id);
					reject(wrapPipeError(err));
				}
			});
		});
	}

	async setModel(provider, model) {
		const r = await this._send({ type: "set_model", payload: { provider, modelId: model } });
		this.provider = provider;
		this.model = model;
		this.modelApplied = true;
		return r.data;
	}

	async sessionStats() {
		const r = await this._send({ type: "get_session_stats", payload: {} }, { timeoutMs: 15000 });
		return r.data;
	}

	/** 派活。返回结构化结果（等agent_settled 或超时）。 */
	async run(prompt, { timeoutMs = 600000 } = {}) {
		if (!this.proc) throw new Error("node not spawned");
		this.status = "running";
		this.startedAt = this.startedAt || Date.now();
		const before = this.events.length;
		try {
			await this._send({ type: "prompt", payload: { message: prompt } }, { timeoutMs: 30000 });
		} catch (err) {
			this.status = "failed";
			throw err;
		}
		await this._waitSettled(timeoutMs);
		return this.result(before);
	}

	_waitSettled(timeoutMs) {
		if (this.status === "completed" && !this.proc || this._settledFlag) return Promise.resolve();
		return new Promise((resolve) => {
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				clearTimeout(t);
				resolve();
			};
			this.settledWaiters.push(finish);
			const t = setTimeout(() => {
				if (done) return;
				done = true;
				this.status = this.status === "cancelled" ? "cancelled" : "timeout";
				this.endedAt = this.endedAt || Date.now();
				this.emit("timeout", { taskId: this.taskId });
				resolve();
			}, timeoutMs);
		});
	}

	/** 结构化结果：最终文本 + 工具调用轨迹 + token 统计。 */
	async result(sinceIdx = 0) {
		const evts = this.events.slice(sinceIdx);
		const toolCalls = evts
			.filter((e) => e.type === "tool_execution_start")
			.map((e) => ({ tool: e.toolName, args: e.args, callId: e.toolCallId }));
		// 记录「尝试过但被拒」的工具——explore 模式下模型仍会尝试 write，
		// 这条证据说明它想写但被程序挡住了（Fusion 的思路：权限是程序保证，不是自觉）。
		const toolDenied = evts
			.filter((e) => e.type === "tool_execution_end" && e.isError)
			.map((e) => ({ tool: e.toolName, callId: e.toolCallId }));
		const toolErrors = toolDenied;

		// 最终文本 = 最后一条 **assistant** 消息的 text 段。
		// 注意：不能取「最后一条任意 role 消息」——那会拿到 user 回显或 system 前导，
		// 实测正是这个 bug 导致结果里出现提示词原文。
		let finalText = "";
		let lastUsage = null;
		for (const e of evts) {
			if (e.type !== "message_end" || !e.message) continue;
			const m = e.message;
			if (m.role === "assistant") {
				const t = extractText(m);
				if (t) finalText = t;
				if (m.usage) {
					lastUsage = {
						input: m.usage.input || 0,
						output: m.usage.output || 0,
						reasoning: m.usage.reasoning || 0,
						total: m.usage.totalTokens || (m.usage.input || 0) + (m.usage.output || 0),
					};
				}
			}
		}

		// token 优先用 assistant消息自带的 usage（--no-session 下 stats 常为空）
		let tokens = lastUsage;
		let contextUsage = null;
		try {
			const stats = await this.sessionStats();
			if (stats?.tokens && (!tokens || !tokens.total)) tokens = stats.tokens;
			contextUsage = stats?.contextUsage || null;
		} catch {
			/* 进程可能已退出，统计拿不到不算失败 */
		}

		// ⚠️ 静默失败探测：模型把工具调用吐成了纯文本（Qwen 原生模板没被解析成结构化调用）。
		// 典型征兆：正文出现 <tool_call> / <parameter=…> 而 toolCallCount 为 0。
		// 此时 agent 会报 completed，但**工具一个都没真跑**——不拦住就是假成功。
		const pseudo = detectPseudoToolCall(finalText);
		if (pseudo && toolCalls.length === 0) {
			this.status = "degraded";
		}

		// ⚠️ 引擎没起时 pi 会静默 settle：无文本、无工具、零 token → 假成功。
		// 实测踩过：报告 completed 但什么都没干。必须显式判失败。
		const noSignal = !finalText && toolCalls.length === 0 && (!tokens || !tokens.total);
		if (noSignal && this.status === "completed") {
			this.status = "unreachable";
		}

		return {
			taskId: this.taskId,
			status: this.status,
			model: `${this.provider}/${this.model}`,
			elapsedMs: this.elapsedMs,
			toolCallCount: toolCalls.length,
			toolCalls,
			toolErrors,
			toolDenied,
			finalText,
			tokens,
			contextUsage,
			toolCallDegraded: pseudo || false,
			hint:
				this.status === "unreachable"
					? `模型零响应（无输出、零 token）。引擎 ${this.provider} 未启动或端口不通——先跑它的启动脚本，或换一个已在线的模型。`
					: null,
		};
	}

	async cancel() {
		if (!this.proc) return;
		this.status = "cancelled";
		try {
			await this._send({ type: "abort", payload: {} }, { timeoutMs: 10000 });
		} catch {
			/* 进程可能已死*/
		}
	}

	kill() {
		try {
			this.proc?.kill();
		} catch {
			/* ignore */
		}
	}
}

/** EPIPE/EPROFS 之类包装成人话。 */
function wrapPipeError(err) {
	const code = err?.code || "";
	if (code === "EPIPE" || code === "ECONNRESET") {
		return new Error("pi 进程已断开（引擎未启动或已崩溃）。请先启动对应模型的引擎。");
	}
	return err;
}

/**
 * 探测「工具调用被当成纯文本吐出来」的情况。
 * 注意正文里常有 U+200B 零宽空格（实测 Bonsai 输出 <tool_call> 就带），
 * 所以匹配要先把零宽字符剥掉，否则正则对不上。
 */
function detectPseudoToolCall(text) {
	if (!text) return null;
	const clean = text.replace(/[-‍﻿]/g, "");
	const m =
		clean.match(/<tool_call>\s*<\s*([a-z_]+)\s*>/i) ||
		clean.match(/<function_calls?>[\s\S]{0,80}?<\s*([a-z_]+)\s*>/i);
	if (!m) return null;
	return {
		tool: m[1],
		reason: "模型把工具调用输出为纯文本（模板未被解析为结构化调用），实际未执行",
		excerpt: clean.slice(0, 200),
	};
}
function extractText(msg) {
	if (!msg) return "";
	if (typeof msg === "string") return msg;
	const c = msg.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		return c
			.filter((b) => b && b.type === "text" && b.text)
			.map((b) => b.text)
			.join("\n")
			.trim();
	}
	if (msg.text) return String(msg.text);
	return "";
}