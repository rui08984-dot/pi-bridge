/**
 * 自检：验证模块加载 + 与真实 pi 二进制的 RPC 握手 + 模型端点存活。
 * 不派活、不改任何状态，纯只读探测。
 *
 * 平台无关：Pi 路径来自配置，模型清单来自你的 aliases 表。
 */
import { PiNode } from "./pi-node.js";
import { listAliases, PROBE_URLS, isEngineUp } from "./models.js";
import { getProjectBrief } from "./context.js";
import { describeConfig, PI_EXE } from "./config.js";

console.log("=== 0. 生效配置 ===");
const cfg = describeConfig();
for (const [k, v] of Object.entries(cfg)) console.log(`  ${k.padEnd(18)} = ${v}`);

console.log("\n=== 1. 模型别名映射 ===");
const aliases = listAliases();
for (const a of aliases) console.log(`  ${a.alias.padEnd(16)} -> ${a.provider} / ${a.model}`);
if (!aliases.length) {
	console.log("  ⚠️ 空表——请检查配置里的 aliases（或内置 defaults.js）");
}

console.log("\n=== 2. 端点存活（配了 probeUrls 才探活）===");
const probeTargets = Object.entries(PROBE_URLS);
if (!probeTargets.length) {
	console.log("  (未配置 probeUrls，跳过——不影响派活，只影响回退时的探活精度)");
} else {
	for (const [alias] of probeTargets) {
		const up = await isEngineUp(alias);
		console.log(`  ${alias.padEnd(16)} ${up ? "✅ 在线" : "⚠️ 未启动"}`);
	}
}

console.log("\n=== 3. 项目简报注入（可选功能）===");
const brief = await getProjectBrief(process.cwd());
console.log(
	brief
		? `  ✅ 取到简报（${brief.length} 字符）首行：${brief.split("\n")[0].slice(0, 60)}`
		: "  ⚠️ 无简报（未配置 srelay / 当前目录无 .sessionrelay —— 属正常，功能不受影响）",
);

console.log("\n=== 4. RPC 握手（真实 pi 进程）===");
if (!PI_EXE) {
	console.log("  ⚠️ 未配置 piExe，跳过握手");
} else {
	const first = aliases[0];
	const node = new PiNode({
		taskId: "selftest",
		cwd: process.cwd(),
		provider: first?.provider || "local-model",
		model: first?.model || "local-model",
	});
	try {
		node.spawn();
		const state = await node._send({ type: "get_state", payload: {} }, { timeoutMs: 20000 });
		console.log(`  ✅ 握手成功  sessionId=${state.data?.sessionId ?? "-"}  streaming=${state.data?.isStreaming}`);
		const models = await node._send({ type: "get_available_models", payload: {} }, { timeoutMs: 20000 });
		const ids = (models.data?.models || []).map((m) => `${m.provider}/${m.id}`);
		console.log(`  ✅ Pi 可见模型 ${ids.length} 个：`);
		for (const i of ids.slice(0, 40)) console.log(`     ${i}`);
	} catch (err) {
		console.log(`  ❌ 握手失败：${String(err).slice(0, 300)}`);
		if (node.stderr) console.log(`     stderr: ${node.stderr.slice(-300)}`);
	} finally {
		node.kill();
	}
}
