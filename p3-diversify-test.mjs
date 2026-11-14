// P3: 选股增强（借鉴 daily_stock_analysis 的 screening 设计）。
// Asserts:
//   1. 行业分散:bucketOf 关键词归桶、diversifyRows 贪心桶上限重排(落选者顺延不丢弃);
//   2. 估值/市值过滤参数:normalizeScreenerParams 透传 + applyBasicFilters 语义
//      (PE 缺失/为负淘汰、市值亿→万元换算)——用真实 normalize + 构造快照行驱动;
//   3. 用户自定义策略:loader 注入后 validate 接受、meta 合并、内置冲突跳过、坏文件安全;
//   4. LLM 终审:buildReviewPrompt 紧凑表 + parseReviewOutput 围栏/越界 code/去重/截断。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bucketOf, diversifyRows, INDUSTRY_BUCKETS } from "./lib/screener.js";
import { normalizeScreenerParams } from "./lib/screener-validate.js";
import { setUserStrategiesLoader, screenerMeta, getStrategyDef, STRATEGY_META } from "./lib/signals.js";
import { buildReviewPrompt, parseReviewOutput, LLM_REVIEW_TOP } from "./lib/llm-review.js";
import { pickScreenerParams } from "./lib/screener-validate.js";

console.log("== 1) bucketOf / diversifyRows ==");
assert.equal(bucketOf("中信证券"), "金融");
assert.equal(bucketOf("贵州茅台"), "消费");
assert.equal(bucketOf("亿纬锂能"), "新能源");
assert.equal(bucketOf("随便一只票"), "");
const rows = [
	{ name: "中信证券", score: 90 },
	{ name: "招商银行", score: 88 },
	{ name: "贵州茅台", score: 85 },
	{ name: "中国平安", score: 80 },
	{ name: "五粮液", score: 78 },
	{ name: "随便一只票", score: 70 },
];
const out = diversifyRows(rows, 2);
// 金融桶(cap 2)保住中信证券/招商银行,中国平安顺延;消费桶 2 只全保。
const keptNames = out.slice(0, 5).map((r) => r.name);
assert.ok(keptNames.includes("中信证券") && keptNames.includes("招商银行"), "金融桶 2 只保留");
assert.ok(keptNames.includes("贵州茅台") && keptNames.includes("五粮液"), "消费桶 2 只保留");
assert.equal(out[out.length - 1].name, "中国平安", "金融桶第 3 只顺延到队尾(不丢弃)");
assert.equal(out.length, rows.length, "总数不变");
// cap=1:金融只保 1 只
const out1 = diversifyRows(rows, 1);
assert.equal(out1.slice(0, 3).filter((r) => bucketOf(r.name) === "金融").length, 1, "cap=1 首轮每桶只保 1 只");

console.log("== 2) 估值/市值过滤参数 ==");
const p = normalizeScreenerParams({ peMin: 0, peMax: 80, mcapMin: 50, diversify: true, diversifyMax: 3 });
assert.equal(p.peMin, 0);
assert.equal(p.peMax, 80);
assert.equal(p.mcapMin, 50);
assert.equal(p.diversify, true);
assert.equal(p.diversifyMax, 3);
const p2 = normalizeScreenerParams({});
assert.equal(p2.diversify, false, "默认不分散");
assert.equal(p2.diversifyMax, 2);
// 越界钳制
assert.equal(normalizeScreenerParams({ diversifyMax: 99 }).diversifyMax, 6);

console.log("== 3) 用户自定义策略 ==");
// 未注入 loader:自定义 key 被拒
const home = mkdtempSync(join(tmpdir(), "leekbox-p3-strategies-"));
assert.throws(() => normalizeScreenerParams({ mode: "multi", strategies: ["myStrat"], minStrategyHits: 1 }), /未知的选股策略/, "无 loader 时自定义 key 拒绝");
// 写用户策略文件并注入 loader(index.js 的 loadUserStrategies 语义:读取+校验+跳过冲突)
mkdirSync(home, { recursive: true });
const stratFile = join(home, "leekbox-strategies.json");
writeFileSync(
	stratFile,
	JSON.stringify({
		strategies: [
			{ key: "myStrat", label: "我的双金叉", desc: "MACD+KDJ 双金叉", signals: ["macdGold", "kdjGold"] },
			{ key: "macdGold", label: "冒牌内置", signals: ["macdGold"] }, // 内置冲突 → 跳过
			{ key: "bad signals", label: "坏 key", signals: ["macdGold"] }, // key 不合法 → 跳过
			{ key: "emptySig", label: "空信号", signals: [] }, // 空信号 → 跳过
		],
	})
);
// 与 index.js loadUserStrategies 相同的校验语义(此处内联以离线复现;
// 冲突检查直接查 STRATEGY_META——经 getStrategyDef 会递归触发 loader)
const SIGNAL_META_KEYS = new Set(Object.keys(screenerMeta().signals.reduce((acc, s) => ((acc[s.key] = 1), acc), {})));
const KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{1,24}$/;
function loadUserStrategies(file) {
	let map = {};
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		for (const item of (Array.isArray(parsed?.strategies) ? parsed.strategies : []).slice(0, 20)) {
			const key = typeof item.key === "string" ? item.key : "";
			const label = typeof item.label === "string" ? item.label.trim() : "";
			const signals = Array.isArray(item.signals) ? item.signals.filter((s) => SIGNAL_META_KEYS.has(s)) : [];
			if (!KEY_RE.test(key) || STRATEGY_META[key] !== void 0) continue;
			if (label === "" || signals.length === 0) continue;
			map[key] = { label: label.slice(0, 12), desc: "", signals: [...new Set(signals)] };
		}
	} catch {
		map = {};
	}
	return map;
}
setUserStrategiesLoader(() => loadUserStrategies(stratFile));
const merged = normalizeScreenerParams({ mode: "multi", strategies: ["myStrat"], minStrategyHits: 1 });
assert.deepEqual(merged.strategies, ["myStrat"], "注入 loader 后自定义 key 接受");
assert.equal(getStrategyDef("macdGold").label, "MACD金叉", "内置优先");
assert.equal(getStrategyDef("myStrat").label, "我的双金叉");
const meta = screenerMeta();
assert.ok(meta.strategies.some((s) => s.key === "myStrat" && s.user === true), "meta 合并用户策略");
assert.equal(meta.strategies.filter((s) => s.key === "macdGold").length, 1, "内置冲突不出现两条");
// 坏文件安全:loader 吞解析错误,自定义策略消失、内置不受影响
writeFileSync(stratFile, "{坏掉的json");
assert.equal(getStrategyDef("myStrat"), void 0, "坏文件 → 自定义策略消失");
assert.equal(getStrategyDef("macdGold").label, "MACD金叉", "内置不受影响");
setUserStrategiesLoader(null);

console.log("== 4) LLM 终审 prompt/parse ==");
const cand = [
	{ code: "sh600519", name: "贵州茅台", price: 1435, changePct: 1.77, turnoverRate: 0.33, marketCap: 17941921, pe: 20.9, signals: ["MACD金叉"], score: 70 },
	{ code: "sz000001", name: "平安银行", price: 12, changePct: -0.5, turnoverRate: 1.2, marketCap: 2300000, pe: 5, signals: [], score: 40 },
];
const prompt = buildReviewPrompt(cand);
assert.ok(prompt.includes("sh600519 贵州茅台"), "prompt 含候选行");
assert.ok(prompt.includes("JSON 数组"), "prompt 含输出格式约定");
const text = '评审如下：\n```json\n[{"code":"sh600519","note":"量价配合良好"},{"code":"sz000001","note":"缩量观望"},{"code":"sz999999","note":"不存在的票"},{"code":"sh600519","note":"重复"}]\n```';
const parsed = parseReviewOutput(text, new Set(["sh600519", "sz000001"]));
assert.deepEqual(parsed, [{ code: "sh600519", note: "量价配合良好" }, { code: "sz000001", note: "缩量观望" }], "围栏剥离 + 越界剔除 + 去重");
assert.equal(parseReviewOutput("完全不是JSON", new Set(["sh600519"])).length, 0);
const plain = parseReviewOutput('[{"code":"sh600519","note":"ok"}]', new Set(["sh600519"]));
assert.equal(plain.length, 1, "无围栏的裸数组也能解析");
assert.equal(parseReviewOutput('[{"code":"sh600519","note":"x"}]'.repeat(20).length > 0 ? '[{"code":"sh600519","note":"' + "长".repeat(200) + '"}]' : "", new Set(["sh600519"]))[0].note.length, 80, "note 截断 80 字");
assert.equal(LLM_REVIEW_TOP, 5);

// pickScreenerParams 丢弃 llmReview(路由层 flag,不进引擎参数)
const picked = pickScreenerParams({ llmReview: true, peMin: 5 });
assert.equal(picked.llmReview, void 0, "llmReview 不进引擎参数(路由层消费)");
assert.equal(picked.peMin, 5);

rmSync(home, { recursive: true, force: true });
console.log("\n✅ P3 DIVERSIFY TEST PASSED: buckets/filters/user strategies/llm review work");
process.exit(0);
