/** 打印 AI 实际看到的 tools/list 全文，用于评估描述质量与 token 占用。 */
import { spawnServer, textOf } from "./_helper.js";

const s = spawnServer();
s.init();

setTimeout(() => s.rpc(2, "tools/list", {}), 800);

setTimeout(() => {
	const r = s.seen.find((x) => x.id === 2);
	if (!r) {
		console.log("无响应");
		process.exit(1);
	}
	for (const t of r.result.tools) {
		console.log("═".repeat(70));
		console.log(`工具名: ${t.name}`);
		console.log("─".repeat(70));
		console.log(t.description);
		console.log("─".repeat(70));
		console.log("参数:");
		for (const [k, v] of Object.entries(t.inputSchema.properties || {})) {
			const req = (t.inputSchema.required || []).includes(k) ? " [必填]" : "";
			console.log(`  ${k}${req}`);
			for (const line of String(v.description || "").split("\n")) console.log(`      ${line}`);
		}
		console.log();
	}
	// 粗略估算 token 占用
	const raw = JSON.stringify(r.result.tools);
	console.log("═".repeat(70));
	console.log(`schema 总字符数: ${raw.length}（约 ${Math.round(raw.length / 2.2)} tokens，每轮都要读）`);
	s.kill();
	process.exit(0);
}, 3000);
