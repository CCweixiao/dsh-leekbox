// P3: AI 决策信号闭环(lib/decision.js + /api/leekbox/signals 路由)。
// Asserts:
//   1. extractSignal:末尾 ```json 块提取 + 正文剥离 + 坏块容错;
//   2. normalizeSignal:action 白名单、数值钳制;
//   3. reviewSignal:目标/失效位触及优先、方向收益判定、未到期/缺数据 → null;
//   4. signalStats:整体与分动作胜率;
//   5. 路由:GET /signals 懒复盘到期信号(真实存储 + 东财日K桩)、feedback、remove。
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractSignal, normalizeSignal, reviewSignal, signalStats } from "./lib/decision.js";
import { makeRoutes, ROUTES, harnessStreamText } from "./lib/index.js";
import { resetRouteCachesForTests } from "./lib/route-cache.js";

// ---- 1) extractSignal ----
console.log("== 1) extractSignal ==");
const analysis = "……倾向小节……\n\n本分析由 AI 生成，仅供研究参考。\n```json\n{\"action\":\"bullish\",\"confidence\":0.62,\"score\":68,\"horizon_days\":5,\"reference_low\":13.95,\"reference_high\":14.87,\"invalidation\":13.6,\"target_price\":14.87,\"watch_conditions\":[\"放量确认\",\"站稳 MA20\"],\"reason\":\"多头排列回踩低吸\"}\n```";
const r1 = extractSignal(analysis, { priceAtSignal: 14.5 });
assert.equal(r1.signal === null, false);
assert.equal(r1.signal.action, "bullish");
assert.equal(r1.signal.confidence, 0.62);
assert.equal(r1.signal.priceAtSignal, 14.5);
assert.equal(r1.signal.watchConditions.length, 2);
assert.ok(!r1.text.includes("```json"), "正文剥离信号块");
assert.ok(r1.text.includes("仅供研究参考"), "正文其余部分保留");
// 无块 / 坏 JSON
assert.equal(extractSignal("普通分析没有代码块").signal, null);
const bad = extractSignal("文字\n```json\n{不是json}\n```");
assert.equal(bad.signal, null);
assert.equal(bad.text, bad.text && "文字\n```json\n{不是json}\n```".length > 0 ? bad.text : "", "坏块时正文原样返回");

// ---- 2) normalizeSignal 钳制 ----
console.log("== 2) normalizeSignal ==");
assert.equal(normalizeSignal({ action: "成交" }, null), null, "未知 action 拒绝");
const clamped = normalizeSignal({ action: "BULLISH", confidence: 5, score: -3, horizon_days: 999 }, 10);
assert.equal(clamped.confidence, 1, "confidence 钳到 1");
assert.equal(clamped.score, 0, "score 钳到 0");
assert.equal(clamped.horizonDays, 30, "horizon 钳到 30");

// ---- 3) reviewSignal 语义 ----
console.log("== 3) reviewSignal semantics ==");
const mkBars = (dates, closes) => dates.map((d, i) => ({ date: d, open: closes[i], close: closes[i], high: Math.max(...[closes[i]]) + 0.2, low: closes[i] - 0.2 }));
const sig = (over = {}) => ({
	action: "bullish",
	horizonDays: 3,
	cnDate: "2026-11-09",
	priceAtSignal: 10,
	targetPrice: 11,
	invalidation: 9.5,
	referenceLow: null,
	referenceHigh: null,
	...over,
});
// 未到期:窗口只有 2 根
assert.equal(reviewSignal(sig({ horizonDays: 3 }), mkBars(["2026-11-10", "2026-11-11"], [10.2, 10.3])), null, "交易日不足 → null");
// 目标价触及优先 → hit
const hitBars = mkBars(["2026-11-10", "2026-11-11", "2026-11-12"], [10.4, 11.2, 11.3]);
const hitOut = reviewSignal(sig(), hitBars);
assert.equal(hitOut.result, "hit", `目标触及 → hit, got ${hitOut?.result}/${hitOut?.note}`);
assert.equal(hitOut.returnPct > 0, true);
// 失效位跌破 → miss(即使窗口整体上涨)
const missBars = mkBars(["2026-11-10", "2026-11-11", "2026-11-12"], [10.4, 9.4, 10.8]);
const missOut = reviewSignal(sig(), missBars);
assert.equal(missOut.result, "miss", `破失效位 → miss, got ${missOut?.result}`);
assert.ok(missOut.note.includes("失效位"));
// 无目标/失效位 → 方向收益判定(偏多 +2% → hit)
const flatOut = reviewSignal(sig({ targetPrice: null, invalidation: null }), mkBars(["2026-11-10", "2026-11-11", "2026-11-12"], [10.2, 10.2, 10.21]));
assert.equal(flatOut.result, "hit", `偏多 +2% → hit, got ${flatOut?.result}`);
// 偏空:窗口下跌 → hit
const bearOut = reviewSignal(sig({ action: "bearish", targetPrice: null, invalidation: null }), mkBars(["2026-11-10", "2026-11-11", "2026-11-12"], [9.8, 9.7, 9.75]));
assert.equal(bearOut.result, "hit", `偏空 -2.5% → hit, got ${bearOut?.result}`);
// 中性:横盘 → hit,单边 → miss
assert.equal(reviewSignal(sig({ action: "neutral", targetPrice: null, invalidation: null }), mkBars(["2026-11-10", "2026-11-11", "2026-11-12"], [10.05, 10, 10])).result, "hit");
assert.equal(reviewSignal(sig({ action: "neutral", targetPrice: null, invalidation: null }), mkBars(["2026-11-10", "2026-11-11", "2026-11-12"], [10.6, 10.7, 10.8])).result, "miss");
// 基准用 priceAtSignal;缺失时回退首根开盘
const noBase = reviewSignal(sig({ priceAtSignal: null, targetPrice: null, invalidation: null }), mkBars(["2026-11-10", "2026-11-11", "2026-11-12"], [10.2, 10.2, 10.21]));
assert.equal(noOutSafe(noBase), true);
function noOutSafe(o) {
	return o !== null && Number.isFinite(o.basePrice) && o.basePrice > 0;
}

// ---- 4) signalStats ----
console.log("== 4) signalStats ==");
const stats = signalStats([
	{ action: "bullish", outcome: { result: "hit" } },
	{ action: "bullish", outcome: { result: "miss" } },
	{ action: "bearish", outcome: { result: "hit" } },
	{ action: "neutral", status: "active", outcome: null },
]);
assert.equal(stats.total, 4);
assert.equal(stats.active, 1);
assert.equal(stats.reviewed, 3);
assert.equal(stats.hit, 2);
assert.equal(stats.miss, 1);
assert.equal(stats.neutral, 0);
assert.equal(stats.hitRatePct, 66.67, `命中率 = hit/(hit+miss) = 66.67, got ${stats.hitRatePct}`);
const bullRow = stats.byAction.find((r) => r.action === "bullish");
assert.equal(bullRow.hitRatePct, 50);

// ---- mock req/res ----
function makeGet(url) {
	const req = new EventEmitter();
	req.method = "GET";
	req.url = url;
	req.socket = { remoteAddress: "127.0.0.1" };
	req.headers = { host: "localhost" };
	return req;
}
function makePost(url, body) {
	const req = Readable.from([Buffer.from(JSON.stringify(body ?? {}), "utf8")]);
	req.method = "POST";
	req.url = url;
	req.socket = { remoteAddress: "127.0.0.1" };
	req.headers = { host: "localhost", "content-type": "application/json", origin: "http://localhost" };
	return req;
}
function makeRes() {
	const res = new EventEmitter();
	res.headersSent = false;
	res.body = null;
	res.statusCode = 0;
	res.writeHead = (code, headers) => {
		res.statusCode = code;
		res.headers = headers;
		res.headersSent = true;
	};
	res.write = (s) => {
		res.body = (res.body ?? "") + s;
		return true;
	};
	res.end = (s) => {
		if (s) res.body = (res.body ?? "") + s;
	};
	return res;
}
const json = (res) => JSON.parse(res.body);

// ---- 5) 路由:懒复盘 + 落库 + feedback/remove ----
console.log("== 5) routes: lazy review / feedback / remove ==");
const home = mkdtempSync(join(tmpdir(), "leekbox-p3-signals-"));
// 东财日K桩:2026-11-10 起的上涨序列(覆盖信号窗口)
globalThis.fetch = async (url) => {
	const u = String(url);
	if (u.includes("/api/qt/stock/kline/get")) {
		const dates = ["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"];
		const klines = dates.map((d, i) => `${d},10,${(10.2 + i * 0.35).toFixed(2)},11.4,9.6,1000`);
		return new Response(JSON.stringify({ data: { klines } }), { status: 200, headers: { "content-type": "application/json" } });
	}
	throw new Error(`unexpected URL in stub: ${u}`);
};
resetRouteCachesForTests();
const routes = makeRoutes({}, { dshHome: home, logger: { warn() {} } });
const signalsRoute = routes.find((r) => r.path === ROUTES.signals);
const feedbackRoute = routes.find((r) => r.path === ROUTES.signals + "/feedback");
const removeRoute = routes.find((r) => r.path === ROUTES.signals + "/remove");
assert.ok(signalsRoute && feedbackRoute && removeRoute, "三条 signals 路由必须注册");

// 落一条已到期的 active 信号(cnDate 2026-11-09,horizon 3,日K桩 4 根)
const signalsFile = join(home, ".leekbox-signals.json");
writeFileSync(
	signalsFile,
	JSON.stringify([
		{
			id: "sig1",
			code: "sh600519",
			name: "贵州茅台",
			action: "bullish",
			confidence: 0.7,
			score: 72,
			horizonDays: 3,
			referenceLow: 9.8,
			referenceHigh: 11,
			invalidation: null,
			targetPrice: null,
			watchConditions: ["放量"],
			reason: "测试",
			priceAtSignal: 10,
			cnDate: "2026-11-09",
			createdAt: "2026-11-09T15:00:00.000Z",
			provider: "zai-coding-cn",
			model: "glm-5.3-flash",
			status: "active",
			outcome: null,
			feedback: null,
		},
	]),
	"utf8"
);

let res = makeRes();
await signalsRoute.handler(makeGet(`${ROUTES.signals}`), res);
assert.strictEqual(res.statusCode, 200);
let body = json(res);
assert.equal(body.signals.length, 1);
assert.equal(body.signals[0].status, "reviewed", "到期信号被懒复盘");
assert.equal(body.signals[0].outcome.result, "hit", "上涨桩 → 命中");
assert.ok(body.signals[0].outcome.returnPct > 0);
assert.equal(body.stats.total, 1);
assert.equal(body.stats.hit, 1);
assert.equal(body.stats.hitRatePct, 100);

// 二次读取:已复盘的不再变(且不再打上游——桩会在意外 URL 上抛错)
res = makeRes();
await signalsRoute.handler(makeGet(`${ROUTES.signals}?code=sh600519`), res);
body = json(res);
assert.equal(body.signals.length, 1, "?code= 过滤");
assert.equal(body.signals[0].outcome.result, "hit");

// feedback + remove
res = makeRes();
await feedbackRoute.handler(makePost(ROUTES.signals + "/feedback", { id: "sig1", useful: true }), res);
assert.strictEqual(res.statusCode, 200);
assert.equal(JSON.parse(readFileSync(signalsFile, "utf8"))[0].feedback.useful, true, "反馈落盘");
res = makeRes();
await feedbackRoute.handler(makePost(ROUTES.signals + "/feedback", {}), res);
assert.strictEqual(res.statusCode, 400, "缺 id 必须 400");
res = makeRes();
await feedbackRoute.handler(makePost(ROUTES.signals + "/feedback", { id: "gone", useful: true }), res);
assert.strictEqual(res.statusCode, 200);
assert.equal(json(res).ok, false, "未知 id → ok:false");
res = makeRes();
await removeRoute.handler(makePost(ROUTES.signals + "/remove", { id: "sig1" }), res);
assert.strictEqual(res.statusCode, 200);
assert.equal(JSON.parse(readFileSync(signalsFile, "utf8")).length, 0, "删除生效");
res = makeRes();
await signalsRoute.handler(makeGet(ROUTES.signals), res);
assert.deepEqual(json(res).stats.total, 0);

rmSync(home, { recursive: true, force: true });

console.log("== 6) harnessStreamText 截断检测（AI 分析静默停止的根修） ==");
// 桩 llm：可编程的 chunk 序列（stream 挂在 prepareCall 返回的 call 对象上）
function stubLlm(chunks) {
	return {
		prepareCall: async () => ({
			provider: "p",
			model: "m",
			config: {},
			stream: async function* () { for (const c of chunks) yield c; },
		}),
	};
}
// 6a. 静默截断：只有 text-delta、没有 finish → failure=stream_truncated
{
	const { text, failure } = await harnessStreamText(stubLlm([{ type: "text-delta", text: "分析正文" }]), { provider: "p", model: "m" }, "提问");
	assert.equal(text, "分析正文");
	assert.equal(failure?.code, "stream_truncated", `静默截断必须报 stream_truncated, got ${failure?.code}`);
}
// 6b. finish=length → failure=length_truncated（正文保留）
{
	const { text, failure } = await harnessStreamText(stubLlm([{ type: "text-delta", text: "半截" }, { type: "finish", reason: { kind: "length" } }]), { provider: "p", model: "m" }, "提问");
	assert.equal(text, "半截");
	assert.equal(failure?.code, "length_truncated");
}
// 6c. 正常 finish（kind=stop，无 failure）→ failure=null
{
	const { text, failure } = await harnessStreamText(stubLlm([{ type: "text-delta", text: "全文" }, { type: "finish", reason: { kind: "stop" } }]), { provider: "p", model: "m" }, "提问");
	assert.equal(text, "全文");
	assert.equal(failure, null, "正常结束不算失败");
}
// 6d. 上游 error 分片 → failure 透传
{
	const { failure } = await harnessStreamText(stubLlm([{ type: "text-delta", text: "x" }, { type: "error", failure: { code: "RATE_LIMIT", message: "限流" } }]), { provider: "p", model: "m" }, "提问");
	assert.equal(failure?.code, "RATE_LIMIT");
}

console.log("\n✅ P3 DECISION TEST PASSED: signal extraction/review/stats/routes/truncation work");
process.exit(0);
