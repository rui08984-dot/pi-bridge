/**
 * 验收层单元测试（不跑模型，纯逻辑，秒级完成）
 * 覆盖那些「让模型故意犯错才能触发」的路径：越界检测、快照 diff、验收命令判定、升档链。
 *
 * 跨平台：验收命令按平台选语法（Windows `if exist` / POSIX `test -f`）。
 */
import {
	runVerify,
	snapshot,
	diffSnapshots,
	checkScope,
	buildReworkPrompt,
	buildEvidence,
} from "../src/verify.js";
import { escalatedAliasFor, resolveModel, MODEL_ALIASES, isLocal } from "../src/models.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "_ut_" + Date.now());
const isWin = process.platform === "win32";
// ★ 2026-10-06 起，Windows 上**带引号的命令也能用**（runVerify 已根治，见 src/verify.js 文件头）。
//   旧版这里是「别用引号」的规避建议 —— 绕路的代价是：验收命令只要写了带引号的路径，
//   就被恒定判失败（文件明明在），于是模型交出的成果被误判成没做。
//   两个 helper 故意并存：无引号写法与带引号写法**都必须对**，
//   谁哪天再把引号弄坏，下面第 1b 段立刻红。
const existsCmd = (p) => (isWin ? `if exist ${p} (exit 0) else (exit 1)` : `test -f "${p}"`);
const quotedExistsCmd = (p) => (isWin ? `if exist "${p}" (exit 0) else (exit 1)` : `test -f "${p}"`);

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, "allowed"), { recursive: true });
mkdirSync(join(ROOT, "denied"), { recursive: true });

let pass = 0,
	fail = 0;
const ok = (cond, name, extra = "") => {
	cond ? pass++ : fail++;
	console.log(`${cond ? "✅" : "❌"} ${name}${extra ? "  " + extra : ""}`);
};

console.log("=== 1. runVerify 判定（跨平台）===");
writeFileSync(join(ROOT, "exists.txt"), "x");
const r1 = await runVerify(existsCmd("exists.txt"), ROOT);
ok(r1?.passed === true, "存在的文件 → 通过", `exit=${r1?.exitCode}`);
const r2 = await runVerify(existsCmd("nope.txt"), ROOT);
ok(r2?.passed === false, "不存在的文件 → 不通过", `exit=${r2?.exitCode}`);
const r3 = await runVerify(null, ROOT);
ok(r3 === null, "未提供命令 → 返回 null（不验收）");

console.log("\n=== 1b. 带引号 / 内嵌引号的命令（★回归：Windows 曾因 Node 转义引号而误判）===");
// 这一段的由来（2026-10-06 实测）：runVerify 旧写法在 Windows 上把命令里的 `"` 破坏掉，
// 造成两种误判，都是「验收门看起来在工作、实际没在工作」：
//   ① 假失败：`if exist "带空格 的路径"` —— 文件明明存在，却恒定 exit 1
//      （真实影响：多个已产出成果的任务被误判「验收未通过」，白触发返工）
//   ② 假通过：`node -e "process.exit(3)"` —— 明明该失败，却报通过
//      （引号被破坏后 Node 收到的是字符串字面量 `"process.exit(3)"`：合法 JS、什么都不做、退出 0）
// ②比①危险得多：一道该拦错误的门，反过来给错误放行。
writeFileSync(join(ROOT, "has space.txt"), "x");
const q1 = await runVerify(quotedExistsCmd("has space.txt"), ROOT);
ok(q1?.passed === true, "带引号路径 + 文件存在 → 通过（旧版恒判失败）", `exit=${q1?.exitCode}`);
const q2 = await runVerify(quotedExistsCmd("no such file.txt"), ROOT);
ok(q2?.passed === false, "带引号路径 + 文件不存在 → 不通过", `exit=${q2?.exitCode}`);
const q3 = await runVerify('node -e "process.exit(3)"', ROOT);
ok(q3?.passed === false, "内嵌引号命令 exit 3 → 不通过（旧版误判通过）", `exit=${q3?.exitCode}`);
const q4 = await runVerify('node -e "process.exit(0)"', ROOT);
ok(q4?.passed === true, "内嵌引号命令 exit 0 → 通过", `exit=${q4?.exitCode}`);

console.log("\n=== 2. 快照 diff ===");
const s1 = snapshot(ROOT);
writeFileSync(join(ROOT, "allowed", "new.txt"), "a");
writeFileSync(join(ROOT, "denied", "bad.txt"), "b");
const s2 = snapshot(ROOT);
const d = diffSnapshots(s1, s2);
ok(d.created.length === 2, "检测到 2 个新建文件", JSON.stringify(d.created.map((f) => f.split(/[/\\]/).pop())));
ok(d.modified.length === 0, "无修改文件");
rmSync(join(ROOT, "denied", "bad.txt"));
const s3 = snapshot(ROOT);
ok(diffSnapshots(s2, s3).deleted.length === 1, "检测到 1 个删除文件");

console.log("\n=== 3. 点开头目录不再盲区（2026-10-06 修复回归）===");
const dotDir = join(ROOT, ".hidden-out");
mkdirSync(dotDir, { recursive: true });
const s4 = snapshot(ROOT);
writeFileSync(join(dotDir, "in-dot.txt"), "x");
const s5 = snapshot(ROOT);
const dDot = diffSnapshots(s4, s5);
ok(dDot.created.length === 1, "点目录内新文件也能被证据链捕获", JSON.stringify(dDot.created.map((f) => f.split(/[/\\]/).slice(-2).join("/"))));

console.log("\n=== 4. checkScope 越界检测（模型故意犯错才会走到的路径）===");
const changed = [join(ROOT, "allowed", "good.txt"), join(ROOT, "denied", "bad.txt")];
const sc1 = checkScope(changed, ["allowed/"], ROOT);
ok(sc1.ok === false, "改了范围外文件 → 判失败");
ok(sc1.violations.length === 1 && sc1.violations[0].includes("denied"), "精确指出越界文件", JSON.stringify(sc1.violations));
const sc2 = checkScope([join(ROOT, "allowed", "sub", "deep.txt")], ["allowed/"], ROOT);
ok(sc2.ok === true, "范围内嵌套子目录 → 放行");
const sc3 = checkScope(changed, null, ROOT);
ok(sc3.ok === true, "未指定 scope → 不检查");

console.log("\n=== 5. 返工提示包含真实失败原因 ===");
const rp = buildReworkPrompt({
	originalTask: "创建配置文件",
	verifyResult: { command: "npm test", passed: false, exitCode: 1, output: "Error: 3 tests failed" },
	scopeResult: { ok: false, violations: ["src/bad.ts"] },
	evidence: { changed: ["src/ok.ts"] },
	round: 2,
	maxRounds: 2,
});
ok(rp.includes("npm test"), "返工提示带验收命令");
ok(rp.includes("Error: 3 tests failed"), "返工提示带**实际输出**");
ok(rp.includes("src/bad.ts"), "返工提示带越界文件");
ok(rp.includes("第 2/2 轮"), "返工提示标明轮次");

console.log("\n=== 6. 证据链汇总 ===");
const ev = buildEvidence({
	before: s1,
	after: s2,
	root: ROOT,
	verifyResult: { command: "x", passed: true },
	scopeResult: null,
	res: { toolCallCount: 3, toolCalls: [{ tool: "write" }, { tool: "bash", args: { command: "npm test" } }, { tool: "read" }] },
});
ok(ev.toolsUsed.includes("write") && ev.toolsUsed.includes("bash"), "列出用到的工具", ev.toolsUsed.join(","));
ok(ev.commands.length === 1 && ev.commands[0] === "npm test", "提取 bash 命令");
ok(ev.verify?.passed === true, "记录验收结论");

console.log("\n=== 7. 返工升档链 ===");
ok(escalatedAliasFor("cloud_fast") === "cloud_chat", "cloud_fast → cloud_chat");
if (MODEL_ALIASES.bonsai) {
	ok(escalatedAliasFor("bonsai") === "cloud_best", "bonsai → cloud_best（跨侧升档）");
}
ok(escalatedAliasFor("cloud_best") === null || !MODEL_ALIASES[escalatedAliasFor("cloud_best")], "最强档 → 原地重试（无更强）");
ok((escalatedAliasFor("__不存在__") ?? null) === null, "未知别名 → 无升档");

console.log("\n=== 8. 模型解析与闸门约定 ===");
ok(resolveModel("__nope__") === null, "未知别名 → null");
ok(isLocal({ provider: "local-x" }) === true, "local-* 视为本地（进闸门）");
ok(isLocal({ provider: "cloud-x" }) === false, "非 local-* 不限并发");

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
