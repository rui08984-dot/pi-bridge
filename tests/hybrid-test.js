/**
 * 混合并行验证：本地任务 + 云端任务同时派，检查是否**真并行**（时间重叠）
 * 而非被单槽闸门排成串行。
 *
 * 需要同时配好一个本地别名与一个云端别名；缺一则跳过。
 */
import { spawnServer, textOf, pickLocalAlias, pickCloudAlias, tempWorkdir } from "./_helper.js";

const local = pickLocalAlias();
const cloud = pickCloudAlias();
if (!local || !cloud) {
	console.log("⏭️  跳过：需要同时配置一个本地别名和一个云端别名。");
	console.log(`    当前: 本地=${local || "(无)"}  云端=${cloud || "(无)"}`);
	process.exit(0);
}

const wd = tempWorkdir("pi-bridge-hybrid-");
const s = spawnServer();
const t0 = Date.now();
const stamps = {};
const origCall = s.call;
s.call = (id, name, args) => {
	stamps[id] = Date.now() - t0;
	origCall(id, name, args);
};

s.init();

setTimeout(() => {
	console.log(`→ 同时派：本地(${local}) + 云端(${cloud})`);
	s.call(10, "pi_execute", { task: "用 bash 执行 echo local-side，只回显输出", model: local, workdir: wd, includeContext: false });
	s.call(11, "pi_execute", { task: "只回答不要用工具：一句话说明什么是并行计算。", model: cloud, workdir: wd, includeContext: false });
}, 800);

setTimeout(async () => {
	const [a, b] = await Promise.all([s.waitFor(10), s.waitFor(11)]);
	const txt = (m) => (m ? textOf(m).split("\n")[0] : "(超时)");
	const at = a ? Date.now() - t0 : null;
	const bt = b ? Date.now() - t0 : null;
	console.log("\n=== 结果 ===");
	console.log(`本地  派出于 ${stamps[10]}ms  完成于 ${at}ms  → ${txt(a)}`);
	console.log(`云端  派出于 ${stamps[11]}ms  完成于 ${bt}ms  → ${txt(b)}`);

	if (a && b) {
		const overlap = Math.min(at, bt) - Math.max(stamps[10], stamps[11]);
		console.log(`\n时间重叠 ${overlap}ms`);
		const parallel = overlap > 1000;
		console.log(parallel ? "✅ 真并行（未被闸门串行化）" : "⚠️ 看起来是串行");
	}
	s.kill();
	process.exit(0);
}, 420000);
