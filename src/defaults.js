/**
 * 内置默认模型表 —— 仅作**示例**，展示如何接本地引擎与云端网关。
 *
 * ⚠️ 这只是模板。你的机器上大概率没有这些 provider —— 请按需改：
 *   方式 A（推荐）：在 ~/.pi-bridge/config.json 里写 "aliases"，整体替换本表；
 *   方式 B：直接改本文件（适合 fork 后自用）。
 *
 * provider 命名约定（决定了闸门与回退行为）：
 *   - 以 `local-` 开头  → 视为**本地模型**：占显存、串行排队、可探活
 *   - 其它名字          → 视为云端/网关模型：不限并发、可与本地真并行
 *
 * 右侧的 model 是 **Pi 侧的 modelId**（必须和 ~/.pi/agent/models.json 里一致）。
 */
export const MODEL_ALIASES = {
	// —— 示例：本地引擎（消费级显卡上的量化模型）——
	bonsai: { provider: "local-main", model: "my-large-model" }, // 主力：能力最强但最慢
	ornith35b: { provider: "local-mid", model: "local-model" }, // 中等：回退首选
	ornith9b: { provider: "local-fast", model: "local-model" }, // 快速：小任务
	kat: { provider: "local-special", model: "local-model" }, // 专项能力模型

	// —— 示例：云端网关（OpenAI 兼容中转）——
	// 典型场景：本地显存被长任务占满时，把另一件活丢给云端同时做（真并行，不抢显存）
	cloud_best: { provider: "my-gateway", model: "auto-best" },
	cloud_chat: { provider: "my-gateway", model: "auto-chat" },
	cloud_fast: { provider: "my-gateway", model: "auto-fast" },
	cloud_long: { provider: "my-gateway", model: "auto-long" },
};

/**
 * 任务类型 → 默认别名。
 * 用户说「随便派个活」时，按任务关键词选模型；不填 model 参数就用这里的路由。
 */
export const TASK_ROUTING = {
	coding: "bonsai", // 写代码：主力
	analysis: "bonsai", // 分析
	research: "bonsai", // 调研
	review: "bonsai", // 代码审查
	quick: "ornith9b", // 小任务：快速模型
	text: "bonsai", // 纯文本
	stable: "ornith35b", // 要稳：备选
	// —— 云端位（不占显存）——
	cloud: "cloud_chat",
	cloud_fast: "cloud_fast",
	cloud_long: "cloud_long",
	cloud_best: "cloud_best",
};
