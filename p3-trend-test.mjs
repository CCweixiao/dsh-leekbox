// P3: 自选行「一句话趋势」(lib/trend.js + /api/leekbox/trend 路由)。
// Asserts:
//   1. trendHint 纯判定:强势拉升/稳步走高/窄幅盘整/快速下降/加速下挫/温和走高/小幅回落;
//   2. 路由批量:代码归一化/去重/上限 60、单只失败静默缺席、closes 带 22 根;
//   3. 缓存:同 code 二次请求不打上游(stub 计数)。
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { makeRoutes, ROUTES } from "./lib/index.js";
import { trendHint } from "./lib/trend.js";
import { resetRouteCachesForTests } from "./lib/route-cache.js";

// ---- 1) trendHint 纯判定 ----
console.log("== 1) trendHint semantics ==");
const rises = (n, step) => Array.from({ length: n }, (_, i) => 10 * Math.pow(1 + step, i));
const falls = (n, step) => Array.from({ length: n }, (_, i) => 10 * Math.pow(1 - step, i));

assert.equal(trendHint(null), null);
assert.equal(trendHint([]), null, "空序列 → null");
assert.equal(trendHint([10, 10, 10]), null, "少于 6 根 → null");

// 强势拉升:近5根≥+5%、窗口≥+8%、收在窗口高点
const rally = rises(22, 0.012); // 每根 +1.2%
assert.equal(trendHint(rally).label, "强势拉升", `rally → ${trendHint(rally)?.label}`);
assert.equal(trendHint(rally).kind, "up");

// 稳步走高:窗口累计 ≥+4% 但近 5 根温和
const steady = Array.from({ length: 22 }, (_, i) => (i < 17 ? 10 + i * 0.12 : 12.04 + (i - 16) * 0.05));
const steadyHint = trendHint(steady);
assert.ok(steadyHint.label === "稳步走高" || steadyHint.label === "强势拉升", `steady → ${steadyHint.label}`);

// 窄幅盘整:围绕 10 微幅波动
const flat = Array.from({ length: 22 }, (_, i) => 10 + Math.sin(i * 1.7) * 0.12);
assert.equal(trendHint(flat).label, "窄幅盘整", `flat → ${trendHint(flat)?.label}`);
assert.equal(trendHint(flat).kind, "flat");

// 加速下挫:近 5 根重挫 + 窗口深跌 + 收在窗口低点
const crash = falls(22, 0.02); // 每根 -2%
assert.equal(trendHint(crash).label, "加速下挫", `crash → ${trendHint(crash)?.label}`);
assert.equal(trendHint(crash).kind, "down");

// 快速下降:前段平稳、近 5 根急跌但窗口未到 -10%
const fastDown = Array.from({ length: 22 }, (_, i) => (i < 17 ? 10 : 10 * Math.pow(0.985, i - 16)));
assert.equal(trendHint(fastDown).label, "快速下降", `fastDown → ${trendHint(fastDown)?.label}`);

// 温和走高 / 小幅回落:两档兜底方向(累计 2~4% 之间,不足「稳步」档)
const mildUp = Array.from({ length: 22 }, (_, i) => 10 + i * 0.012); // 窗口 +2.4%,近5根 +0.6%
assert.equal(trendHint(mildUp).label, "温和走高", `mildUp → ${trendHint(mildUp)?.label}`);
const mildDown = Array.from({ length: 22 }, (_, i) => 11.2 - i * 0.032); // 窗口 ≈ -5.9%
assert.equal(trendHint(mildDown).label, "小幅回落", `mildDown → ${trendHint(mildDown)?.label}`);

// ---- mock req/res ----
function makeGet(url) {
	const req = new EventEmitter();
	req.method = "GET";
	req.url = url;
	req.socket = { remoteAddress: "127.0.0.1" };
	req.headers = { host: "localhost" };
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

// ---- 东财日K stub:/api/qt/stock/kline/get → 24 根 ----
let klineCalls = 0;
const failCodes = new Set();
globalThis.fetch = async (url) => {
	const u = String(url);
	if (u.includes("/api/qt/stock/kline/get")) {
		klineCalls += 1;
		const m = /secid=(\d+)\.(\d{6})/.exec(u);
		const code = `${Number(m[1]) === 1 ? "sh" : "sz"}${m[2]}`;
		if (failCodes.has(code)) throw new Error("simulated upstream outage");
		// rally 形态:每根 +1.2%(近5根约 +6%,够「强势拉升」档)
		const n = 24;
		const klines = Array.from({ length: n }, (_, i) => {
			const c = (10 * Math.pow(1.012, i)).toFixed(2);
			return `2026-10-${String(i + 1).padStart(2, "0")},10,${c},10.2,9.9,1000`;
		});
		return new Response(JSON.stringify({ data: { klines } }), { status: 200, headers: { "content-type": "application/json" } });
	}
	throw new Error(`unexpected URL in stub: ${u}`);
};

console.log("== 2) route: 批量 + 归一化 + 单只失败缺席 ==");
resetRouteCachesForTests();
const routes = makeRoutes({}, { dshHome: "/tmp", logger: { warn() {} } });
const trendRoute = routes.find((r) => r.path === ROUTES.trend);
assert.ok(trendRoute, "/trend route must be registered");

let res = makeRes();
await trendRoute.handler(makeGet(`${ROUTES.trend}?codes=sh600519,600519,sz000001`), res);
assert.strictEqual(res.statusCode, 200);
let body = json(res);
assert.equal(Object.keys(body.trends).length, 2, "裸代码归一去重 → 2 只");
const t1 = body.trends.sh600519;
assert.ok(t1, "sh600519 必须有趋势");
assert.ok(Array.isArray(t1.closes) && t1.closes.length === 22, `closes 应为 22 根, 实测 ${t1.closes?.length}`);
assert.ok(t1.closes[1] > t1.closes[0], "rally 桩的收盘递增");
assert.equal(t1.label, "强势拉升", `rally 桩 → 强势拉升, 实测 ${t1.label}`);
assert.equal(t1.kind, "up");

// 单只失败:sz000001 拉不到 → 该码缺席,其余仍在
failCodes.add("sz000001");
resetRouteCachesForTests();
res = makeRes();
await trendRoute.handler(makeGet(`${ROUTES.trend}?codes=sh600519,sz000001`), res);
body = json(res);
assert.strictEqual(res.statusCode, 200, "单只失败不整批报错");
assert.equal(body.trends.sh600519 !== undefined, true);
assert.equal(body.trends.sz000001, undefined, "失败码静默缺席");
failCodes.delete("sz000001");

// 参数校验
res = makeRes();
await trendRoute.handler(makeGet(ROUTES.trend), res);
assert.strictEqual(res.statusCode, 400);
assert.match(json(res).error, /缺少参数 codes/);

// 上限 60
res = makeRes();
const many = Array.from({ length: 70 }, (_, i) => `sz0000${String(i).padStart(2, "0")}`.slice(0, 8));
await trendRoute.handler(makeGet(`${ROUTES.trend}?codes=${many.join(",")}`), res);
assert.strictEqual(res.statusCode, 200);
assert.ok(Object.keys(json(res).trends).length <= 60, "一次最多处理 60 只");

console.log("== 3) 缓存:同 code 二次请求不打上游 ==");
resetRouteCachesForTests();
klineCalls = 0;
res = makeRes();
await trendRoute.handler(makeGet(`${ROUTES.trend}?codes=sh600519`), res);
const callsAfterFirst = klineCalls;
assert.ok(callsAfterFirst > 0, "首次必须打上游");
res = makeRes();
await trendRoute.handler(makeGet(`${ROUTES.trend}?codes=sh600519`), res);
assert.strictEqual(res.statusCode, 200);
assert.equal(klineCalls, callsAfterFirst, "5 分钟内二次请求命中缓存,不再打上游");

console.log("\n✅ P3 TREND TEST PASSED: trend hints + batch route + cache behave");
process.exit(0);
