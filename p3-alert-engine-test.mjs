// P3: 宿主侧预警引擎(lib/alert-engine.js)+ 路由接线。Drives the REAL
// registered handlers (lib/index.js makeRoutes) with mock loopback req/res
// and a real temp dshHome, asserting:
//   1. evaluateRule 纯语义:7 类规则、MA 真穿越判定、空字段安全;
//   2. maPairFromKlines 的「昨MA/今MA」对;
//   3. 引擎 tick:交易时段门控、行情批拉、冷却期、事件流落盘与游标;
//   4. 路由:/alerts/add 支持新类型与校验,/alerts/events 增量读;
//   5. 事件容量上限(maxEvents)与 seq 单调。
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAlertEngine, evaluateRule, maPairFromKlines, ruleLabel } from "./lib/alert-engine.js";
import { makeRoutes, ROUTES } from "./lib/index.js";

// ---- 1) evaluateRule 纯语义 ----
console.log("== 1) evaluateRule semantics ==");
const quote = { price: 10.5, prevClose: 10.0, changePct: 5, volumeRatio: 2.3 };
assert.equal(evaluateRule({ kind: "above", price: 10 }, quote), true, "above ≥ fires");
assert.equal(evaluateRule({ kind: "above", price: 11 }, quote), false, "above < no fire");
assert.equal(evaluateRule({ kind: "below", price: 11 }, quote), true);
assert.equal(evaluateRule({ kind: "pctUp", pct: 5 }, quote), true);
assert.equal(evaluateRule({ kind: "pctUp", pct: 6 }, quote), false);
assert.equal(evaluateRule({ kind: "pctDown", pct: 5 }, quote), false, "pctDown 阈值取负比较");
assert.equal(evaluateRule({ kind: "pctDown", pct: 3 }, { ...quote, changePct: -3.2 }), true);
assert.equal(evaluateRule({ kind: "volSpike", volRatio: 2 }, quote), true);
assert.equal(evaluateRule({ kind: "volSpike", volRatio: 3 }, quote), false);
assert.equal(evaluateRule({ kind: "volSpike", volRatio: 2 }, { ...quote, volumeRatio: null }), false, "量比缺失不触发");

// MA 上穿:昨收 < 昨MA 且 现价 ≥ 今MA
assert.equal(evaluateRule({ kind: "maUp", span: 5 }, { ...quote, prevClose: 9.5 }, { prev: 9.8, last: 10.2 }), true, "真上穿触发");
assert.equal(evaluateRule({ kind: "maUp", span: 5 }, { ...quote, prevClose: 10.3 }, { prev: 9.8, last: 10.2 }), false, "昨收已在上方=非穿越");
assert.equal(evaluateRule({ kind: "maUp", span: 5 }, { ...quote, prevClose: 9.5 }, { prev: 9.8, last: 11 }), false, "现价未站上今MA");
assert.equal(evaluateRule({ kind: "maUp", span: 5 }, quote, { prev: null, last: null }), false, "MA 缺失安全");
assert.equal(evaluateRule({ kind: "maUp", span: 5 }, quote, undefined), false);
// MA 下破
assert.equal(evaluateRule({ kind: "maDown", span: 5 }, quote, { prev: 11, last: 10.2 }), false, "现价仍在上方");
assert.equal(
	evaluateRule({ kind: "maDown", span: 5 }, { price: 9.5, prevClose: 10.4, changePct: -8, volumeRatio: 1 }, { prev: 10.0, last: 9.8 }),
	true,
	"昨收在上方、现价跌破今MA"
);

console.log("== 2) maPairFromKlines ==");
// 10 根:前 9 根 MA5=9.8(idx8),第 10 根 close 10.6 → MA5=9.92
const klines = [];
for (let i = 0; i < 9; i++) klines.push({ close: i === 8 ? 9 : 10 });
klines.push({ close: 10.6 });
const pair = maPairFromKlines(klines, 5);
assert.ok(Math.abs(pair.prev - 9.8) < 1e-9, `prev MA5 should be 9.8, got ${pair.prev}`);
assert.ok(Math.abs(pair.last - 9.92) < 1e-9, `last MA5 should be 9.92, got ${pair.last}`);
assert.deepEqual(maPairFromKlines(klines.slice(0, 4), 5), { prev: null, last: null }, "数据不足返回 null 对");

// ---- 路由 mock(与 p0 同款) ----
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

console.log("== 3) route: add 新类型 + 校验 ==");
const home = mkdtempSync(join(tmpdir(), "leekbox-p3-alerts-"));

// stub 引擎:事件走内存,route 的 /events 直接读它
const stubStore = { events: [], seq: 0 };
const stubEngine = {
	listEvents: (since = 0) => ({ events: stubStore.events.filter((e) => e.seq > since), cursor: stubStore.seq }),
};
const routes = makeRoutes({}, { dshHome: home, logger: { warn() {} }, alertEngine: stubEngine });
const alertsAdd = routes.find((r) => r.path === ROUTES.alerts + "/add");
const alertsEvents = routes.find((r) => r.path === ROUTES.alerts + "/events");
assert.ok(alertsEvents, "/alerts/events route must be registered");

let res = makeRes();
await alertsAdd.handler(makePost(ROUTES.alerts + "/add", { code: "sh600519", name: "贵州茅台", kind: "maUp", span: 20 }), res);
assert.strictEqual(res.statusCode, 200, "maUp add must be 200");
let rule = json(res).alerts.find((a) => a.kind === "maUp");
assert.strictEqual(rule.span, 20);
assert.strictEqual(rule.cooldownMin, 30, "默认冷却 30 分钟");
assert.strictEqual(rule.lastFired, 0);
assert.strictEqual(rule.firedCount, 0);

res = makeRes();
await alertsAdd.handler(makePost(ROUTES.alerts + "/add", { code: "sh600519", kind: "maUp", span: 7 }), res);
assert.strictEqual(res.statusCode, 400, "非法均线周期必须 400");
assert.match(json(res).error, /均线周期无效/);

res = makeRes();
await alertsAdd.handler(makePost(ROUTES.alerts + "/add", { code: "sz000001", name: "平安银行", kind: "volSpike", volRatio: 2.5, cooldownMin: 10 }), res);
assert.strictEqual(res.statusCode, 200, "volSpike add must be 200");
rule = json(res).alerts.find((a) => a.kind === "volSpike");
assert.strictEqual(rule.volRatio, 2.5);
assert.strictEqual(rule.cooldownMin, 10, "自定义冷却生效");

res = makeRes();
await alertsAdd.handler(makePost(ROUTES.alerts + "/add", { code: "sz000001", kind: "volSpike", volRatio: 99 }), res);
assert.strictEqual(res.statusCode, 400, "量比阈值越界必须 400");
assert.match(json(res).error, /量比阈值无效/);

res = makeRes();
await alertsAdd.handler(makePost(ROUTES.alerts + "/add", { code: "sh600519", kind: "above", price: 5, cooldownMin: 99999 }), res);
assert.strictEqual(res.statusCode, 400, "冷却分钟数越界必须 400");
assert.match(json(res).error, /冷却分钟数无效/);

// 旧语义去重:pctUp 再加一条同参的 → 400
res = makeRes();
await alertsAdd.handler(makePost(ROUTES.alerts + "/add", { code: "sh600036", name: "招商银行", kind: "pctUp", pct: 4 }), res);
assert.strictEqual(res.statusCode, 200);
res = makeRes();
await alertsAdd.handler(makePost(ROUTES.alerts + "/add", { code: "600036", kind: "pctUp", pct: 4 }), res);
assert.strictEqual(res.statusCode, 400, "裸代码归一后重复仍要 400");

console.log("== 4) 引擎 tick:门控 / 冷却 / 事件流 ==");
// 真实数据函数全部 stub,时间可控
let rules = [];
const firedPatches = [];
const store = { events: [], seq: 0 };
let nowMs = 1_700_000_000_000;
let session = "open";
let quotesToReturn = [];
let klinesToReturn = [];
const engine = createAlertEngine({
	readAlerts: () => rules,
	applyFirePatches: (patches) => {
		firedPatches.push(...patches);
		for (const p of patches) {
			const rule2 = rules.find((r) => r.id === p.id);
			if (rule2) {
				rule2.lastFired = p.lastFired;
				rule2.firedCount = p.firedCount;
			}
		}
	},
	readEvents: () => store,
	writeEvents: (state) => {
		Object.assign(store, state);
		return true;
	},
	fetchQuotes: async (codes) => quotesToReturn.filter((q) => codes.includes(q.code)),
	fetchDailyKline: async () => klinesToReturn,
	sessionState: () => ({ session }),
	now: () => nowMs,
	maxEvents: 3,
	intervalMs: 60000,
});

// 4a. 空规则
let out = await engine.tick();
assert.equal(out.skipped, "no-rules");

// 4b. 休市门控:规则存在但不发任何请求
rules = [{ id: "r1", code: "sh600519", name: "贵州茅台", kind: "above", price: 9, cooldownMin: 0 }];
session = "closed";
out = await engine.tick();
assert.equal(out.skipped, "closed");
assert.equal(firedPatches.length, 0);

// 4c. 盘中触发 + 事件落盘
session = "open";
quotesToReturn = [{ code: "sh600519", name: "贵州茅台", price: 9.5, prevClose: 9.0, changePct: 5.5, volumeRatio: 1.2 }];
out = await engine.tick();
assert.equal(out.fired.length, 1, "above 9 现价 9.5 必须触发");
assert.equal(out.checked, 1);
assert.equal(store.events.length, 1, "事件落盘");
assert.equal(store.events[0].seq, 1);
assert.equal(store.events[0].label, "价格涨到 9");
assert.equal(firedPatches[0].firedCount, 1);
// cooldownMin=0 → 再次 tick 仍触发,seq 递增
out = await engine.tick();
assert.equal(out.fired.length, 1, "冷却 0 分钟重复触发");
assert.equal(store.seq, 2, "事件游标递增");
assert.equal(store.events[store.events.length - 1].seq, 2);

// 4d. 默认冷却:触发后 30 分钟内不再触发
nowMs += 60_000;
rules = [{ id: "r2", code: "sz000001", name: "平安银行", kind: "volSpike", volRatio: 2, cooldownMin: 30 }];
quotesToReturn = [{ code: "sz000001", name: "平安银行", price: 11, prevClose: 10.5, changePct: 4.7, volumeRatio: 2.6 }];
out = await engine.tick();
assert.equal(out.fired.length, 1);
out = await engine.tick();
assert.equal(out.fired.length, 0, "冷却期内不重复触发");
assert.equal(out.skipped, "cooldown");
nowMs += 31 * 60_000;
out = await engine.tick();
assert.equal(out.fired.length, 1, "冷却期过后重新可触发");

// 4e. MA 规则拉日K并按真穿越判定
rules = [{ id: "r3", code: "sh600036", name: "招商银行", kind: "maUp", span: 5, cooldownMin: 0 }];
quotesToReturn = [{ code: "sh600036", name: "招商银行", price: 10.6, prevClose: 9, changePct: 17, volumeRatio: 1 }];
klinesToReturn = [...Array.from({ length: 9 }, (_, i) => ({ close: i === 8 ? 9 : 10 })), { close: 10.6 }];
out = await engine.tick();
assert.equal(out.fired.length, 1, "MA5 真上穿触发");
assert.equal(store.events[store.events.length - 1].label, "上穿 MA5");
// 横盘贴线不触发
quotesToReturn = [{ code: "sh600036", name: "招商银行", price: 10.1, prevClose: 10, changePct: 1, volumeRatio: 1 }];
klinesToReturn = Array.from({ length: 40 }, () => ({ close: 10 }));
out = await engine.tick();
assert.equal(out.fired.length, 0, "横盘贴线不误报");

// 4f. 事件容量上限:store 已有若干事件,再触发到超限,只留最近 maxEvents=3 条
rules = [{ id: "r4", code: "sh600519", name: "贵州茅台", kind: "above", price: 1, cooldownMin: 0 }];
quotesToReturn = [{ code: "sh600519", name: "贵州茅台", price: 9.5, prevClose: 9, changePct: 5, volumeRatio: 1 }];
for (let i = 0; i < 4; i++) await engine.tick();
assert.equal(store.events.length, 3, "事件数不得超过 maxEvents");
const seqs = store.events.map((e) => e.seq);
assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "seq 单调递增");

// 4g. listEvents(since) 增量
const all = engine.listEvents(0);
const since1 = engine.listEvents(all.events[0].seq);
assert.equal(since1.events.length, all.events.length - 1, "since 游标后的增量");
assert.equal(since1.cursor, all.cursor);

console.log("== 5) route: /alerts/events 增量读 ==");
stubStore.events = [
	{ seq: 1, id: "e1", alertId: "r1", code: "sh600519", name: "贵州茅台", kind: "above", label: "价格涨到 9", price: 9.5, changePct: 5, ts: nowMs },
	{ seq: 2, id: "e2", alertId: "r2", code: "sz000001", name: "平安银行", kind: "volSpike", label: "量比达到 2", price: 11, changePct: 4.7, ts: nowMs },
];
stubStore.seq = 2;
res = makeRes();
await alertsEvents.handler(makeGet(ROUTES.alerts + "/events"), res);
assert.strictEqual(res.statusCode, 200);
assert.equal(json(res).events.length, 2);
assert.equal(json(res).cursor, 2);
res = makeRes();
await alertsEvents.handler(makeGet(ROUTES.alerts + "/events?since=1"), res);
assert.equal(json(res).events.length, 1, "since 游标生效");
assert.equal(json(res).events[0].seq, 2);

console.log("== 6) ruleLabel 全类型 ==");
assert.equal(ruleLabel({ kind: "maDown", span: 60 }), "下破 MA60");
assert.equal(ruleLabel({ kind: "volSpike", volRatio: 3 }), "量比达到 3");
assert.equal(ruleLabel({ kind: "pctDown", pct: 4 }), "跌幅达到 4%");
assert.equal(ruleLabel({ kind: "unknown" }), "unknown");

rmSync(home, { recursive: true, force: true });
console.log("\n✅ P3 ALERT-ENGINE TEST PASSED: host-side evaluation + events feed + routes work");
process.exit(0);
