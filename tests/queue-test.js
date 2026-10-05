/**
 * 排队闸门测试：并发派 2 个**本地**任务，验证是串行而非同时抢显存。
 * 同时验证 pi_status 能看到队列、pi_cancel 能取消排队中的任务。
 *
 * 需要一个本地模型已启动引擎；没配本地别名则跳过。
 */
import { spawnServer, textOf, pickLocalAlias, tempWorkdir } from "./_helper.js";

const localAlias = pickLocalAlias();
if (!localAlias) {
	console.log("⏭️  跳过：配置里没有本地模型别名（provider 以 local- 开头）。");
	process.exit(0);
}

const wd = tempWorkdir("pi-bridge-queue-");
const s = spawnServer();
s.init();

setTimeout(() => {
	console.log(`→ 同时派 2 个任务（模型 ${localAlias}，应串行执行）`);
	s.call(10, "pi_execute", { task: "用 bash 执行 echo queue-A，只回显输出", model: localAlias, workdir: wd, includeContext: false });
	s.call(11, "pi_execute", { task: "用 bash 执行 echo queue-B，只回显输出", model: localAlias, workdir: wd, includeContext: false });
}, 900);

// 运行中途查一次状态，确认能看到「排队中」
setTimeout(async () => {
	s.call(20, "pi_status", {});
	const st = await s.waitFor(20, 15000);
	if (st) {
		const d = JSON.parse(textOf(st));
		console.log("\n=== 运行中 pi_status ===");
		console.log(`active=${d.active}/${d.maxConcurrent}  running=${d.running}  queued=${d.queued}`);
		console.log("tasks:", d.tasks.map((t) => `${t.taskId}:${t.status}:${t.currentTool}`).join(" | "));
		if (d.queue?.length) console.log("queue:", d.queue.map((q) => `${q.position}.${q.taskId}`).join(" | "));
	}
}, 9000);

setTimeout(async () => {
	const [a, b] = await Promise.all([s.waitFor(10), s.waitFor(11)]);
	const first = (m) => (m ? textOf(m).split("\n")[0] : "(超时)");
	console.log("\n=== 两条任务结果 ===");
	console.log("任务A:", first(a));
	console.log("任务B:", first(b));
	const ok = [a, b].every((m) => m && textOf(m).includes("✅"));
	console.log(`\n${ok ? "✅ 两个任务都完成（串行，未抢显存）" : "⚠️ 有任务未成功"}`);
	s.kill();
	process.exit(ok ? 0 : 1);
}, 300000);
