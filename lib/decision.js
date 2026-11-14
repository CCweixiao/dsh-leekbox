// AI 决策信号：提取、归一、到期复盘与胜率统计。
//
// 借鉴 daily_stock_analysis 的 decision-signals + outcomes 闭环，但口径保持
// 韭菜盒子的「研究观察信号」：action 是研究倾向（偏多关注/中性观望/偏空
// 谨慎）而非交易指令，参考区间/目标价/失效位都是观察参考。
//
// 生命周期：AI 分析首轮正文末尾输出 ```json 信号块 → extractSignal 剥离并
// 归一 → 落库（status=active）→ horizon_days 个交易日后由 /signals 懒复盘
// （reviewSignal 用真实日K对账：目标价/失效位触及优先，否则按窗口收益判
// hit/miss/neutral）→ 胜率统计（signalStats）。

/** 信号容量的硬上限，防止无界增长。 */
export const SIGNAL_MAX = 200;

/** 研究倾向 → 中文标签。 */
export const SIGNAL_ACTIONS = {
	bullish: "偏多关注",
	neutral: "中性观望",
	bearish: "偏空谨慎",
};

const FENCE_OPEN = "```json";

/**
 * 从分析文本末尾提取「研究观察信号」JSON 代码块。
 * 返回 { signal, text }：signal 为归一后的核心字段（无块/解析失败 → null），
 * text 为剥离信号块后的正文（供展示与缓存，模型偶尔格式走样时原样返回）。
 * @param {string} text 模型完整输出
 * @param {{priceAtSignal?: number|null}} [ref] 信号发生时的现价（复盘基准）
 */
export function extractSignal(text, ref = {}) {
	if (typeof text !== "string" || !text.includes(FENCE_OPEN)) return { signal: null, text };
	const idx = text.lastIndexOf(FENCE_OPEN);
	const end = text.indexOf("```", idx + FENCE_OPEN.length);
	if (end < 0) return { signal: null, text };
	let raw = null;
	try {
		raw = JSON.parse(text.slice(idx + FENCE_OPEN.length, end).trim());
	} catch {
		raw = null;
	}
	const signal = normalizeSignal(raw, ref?.priceAtSignal ?? null);
	const clean = signal === null ? text : (text.slice(0, idx).trimEnd() + "\n");
	return { signal, text: signal === null ? text : clean };
}

const numOf = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** 归一并钳制模型给出的字段；不合规（action 不认识等）返回 null。 */
export function normalizeSignal(raw, priceAtSignal = null) {
	if (raw === null || typeof raw !== "object") return null;
	const action = String(raw.action ?? "").toLowerCase();
	if (!(action in SIGNAL_ACTIONS)) return null;
	const confidence = numOf(raw.confidence);
	const score = numOf(raw.score);
	const horizonRaw = numOf(raw.horizon_days) ?? 5;
	const conditions = Array.isArray(raw.watch_conditions)
		? raw.watch_conditions
			.filter((s) => typeof s === "string" && s.trim() !== "")
			.map((s) => s.trim().slice(0, 80))
			.slice(0, 5)
		: [];
	return {
		action,
		confidence: confidence === null ? null : Math.min(Math.max(confidence, 0), 1),
		score: score === null ? null : Math.min(Math.max(Math.round(score), 0), 100),
		horizonDays: Math.min(Math.max(Math.round(horizonRaw), 1), 30),
		referenceLow: numOf(raw.reference_low),
		referenceHigh: numOf(raw.reference_high),
		invalidation: numOf(raw.invalidation),
		targetPrice: numOf(raw.target_price),
		watchConditions: conditions,
		reason: typeof raw.reason === "string" ? raw.reason.trim().slice(0, 160) : "",
		priceAtSignal: numOf(priceAtSignal),
	};
}

const r2 = (v) => Math.round(v * 100) / 100;

/**
 * 到期复盘：信号落库 horizon_days 个「交易日」（以日K日期计）后，用真实
 * 日K对账。目标价/失效位被收盘价触及优先判定，否则按窗口收益判方向。
 * @param {object} signal 落库信号（含 cnDate "YYYY-MM-DD"、horizonDays、action…）
 * @param {Array<{date:string,open:number,close:number,high:number,low:number}>} klines 升序日K
 * @param {number} [nowMs]
 * @returns {object|null} outcome（未到期/数据不足 → null）
 */
export function reviewSignal(signal, klines, nowMs = Date.now()) {
	if (signal === null || signal === void 0 || typeof signal !== "object") return null;
	const horizon = Math.min(Math.max(Math.round(Number(signal.horizonDays) || 5), 1), 30);
	const sigDate = String(signal.cnDate ?? "");
	if (sigDate === "" || !Array.isArray(klines) || klines.length === 0) return null;
	const after = klines.filter((k) => String(k.date) > sigDate);
	if (after.length < horizon) return null; // 观察窗口还没走完
	const win = after.slice(0, horizon);
	const base = Number(signal.priceAtSignal);
	const refPrice = Number.isFinite(base) && base > 0 ? base : Number(win[0].open) || Number(win[0].close);
	if (!Number.isFinite(refPrice) || refPrice <= 0) return null;
	const endPrice = Number(win[win.length - 1].close);
	if (!Number.isFinite(endPrice) || endPrice <= 0) return null;
	const returnPct = r2((endPrice / refPrice - 1) * 100);
	const touchedClose = (level, dir) => {
		if (!Number.isFinite(level)) return false;
		return win.some((k) => (dir === "below" ? Number(k.close) <= level : Number(k.close) >= level));
	};
	const flat = () => {
		// 无目标/失效位可判时：同向超过 ±1% 算命中，反向超过 ±1% 算未中，
		// 其余（横盘）算中性——不把噪音硬判成对错。
		let result = "neutral";
		let note = `窗口收益 ${returnPct >= 0 ? "+" : ""}${returnPct}%，幅度不足 1% 记中性`;
		if (returnPct > 1) {
			result = returnPct > 0 && signal.action === "bearish" ? "miss" : "hit";
			note = `窗口收益 ${returnPct >= 0 ? "+" : ""}${returnPct}%`;
		} else if (returnPct < -1) {
			result = signal.action === "bearish" ? "hit" : "miss";
			note = `窗口收益 ${returnPct}%`;
		}
		return { result, note };
	};
	let outcome;
	if (signal.action === "bullish") {
		if (touchedClose(signal.invalidation, "below")) outcome = { result: "miss", note: `窗口内收盘跌破失效位 ${signal.invalidation}` };
		else if (touchedClose(signal.targetPrice, "above")) outcome = { result: "hit", note: `窗口内收盘触及观察目标 ${signal.targetPrice}` };
		else outcome = flat();
	} else if (signal.action === "bearish") {
		if (touchedClose(signal.invalidation, "above")) outcome = { result: "miss", note: `窗口内收盘升破失效位 ${signal.invalidation}` };
		else if (touchedClose(signal.targetPrice, "below")) outcome = { result: "hit", note: `窗口内收盘触及观察目标 ${signal.targetPrice}` };
		else outcome = flat();
	} else {
		// 中性观望：窗口收益 |±3%| 以内算「确实横盘」命中，否则记 miss。
		if (Math.abs(returnPct) <= 3) outcome = { result: "hit", note: `窗口收益 ${returnPct >= 0 ? "+" : ""}${returnPct}%，横盘符合观望` };
		else outcome = { result: "miss", note: `窗口收益 ${returnPct >= 0 ? "+" : ""}${returnPct}%，走出了单边` };
	}
	return {
		checkedAt: nowMs,
		windowStart: win[0].date,
		windowEnd: win[win.length - 1].date,
		basePrice: refPrice,
		endPrice,
		returnPct,
		result: outcome.result,
		note: outcome.note,
	};
}

/**
 * 胜率统计：按已复盘信号计算整体与分动作命中率。
 * @param {Array<object>} signals 全量信号（含 active 与已复盘）
 */
export function signalStats(signals) {
	const list = Array.isArray(signals) ? signals : [];
	const reviewed = list.filter((s) => s.outcome !== null && s.outcome !== void 0);
	const count = (r) => reviewed.filter((s) => s.outcome.result === r).length;
	const hit = count("hit");
	const miss = count("miss");
	const neutral = count("neutral");
	const done = hit + miss;
	const byAction = Object.keys(SIGNAL_ACTIONS).map((action) => {
		const mine = reviewed.filter((s) => s.action === action);
		const myHit = mine.filter((s) => s.outcome.result === "hit").length;
		const myDone = mine.filter((s) => s.outcome.result !== "neutral").length;
		return {
			action,
			label: SIGNAL_ACTIONS[action],
			reviewed: mine.length,
			hit: myHit,
			hitRatePct: myDone > 0 ? r2((myHit / myDone) * 100) : null,
		};
	});
	return {
		total: list.length,
		active: list.length - reviewed.length,
		reviewed: reviewed.length,
		hit,
		miss,
		neutral,
		hitRatePct: done > 0 ? r2((hit / done) * 100) : null,
		byAction,
	};
}
