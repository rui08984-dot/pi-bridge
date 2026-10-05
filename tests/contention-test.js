/**
 * 竞争测试：另一个客户端（模拟 Pi TUI）正占着本地引擎时，桥接层还能不能派活。
 * 前提是引擎的 --max-concurrency 是 1（只服务一个客户端）——此时桥接派活应排队等待而非失败。
 *
 * 用法：node tests/contention-test.js [modelAlias]
 * 需要一个本地别名 + 配好 probeUrls（或引擎默认端口）——否则会明确跳过。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { listAliases, isLocal, PROBE_URLS } from "../src/models.js";

const firstLocal = listAliases().find((a) => isLocal({ provider: a.provider }));
const alias = process.argv[2] || firstLocal?.alias;
const probeUrl = alias ? PROBE_URLS[alias] : null;

if (!alias) {
	console.log("⏭️  跳过：配置里没有本地模型别名。");
	process.exit(0);
}
if (!probeUrl) {
	console.log(`⏭️  跳过：未给 ${alias} 配 probeUrls（无法定位它的引擎端口，也就无法模拟占位）。`);
	console.log("    想跑这个测试：在配置里加 probeUrls，如 {\"" + alias + "\": \"http://127.0.0.1:PORT/v1/models\"}。");
	process.exit(0);
}

// 从 probeUrl 推出 /v1/chat/completions 端点
const base = probeUrl.replace(/\/v1\/models\/?$/, "");
const chatUrl = base + "/v1/chat/completions";
const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "src", "server.js");

// 先模拟「另一个客户端正占着这个引擎」：压一个长请求
const hogCode = `
import json,urllib.request,time
req={"model":"${firstLocal.model}","messages":[{"role":"user","content":"写一篇800字的中文短文，题目《秋》。"}],
     "max_tokens":900,"temperature":0.3}
r=urllib.request.Request("${chatUrl}",data=json.dumps(req).encode(),
  headers={"Content-Type":"application/json","Authorization":"Bearer local"})
t=time.time()
try:
    json.load(urllib.request.urlopen(r,timeout=300))
    print("占位请求完成 %.1fs"%(time.time()-t))
except Exception as e:
    print("占位请求失败:",str(e)[:200])
`;
const hog = spawn(process.platform === "win32" ? "python" : "python3", ["-c", hogCode], { windowsHide: true });
hog.stdout.on("data", (b) => process.stdout.write("  [占位客户端] " + b.toString()));
hog.stderr.on("data", (b) => process.stdout.write("  [占位错误] " + b.toString().slice(0, 200)));

await new Promise((r) => setTimeout(r, 2500)); // 让它先占住槽位

console.log("→ 槽位已被占用，现在用桥接层派活…");
const t0 = Date.now();
const p = spawn(process.execPath, [SERVER, "exec", "回答：1+1等于几？只输出数字。", `--model=${alias}`, "--ctx=false"], {
	cwd: join(HERE, ".."),
	stdio: ["ignore", "pipe", "pipe"],
	windowsHide: true,
	env: { ...process.env },
});
let out = "";
p.stdout.on("data", (b) => (out += b.toString()));
p.stderr.on("data", (b) => (out += b.toString()));

const killer = setTimeout(() => {
	p.kill();
	hog.kill();
	console.log(`\n结论：桥接层派活 ${Math.round((Date.now() - t0) / 1000)}s 仍未返回 → 被引擎的单并发限制卡住了`);
	process.exit(0);
}, 150000);

p.on("exit", () => {
	clearTimeout(killer);
	hog.kill();
	console.log(`\n桥接层派活返回，耗时 ${Math.round((Date.now() - t0) / 1000)}s`);
	console.log(out.replace(/^\[pi-bridge\].*$/gm, "").slice(0, 400));
	process.exit(0);
});
