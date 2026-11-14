// 选股 LLM 终审（借鉴 daily_stock_analysis 的 L2 LLM ranking）：
// 因子初筛的 Top 候选带上下文交给模型重排并给一句话理由；解析失败或模型
// 不可用时自动回落纯因子顺序（与 DSA 的 ranking_mode 回落语义一致）。
// 本模块只做纯文本组装与解析；模型调用由路由侧（harnessStreamText）完成。

/** 终审最多看的候选数。 */
export const LLM_REVIEW_TOP = 5;

/** 候选行 → 紧凑描述（一行一票，数值右对齐交给等宽数字渲染是前端的事）。 */
function rowLine(row, index) {
	const cap = Number.isFinite(row.marketCap) && row.marketCap > 0 ? `${(row.marketCap / 10000).toFixed(0)}亿` : "—";
	const pe = Number.isFinite(row.pe) && row.pe > 0 ? `${row.pe}` : "亏损";
	const pct = row.changePct === null || row.changePct === void 0 ? "—" : `${row.changePct >= 0 ? "+" : ""}${row.changePct}%`;
	const sig = Array.isArray(row.signals) && row.signals.length > 0 ? row.signals.join("/") : "无";
	return `${index + 1}. ${row.code} ${row.name}：现价${row.price ?? "—"} 涨跌${pct} 换手${row.turnoverRate ?? "—"}% 市值${cap} PE${pe} 信号[${sig}] 评分${row.score}`;
}

/**
 * 组装终审提示词：候选紧凑表 + 评估维度 + 输出格式（严格 JSON 数组）。
 * @param {Array<object>} rows 因子初筛后的候选（已按评分降序）
 */
export function buildReviewPrompt(rows) {
	const list = (Array.isArray(rows) ? rows : []).slice(0, LLM_REVIEW_TOP);
	return [
		"你是选股终审助手。以下候选已通过技术因子初筛（评分降序）。请从短线视角综合评估每只：动量强度、位置风险（涨幅过大/乖离过高要扣分）、量能配合、信号组合质量，并注意避免名单集中在同一逻辑。",
		"输出要求：只输出一个 JSON 数组，不要任何其他文字；按建议优先级从高到低排序，每项格式 {\"code\":\"代码\",\"note\":\"不超过60字的理由\"}；只评下面列出的候选，全部都要评。",
		"候选清单：",
		...list.map((r, i) => rowLine(r, i)),
	].join("\n");
}

/**
 * 解析模型输出的终审结果。容错：剥掉可能的 ```json 围栏；只保留合法 code；
 * note 截断到 80 字；模型漏评的候选不补。
 * @param {string} text 模型完整输出
 * @param {Set<string>} validCodes 允许出现的代码集合
 * @returns {Array<{code: string, note: string}>}
 */
export function parseReviewOutput(text, validCodes) {
	if (typeof text !== "string" || text.trim() === "") return [];
	let body = text.trim();
	const fenceIdx = body.indexOf("```");
	if (fenceIdx >= 0) {
		const open = body.indexOf("\n", fenceIdx);
		const close = body.indexOf("```", fenceIdx + 3);
		if (open >= 0 && close > open) body = body.slice(open + 1, close).trim();
	}
	// 兜底：截取第一个 [ 到最后一个 ]，容忍模型在 JSON 前后多说了一句话。
	const start = body.indexOf("[");
	const end = body.lastIndexOf("]");
	if (start < 0 || end <= start) return [];
	let arr = null;
	try {
		arr = JSON.parse(body.slice(start, end + 1));
	} catch {
		return [];
	}
	if (!Array.isArray(arr)) return [];
	const out = [];
	const seen = new Set();
	for (const item of arr.slice(0, LLM_REVIEW_TOP)) {
		if (item === null || typeof item !== "object") continue;
		const code = String(item.code ?? "").trim().toLowerCase();
		if (!validCodes.has(code) || seen.has(code)) continue;
		seen.add(code);
		const note = typeof item.note === "string" ? item.note.trim().slice(0, 80) : "";
		out.push({ code, note });
	}
	return out;
}
