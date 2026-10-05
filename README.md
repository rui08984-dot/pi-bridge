# pi-bridge

把 **Pi** 执行节点暴露成 **MCP 工具**，让任意 MCP 客户端（Claude Code / Codex / ZCode / Cursor / Windsurf …）能给本地或云端模型**派活、查状态、取消**。

> 一句话定位：**让主会话当调度者，把干活的活外包出去——用命令行验收兜底，不靠模型自述。**

```
你的 MCP 客户端（编排者）
   │  MCP：pi_execute（可异步）/ pi_result / pi_status / pi_cancel
   ▼
pi-bridge（本包，MCP stdio server）
   │  spawn `pi --mode rpc`（常驻子进程）
   ▼
Pi（执行节点）
   │
   ├─► 本地模型引擎（llama.cpp / NInfer / AtomicBot / 任何 OpenAI 兼容服务）
   └─► 云端/网关模型（OpenAI 兼容中转）
```

---

## 为什么需要它

问题一：**主会话的上下文很贵**。让它亲自读 50 个文件、跑 20 条命令，token 烧得飞快。
问题二：**弱模型会说谎**。"我做完了"是最不可靠的完成信号——尤其量化小模型，工具调用可能退化成纯文本，它仍然报"完成"。

pi-bridge 的答案：
1. **分发**——把子任务派给另一个模型；它读文件、跑命令的 token 不算在主会话头上。传**路径**而不是内容，让它自己按需读。
2. **验收**——派活时给一条命令，桥接层**真实执行**它，退出码 0 才算完成。**验收本身零 token**。
3. **证据链**——任务前后拍文件快照做 diff，如实告诉你"实际改了什么"，而不是复述模型的自述。
4. **升档重试**——验收不过时，自动换**更强**的模型重来（弱模型打头阵省钱，强模型兜底保成）。
5. **程序级约束**——`explore` 模式在**进程启动层面**禁用 write/edit 工具，模型想调也调不到；`scope` 越界改文件直接判失败。

---

## 快速开始

### 0. 前置条件

- **Node.js ≥ 20**
- **Pi 已安装**（本包不代替 Pi，它只是 Pi 的 MCP 外壳）：确认 `pi --version` 能跑
- **至少一个模型端点**：
  - 本地模型：先按 Pi 的文档在 `~/.pi/agent/models.json` 里配好 provider，并**手动启动**它的推理引擎（本包不会替你拉进程）
  - 云端模型：OpenAI 兼容的 baseUrl + key，同样先配进 Pi 的 `models.json`

### 1. 安装

```bash
git clone <this-repo> pi-bridge
cd pi-bridge
npm install
```

### 2. 配置（关键一步）

```bash
cp pi-bridge.config.example.json ~/.pi-bridge/config.json
# 编辑它：至少填 piExe 和 aliases
```

最少要配两项：

```json
{
  "piExe": "/path/to/pi",
  "aliases": {
    "local-main": { "provider": "local-myengine", "model": "my-model-id" },
    "cloud-fast": { "provider": "my-gateway", "model": "auto-fast" }
  }
}
```

**命名约定（决定行为）**：`provider` 以 `local-` 开头 → 视为本地模型（占显存、串行排队、可探活）；其它 → 不限并发，可与本地真并行。

配置优先级：`PI_BRIDGE_CONFIG` 环境变量 > `~/.pi-bridge/config.json` > 包内 `pi-bridge.config.json` > 内置默认。
每一项也都能用环境变量覆盖（`PI_EXE` / `PI_BRIDGE_ALIASES` / `PI_BRIDGE_CONCURRENCY` …）。
**什么都不配也能启动**（用内置示例表），只是派活前你得把 aliases 指向自己真实的模型。

### 3. 接入你的 MCP 客户端

以通用 stdio 配置为例（各客户端字段名略有差异）：

```json
{
  "mcpServers": {
    "pi-bridge": {
      "command": "node",
      "args": ["/abs/path/to/pi-bridge/src/server.js"],
      "env": { "PI_BRIDGE_CONFIG": "/abs/path/to/config.json" },
      "timeoutMs": 1800000
    }
  }
}
```

> ⚠️ **`timeoutMs` 必须调大**（默认 30 秒太短）。派一个真实任务通常要 1–4 分钟，
> 超时会导致调用方拿不到结果（任务在后台照跑完，但结果是丢的）。给 30 分钟是稳妥值。

### 4. 验证

```bash
npm run smoke     # MCP 协议握手 + 工具列表（不派活）
npm test          # 验收层单元测试（不跑模型，秒级）
npm run selftest  # 配置解析 + 端点探活 + Pi RPC 握手（只读）
```

---

## 四个工具

| 工具 | 作用 |
|---|---|
| `pi_execute` | 派子任务，回传结构化结果（状态 / 耗时 / 工具轨迹 / token / 证据链）。加 `async: true` 则秒回 taskId，不阻塞 |
| `pi_result` | 取回**异步任务**的最终结果（跑着给进度，可选就地等；结果存内存+磁盘，跨会话也能取） |
| `pi_status` | 任务状态表：`tasks` = 在跑的，`asyncTasks` = 异步派发的 |
| `pi_cancel` | 取消任务（同步/异步/排队中都支持，立即生效） |

### 异步模式：派完就走，不必干等 ⭐

MCP 工具调用是「请求-响应」，同步等结果的调用方在整条验收链跑完前只能干等——
一个云端任务动辄 1–10 分钟。**加 `async: true` 就变成派发即返回**：

```
pi_execute(task="重构认证模块", verify="npm test", async=true)
  → 🚀 任务已派发（异步）｜taskId: t-xxx   ← 200ms 内返回，你立刻能继续干活

（……你干自己的活，Pi 在后台跑执行→验收→返工→升档……）

pi_result(taskId="t-xxx")                    ← 完成后取完整结果
pi_result(taskId="t-xxx", waitMs=120000)     ← 或就地等最多 2 分钟
pi_cancel(taskId="t-xxx")                    ← 随时可停
```

**关键保证**：异步任务跑的是**同一条验收链代码**——验收/返工/升档/证据链一字不差，
不存在"异步模式打了折"。结果写内存 + `~/.pi-bridge/tasks/` 落盘（滚动保留最近 200 个），
进程重启或换会话也能取回。

> 实测：派发返回 **207ms**（同步模式要 30–600 秒）；派完后自己的活 3 秒干完时 Pi 还在跑。

### `pi_execute` 参数

| 参数 | 说明 |
|---|---|
| `task` | **必填**。要做什么、改哪些文件、什么算完成——说清这三件事 |
| `model` | 模型别名 / 任务类型关键词；不填按 routing 表路由 |
| `workdir` | 工作目录，所有文件操作在这里发生 |
| `files` | 相关文件**路径**（不要传内容——让模型自己读，这是省 token 的关键） |
| `constraints` | 技术栈、风格、禁止事项 |
| `verify` | **强烈建议填**。验收命令，退出码 0 才算完成 |
| `rework` | 验收不过时自动返工，0–3（默认 0） |
| `escalate` | 返工是否升档到更强模型（默认 `true`） |
| `scope` | 限定可改路径前缀；越界即判失败 |
| `mode` | `implement`（默认）/ `explore`（只读，进程级禁写） |
| `async` | `true` = 异步派发（秒回 taskId）；默认 `false` = 同步等结果 |
| `timeoutMs` | 单任务超时（默认 600000） |
| `includeContext` | 是否注入项目简报（需配置 sessionrelay，否则自动跳过） |

### CLI 模式（不经过 MCP，便于脚本化与排障）

```bash
node src/server.js exec "任务描述" --model=local-main --dir=/path/to/repo
node src/server.js exec "创建 ok.txt" --model=local-main --dir=/tmp/w \
  --verify="if exist ok.txt (exit 0) else (exit 1)"
node src/server.js exec "分析架构" --model=local-main --mode=explore     # 只读
node src/server.js exec "改 src/"  --model=local-main --scope=src/ --rework=1
node src/server.js exec "长任务"   --model=local-main --async=true --wait=300000   # 异步派发
```

---

## 设计要点：为什么「可验证」比「聪明」更重要

### 1. 「我完成了」不是证据，命令才是

```
✅ 任务完成（验收通过）｜模型 gw/auto-fast｜耗时 61s｜工具调用 2次
✅ 验收通过（`if exist out.json (exit 0) else (exit 1)`）
```

配了 `verify` 而命令没过时，桥接层**明确报失败**并附上命令的实际输出——哪怕模型口口声声说做完了：

```
🚨 验收未通过——模型说完成了，但命令跑出来不是这样
   验收命令：`npm test`（退出码 1）
   Error: 3 tests failed
```

### 2. 证据链：文件快照 diff

任务前后各拍一次文件指纹，得出**实际改动**。这能识破两类骗局：改了范围外的文件、或该改却没改（工具没真执行）。

```
【证据链】
改动 2 个文件：
   ~ src/auth/login.ts
   ~ tests/auth.test.ts
执行命令 3 条：
   $ npm test
```

### 3. 升档：弱模型打头阵，强模型兜底

`rework` + `escalate`（默认开）让失败重试自动**升级模型**：

```
⬆️ 返工升档：local-fast → local-main → cloud-best（升档后验收通过）
```

经济含义：便宜模型有较大概率一次做对；做不对时才付强模型的成本。
升档链在 `src/models.js` 的 `ESCALATION` 里，按你的模型表改。

### 4. 程序级约束，不是提示词自觉

- `mode=explore`：给 Pi 传 `--exclude-tools write,edit`，工具在**进程层面**不存在；
- `scope`：越界改动由证据链识破并判失败。

### 5. 失败不会被伪装成成功

| 情况 | 桥接层报告 |
|---|---|
| 端点没起 | `unreachable` + 明确提示；配了 probeUrls 时自动探活并回退 |
| 工具调用退化成纯文本 | `degraded` 检测拦住；自动换模型重跑 |
| 验收不通过 | `❌ 验收未通过` + 命令实际输出 |
| 改动越界 | `❌ 改动越界` + 越界文件清单 |
| 超时 | `❌ timeout` + 建议调大 timeoutMs |

### 6. 验收命令要设计成「无法取巧」⭐

这条是实测踩出来的坑，**用之前务必读**。

验收层会真实执行你给的命令，但它**只能判断退出码**——它不知道这个退出码是怎么来的。
于是出现了一个反直觉的情况：**如果验收命令可以被"顺手满足"，模型就会顺手满足它，而不是完成真正的任务。**

实测案例（2026-10-06）：验收命令写成"检查 `never_this_file_xyz.txt` 是否存在"，
本意是造一个**必定失败**的测试。结果第一轮模型直接把那个文件创建出来了——
验收通过，任务"成功"了，但**它根本没做我真正想让它做的事**。

> 注意：这不是 bug，而是"验收 = 退出码"这个机制的本质。模型的优化目标就是让退出码变 0，
> 它会走最短路径。所以**设计验收命令的责任在调用方**。

**好的验收命令**（无法用取巧手段满足）：

| 类型 | 例子 | 为什么可靠 |
|---|---|---|
| 跑真实测试套件 | `npm test`、`pytest -q`、`go test ./...` | 要让测试全过，必须真改对代码 |
| 校验产物**内容** | `grep -q "expected_fn" src/out.ts` | 存在性可伪造，内容不行 |
| 组合校验 | `npm run build && node dist/cli.js --selftest` | 构建 + 行为都要过 |
| 断言语义结果 | `node -e "const r=require('./calc');process.exit(r.add(2,3)===5?0:1)"` | 直接验证功能正确 |

**要避免的验收命令**：

- ❌ 单纯检查文件存在（`test -f out.txt`）—— 模型直接 `touch` 就过了；
- ❌ 检查文件大小/行数 —— 塞点填充内容就能满足；
- ❌ 检查某个字符串出现 —— 让它出现在注释里也算过；
- ❌ 任何"结果状态"而非"正确行为"的检查。

**一个实用的自检问法**：*「模型如果不想真干活、只想让这条命令返回 0，它能怎么做？」*
如果存在一条明显的捷径，这条验收就是不可靠的。

---

### 升档的生命周期：每次任务独立从原档起步

你可能会担心："升档会不会粘住？一次任务升到高配，之后所有任务都从高配开始烧钱？"

**不会。** 实证结论（2026-10-06 同进程连派双任务实测）：

- 升档状态（当前模型 / 升档轨迹）是**单次任务内的局部变量**，任务结束即销毁；
- 同一个 server 进程里，前一个任务升档到 `cloud_chat` 后，
  下一个任务仍从**你指定的原档**（`cloud_fast`）开始；
- 没有"降档"逻辑，也不需要——**每个任务天然从原档起步**，等价于每次自动归零。

```
任务A：cloud_fast 验收✗ → 升档 cloud_chat → 验收✓  （任务A 结束，状态丢弃）
任务B：cloud_fast 重新起步 ← 不继承任务A 的升档
```

> 唯一的例外是**返工链本身的方向**：单个任务内升档只会向上升，不会中途降回去。
> 这是刻意的——已经被证明做不对的模型，在同一任务里重试它没有意义。

**如果某类任务反复需要升到顶档才能通过**，说明起始档选低了，
应该去改该任务类型的默认路由（`routing` 配置），而不是指望运行时的降档。


---

## 跨平台

- **Windows / Linux / macOS** 均可。（验收命令的 shell 自动选择：Windows 走 `cmd.exe /d /s /c`，类 Unix 走 `/bin/sh -c`。）
- 验收命令请用对应平台的语法：Windows `if exist x (exit 0) else (exit 1)`；POSIX `test -f x`。
- ⚠️ Windows 实测坑：命令经 `cmd /d /s /c` 执行时，其中的引号会被重解析——`if exist "a.txt" …` 实测会失败，去掉引号正常；路径含空格请改用 `cd /d "目录" && 命令`。

---

## 可用别名与并发模型

- **本地模型**（provider 以 `local-` 开头）：占显存，**串行排队**，一次只跑一个（单卡现实）。
  上游大显存机器可放开：`maxConcurrent` 或 `PI_BRIDGE_CONCURRENCY=2`。
- **云端/网关模型**：不限并发，**与本地真并行**。适合"本地跑长任务时，把另一件活丢给云端同时做"。

## 可选：项目上下文注入

如果你的项目用 SessionRelay 之类的状态层，子任务开局即可带上项目简报（看板/决策），开局不失忆。
**这是完全可选的**：不配 `srelayPath` + `briefShared` 就整个跳过，零打扰、不影响其它功能。
注入时也只传**路径**，内容由子模型按需读取。

---

## 目录结构

```
src/
  config.js      配置解析（环境变量 / 配置文件 / 默认值三层）
  defaults.js    内置示例模型表（仅作模板）
  models.js      模型表、路由、回退链、升档链、探活
  pi-node.js     Pi RPC 进程生命周期（协议细节有注释，勿凭记忆改）
  context.js     提示词组装 + 可选的项目上下文注入
  verify.js      验收层：跑命令、文件快照 diff、范围检查、证据链
  server.js      MCP server + CLI
tests/
  verify-unit.js 验收层单元测试（跨平台、不跑模型）
```

---

<sub>如果这个项目帮到你了，点个 ⭐ 就是最好的支持 —— 也能让更多人找到它。</sub>

## License

MIT
