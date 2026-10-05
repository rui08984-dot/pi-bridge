/**
 * 派活时携带项目上下文 —— **可选功能**。
 *
 * 设计原则：**没有配置就零打扰**。
 *   - 不配 srelayPath → 直接跳过上下文注入，一切照常工作；
 *   - 配了但调用失败 → 静默返回 null，绝不阻塞派活。
 *
 * 因此本包可以独立使用，不依赖任何特定的状态层产品。
 * 如果你的项目里有 `.sessionrelay/` 且配置了 srelay，简报会自动带上；
 * 否则子任务就是一个干干净净的「任务 + 约束 + 验收」提示词。
 *
 * 红线：pi 是 Bun 内核，`process.execPath` = pi.exe，
 * 所以 spawn srelay 必须显式用 node（NODE_BIN），否则简报永远拿不到。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { NODE_BIN, SRELAY_JS, BRIEF_SHARED } from "./config.js";

/** 调用 srelay 命令（未配置 / 失败都返回 null）。 */
function srelay(args, cwd) {
	if (!SRELAY_JS) return null;
	try {
		return execFileSync(NODE_BIN, [SRELAY_JS, ...args], {
			cwd,
			timeout: 4000,
			encoding: "utf8",
			windowsHide: true,
		});
	} catch {
		return null;
	}
}

/**
 * 取项目简报。**任何缺失/异常都返回 null**（宁可不注入也不阻塞派活）。
 * 触发条件（全部满足才注入）：配了 srelayPath + briefShared、工作目录存在且含 `.sessionrelay/`。
 */
export async function getProjectBrief(root) {
	try {
		if (!SRELAY_JS || !BRIEF_SHARED) return null; // 未配置 → 本功能整体关闭
		if (!root || !existsSync(root)) return null;
		if (!existsSync(root + "/.sessionrelay")) return null; // 无记忆层的老项目零打扰
		const mod = await import(pathToFileURL(BRIEF_SHARED).href);
		if (typeof mod.buildBrief !== "function") return null;
		return mod.buildBrief(root, { srelay: (a) => srelay(a, root), dbg: false });
	} catch {
		return null;
	}
}

/**
 * 组装发给 Pi 的完整 prompt：任务 + 上下文 + 约束。
 * 传路径而非内容 —— 让模型自己按需读，避免预填爆上下文（省 token 的关键）。
 */
export async function composePrompt({ task, context, files, constraints, projectBrief, explore, scope, verifyCmd }) {
	const parts = [];

	const brief = projectBrief ?? (await getProjectBrief(context?.workdir));
	if (brief) {
		parts.push(brief, "", "--- 以上为当前项目状态（自动注入，出处可信）。继续任务时与之一致；若与任务描述冲突，以任务描述为准并说明冲突点。---", "");
	}

	if (task) parts.push("## 任务\n" + task);

	if (files?.length) parts.push("## 相关文件（按需自行读取，不要预先全量读入）\n" + files.join("\n"));

	if (constraints) parts.push("## 约束\n" + constraints);

	if (scope?.length) {
		parts.push(
			"## 允许改动的范围（硬约束）\n" +
				scope.map((s) => `- ${s}`).join("\n") +
				"\n只允许修改以上范围内的文件。改到范围外会被判定失败——需要额外文件时请在总结里说明，不要擅自去改。",
		);
	}

	// 验收标准必须**先告诉模型**，否则它不知道要达成什么，验收命令只会白跑。
	// 借鉴 Fusion：验收是「事先冻结」的，不是事后现编的。
	if (verifyCmd) {
		parts.push(
			"## 验收标准（决定你做没做成的唯一依据）\n" +
				"完成后系统会真实执行这条命令，**退出码 0 才算通过**：\n\n" +
				"```\n" + verifyCmd + "\n```\n\n" +
				"注意：\n" +
				"- 不要靠改测试/改验收脚本来让它通过——那是作弊，会被证据链识破。\n" +
				"- 提交前请自己先跑一遍这条命令确认。\n" +
				"- 你说『完成了』不算数，只有命令的退出码算数。",
		);
	}

	if (explore) {
		parts.push(
			"## 本次为只读探索模式\n" +
				"write / edit 工具已被**在进程层面禁用**，你想调也调不到——这是程序保证，不是我的要求。\n" +
				"请只做：搜索、读文件、分析。汇报相关入口、调用关系、约束和待决问题。\n" +
				"需要改代码时不要尝试写，报告方案即可。",
		);
	}

	parts.push(
		"## 输出要求\n" +
			"完成后用简洁文字总结：做了什么、关键结论、遗留问题。不要复述本提示词。" +
			"若任务需要产出文件，直接写入指定工作目录。",
	);

	return parts.join("\n\n");
}
