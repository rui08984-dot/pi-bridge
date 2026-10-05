/**
 * MCP 协议冒烟测试：只验证 server 能列出工具，不派任何活、不加载模型。
 * 走标准 stdio JSON-RPC，与 MCP 客户端的调用路径完全一致。
 *
 * 平台无关：用本文件相对路径定位 server.js，不依赖任何安装位置。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const NODE = process.execPath;
const SERVER = join(dirname(fileURLToPath(import.meta.url)), "server.js");

const child = spawn(NODE, [SERVER], {
	stdio: ["pipe", "pipe", "pipe"],
	windowsHide: true,
	env: { ...process.env }, // 配置由 config.js 统一解析，这里不再注入个人路径
});

let buf = "";
const seen = [];
child.stdout.on("data", (b) => {
	buf += b.toString();
	let i;
	while ((i = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, i).trim();
		buf = buf.slice(i + 1);
		if (line) {
			try {
				seen.push(JSON.parse(line));
			} catch {
				/* ignore */
			}
		}
	}
});
child.stderr.on("data", (b) => process.stderr.write("[srv] " + b.toString()));

const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");

setTimeout(() => {
	send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
		protocolVersion: "2024-11-05",
		capabilities: {},
		clientInfo: { name: "smoke", version: "1.0" },
	} });
}, 300);

setTimeout(() => {
	send({ jsonrpc: "2.0", method: "notifications/initialized" });
	send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
}, 900);

setTimeout(() => {
	const init = seen.find((m) => m.id === 1);
	const tools = seen.find((m) => m.id === 2);
	console.log("=== initialize ===");
	console.log(init ? `✅ ${init.result?.serverInfo?.name} v${init.result?.serverInfo?.version}` : "❌ 无响应");
	console.log("\n=== tools/list ===");
	if (tools?.result?.tools) {
		console.log(`✅ 暴露 ${tools.result.tools.length} 个工具：`);
		for (const t of tools.result.tools) {
			const req = t.inputSchema?.required || [];
			console.log(`   - ${t.name}(${req.join(",") || "无必填"})`);
		}
	} else {
		console.log("❌ 未拿到工具列表");
	}
	child.kill();
	process.exit(tools?.result?.tools ? 0 : 1);
}, 2600);
