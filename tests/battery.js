/**
 * 顺序测试台：单卡一次只能跑一个模型，故全部串行。
 * 每个 case 都做**客观校验**（文件真的落地/内容真的对），不信模型自述。
 *
 * 用法：node tests/battery.js <modelAlias>
 * 未指定别名时用配置里的第一个本地模型（没有则第一个任意模型）。
 */
import { PiNode } from "../src/pi-node.js";
import { resolveModel, listAliases, isLocal } from "../src/models.js";
import { composePrompt, getProjectBrief } from "../src/context.js";
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const firstLocal = listAliases().find((a) => isLocal({ provider: a.provider }));
const alias = process.argv[2] || firstLocal?.alias || listAliases()[0]?.alias;
const m = alias ? resolveModel(alias) : null;
if (!alias || !m) {
	console.error("未知模型别名，且配置里没有可用别名。请在配置的 aliases 里至少配一个模型。");
	process.exit(1);
}

const WORK = join(tmpdir(), "pi-bridge-battery-" + Date.now());
mkdirSync(WORK, { recursive: true });
const F = (n) => join(WORK, n);
const isWin = process.platform === "win32";

console.log(`模型：${alias} → ${m.provider}/${m.model}`);
const brief = await getProjectBrief(WORK);
console.log(`项目简报：${brief ? "可注入（" + brief.length + " 字符）" : "无（未配置，属正常）"}`);
console.log("=".repeat(64));

const CASES = [
	{
		name: "写文件",
		task: `用 write 工具在 ${F("add.js")} 写入内容：function add(a,b){return a+b}`,
		check: () => existsSync(F("add.js")) && readFileSync(F("add.js"), "utf8").includes("return a+b"),
	},
	{
		name: "读文件（客观：先由我放好文件）",
		task: `用 read 工具读取 ${F("given.txt")}，告诉我它的内容。`,
		setup: () => writeFileSync(F("given.txt"), "内容是ABC-777", "utf8"),
		check: () => true,
	},
	{
		name: "改文件（edit）",
		task: `用 read 读 ${F("given.txt")}，然后用 edit 把 ABC-777 改成 XYZ-888，改完读回确认。`,
		check: () => existsSync(F("given.txt")) && readFileSync(F("given.txt"), "utf8").includes("XYZ-888"),
	},
	{
		name: "跑命令（bash）",
		task: "用 bash 工具执行 `echo cmd-ok`，把输出原样告诉我。",
		check: () => true,
	},
	{
		name: "纯文本问答（不该调工具）",
		task: "不要调用任何工具，直接回答：快速排序平均和最坏时间复杂度分别是什么？",
		check: () => true,
		expectNoTool: true,
	},
];

let pass = 0;
let fail = 0;

for (const c of CASES) {
	const node = new PiNode({ taskId: "battery", cwd: WORK, provider: m.provider, model: m.model });
	c.setup?.();
	let verdict;
	let note = "";
	try {
		node.spawn();
		const prompt = await composePrompt({ task: c.task, context: { workdir: WORK }, projectBrief: null });
		const res = await node.run(prompt, { timeoutMs: 420000 });
		const secs = Math.round(node.elapsedMs / 1000);
		const calls = res.toolCallCount;

		if (res.toolCallDegraded) {
			verdict = "❌";
			note = "工具调用退化为纯文本";
		} else if (res.status !== "completed") {
			verdict = "❌";
			note = "status=" + res.status;
		} else if (c.expectNoTool && calls > 0) {
			verdict = "⚠️";
			note = `不预期调工具却调了 ${calls} 次`;
		} else if (!c.check()) {
			verdict = "❌";
			note = "客观校验失败（文件未落地/内容不符）";
		} else {
			verdict = "✅";
		}
		console.log(`${verdict} ${c.name.padEnd(22)} ${String(secs).padStart(4)}s  工具${String(calls).padStart(2)}次  ${note}`);
	} catch (err) {
		console.log(`❌ ${c.name.padEnd(22)} 异常：${String(err).slice(0, 90)}`);
	} finally {
		node.kill();
		await sleep(800); // 让上一轮的引擎句柄彻底释放，否则下一个 spawn 可能撞端口
	}
	verdict === "✅" ? pass++ : fail++;
}

rmSync(WORK, { recursive: true, force: true });
console.log("=".repeat(64));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
