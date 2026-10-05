/**
 * 验证 pi_status 能同时看到：本地闸门占用 + 本地排队 + 云端在跑。
 * 云端任务不受闸门限制，但必须出现在状态表里（否则等于黑盒）。
 *
 * 需要至少一个本地别名与一个云端别名；缺哪个就只测有哪个。
 */
import { spawnServer, textOf, pickLocalAlias, pickCloudAlias, tempWorkdir } from "./_helper.js";

const local = pickLocalAlias();
const cloud = pickCloudAlias();
if (!local && !cloud) {
	console.log("⏭️  跳过：配置里没有任何模型别名。");
	process.exit(0);
}

const wd = tempWorkdir("pi-bridge-status-");
const s = spawnServer();
s.init();

setTimeout(() => {
	console.log(`→ 派活：本地=${local || "(无)"}  云端=${cloud || "(无)"}`);
	if (local) {
		s.rpc(2, "tools/call", { name: "pi_execute", arguments: { task: "用 bash 执行 echo A，只回显", model: local, workdir: wd, includeContext: false } });
		s.rpc(3, "tools/call", { name: "pi_execute", arguments: { task: "用 bash 执行 echo B，只回显", model: local, workdir: wd, includeContext: false } });
	}
	if (cloud) {
		s.rpc(4, "tools/call", { name: "pi_execute", arguments: { task: "只回答不用工具：1+1 等于几", model: cloud, workdir: wd, includeContext: false } });
	}
}, 800);

setTimeout(async () => {
	s.rpc(9, "tools/call", { name: "pi_status", arguments: {} });
	const st = await s.waitFor(9, 20000);
	if (!st) {
		console.log("❌ pi_status 无响应");
	} else {
		const d = JSON.parse(textOf(st));
		console.log("本地闸门 active:", d.active, "/", d.maxConcurrent);
		console.log("running:", d.running, " queued:", d.queued, " total:", d.total);
		console.log("tasks:");
		for (const t of d.tasks) console.log(`    ${t.taskId}  ${t.model.padEnd(28)} ${t.status.padEnd(10)} ${t.elapsedSec}s`);
		if (d.queue?.length) console.log("queue:", d.queue.map((q) => `${q.position}.${q.taskId}`).join(" | "));
		if (cloud) {
			const cloudSeen = d.tasks.some((t) => !t.model.startsWith("local-"));
			console.log(cloudSeen ? "\n✅ 云端任务出现在状态表里（可见，非黑盒）" : "\n⚠️ 云端任务不可见");
		}
	}
	s.kill();
	process.exit(0);
}, 20000);
