/**
 * 配置层 —— 把「个人环境」与「桥接逻辑」彻底解耦。
 *
 * 任何一条硬编码路径都在这里收口，按以下优先级解析（高 → 低）：
 *   1. 环境变量（PI_BRIDGE_CONFIG 指定的 JSON 文件）
 *   2. 用户配置文件 ~/.pi-bridge/config.json
 *   3. 环境变量逐项覆盖（PI_EXE / PI_BRIDGE_NODE / ...）
 *   4. 内置默认值（跨平台合理值，不含任何个人目录）
 *
 * 因此本包可以原样丢到任何机器上：不配 = 用默认，配了 = 覆盖。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = join(HERE, "..");

/**
 * 读取 JSON 配置（容错：文件不存在/解析失败都返回空对象，不炸）。
 */
function readJsonSafe(p) {
	try {
		return JSON.parse(readFileSync(p, "utf8"));
	} catch {
		return {};
	}
}

/** 配置文件查找：显式 env > 用户主目录 > 包目录。 */
function findConfigFile() {
	const explicit = process.env.PI_BRIDGE_CONFIG;
	if (explicit && existsSync(explicit)) return explicit;
	const user = join(homedir(), ".pi-bridge", "config.json");
	if (existsSync(user)) return user;
	const local = join(PKG_ROOT, "pi-bridge.config.json");
	if (existsSync(local)) return local;
	return null;
}

const CONFIG_PATH = findConfigFile();
const FILE_CFG = CONFIG_PATH ? readJsonSafe(CONFIG_PATH) : {};

/** 取值优先级：文件配置 > 环境变量 > 默认值。 */
function pick(fileKey, envKey, fallback) {
	if (FILE_CFG[fileKey] !== undefined) return FILE_CFG[fileKey];
	if (envKey && process.env[envKey] !== undefined) return process.env[envKey];
	return fallback;
}

/** 展开 ~ 与相对路径（相对包根）。 */
function expand(p) {
	if (!p || typeof p !== "string") return p;
	let out = p;
	if (out.startsWith("~")) out = join(homedir(), out.slice(1));
	if (!/^([a-zA-Z]:[\\/]|\/)/.test(out)) out = join(PKG_ROOT, out);
	return out;
}

const isWin = process.platform === "win32";

/**
 * Pi 可执行文件 —— 唯一必需项。
 * 默认按 PATH 找（`pi`），Windows 上尝试 `pi.exe`。
 */
export const PI_EXE = pick("piExe", "PI_EXE", isWin ? "pi.exe" : "pi");

/** 项目上下文注入用的 node（默认就是当前 node，绝大多数情况无需配置）。 */
export const NODE_BIN = pick("nodeBin", "PI_BRIDGE_NODE", process.execPath);

/**
 * SessionRelay 可选集成 —— **没有就跳过，零打扰**。
 * 本包不强依赖它；配了 srelayPath 才会尝试注入项目简报。
 */
export const SRELAY_JS = expand(pick("srelayPath", "SRELAY_JS", "")) || "";
export const BRIEF_SHARED = expand(pick("briefShared", "PI_BRIDGE_BRIEF_SHARED", "")) || "";

/** 验收命令在哪个 shell 里跑：Windows=cmd，类 Unix=/bin/sh。 */
export const VERIFY_SHELL = pick("verifyShell", "PI_BRIDGE_VERIFY_SHELL", isWin ? (process.env.COMSPEC || "cmd.exe") : "/bin/sh");

/** 验收命令的 shell 参数（Windows 的 cmd 需要 /d /s /c）。 */
export const VERIFY_SHELL_ARGS = isWin ? [" /d", "/s", "/c"] : ["-c"];

/** 本地引擎并发闸门（占显存的那些）。云端不限。 */
export const MAX_CONCURRENT = Number(pick("maxConcurrent", "PI_BRIDGE_CONCURRENCY", 1));

/** 默认单任务超时（毫秒）。 */
export const DEFAULT_TIMEOUT_MS = Number(pick("timeoutMs", "PI_BRIDGE_TIMEOUT_MS", 600000));

export const CONFIG_SOURCE = CONFIG_PATH || "(内置默认值)";
export const CONFIG_PATH_RESOLVED = CONFIG_PATH;

/** 诊断用：打印当前生效配置（隐藏敏感项）。 */
export function describeConfig() {
	return {
		configSource: CONFIG_SOURCE,
		piExe: PI_EXE,
		nodeBin: NODE_BIN,
		verifyShell: VERIFY_SHELL + (VERIFY_SHELL_ARGS.join(" ") || ""),
		maxConcurrent: MAX_CONCURRENT,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		srelay: SRELAY_JS || "(未配置，跳过上下文注入)",
		briefShared: BRIEF_SHARED || "(未配置)",
	};
}
