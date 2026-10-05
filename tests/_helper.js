/**
 * 测试共享 helper —— 让集成测试不依赖任何个人环境。
 *
 * 关键点：
 *   - server.js / 模型别名 / 工作目录全部动态解析
 *   - 集成测试需要**真实模型端点**，所以请在配置里给模型起可测的名字；
 *     这些测试会从你的 aliases 里挑「本地第一个」「云端第一个」来用。
 *   - 没配对应类型的模型时，测试会明确跳过而不是报错。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { MODEL_ALIASES, isLocal } from "../src/models.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SERVER = join(HERE, "..", "src", "server.js");
export const NODE = process.execPath;

/** 临时工作目录（每次测试独立，测完即弃）。 */
export function tempWorkdir(prefix = "pi-bridge-test-") {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** 从配置里挑一个本地模型别名（没配返回 null）。 */
export function pickLocalAlias() {
	return Object.keys(MODEL_ALIASES).find((a) => isLocal(MODEL_ALIASES[a])) || null;
}

/** 从配置里挑一个非本地（云端/网关）模型别名（没配返回 null）。 */
export function pickCloudAlias() {
	return Object.keys(MODEL_ALIASES).find((a) => !isLocal(MODEL_ALIASES[a])) || null;
}

/**
 * 起一个 MCP server 子进程，返回 { child, seen, rpc, call, waitFor, send, kill }。
 * 走标准 stdio JSON-RPC，与真实 MCP 客户端调用路径一致。
 */
export function spawnServer({ quiet = true } = {}) {
	const child = spawn(NODE, [SERVER], {
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
		env: { ...process.env }, // 配置由 config.js 解析，不在此注入个人路径
	});
	const seen = [];
	let buf = "";
	child.stdout.on("data", (b) => {
		buf += b.toString();
		let i;
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i).trim();
			buf = buf.slice(i + 1);
			if (line) {
				try {
					seen.push(JSON.parse(line));
				} catch {}
			}
		}
	});
	child.stderr.on("data", (b) => {
		if (!quiet) process.stderr.write("[srv] " + b.toString());
	});

	const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
	const rpc = (id, method, params) => send({ jsonrpc: "2.0", id, method, params });
	const call = (id, name, args) => rpc(id, "tools/call", { name, arguments: args });
	const waitFor = (id, ms = 300000) =>
		new Promise((res) => {
			const t0 = Date.now();
			const iv = setInterval(() => {
				const m = seen.find((x) => x.id === id);
				if (m) {
					clearInterval(iv);
					res(m);
				} else if (Date.now() - t0 > ms) {
					clearInterval(iv);
					res(null);
				}
			}, 250);
		});

	const init = () => {
		setTimeout(() => {
			rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } });
			setTimeout(() => send({ jsonrpc: "2.0", method: "notifications/initialized" }), 500);
		}, 300);
	};

	return { child, seen, send, rpc, call, waitFor, init, kill: () => child.kill() };
}

/** 取 MCP 工具返回的文本。 */
export function textOf(m) {
	return m?.result?.content?.[0]?.text ?? "(无响应)";
}
