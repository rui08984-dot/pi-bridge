/**
 * 验收层 —— 借鉴 DSH Fusion 的「真实验收 + 证据链 + 返工」设计。
 *
 * 要解决的问题：本地量化模型会说「我做完了」，但工具调用可能退化、
 * 可能只改了一半、可能压根没执行文件操作。**光听它自述不算数。**
 *
 * 全部在桥接层实现，不改 Pi 一行代码。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { VERIFY_SHELL, VERIFY_SHELL_ARGS } from "./config.js";

const execFileAsync = promisify(execFile);

/**
 * 跑验收命令。退出码 0 = 通过。任何异常都算不通过（宁严勿松）。
 *
 * 跨平台：Windows 走 cmd.exe /d /s /c，类 Unix 走 /bin/sh -c。
 * 命令里可以用各自平台的语法（Windows: `if exist`；POSIX: `test -f`）。
 *
 * ★★ Windows 引号问题：已**根治**，不再是限制（2026-10-06）★★
 *
 * 旧版在这里留了一段「实测坑」的规避建议（别用引号 / 用 `cd /d "目录" &&`）。
 * 那是绕路，不是修路 —— 后果是**验收命令一写带引号的路径就被误判**：
 *   · 假失败：`if exist "有空格 的路径"` 文件明明在，却恒定 exit 1
 *     ⇒ 模型交出的成果被误判成没做，白白触发返工
 *   · 假通过（更危险）：`node -e "process.exit(3)"` 明明该失败，却报通过
 *     ⇒ 因为引号被破坏后 Node 收到的是字符串字面量 `"process.exit(3)"`
 *        ——合法 JS、什么都不做、退出 0。一道该拦错误门，反过来给错误放行。
 *
 * 根因：Windows 上 Node 按 MSVCRT 规则给参数加引号/转义（`"` → `\"`），
 *   而 **cmd.exe 不认 `\"`**，命令里的引号被破坏。调用形如
 *   `execFile(cmd, ["/d","/s","/c", command])` —— cmd 的 /s 规则是
 *   「整串以引号开头就剥掉首尾引号」，命令**内部**的引号没人保护。
 *
 * 修法（两条缺一不可，实测缺一即错）：
 *   ① 整条命令**再包一层引号** —— 配合 /s 的剥离规则，内部引号才活下来；
 *   ② `windowsVerbatimArguments: true` —— 让 Node 原样传参、不做转义。
 *
 * 实测（13 例对照，见仓库 tests/verify-unit.js 的「1b」段）：
 *   旧写法 7/13 ｜ 只加 ② 12/13（命令以引号开头那类仍错）｜ ①+② **13/13**
 *
 * ⚠️ 只在 shell 确实是 cmd.exe 时才套引号 —— POSIX 的 sh -c 本来就不用它，
 *    硬套反而会多一层语法错误。同理 windowsVerbatimArguments 在 Unix 上是空操作，
 *    一并按平台收口，免得有人把 Windows 的 verifyShell 配成 bash 时踩雷。
 */
export async function runVerify(command, cwd, timeoutMs = 120000) {
	if (!command) return null;
	const viaCmd = process.platform === "win32" && /(^|[\\/])cmd(\.exe)?$/i.test(VERIFY_SHELL);
	try {
		const args = viaCmd ? [...VERIFY_SHELL_ARGS, '"' + command + '"'] : [...VERIFY_SHELL_ARGS, command];
		const opts = {
			cwd,
			timeout: timeoutMs,
			windowsHide: true,
			maxBuffer: 8 * 1024 * 1024,
		};
		if (viaCmd) opts.windowsVerbatimArguments = true; // 不让 Node 转义引号
		const { stdout, stderr } = await execFileAsync(VERIFY_SHELL, args, opts);
		const out = ((stdout || "") + (stderr || "")).trim();
		return { command, passed: true, exitCode: 0, output: out.slice(-4000) };
	} catch (err) {
		return {
			command,
			passed: false,
			exitCode: err.code ?? -1,
			output: ((err.stdout || "") + (err.stderr || "") + (err.message || "")).trim().slice(-4000),
		};
	}
}

const SKIP_DIRS = new Set([".git", "node_modules", ".sessionrelay", "__pycache__", ".venv", "dist", ".cache", ".scratch", ".next", ".nuxt", ".turbo", ".parcel-cache"]);
// 注意：不跳过所有点开头目录！只跳过上面这些噪声目录。
// 否则「在 .某目录/ 里改了文件」会被误报成「实际没有改动任何文件」（实测踩过）。
const SKIP_FILES = new Set([".DS_Store", "Thumbs.db"]);

/**
 * 拍快照：记录工作目录下所有文件的内容指纹。
 * 用来在任务前后做diff，得出「模型到底改了什么」——这是 Fusion 的证据链。
 */
export function snapshot(root, { maxFiles = 4000 } = {}) {
	const map = new Map();
	const walk = (dir, depth = 0) => {
		if (depth > 6 || map.size >= maxFiles) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (map.size >= maxFiles) return;
			if (SKIP_FILES.has(e.name)) continue;
			const full = join(dir, e.name);
			if (e.isDirectory()) {
				if (SKIP_DIRS.has(e.name)) continue;
				walk(full, depth + 1);
			} else if (e.isFile()) {
				try {
					const st = statSync(full);
					// 太大（会话日志/构建产物）不参与，省开销
					if (st.size > 4 * 1024 * 1024) continue;
					map.set(full, `${st.size}:${st.mtimeMs}`);
				} catch {}
			}
		}
	};
	walk(root);
	return map;
}

/** 对比两个快照 → { created, modified, deleted } */
export function diffSnapshots(before, after) {
	const created = [];
	const modified = [];
	const deleted = [];
	for (const [f, sig] of after) {
		if (!before.has(f)) created.push(f);
		else if (before.get(f) !== sig) modified.push(f);
	}
	for (const f of before.keys()) if (!after.has(f)) deleted.push(f);
	return { created, modified, deleted };
}

/**
 * 范围约束：检查改动是否越界。
 * Fusion 的 allowedPaths —— 只能限定范围，不能靠提示词自觉。
 */
export function checkScope(changedFiles, allowedPaths, root) {
	if (!allowedPaths || !allowedPaths.length) return { ok: true, violations: [] };
	const norm = allowedPaths.map((p) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase());
	const violations = [];
	for (const f of changedFiles) {
		const rel = relative(root, f).replace(/\\/g, "/").toLowerCase();
		const ok = norm.some((a) => rel === a || rel.startsWith(a + "/") || rel.startsWith(a));
		if (!ok) violations.push(rel);
	}
	return { ok: violations.length === 0, violations };
}

/**
 * 生成返工提示：把「验收为什么没过」明确告诉模型，让它改，而不是重写。
 * 借鉴 Fusion 的返工设计——打回给同一个执行者，带具体问题。
 */
export function buildReworkPrompt({ originalTask, verifyResult, scopeResult, evidence, round, maxRounds }) {
	const problems = [];
	if (verifyResult && !verifyResult.passed) {
		problems.push(
			`验收命令 \`${verifyResult.command}\` **未通过**（退出码 ${verifyResult.exitCode}）。\n` +
				`输出：\n\`\`\`\n${(verifyResult.output || "(无输出)").slice(0, 1500)}\n\`\`\``,
		);
	}
	if (scopeResult && !scopeResult.ok) {
		problems.push(`改动越界：这些文件不在允许范围内——\n${scopeResult.violations.map((v) => `  - ${v}`).join("\n")}`);
	}
	if (!problems.length) problems.push("验收未通过，但没有拿到具体输出——请自己跑一遍验收命令确认。");

	return [
		`## 返工（第 ${round}/${maxRounds} 轮）`,
		`上一轮你报告完成了，但**验收没通过**。这不是你的结论说了算，是命令跑出来的。`,
		"",
		"## 原始任务",
		originalTask,
		"",
		"## 必须解决的问题",
		...problems,
		"",
		evidence?.changed?.length
			? `## 你上一轮声称改动的文件\n${evidence.changed.map((f) => `  - ${f}`).join("\n")}\n（若实际没改成，请确认工具真的执行了，而不是只写进回复里）`
			: "## 你上一轮没有改动任何文件\n如果任务本该产出文件，说明工具没有真正执行——请重做。",
		"",
		"只针对上述问题修，不要重写无关部分。修完后简短说明你改了什么。",
	].join("\n");
}

/** 汇总证据链：改了什么 + 跑了什么命令 + 验收结果。 */
export function buildEvidence({ before, after, root, verifyResult, scopeResult, res }) {
	const d = diffSnapshots(before, after);
	const rel = (list) => list.map((f) => relative(root, f).replace(/\\/g, "/")).slice(0, 50);
	const changed = [...d.created, ...d.modified];
	const scope = scopeResult || checkScope(changed, null, root);
	return {
		changed: rel(changed),
		created: rel(d.created),
		modified: rel(d.modified),
		deleted: rel(d.deleted),
		commands: (res?.toolCalls || []).filter((c) => c.tool === "bash").map((c) => c.args?.command).slice(0, 20),
		toolsUsed: [...new Set((res?.toolCalls || []).map((c) => c.tool))],
		toolCallCount: res?.toolCallCount ?? 0,
		verify: verifyResult ? { command: verifyResult.command, passed: verifyResult.passed } : null,
		scopeOk: scope.ok,
		violations: scope.violations,
	};
}
