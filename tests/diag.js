/**
 * 诊断：单任务，打印完整事件序列 + 模型原始输出。
 * 用途：查清「工具调用数为 0」到底是模型没调、还是统计方式有问题。
 *
 * 用法：node tests/diag.js [modelAlias]
 */
import { PiNode } from "../src/pi-node.js";
import { resolveModel, listAliases, isLocal } from "../src/models.js";
import { composePrompt } from "../src/context.js";
import { mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const firstLocal = listAliases().find((a) => isLocal({ provider: a.provider }));
const alias = process.argv[2] || firstLocal?.alias || listAliases()[0]?.alias;
const m = alias ? resolveModel(alias) : null;
if (!alias || !m) {
	console.error("未知模型别名，且配置里没有可用别名。");
	process.exit(1);
}

const WORK = join(tmpdir(), "pi-bridge-diag-" + Date.now());
mkdirSync(WORK, { recursive: true });
const target = join(WORK, "hello.txt");

const task = `用 write 工具在 ${target} 写入文本「diag-ok」，然后用 read 工具读回确认内容。`;

console.log(`模型 ${alias} → ${m.provider}/${m.model}`);
const node = new PiNode({ taskId: "diag", cwd: WORK, provider: m.provider, model: m.model });
node.spawn();
const prompt = await composePrompt({ task, context: { workdir: WORK }, projectBrief: null });
console.log("--- 发给模型的 prompt ---\n" + prompt + "\n---");

const res = await node.run(prompt, { timeoutMs: 420000 });

console.log("=== 事件序列 ===");
console.log(node.events.map((e) => e.type).filter((t) => !t.startsWith("extension_ui")).join(" → "));

console.log("\n=== 模型最终输出 ===");
console.log(res.finalText || "(空)");

console.log("\n=== 统计 ===");
console.log("status:", res.status, "| 工具调用:", res.toolCallCount, "| token:", JSON.stringify(res.tokens));
console.log("工具轨迹:", JSON.stringify(res.toolCalls, null, 1));

console.log("\n=== 文件落地检查 ===");
console.log(existsSync(target) ? "✅ 文件存在，内容：" + JSON.stringify(readFileSync(target, "utf8")) : "❌ 文件不存在（模型没调 write）");

console.log("\n=== 原始 assistant 消息 ===");
for (const e of node.events) {
	if (e.type === "message_end" && e.message?.role === "assistant") {
		console.log(JSON.stringify(e.message.content, null, 1).slice(0, 900));
	}
}
node.kill();
rmSync(WORK, { recursive: true, force: true });
