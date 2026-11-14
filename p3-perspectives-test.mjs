// P3: 策略视角(lib/perspectives.js)。Asserts:
//   1. 15 个视角齐全,每个都有 label/category/regime/framework/hints;
//   2. buildPerspectiveBlock:注入框架 + 评分参考 + 本地信号事实;未知 key 返回 "";
//   3. 信号事实为空时明确标注"未命中";服务端路由下发清单与定义一致。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PERSPECTIVES, perspectivesList, buildPerspectiveBlock } from "./lib/perspectives.js";

console.log("== 1) 视角完整性 ==");
const keys = Object.keys(PERSPECTIVES);
assert.equal(keys.length, 15, `应有 15 个视角,实测 ${keys.length}`);
for (const [key, p] of Object.entries(PERSPECTIVES)) {
	assert.ok(p.label && p.category && p.regime, `${key} 元数据齐全`);
	assert.ok(typeof p.framework === "string" && p.framework.length > 80, `${key} framework 要有实质内容`);
	assert.ok(typeof p.hints === "string" && p.hints.includes("sentiment_score") === false && p.hints.length > 10, `${key} hints 要有评分参考`);
}
// 关键视角存在(对照 DSA 全集)
for (const key of ["chanTheory", "waveTheory", "emotionCycle", "dragonHead", "hotTheme", "bullTrend"]) {
	assert.ok(key in PERSPECTIVES, `${key} 必须在`);
}
// 忠实性抽查:缠论要有背驰与买卖点;情绪周期要有换手率分档
assert.ok(PERSPECTIVES.chanTheory.framework.includes("背驰"), "缠论框架要含背驰");
assert.ok(PERSPECTIVES.chanTheory.framework.includes("一买"), "缠论框架要含买卖点类型");
assert.ok(PERSPECTIVES.emotionCycle.framework.includes("换手率"), "情绪周期框架要含换手率分档");
assert.ok(PERSPECTIVES.waveTheory.framework.includes("1.618"), "波浪框架要含斐波那契");

console.log("== 2) buildPerspectiveBlock ==");
const block = buildPerspectiveBlock("chanTheory", ["MACD金叉", "放量"]);
assert.ok(block.includes("【策略视角：缠论结构】"));
assert.ok(block.includes("背驰"));
assert.ok(block.includes("评分参考"));
assert.ok(block.includes("MACD金叉、放量"), "信号事实注入");
const empty = buildPerspectiveBlock("chanTheory", []);
assert.ok(empty.includes("未命中任何内置技术信号"), "空事实要明确标注");
assert.equal(buildPerspectiveBlock("nope", []), "", "未知 key 返回空串");
assert.equal(buildPerspectiveBlock("", []), "", "空 key 返回空串");

console.log("== 3) 服务端下发清单与定义一致 ==");
const hostSrc = readFileSync(new URL("./lib/index.js", import.meta.url), "utf8");
assert.match(hostSrc, /perspectivesList\(\)/, "路由要下发清单");
assert.match(hostSrc, /PERSPECTIVES\[body\.perspective\]/, "流式路由要校验视角 key");
assert.match(hostSrc, /computeSignals\(Array\.isArray\(d\.klines\)/, "注入前要本地计算信号事实");
const list = perspectivesList();
assert.equal(list.length, 15);
assert.ok(list.every((p) => p.key in PERSPECTIVES));

console.log("\n✅ P3 PERSPECTIVES TEST PASSED: 15 strategy perspectives + prompt injection work");
process.exit(0);
