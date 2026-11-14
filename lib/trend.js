// 自选行「一句话趋势」的唯一定义处。
//
// 借鉴寰镜 MarketLens 的自选行设计：在股票名下用一条方向着色的小字短语
//（强势拉升 / 稳步走高 / 窄幅盘整 / 快速下降 / 加速下挫）概括近期走势。
// 纯本地计算——输入近 22 日收盘价，不发任何请求；宿主经 5 分钟缓存批量
// 供给（见 /api/leekbox/trend 路由），客户端只渲染。

/** 判定窗口：近 22 个交易日（约一个月）。 */
export const TREND_WINDOW = 22;

/**
 * 由升序收盘价序列判定一句话趋势。
 * 规则按序短路，前两条抓强势行情，随后抓下跌，剩余归入盘整/温和——
 * 宁可把模糊行情判成「窄幅盘整」，也不硬贴一个方向。
 *
 * @param {Array<number>} closes 升序收盘价（≤22 根即可，更长会自动截窗）
 * @returns {{ label: string, kind: "up"|"down"|"flat" }|null} 数据不足返回 null
 */
export function trendHint(closes) {
	if (!Array.isArray(closes)) return null;
	const win = closes.slice(-TREND_WINDOW).filter((v) => Number.isFinite(v) && v > 0);
	if (win.length < 6) return null;
	const last = win[win.length - 1];
	const hi = Math.max(...win);
	const lo = Math.min(...win);
	const mid = (hi + lo) / 2 || 1;
	const rangePct = ((hi - lo) / mid) * 100; // 窗口振幅
	const pctAll = (last / win[0]) * 100 - 100; // 窗口累计涨跌
	const pct5 = (last / win[win.length - 6]) * 100 - 100; // 近 5 根涨跌
	if (pct5 >= 5 && pctAll >= 8 && last >= hi * 0.995) return { label: "强势拉升", kind: "up" };
	if (pctAll >= 4 && pct5 >= 0) return { label: "稳步走高", kind: "up" };
	if (pct5 <= -5 && pctAll <= -10 && last <= lo * 1.005) return { label: "加速下挫", kind: "down" };
	if (pct5 <= -4) return { label: "快速下降", kind: "down" };
	// 盘整要求「振幅小且整体没走出去向」——慢牛/阴跌的窄幅波动不算盘整，
	// 否则温和方向行情会被误标成中性。
	if (rangePct <= 8 && Math.abs(pct5) < 2.5 && Math.abs(pctAll) < 2) return { label: "窄幅盘整", kind: "flat" };
	if (pctAll <= -4) return { label: "小幅回落", kind: "down" };
	if (pctAll >= 2) return { label: "温和走高", kind: "up" };
	return { label: "窄幅盘整", kind: "flat" };
}
