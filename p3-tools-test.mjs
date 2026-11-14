// P3: 只读模型工具(lib/tools.js)。Asserts:
//   1. 四个工具的定义形状(name/description/parameters JSON Schema/output.render/execute);
//   2. leekbox_quotes:代码归一化、去重、截断、缺失 → failed[];
//   3. leekbox_kline:count 钳制,透传 fetchDailyKline;
//   4. leekbox_signals:真跑 computeSignals/scoreOf/strategyHits(离线K线);
//   5. leekbox_search:关键词与 limit 传递、render 输出文本块。
import assert from "node:assert/strict";
import { buildLeekboxTools } from "./lib/tools.js";

/** 测试用代码归一化(带前缀或裸 6 位,足以覆盖工具的透传行为)。 */
const normalizeCode = (raw) => {
	const s = String(raw).trim().toLowerCase();
	if (/^(sh|sz|bj)\d{5,6}$/.test(s)) return s;
	const digits = s.replace(/\D/g, "");
	return /^\d{5,6}$/.test(digits) ? "sh" + digits : null;
};

console.log("== 1) 定义形状 ==");
const calls = { quotes: [], kline: [], search: [] };
const tools = buildLeekboxTools({
	fetchQuotes: async (codes) => {
		calls.quotes.push(codes);
		return codes.filter((c) => c !== "sz999999").map((c) => ({ code: c, name: c === "sh600519" ? "贵州茅台" : c, price: 10, prevClose: 9.5, changePct: 5.2, volumeRatio: 1.5, turnoverRate: 1.1 }));
	},
	fetchDailyKline: async (code, opts) => {
		calls.kline.push({ code, opts });
		return Array.from({ length: Math.min(opts?.lmt ?? 60, 40) }, (_, i) => ({ date: `2026-${String((i % 12) + 1).padStart(2, "0")}-01`, open: 10, close: 10 + i * 0.1, high: 11, low: 9.5, volume: 1000 + i }));
	},
	normalizeCode,
	searchLookup: async (kw, count) => {
		calls.search.push({ kw, count });
		return { items: [{ code: "sh600519", name: "贵州茅台", market: "SH", type: "stock", typeLabel: "A股", price: 1435, changePct: 1.2 }], source: "index" };
	},
});
assert.equal(tools.length, 4);
const byName = new Map(tools.map((t) => [t.name, t]));
for (const name of ["leekbox_search", "leekbox_quotes", "leekbox_kline", "leekbox_signals"]) {
	const tool = byName.get(name);
	assert.ok(tool, `${name} 必须存在`);
	assert.ok(typeof tool.description === "string" && tool.description.length > 10);
	assert.equal(tool.parameters.type, "object");
	assert.ok(typeof tool.execute === "function");
	assert.ok(typeof tool.output.render === "function");
}
const search = byName.get("leekbox_search");
assert.deepEqual(search.parameters.required, ["query"], "search.query 必填");
const quotes = byName.get("leekbox_quotes");
assert.deepEqual(quotes.parameters.required, ["codes"], "quotes.codes 必填");
assert.equal(quotes.parameters.properties.codes.type, "array");
assert.equal(quotes.parameters.properties.codes.items.type, "string");
const kline = byName.get("leekbox_kline");
assert.deepEqual(kline.parameters.required, ["code"]);
const signals = byName.get("leekbox_signals");
assert.deepEqual(signals.parameters.required, ["code"]);

console.log("== 2) leekbox_quotes 归一化/去重/failed ==");
let value = await quotes.execute({ codes: ["sh600519", "SH600519", "sh600519", "sz999999", "garbage!!"] }, {});
assert.deepEqual(calls.quotes.at(-1), ["sh600519", "sz999999"], "去重 + 保留无法识别项供上游判断前先剔除? 应只传归一化成功的");
assert.equal(value.quotes.length, 1, "上游只回了 sh600519");
assert.equal(value.failed.length, 1, "sz999999 无行情 → failed[]");
assert.equal(value.failed[0].code, "sz999999");
const rendered = quotes.output.render({}, value);
assert.equal(rendered.length, 1);
assert.match(rendered[0].text, /贵州茅台 sh600519: 10 \+5\.2%/);
await assert.rejects(quotes.execute({ codes: ["garbage!!"] }, {}), /没有可识别的股票代码/, "全部无法识别必须报错");
await assert.rejects(quotes.execute({ codes: [] }, {}), /codes 必须是非空字符串数组/);
await assert.rejects(quotes.execute({}, {}), /codes 必须是非空字符串数组/);

console.log("== 3) leekbox_kline count 钳制 ==");
value = await kline.execute({ code: "600519", count: 9999 }, {});
assert.deepEqual(calls.kline.at(-1), { code: "sh600519", opts: { lmt: 250 } }, "裸代码归一 + 上限 250");
assert.equal(value.code, "sh600519");
assert.equal(value.adjust, "qfq");
assert.equal(value.count, 40);
assert.match(value.bars[0].date, /^2026-/);
const krender = kline.output.render({}, value);
assert.match(krender[0].text, /sh600519 日K\(qfq\) 共 40 根/);
await assert.rejects(kline.execute({ code: "nope" }, {}), /股票代码无法识别/);

console.log("== 4) leekbox_signals 真跑信号 ==");
// 构造 40 根持续上涨K线:必中 aboveMa20/aboveMa60/upStreak,价>均线
const rising = Array.from({ length: 40 }, (_, i) => ({
	date: `d${i}`,
	open: 10 + i * 0.1,
	close: 10.2 + i * 0.15,
	high: 10.3 + i * 0.15,
	low: 9.9 + i * 0.1,
	volume: 2000,
}));
const risingQuotes = async (codes) => [{ code: codes[0], name: "测试涨", price: 15.9, prevClose: 15.8, changePct: 0.6, volumeRatio: 1.2, turnoverRate: 1 }];
const toolsWithRising = buildLeekboxTools({
	fetchQuotes: risingQuotes,
	fetchDailyKline: async () => rising,
	normalizeCode,
	searchLookup: async () => ({ items: [], source: "index" }),
});
const signalsTool = toolsWithRising.find((t) => t.name === "leekbox_signals");
value = await signalsTool.execute({ code: "sh600519" }, {});
assert.equal(value.score > 0, true, `上涨序列得分必须 > 0, got ${value.score}`);
assert.ok(value.signals.includes("站上MA20"), `必中站上MA20, got ${value.signals.join(",")}`);
assert.ok(value.signals.includes("连涨"), `必中连涨, got ${value.signals.join(",")}`);
assert.equal(value.name, "测试涨");
assert.equal(value.barsUsed, 40);
const srender = signalsTool.output.render({}, value);
assert.match(srender[0].text, /技术信号：得分 \d+\/100/);
assert.match(srender[0].text, /现价 15\.9/);
await assert.rejects(signalsTool.execute({ code: "!!" }, {}), /股票代码无法识别/);

console.log("== 5) leekbox_search 参数传递与渲染 ==");
const searchTool = byName.get("leekbox_search");
value = await searchTool.execute({ query: "  茅台  ", limit: 99 }, {});
assert.deepEqual(calls.search.at(-1), { kw: "茅台", count: 30 }, "关键词 trim + limit 上限 30");
assert.equal(value.source, "index");
const sText = searchTool.output.render({}, value);
assert.match(sText[0].text, /sh600519  贵州茅台  SH  1435/);
value = await searchTool.execute({ query: "gzmt" }, {});
assert.deepEqual(calls.search.at(-1), { kw: "gzmt", count: 12 }, "缺省 limit 12");
await assert.rejects(searchTool.execute({ query: "   " }, {}), /query 不能为空/);
await assert.rejects(searchTool.execute({}, {}), /query 不能为空/);

console.log("\n✅ P3 TOOLS TEST PASSED: plain-shape model tools behave end to end");
process.exit(0);
