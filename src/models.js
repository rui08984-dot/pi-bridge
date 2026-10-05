/**
 * 模型表 —— **配置驱动**，不硬编码任何个人环境。
 *
 * 三层结构（高 → 低）：
 *   1. 环境变量 PI_BRIDGE_ALIASES（JSON）；
 *   2. 用户配置 ~/.pi-bridge/config.json 的 "aliases" 字段；
 *   3. 内置默认（./defaults.js，仅作示例）。
 *
 * 关键认知：**本包不碰模型的网络细节**——它只告诉 Pi「用哪个 provider + modelId」。
 * 真正的 endpoint/端口/密钥写在 **Pi 自己的 `~/.pi/agent/models.json`**。
 * 所以接入两步：a) 在 Pi 配好 provider；b) 在本包 config.json 写「别名 → {provider, model}」。
 * 换机器只需改这两个 JSON，代码一行不动。
 */
import { readFileSync } from "node:fs";
import { CONFIG_PATH_RESOLVED } from "./config.js";
import { MODEL_ALIASES as DEFAULT_ALIASES, TASK_ROUTING as DEFAULT_ROUTING } from "./defaults.js";

/** 读用户配置文件（容错）。 */
function userConfig() {
	if (!CONFIG_PATH_RESOLVED) return {};
	try {
		return JSON.parse(readFileSync(CONFIG_PATH_RESOLVED, "utf8")) || {};
	} catch {
		return {};
	}
}

function parseJsonEnv(name) {
	if (!process.env[name]) return null;
	try {
		return JSON.parse(process.env[name]);
	} catch {
		return null;
	}
}

/**
 * 生效的别名表。用户配置**整体替换**内置默认（不合并）——
 * 模型清单是强耦合的，混着用容易出现「别名指向不存在的 provider」。
 */
export const MODEL_ALIASES = parseJsonEnv("PI_BRIDGE_ALIASES") || userConfig().aliases || DEFAULT_ALIASES;

/** 任务类型 → 默认别名。过滤掉当前表里不存在的别名，防呆。 */
export const TASK_ROUTING = (() => {
	const base = parseJsonEnv("PI_BRIDGE_ROUTING") || userConfig().routing || DEFAULT_ROUTING;
	const out = {};
	for (const [k, v] of Object.entries(base)) {
		if (MODEL_ALIASES[v]) out[k] = v;
	}
	// 兜底：至少保证有个可路由的默认项
	if (!Object.keys(out).length) {
		const first = Object.keys(MODEL_ALIASES)[0];
		if (first) out.coding = first;
	}
	return out;
})();

/**
 * 探活表（别名 → 健康检查 URL）。用于「引擎没起时先探活再回退」。
 * 来源：环境变量 PI_BRIDGE_PROBE_URLS 或用户配置的 "probeUrls"。
 * 未配置 → 空表 → isEngineUp 视为「无从探活」（由实际调用去证伪，功能不受影响）。
 */
export const PROBE_URLS = parseJsonEnv("PI_BRIDGE_PROBE_URLS") || userConfig().probeUrls || {};

/** 是否是本地模型（占显存、需要串行闸门）。约定：provider 以 `local-` 开头。 */
export function isLocal({ provider }) {
	return String(provider || "").startsWith("local-");
}

/**
 * 工具调用退化时的自动回退链（机制故障：引擎没起 / 输出退化）。
 * 只回退到**同侧**（本地→本地，云端→云端），避免把云端任务变成抢显存的任务。
 */
export const FALLBACK_CHAIN = {
	bonsai: ["ornith35b", "kat"],
	bonsai_retr: ["ornith35b", "kat"],
	ornith35b: ["kat"],
	ornith9b: ["ornith35b"],
	cloud_best: ["cloud_chat", "cloud_fast"],
	cloud_chat: ["cloud_fast"],
	cloud_fast: ["cloud_chat"],
	cloud_long: ["cloud_chat"],
	cloud_glm: ["cloud_chat"],
	cloud_gemini: ["cloud_chat"],
};

/**
 * 返工升档链（验收没过 → 换**更强**的模型重试）。
 *
 * 与回退链互补但语义不同：
 *   - 回退 = 机制故障（引擎没起/工具退化）→ 换个能跑的；
 *   - 升档 = 模型真干活了但没做对 → 换个更能干的。
 *
 * 经济做法：弱模型打头阵（便宜/快），验收不过才升档到强模型兜底。
 */
export const ESCALATION = {
	// 本地：小 → 大 → 云端最强
	ornith9b: ["ornith35b", "bonsai", "cloud_best"],
	ornith_atomic: ["bonsai", "cloud_best"],
	qwen35b: ["bonsai", "cloud_best"],
	kat: ["bonsai", "cloud_best"],
	ornith35b: ["bonsai", "cloud_best"],
	bonsai_retr: ["bonsai", "cloud_best"],
	bonsai: ["cloud_best"],
	// 云端：快 → 通用 → 最强
	cloud_fast: ["cloud_chat", "cloud_best"],
	cloud_gemini: ["cloud_best"],
	cloud_glm: ["cloud_best"],
	cloud_long: ["cloud_best"],
	cloud_chat: ["cloud_best"],
	cloud_best: [], // 已是最强
};

/** 解析别名 / 任务类型名 / `provider/model` → { provider, model }；认不出返回 null。 */
export function resolveModel(alias) {
	if (!alias) return null;
	const key = String(alias).trim();
	if (MODEL_ALIASES[key]) return MODEL_ALIASES[key];
	if (TASK_ROUTING[key]) return MODEL_ALIASES[TASK_ROUTING[key]] || null;
	// 裸 provider id（以 local- 开头）→ 默认 model id
	if (/^local-/.test(key)) return { provider: key, model: "local-model" };
	// 形如 provider/model 直接透传
	if (key.includes("/")) {
		const [provider, ...rest] = key.split("/");
		if (provider && rest.length) return { provider, model: rest.join("/") };
	}
	return null;
}

export function listAliases() {
	return Object.entries(MODEL_ALIASES).map(([alias, v]) => ({ alias, provider: v.provider, model: v.model }));
}

/** 反查：{provider, model} → 别名（用于证据链与升档定位）。 */
export function aliasOf({ provider, model }) {
	for (const [alias, v] of Object.entries(MODEL_ALIASES)) {
		if (v.provider === provider && v.model === model) return alias;
	}
	return `${provider}/${model}`;
}

/** 返工升档：当前别名 → 下一档别名；已到顶 / 无链返回 null。 */
export function escalatedAliasFor(currentAlias) {
	const chain = (ESCALATION[currentAlias] || []).filter((a) => MODEL_ALIASES[a]);
	return chain[0] || null;
}

/** 探活：引擎是否在监听。1.5s 超时，绝不拖慢派活。 */
export async function isEngineUp(alias, timeoutMs = 1500) {
	const url = PROBE_URLS[alias];
	if (!url) return true; // 无从探活 → 视为可用（由实际调用去证伪）
	try {
		const ac = new AbortController();
		const t = setTimeout(() => ac.abort(), timeoutMs);
		const r = await fetch(url, { signal: ac.signal });
		clearTimeout(t);
		const txt = await r.text();
		// 网关即使报 401 / Invalid token 也说明**服务活着**
		if (/invalid token|unauthorized|api ?key/i.test(txt)) return true;
		if (!r.ok) return false;
		return !/loading|unavailable/i.test(txt);
	} catch {
		return false;
	}
}
