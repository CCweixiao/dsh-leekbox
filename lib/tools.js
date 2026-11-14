// 韭菜盒子 — 只读模型工具（DSH 会话里的 AI 可直接调用）。
//
// 让 DSH 里的对话助手能拉 A 股数据：搜索标的、批量行情、日K、以及韭菜盒子
// 特有的 13 项技术信号评分。全部只读公开接口，没有任何交易动词。
//
// 注册形态：不 import @deepseek-ai/dsh-tools（宿主内部包版本会漂移，link 安
// 装的插件解析不到时整包瘫痪），而是手拼与其产物相同的 plain ToolDefinition
// —— name/description/parameters(JSON Schema)/output{schema,render}/execute。
// 参数校验因此由各 execute 自己做（defineTool 的自动校验这里等价手写）。
//
// 工具命名带 leekbox_ 前缀：用户可能同时装寰镜 MarketLens（market_* 工具），
// 两套工具在同一个会话里并存不冲突。

import { computeSignals, scoreOf, strategyHits, STRATEGY_META, SIGNAL_META, SIGNAL_KEYS } from "./signals.js";

const READ_ONLY_NOTE = "只读延迟行情（非 Level-2），不涉及任何交易。";

/** 手拼 defineTool 的产物形状；parameters 用与 compilePropertyMap 等价的转换。 */
function defineTool(options) {
	const properties = {};
	const required = [];
	for (const [key, value] of Object.entries(options.parameters ?? {})) {
		const { required: isRequired, ...rest } = value ?? {};
		properties[key] = rest;
		if (isRequired === true) required.push(key);
	}
	const parameters = { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
	return {
		name: options.name,
		description: options.description,
		parameters,
		output: {
			// 作者简写 { type: "json" }（任意 JSON）在注册表侧编译为空 schema {}。
			schema: options.output?.schema?.type === "json" || options.output?.schema === void 0 ? {} : options.output.schema,
			render: (args, value) => options.output.render(args, value),
		},
		...(options.timeoutMs !== void 0 ? { timeoutMs: options.timeoutMs } : {}),
		...(options.isConcurrencySafe !== void 0 ? { isConcurrencySafe: options.isConcurrencySafe } : {}),
		async execute(args, exec) {
			return await options.execute(args, exec);
		},
	};
}

function badInput(message) {
	const error = new Error(message);
	error.code = "BAD_INPUT";
	throw error;
}

/** 行情一行的模型可读渲染。 */
function quoteLine(q) {
	const pct = q.changePct === null || q.changePct === void 0 ? "—" : `${q.changePct > 0 ? "+" : ""}${q.changePct}%`;
	const px = q.price === null || q.price === void 0 ? "—" : String(q.price);
	const vol = q.volumeRatio === null || q.volumeRatio === void 0 ? "" : ` 量比${q.volumeRatio}`;
	const tr = q.turnoverRate === null || q.turnoverRate === void 0 ? "" : ` 换手${q.turnoverRate}%`;
	return `${q.name} ${q.code}: ${px} ${pct}${vol}${tr}`;
}

/**
 * 构建四个只读工具定义。数据函数全部注入，保持本模块离线可测。
 * @param {object} deps
 * @param {(codes: string[]) => Promise<Array<object>>} deps.fetchQuotes 批量行情（归一化 code → quote）
 * @param {(code: string, opts?: object) => Promise<Array<object>>} deps.fetchDailyKline 东财日K（默认前复权）
 * @param {(raw: string) => string|null} deps.normalizeCode 代码归一化
 * @param {(kw: string, count: number) => Promise<{items: Array<object>, source: string}>} deps.searchLookup 搜索（索引→smartbox→suggest 已在宿主组合好）
 * @param {(kws: Array<{strategyKeys?: string[]}>) => void} [_unused] 预留
 */
export function buildLeekboxTools({ fetchQuotes, fetchDailyKline, normalizeCode, searchLookup }) {
	const leekboxSearch = defineTool({
		name: "leekbox_search",
		description: `按代码、名称、拼音首字母搜索 A 股标的（"gzmt" → 贵州茅台）。返回 code/name/market 与快照价格。沪深京 A 股、ETF、可转债、LOF；不含港美股。${READ_ONLY_NOTE}`,
		parameters: {
			query: { type: "string", required: true, description: "搜索关键词（1-50 字符）：代码 / 名称 / 拼音 / 拼音首字母" },
			limit: { type: "integer", description: "返回条数上限，1-30，默认 12" },
		},
		output: {
			schema: { type: "json" },
			render: (_args, value) => [
				{
					type: "text",
					text:
						value.items.map((it) => `${it.code}  ${it.name}${it.market ? `  ${it.market}` : ""}${it.price !== null && it.price !== void 0 ? `  ${it.price}` : ""}`).join("\n") || "无匹配结果",
				},
			],
		},
		timeoutMs: 15000,
		isConcurrencySafe: () => true,
		async execute(args) {
			const kw = typeof args?.query === "string" ? args.query.trim() : "";
			if (kw === "") throw badInput("query 不能为空");
			const limit = Math.min(Math.max(Number(args?.limit) || 12, 1), 30);
			return await searchLookup(kw.slice(0, 50), limit);
		},
	});

	const leekboxQuotes = defineTool({
		name: "leekbox_quotes",
		description: `批量获取沪深京 A 股实时快照：现价、涨跌幅、量比、换手、振幅、总市值等。最多 50 只；代码支持 600519 / sh600519 / sz000001 等写法。${READ_ONLY_NOTE}`,
		parameters: {
			codes: { type: "array", required: true, items: { type: "string" }, description: "股票代码数组，如 [\"600519\",\"sz000001\"]，最多 50 个" },
		},
		output: {
			schema: { type: "json" },
			render: (_args, value) => [
				{
					type: "text",
					text:
						[...value.quotes.map(quoteLine), ...value.failed.map((f) => `${f.code}: 取不到（${f.reason}）`)].join("\n") || "无行情",
				},
			],
		},
		timeoutMs: 15000,
		isConcurrencySafe: () => true,
		async execute(args) {
			const raw = Array.isArray(args?.codes) ? args.codes : null;
			if (raw === null || raw.length === 0) throw badInput("codes 必须是非空字符串数组");
			const seen = new Set();
			const codes = [];
			for (const item of raw.slice(0, 50)) {
				const code = normalizeCode(String(item ?? ""));
				if (code === null || seen.has(code)) continue;
				seen.add(code);
				codes.push(code);
			}
			if (codes.length === 0) throw badInput("没有可识别的股票代码（示例：600519 / sh600519 / sz000001）");
			const quotes = await fetchQuotes(codes);
			const got = new Set(quotes.map((q) => q.code));
			return {
				quotes,
				failed: codes.filter((c) => !got.has(c)).map((c) => ({ code: c, reason: "上游无此代码或暂无行情" })),
			};
		},
	});

	const leekboxKline = defineTool({
		name: "leekbox_kline",
		description: `单只 A 股的日 K 线（东财源，默认前复权），返回 date/open/high/low/close/volume。count 默认 60，最大 250。${READ_ONLY_NOTE}`,
		parameters: {
			code: { type: "string", required: true, description: "股票代码，如 600519 / sh600519" },
			count: { type: "integer", description: "K 线根数，10-250，默认 60" },
		},
		output: {
			schema: { type: "json" },
			render: (_args, value) => [
				{
					type: "text",
					text: `${value.code} 日K(${value.adjust}) 共 ${value.count} 根\n` + value.bars.map((b) => `${b.date} O${b.open} H${b.high} L${b.low} C${b.close} V${b.volume}`).join("\n"),
				},
			],
		},
		timeoutMs: 20000,
		isConcurrencySafe: () => true,
		async execute(args) {
			const code = normalizeCode(String(args?.code ?? ""));
			if (code === null) throw badInput("股票代码无法识别（示例：600519 / sh600519）");
			const count = Math.min(Math.max(Number(args?.count) || 60, 10), 250);
			const bars = await fetchDailyKline(code, { lmt: count });
			return { code, adjust: "qfq", count: bars.length, bars };
		},
	});

	const leekboxSignals = defineTool({
		name: "leekbox_signals",
		description: `对单只 A 股跑韭菜盒子的 13 项技术信号（MACD/KDJ/RSI 金叉、均线多头、布林突破、放量、连涨、新高等），返回命中信号、加权得分（0-100）与命中的预设策略。判断个股当前技术面状态的快捷入口。${READ_ONLY_NOTE}`,
		parameters: {
			code: { type: "string", required: true, description: "股票代码，如 600519 / sh600519" },
			lookback: { type: "integer", description: "交叉类信号允许的近 N 日内判定窗口，1-10，默认 3" },
		},
		output: {
			schema: { type: "json" },
			render: (_args, value) => [
				{
					type: "text",
					text:
						`${value.code} ${value.name ?? ""}${value.price !== null && value.price !== void 0 ? ` 现价 ${value.price}（${value.changePct > 0 ? "+" : ""}${value.changePct}%）` : ""} 技术信号：得分 ${value.score}/100\n` +
						(value.signals.length > 0 ? `命中：${value.signals.join("、")}\n` : "无命中信号\n") +
						(value.strategies.length > 0 ? `命中策略：${value.strategies.map((s) => s.label).join("、")}` : "未命中任何预设策略"),
				},
			],
		},
		timeoutMs: 20000,
		isConcurrencySafe: () => true,
		async execute(args) {
			const code = normalizeCode(String(args?.code ?? ""));
			if (code === null) throw badInput("股票代码无法识别（示例：600519 / sh600519）");
			const lookback = Math.min(Math.max(Number(args?.lookback) || 3, 1), 10);
			const [klines, quotes] = await Promise.all([
				fetchDailyKline(code, { lmt: 120 }),
				fetchQuotes([code]).catch(() => []),
			]);
			const quote = Array.isArray(quotes) && quotes[0] !== void 0 ? quotes[0] : null;
			const sig = computeSignals(klines, lookback);
			const hitKeys = SIGNAL_KEYS.filter((k) => sig[k]);
			return {
				code,
				name: quote?.name ?? null,
				price: quote?.price ?? null,
				changePct: quote?.changePct ?? null,
				score: scoreOf(sig),
				signals: hitKeys.map((k) => SIGNAL_META[k].label),
				strategies: strategyHits(sig, Object.keys(STRATEGY_META)),
				barsUsed: klines.length,
			};
		},
	});

	return [leekboxSearch, leekboxQuotes, leekboxKline, leekboxSignals];
}
