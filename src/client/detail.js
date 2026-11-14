// 韭菜盒子 LeekBox — 客户端 bundle 源码：个股详情弹窗（K线/分时/资金流/F10）
// 由 build.mjs 打包进 lib/client.js（npm run build）；不要手改产物。
import { h, useEffect, useRef, useState } from "./react.js";
import { API, api, cnMarket, describeError, fmt, fmtAmount, fmtPct, fmtSign, fmtTime, fmtVol, fmtYi, notifyFailure, trend, useTradingInterval } from "./core.js";

const UP_COLOR = "#e03131";
const DOWN_COLOR = "#0f9d6e";
const MA_DEFS = [
	{ n: 5, color: "#e8590c" },
	{ n: 10, color: "#4263eb" },
	{ n: 20, color: "#9c36b5" },
];

function maSeries(closes, n) {
	const out = new Array(closes.length).fill(null);
	let sum = 0;
	for (let i = 0; i < closes.length; i++) {
		sum += closes[i];
		if (i >= n) sum -= closes[i - n];
		if (i >= n - 1) out[i] = sum / n;
	}
	return out;
}

// 压力位/支撑位(逐日滚动):每日只用截至当日的最近 60 根K线,检测摆动高低点(左右各2根确认),不使用未来数据。
// 压力位 = 收盘价上方最近的摆动高点,支撑位 = 下方最近的摆动低点(均为真实价格水平);
// 无摆动点时回退经典枢轴点,区间极值兜底,恒保证 压力位 >= 收盘 >= 支撑位。仅用于悬停浮窗展示。
function srLevels(klines, idx) {
	const L = 2;
	const win = klines.slice(Math.max(0, idx - 59), idx + 1);
	const m = win.length;
	const cur = klines[idx];
	let res = null;
	let sup = null;
	for (let i = L; i < m - L; i++) {
		let isH = true;
		let isL = true;
		for (let j = i - L; j <= i + L; j++) {
			if (j === i) continue;
			if (win[j].high >= win[i].high) isH = false;
			if (win[j].low <= win[i].low) isL = false;
		}
		if (isH && win[i].high > cur.close && (res === null || win[i].high < res)) res = win[i].high;
		if (isL && win[i].low < cur.close && (sup === null || win[i].low > sup)) sup = win[i].low;
	}
	if (m >= 2) {
		// 回退:经典枢轴点(前一根K线 P=(H+L+C)/3, R1=2P-L, S1=2P-H)
		const p = win[m - 2];
		const pp = (p.high + p.low + p.close) / 3;
		if (res === null) res = 2 * pp - p.low;
		if (sup === null) sup = 2 * pp - p.high;
	}
	// 最终兜底:区间极值
	if (res === null || res <= cur.close) res = Math.max(...win.map((b) => b.high));
	if (sup === null || sup >= cur.close) sup = Math.min(...win.map((b) => b.low));
	return { res, sup };
}

/** 把上游日期/时间压成界面上的短格式：2025-01-06 → 01-06；202501060930 → 01-06 09:30。 */
function shortDate(d) {
	const s = String(d ?? "");
	if (s.includes("-")) return s.slice(5); // 2025-01-06 -> 01-06
	if (/^\d{12}$/.test(s)) return `${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}`;
	return s;
}

// K线绘图用的比例尺（纯函数，便于数值对照测试）。
// y 轴不做等比缩放：svg 的 style.height 恒等于 viewBox 高度，所以 y 方向
// scale 恒为 1（K 线实体不会被压扁/拉长）；x 方向按容器宽度拉伸，这正是
// "填满可用宽度"想要的效果。刻度只需把 [min,max] 线性映射到绘图带。
/** 价格轴刻度：等分 [min,max] 得到 count 个价位的值与纵向位置。 */
export function priceAxisTicks(min, max, top, height, count = 4) {
	const out = [];
	const steps = Math.max(1, Math.floor(count) - 1);
	for (let k = 0; k < count; k++) {
		const frac = k / steps; // 0 = 顶部（最高价）
		out.push({ value: max - frac * (max - min), y: top + frac * height });
	}
	return out;
}

// 日K/周K/月K + 均线 + 成交量 + 右侧价格轴。
function KlineChart({ klines }) {
	const [hover, setHover] = useState(null);
	// 视窗 {count, offset}:count=可见根数,offset=右端被藏起的根数(0=最新价
	// 那根可见)。null = 全览。缩放/平移只改这两个数,Y 轴按可见窗口自适应。
	const [view, setViewState] = useState(null);
	const kwrapRef = useRef(null);
	// 拖拽平移起点(mouse only);放 ref 免得拖拽途中重渲染丢状态。
	const panRef = useRef(null);
	// 滚轮 rAF 合帧:一帧最多应用一次缩放,多格滚动叠乘不丢。
	const wheelRaf = useRef(0);
	// 原生滚监听经它读当前几何(避免每次渲染重挂监听)。
	const geoRef = useRef({ total: 0, count: 0, offset: 0, plotW: 1 });
	const W = 900;
	const PRICE_H = 188;
	const GAP = 10;
	const VOL_H = 52;
	const H = PRICE_H + GAP + VOL_H;
	const AXIS_W = 46;
	const MIN_BARS = 10; // 缩放下限:再少就没法看了
	// 换票/换周期:复位视窗与悬停;并(重)挂原生滚轮监听——React 合成 wheel
	// 是被动的,preventDefault 阻止页面滚动必须走非被动原生监听(寰镜同款)。
	useEffect(() => {
		setViewState(null);
		setHover(null);
		panRef.current = null;
		const wrap = kwrapRef.current;
		if (wrap === null) return void 0;
		let pending = null;
		const flush = () => {
			wheelRaf.current = 0;
			const p = pending;
			pending = null;
			if (p === null) return;
			const g = geoRef.current;
			if (g.total < 2) return;
			// 灵敏度刻意调低:每格 ±8%(寰镜是 1.15,这里 1.08),不轻易一滚就翻倍。
			const factor = p.deltaY > 0 ? 1.08 : 1 / 1.08;
			const minBars = Math.min(MIN_BARS, g.total);
			const next = Math.min(Math.max(Math.round(g.count * factor), minBars), g.total);
			if (next === g.count) return;
			// 光标下的那根 K 线缩放前后保持在同一屏幕位置(锚点缩放)。
			const anchor = g.total - g.count - g.offset + p.frac * g.count;
			const newStart = anchor - p.frac * next;
			setViewState({
				count: next,
				offset: Math.min(Math.max(Math.round(g.total - next - newStart), 0), g.total - next),
			});
		};
		const onWheel = (event) => {
			event.preventDefault();
			const rect = wrap.getBoundingClientRect();
			if (rect.width <= 0) return;
			const vx = (event.clientX - rect.left) / rect.width * W;
			pending = { deltaY: event.deltaY, frac: Math.max(0, Math.min(1, vx / (W - AXIS_W))) };
			if (wheelRaf.current === 0) wheelRaf.current = requestAnimationFrame(flush);
		};
		wrap.addEventListener("wheel", onWheel, { passive: false });
		return () => {
			wrap.removeEventListener("wheel", onWheel);
			if (wheelRaf.current !== 0) cancelAnimationFrame(wheelRaf.current);
			wheelRaf.current = 0;
		};
	}, [klines]);
	if (!Array.isArray(klines) || klines.length < 2) return h("div", { className: "lkb-empty" }, "暂无K线数据");
	const total = klines.length;
	const count = view === null ? total : Math.min(Math.max(Math.round(view.count), Math.min(MIN_BARS, total)), total);
	const offset = view === null ? 0 : Math.min(Math.max(Math.round(view.offset), 0), total - count);
	const zoomed = count < total || offset > 0;
	const start = total - count - offset;
	const vis = klines.slice(start, start + count);
	const n = vis.length;
	const plotW = W - AXIS_W;
	const step = plotW / n;
	const xc = (i) => i * step + step / 2;
	const closes = klines.map((k) => k.close);
	const mas = MA_DEFS.map((d) => maSeries(closes, d.n));
	// Y 轴随可见窗口自适应:放大到局部时,那段的涨跌细节才会被拉开。
	let min = Math.min(...vis.map((k) => k.low));
	let max = Math.max(...vis.map((k) => k.high));
	for (const series of mas) {
		for (let i = start; i < start + n; i++) {
			const v = series[i];
			if (v !== null) {
				if (v < min) min = v;
				if (v > max) max = v;
			}
		}
	}
	if (!(max > min)) {
		min -= 1;
		max += 1;
	}
	const pad = (max - min) * 0.06;
	min -= pad;
	max += pad;
	const py = (v) => 4 + (1 - (v - min) / (max - min)) * (PRICE_H - 8);
	const maxVol = Math.max(...vis.map((k) => k.volume)) || 1;
	const volBase = PRICE_H + GAP + VOL_H - 2;
	const vh = (v) => Math.max(1, v / maxVol * (VOL_H - 6));
	const bodyW = Math.max(1.5, Math.min(step * 0.64, 12));
	const barColor = (i) => vis[i].close >= vis[i].open ? UP_COLOR : DOWN_COLOR;
	// hover.i 是全数组的绝对下标(提示窗的 MA 值与支撑/压力位要回看全量)。
	const absHi = hover === null ? start + n - 1 : Math.min(Math.max(hover.i, start), start + n - 1);
	const locHi = absHi - start;
	const hb = klines[absHi];
	const hPrev = absHi > 0 ? klines[absHi - 1].close : hb.open;
	const hPct = hPrev ? (hb.close - hPrev) / hPrev * 100 : null;
	const sr = srLevels(klines, absHi);
	const onMove = (e) => {
		if (panRef.current !== null) return; // 拖拽平移期间不追十字线
		const rect = e.currentTarget.getBoundingClientRect();
		if (rect.width <= 0) return;
		const vx = (e.clientX - rect.left) / rect.width * W;
		const i = start + Math.min(Math.max(Math.floor(vx / step), 0), n - 1);
		setHover({ i, x: e.clientX - rect.left, y: e.clientY - rect.top });
	};
	const onPanDown = (e) => {
		if (e.pointerType !== "mouse" || e.button !== 0) return;
		panRef.current = { x0: e.clientX, offset0: offset };
	};
	const onPanMove = (e) => {
		const pan = panRef.current;
		if (pan === null) return;
		// 往右拖 = 看更早的K线(窗口左移,offset 增大)。
		const shift = Math.round((e.clientX - pan.x0) / step);
		const next = Math.min(Math.max(pan.offset0 + shift, 0), total - count);
		if (next !== offset) setViewState({ count, offset: next });
	};
	const onPanUp = () => {
		panRef.current = null;
	};
	const resetView = () => {
		setViewState(null);
	};
	geoRef.current = { total, count, offset, plotW };
	const gridYs = [0, 1 / 3, 2 / 3, 1].map((f) => 4 + f * (PRICE_H - 8));
	const axisTicks = priceAxisTicks(min, max, 4, PRICE_H - 8, 4);
	const ticks = Array.from({ length: 6 }, (_, k) => start + Math.round((k * (n - 1)) / 5));
	const tipW = 168;
	const tipH = 196;
	const wrapW = kwrapRef.current !== null && kwrapRef.current.clientWidth > 0 ? kwrapRef.current.clientWidth : W;
	const tipLeft = hover === null ? 0 : hover.x + 14 + tipW > wrapW ? Math.max(0, hover.x - 14 - tipW) : hover.x + 14;
	const tipTop = hover === null ? 0 : hover.y + 14 + tipH > H ? Math.max(0, hover.y - 14 - tipH) : hover.y + 14;
	const lastBar = klines[total - 1];
	return h(
		"div",
		null,
		h(
			"div",
			{
				className: "lkb-kwrap",
				ref: kwrapRef,
				onMouseMove: onMove,
				onMouseLeave: () => {
					if (panRef.current === null) setHover(null);
				},
				onPointerDown: onPanDown,
				onPointerMove: onPanMove,
				onPointerUp: onPanUp,
				onPointerCancel: onPanUp,
				onDoubleClick: resetView,
				title: "滚轮缩放（以光标为锚）· 拖拽平移 · 双击回全览",
				style: zoomed ? { cursor: "grab" } : undefined,
			},
			h(
				"svg",
				{ viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", style: { width: "100%", height: H, display: "block" } },
				gridYs.map(
					(y, gi) => h("line", { key: "g" + gi, x1: 0, x2: plotW, y1: y, y2: y, stroke: "var(--dsw-alias-border-l1,#eceef1)", strokeWidth: 0.6, vectorEffect: "non-scaling-stroke" })
				),
				vis.map((b, i) => {
					const color = barColor(i);
					const x = xc(i);
					const yO = py(b.open);
					const yC = py(b.close);
					const top = Math.min(yO, yC);
					const bh = Math.max(1, Math.abs(yO - yC));
					return h(
						"g",
						{ key: start + i },
						h("line", { x1: x, x2: x, y1: py(b.high), y2: py(b.low), stroke: color, strokeWidth: 1, vectorEffect: "non-scaling-stroke" }),
						h("rect", { x: x - bodyW / 2, y: top, width: bodyW, height: bh, fill: color })
					);
				}),
				mas.map((series, mi) => {
					const pts = [];
					for (let i = start; i < start + n; i++) if (series[i] !== null) pts.push(`${xc(i - start).toFixed(1)},${py(series[i]).toFixed(1)}`);
					return pts.length > 1 ? h("polyline", { key: "ma" + mi, points: pts.join(" "), fill: "none", stroke: MA_DEFS[mi].color, strokeWidth: 1.1, vectorEffect: "non-scaling-stroke", opacity: 0.95 }) : null;
				}),
				// 最新价虚线:只在最新一根可见(右端贴齐)时有意义。
				offset === 0 ? h("line", {
					x1: 0,
					x2: plotW,
					y1: py(lastBar.close),
					y2: py(lastBar.close),
					stroke: lastBar.close >= lastBar.open ? UP_COLOR : DOWN_COLOR,
					strokeDasharray: "5 4",
					strokeWidth: 0.8,
					vectorEffect: "non-scaling-stroke",
					opacity: 0.8
				}) : null,
				h("line", { x1: 0, x2: plotW, y1: PRICE_H + GAP / 2, y2: PRICE_H + GAP / 2, stroke: "var(--dsw-alias-border-l1,#eceef1)", strokeWidth: 0.6, vectorEffect: "non-scaling-stroke" }),
				// 右侧价格轴：只画基准竖线与短刻度线。价位**文字**走下面的 HTML
				// 浮层（`.lkb-maxis`）——svg 是 preserveAspectRatio="none"，文字会被
				// 横向拉伸，MinuteChart 已经为同样的原因用了浮层，这里沿用同一套
				// 类与口径，两个图看起来才一致。
				h("line", { x1: plotW, x2: plotW, y1: 0, y2: PRICE_H, stroke: "var(--dsw-alias-border-l1,#eceef1)", strokeWidth: 0.6, vectorEffect: "non-scaling-stroke" }),
				axisTicks.map(
					(t, ti) => h("line", { key: "ax" + ti, x1: plotW, x2: plotW + 4, y1: t.y, y2: t.y, stroke: "var(--dsw-alias-border-l1,#b7bcc7)", strokeWidth: 0.6, vectorEffect: "non-scaling-stroke" })
				),
				vis.map(
					(k, i) => h("rect", {
						key: "v" + (start + i),
						x: xc(i) - bodyW / 2,
						y: volBase - vh(k.volume),
						width: bodyW,
						height: vh(k.volume),
						fill: barColor(i),
						opacity: 0.55
					})
				),
				hover !== null ? h("line", { x1: xc(locHi), x2: xc(locHi), y1: 2, y2: volBase, stroke: "#868e96", strokeDasharray: "4 3", strokeWidth: 0.8, vectorEffect: "non-scaling-stroke" }) : null
			),
			zoomed ? h(
				"button",
				{ className: "lkb-kzoomReset", onClick: (e) => { e.stopPropagation(); resetView(); }, title: "回到全部K线" },
				"⤢ 全览"
			) : null,
			// 价格轴文字浮层（HTML，避免被 svg 横向拉伸）
			h(
				"div",
				{ className: "lkb-maxis" },
				axisTicks.map(
					(t, ti) => h("span", { key: "l" + ti, className: "lkb-maxL", style: { top: Math.max(10, Math.min(PRICE_H - 2, t.y)) } }, fmt(t.value))
				)
			),
			hover === null ? null : h(
				"div",
				{ className: "lkb-kTip", style: { left: tipLeft, top: tipTop } },
				h("div", { className: "tipDate" }, shortDate(hb.date)),
				h("span", null, "开"),
				h("b", null, fmt(hb.open)),
				h("span", null, "高"),
				h("b", null, fmt(hb.high)),
				h("span", null, "低"),
				h("b", null, fmt(hb.low)),
				h("span", null, "收"),
				h("b", { className: trend(hPct) }, fmt(hb.close), " ", fmtPct(hPct)),
				h("span", null, "量"),
				h("b", null, fmtVol(hb.volume)),
				mas.flatMap((series, mi) => [
					h("span", { className: "ma" + MA_DEFS[mi].n, key: "m" + MA_DEFS[mi].n }, `MA${MA_DEFS[mi].n}`),
					h("b", { key: "v" + MA_DEFS[mi].n, className: "ma" + MA_DEFS[mi].n }, series[absHi] === null ? "—" : fmt(series[absHi]))
				]),
				h("span", { className: "srRes" }, "压力位"),
				h("b", { className: "srRes" }, fmt(sr.res)),
				h("span", { className: "srSup" }, "支撑位"),
				h("b", { className: "srSup" }, fmt(sr.sup))
			),
			h(
				"div",
				{ className: "lkb-kaxis" },
				ticks.map(
					(ti, k) => h("span", { key: `${k}-${ti}`, style: { left: `${Math.min(96, Math.max(4, xc(ti - start) / plotW * 100))}%` } }, shortDate(klines[ti]?.date))
				)
			)
		)
	);
}
function MinuteChart({ points, prevClose, date }) {
	const [hover, setHover] = useState(null);
	const kwrapRef = useRef(null);
	const W = 900;
	const PRICE_H = 188;
	const GAP = 10;
	const VOL_H = 52;
	const H = PRICE_H + GAP + VOL_H;
	if (!Array.isArray(points) || points.length < 2) return h("div", { className: "lkb-empty" }, "暂无分时数据");
	const n = points.length;
	const step = W / n;
	const xc = (i) => i * step + step / 2;
	const avg = new Array(n).fill(null);
	let sumPV = 0;
	let sumV = 0;
	for (let i = 0; i < n; i++) {
		const v = Number(points[i].volume) || 0;
		sumPV += (Number(points[i].price) || 0) * v;
		sumV += v;
		avg[i] = sumV > 0 ? sumPV / sumV : points[i].price;
	}
	const prices = points.map((p) => p.price);
	let min = Math.min(...prices, ...avg);
	let max = Math.max(...prices, ...avg);
	if (prevClose > 0) {
		if (prevClose < min) min = prevClose;
		if (prevClose > max) max = prevClose;
	}
	if (!(max > min)) {
		min -= 1;
		max += 1;
	}
	const pad = (max - min) * 0.08;
	min -= pad;
	max += pad;
	const py = (v) => 4 + (1 - (v - min) / (max - min)) * (PRICE_H - 8);
	const pctAt = (v) => prevClose > 0 ? (v - prevClose) / prevClose * 100 : null;
	const maxVol = Math.max(...points.map((p) => p.volume)) || 1;
	const volBase = PRICE_H + GAP + VOL_H - 2;
	const vh = (v) => Math.max(1, (Number(v) || 0) / maxVol * (VOL_H - 6));
	const volColor = (i) => points[i].price >= (i > 0 ? points[i - 1].price : prevClose > 0 ? prevClose : points[0].price) ? UP_COLOR : DOWN_COLOR;
	const hi = hover === null ? n - 1 : Math.min(Math.max(hover.i, 0), n - 1);
	const hb = points[hi];
	const base = prevClose > 0 ? prevClose : points[0].price;
	const hPct = base > 0 ? (hb.price - base) / base * 100 : null;
	const onMove = (e) => {
		const rect = e.currentTarget.getBoundingClientRect();
		if (rect.width <= 0) return;
		const i = Math.min(Math.max(Math.floor((e.clientX - rect.left) / rect.width * n), 0), n - 1);
		setHover({ i, x: e.clientX - rect.left, y: e.clientY - rect.top });
	};
	const fmtT = (t) => /^\d{4}$/.test(String(t ?? "")) ? `${String(t).slice(0, 2)}:${String(t).slice(2)}` : String(t ?? "");
	const gridYs = [0, 1 / 3, 2 / 3, 1].map((f) => 4 + f * (PRICE_H - 8));
	const yTicks = [max, (min + max) / 2, min];
	const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * (n - 1)));
	const tipW = 150;
	const tipH = 110;
	const wrapW = kwrapRef.current !== null && kwrapRef.current.clientWidth > 0 ? kwrapRef.current.clientWidth : W;
	const tipLeft = hover === null ? 0 : hover.x + 14 + tipW > wrapW ? Math.max(0, hover.x - 14 - tipW) : hover.x + 14;
	const tipTop = hover === null ? 0 : hover.y + 14 + tipH > H ? Math.max(0, hover.y - 14 - tipH) : hover.y + 14;
	const pricePts = points.map((_, i) => `${xc(i).toFixed(1)},${py(points[i].price).toFixed(1)}`).join(" ");
	const avgPts = avg.map((v, i) => `${xc(i).toFixed(1)},${py(v).toFixed(1)}`).join(" ");
	return h(
		"div",
		null,
		h(
			"div",
			{ className: "lkb-kwrap", ref: kwrapRef, onMouseMove: onMove, onMouseLeave: () => setHover(null) },
			h(
				"svg",
				{ viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", style: { width: "100%", height: H, display: "block" } },
				gridYs.map(
					(y, gi) => h("line", { key: "g" + gi, x1: 0, x2: W, y1: y, y2: y, stroke: "var(--dsw-alias-border-l1,#eceef1)", strokeWidth: 0.6, vectorEffect: "non-scaling-stroke" })
				),
				prevClose > 0 ? h("line", { x1: 0, x2: W, y1: py(prevClose), y2: py(prevClose), stroke: "#868e96", strokeDasharray: "4 3", strokeWidth: 0.8, vectorEffect: "non-scaling-stroke", opacity: 0.8 }) : null,
				points.map(
					(_, i) => h("rect", {
						key: "v" + i,
						x: xc(i) - Math.max(0.8, step * 0.3),
						y: volBase - vh(points[i].volume),
						width: Math.max(1.6, step * 0.6),
						height: vh(points[i].volume),
						fill: volColor(i),
						opacity: 0.55
					})
				),
				h("polyline", { points: pricePts, fill: "none", stroke: "#4263eb", strokeWidth: 1.2, vectorEffect: "non-scaling-stroke" }),
				h("polyline", { points: avgPts, fill: "none", stroke: "#f08c00", strokeWidth: 1.1, vectorEffect: "non-scaling-stroke", opacity: 0.95 }),
				h("line", { x1: 0, x2: W, y1: PRICE_H + GAP / 2, y2: PRICE_H + GAP / 2, stroke: "var(--dsw-alias-border-l1,#eceef1)", strokeWidth: 0.6, vectorEffect: "non-scaling-stroke" }),
				hover !== null && hover.i >= 0 && hover.i < n ? h("line", { x1: xc(hover.i), x2: xc(hover.i), y1: 2, y2: volBase, stroke: "#868e96", strokeDasharray: "4 3", strokeWidth: 0.8, vectorEffect: "non-scaling-stroke" }) : null
			),
			h(
				"div",
				{ className: "lkb-maxis" },
				yTicks.map(
					(t, ti) => h("span", { key: "l" + ti, className: "lkb-maxL", style: { top: Math.max(10, Math.min(PRICE_H - 2, py(t))) } }, fmt(t))
				),
				prevClose > 0 ? yTicks.map(
					(t, ti) => h("span", { key: "r" + ti, className: "lkb-maxR " + trend(pctAt(t)), style: { top: Math.max(10, Math.min(PRICE_H - 2, py(t))) } }, fmtPct(pctAt(t)))
				) : null
			),
			hover === null ? null : h(
				"div",
				{ className: "lkb-kTip", style: { left: tipLeft, top: tipTop } },
				h("div", { className: "tipDate" }, `${String(date ?? "").includes("-") ? String(date).slice(5) : String(date ?? "")} ${fmtT(hb.time)}`),
				h("span", null, "价"),
				h("b", { className: trend(hPct) }, fmt(hb.price)),
				h("span", null, "均"),
				h("b", { style: { color: "#f08c00" } }, fmt(avg[hi])),
				h("span", null, "幅"),
				h("b", { className: trend(hPct) }, fmtPct(hPct)),
				h("span", null, "量"),
				h("b", null, fmtVol(hb.volume))
			),
			h(
				"div",
				{ className: "lkb-kaxis" },
				ticks.map(
					(ti, tk) => h("span", { key: tk, style: { left: `${Math.min(96, Math.max(4, xc(ti) / W * 100))}%` } }, fmtT(points[ti]?.time))
				)
			)
		)
	);
}
function FflowChart({ rows }) {
	const [hover, setHover] = useState(null);
	const W = 900;
	const H = 110;
	if (!Array.isArray(rows) || rows.length < 1) return null;
	const n = rows.length;
	const step = W / n;
	const xc = (i) => i * step + step / 2;
	const bw = Math.max(6, Math.min(step * 0.5, 42));
	const vals = rows.map((r) => Number(r.main) || 0);
	const maxAbs = Math.max(...vals.map(Math.abs)) || 1;
	const mid = H / 2;
	const bh = (v) => Math.max(2, Math.abs(v) / maxAbs * (mid - 8));
	const hi = hover === null ? -1 : Math.min(Math.max(hover.i, 0), n - 1);
	return h(
		"div",
		{ className: "lkb-ffwrap", onMouseLeave: () => setHover(null) },
		h(
			"svg",
			{ viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", style: { width: "100%", height: H, display: "block" } },
			h("line", { x1: 0, x2: W, y1: mid, y2: mid, stroke: "var(--dsw-alias-border-l1,#b7bcc7)", strokeWidth: 0.8, vectorEffect: "non-scaling-stroke" }),
			rows.map((r, i) => {
				const v = vals[i];
				const hgt = bh(v);
				const up = v >= 0;
				return h("rect", {
					key: i,
					x: xc(i) - bw / 2,
					y: up ? mid - hgt : mid,
					width: bw,
					height: hgt,
					fill: up ? UP_COLOR : DOWN_COLOR,
					opacity: hi === -1 || hi === i ? 0.85 : 0.35,
					// 悬停判定放在柱子上：以前只有容器的 onMouseLeave，没有任何
					// setter 写过 hover，于是 hi 恒为 -1 —— 高亮永远是"全部亮"、
					// 下面的净流入读数永远不出现，整段是死代码。
					// 用 onMouseEnter 而不是移动事件：柱子是离散的，进入即选中，
					// 不需要按坐标反算下标（窄柱/宽间距下反算会选中相邻那天）。
					onMouseEnter: () => setHover({ i })
				});
			})
		),
		h("div", { className: "lkb-ffaxis" }, rows.map((r, i) => h("span", { key: i, style: { left: `${Math.min(96, Math.max(4, xc(i) / W * 100))}%` } }, String(r.date ?? "").slice(5)))),
		hover === null || hi < 0 ? h("div", { className: "lkb-ffval" }, "悬停柱子查看当日主力净流入") : h("div", { className: "lkb-ffval" }, `${String(rows[hi].date ?? "").slice(5)} 主力净流入 `, h("b", { className: trend(vals[hi]) }, fmtYi(vals[hi])))
	);
}

/** 同比/涨跌小胶囊：复用 lkb-pct 红涨绿跌色板，窄版（塞在数值旁边）。 */
function Yoy({ v }) {
	return h("span", { className: `lkb-pct lkb-yoy ${trend(v)}` }, fmtPct(v));
}

/**
 * 财务摘要 F10：最新期指标瓦片 + 瘦身明细表。
 * 以前是一张 9 列 × 8 行的 11px 素表格，一眼扫不出重点；现在最关心的
 * 「最新一期」用四块瓦片放大呈现（营收/归母净利带同比胶囊），明细表瘦
 * 身到 6 列、数值右侧对齐、斑马行，最新一期整行加粗强调。
 */
function F10Section({ reports }) {
	const latest = reports[0];
	const tile = (label, value, yoy) =>
		h(
			"div",
			{ className: "lkb-finTile", key: label },
			h("div", { className: "lkb-finLabel" }, label),
			h("div", { className: "lkb-finValue" }, value, yoy === null || yoy === void 0 ? null : h(Yoy, { v: yoy }))
		);
	const tiles = h(
		"div",
		{ className: "lkb-finTiles" },
		tile("最新营收", latest.revenue === null || latest.revenue === void 0 ? "—" : `${fmtYi(latest.revenue)}亿`, latest.revenueYoy),
		tile("归母净利", latest.profit === null || latest.profit === void 0 ? "—" : `${fmtYi(latest.profit)}亿`, latest.profitYoy),
		tile("每股收益", latest.eps === null || latest.eps === void 0 ? "—" : `${fmt(latest.eps)}元`, null),
		tile("净资产收益率", latest.roe === null || latest.roe === void 0 ? "—" : `${fmt(latest.roe)}%`, null)
	);
	const rows = reports.map(
		(r) =>
			h(
				"tr",
				{ key: r.period },
				h("td", null, r.period),
				h("td", null, fmtYi(r.revenue), h(Yoy, { v: r.revenueYoy })),
				h("td", null, fmtYi(r.profit), h(Yoy, { v: r.profitYoy })),
				h("td", null, fmt(r.eps)),
				h("td", null, fmt(r.roe) === "—" ? "—" : `${fmt(r.roe)}%`),
				h("td", null, fmt(r.debtRatio) === "—" ? "—" : `${fmt(r.debtRatio)}%`)
			)
	);
	return h(
		"div",
		null,
		tiles,
		h(
			"table",
			{ className: "lkb-finTable lkb-finLatest" },
			h(
				"thead",
				null,
				h("tr", null, h("th", null, "报告期"), h("th", null, "营收(亿)"), h("th", null, "归母净利(亿)"), h("th", null, "EPS(元)"), h("th", null, "ROE"), h("th", null, "负债率"))
			),
			h("tbody", null, rows)
		)
	);
}

/**
 * 资金流分明细：主力净流入一列加双向量条（正红右伸/负绿左伸，以 8 日内
 * 最大绝对值为满格），一眼看出哪天放了多少量；表头右侧给出 8 日主力
 * 合计。其余单/列保持数字但统一右对齐 + 斑马行。
 */
function FlowDetailSection({ rows }) {
	const win = rows.slice(-8);
	const maxAbs = Math.max(...win.map((r) => Math.abs(Number(r.main) || 0)), 1e-8);
	const sumMain = win.reduce((acc, r) => acc + (Number(r.main) || 0), 0);
	const bar = (r) => {
		const v = Number(r.main);
		if (!Number.isFinite(v) || v === 0) return null;
		const w = Math.min(50, (Math.abs(v) / maxAbs) * 50);
		return h("span", {
			className: `lkb-flowBar ${v > 0 ? "lkb-up" : "lkb-down"}`,
			style: v > 0 ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` },
		});
	};
	const body = win.map(
		(r) =>
			h(
				"tr",
				{ key: r.date },
				h("td", null, String(r.date ?? "").slice(5)),
				h(
					"td",
					{ className: "lkb-flowMain" },
					h("span", { className: "lkb-flowTrack" }, bar(r)),
					h("b", { className: trend(r.main) }, fmtYi(r.main))
				),
				h("td", { className: trend(r.xl) }, fmtYi(r.xl)),
				h("td", { className: trend(r.big) }, fmtYi(r.big)),
				h("td", { className: trend(r.middle) }, fmtYi(r.middle)),
				h("td", { className: trend(r.small) }, fmtYi(r.small))
			)
	);
	return h(
		"div",
		null,
		h(
			"table",
			{ className: "lkb-finTable lkb-flowNew" },
			h(
				"thead",
				null,
				h("tr", null, h("th", null, "日期"), h("th", null, "主力净流入"), h("th", null, "超大单"), h("th", null, "大单"), h("th", null, "中单"), h("th", null, "小单"))
			),
			h("tbody", null, body)
		)
	);
}
export function StockDetailWindow({ code, name, isIndex, x, y, z, onFocus, onClose, onWatched }) {
	const [q, setQ] = useState(null);
	const [klines, setKlines] = useState([]);
	const [minute, setMinute] = useState(null);
	const [period, setPeriod] = useState("day");
	const [watching, setWatching] = useState(false);
	const [fflow, setFflow] = useState(null);
	const [f10, setF10] = useState(null);
	const [fflowErr, setFflowErr] = useState("");
	const [f10Err, setF10Err] = useState("");
	const [extraTick, setExtraTick] = useState(0);
	const [error, setError] = useState("");
	const [kError, setKError] = useState("");
	const cardRef = useRef(null);
	const [pos, setPos] = useState({ x, y });
	useEffect(() => {
		let alive = true;
		setError("");
		api(API.quote + `?codes=${code}`).then((d) => alive && setQ((d.quotes ?? [])[0] ?? null)).catch((e) => alive && setError(describeError(e)));
		api(API.watchlist).then((d) => alive && setWatching((d.watchlist ?? []).some((e) => e.code === code))).catch(() => {
		});
		return () => {
			alive = false;
		};
	}, [code]);
	useEffect(() => {
		let alive = true;
		setKError("");
		if (period === "m1") {
			api(API.minute + `?code=${code}`).then((d) => {
				if (alive) {
					setMinute(d ?? null);
					setKlines([]);
				}
			}).catch((e) => {
				if (alive) {
					setMinute(null);
					setKError(describeError(e));
				}
			});
			return () => {
				alive = false;
			};
		}
		setMinute(null);
		api(API.kline + `?code=${code}&period=${period}&count=120&fq=qfq`).then((d) => {
			if (alive) setKlines(d.klines ?? []);
		}).catch((e) => {
			if (alive) {
				setKlines([]);
				setKError(describeError(e));
			}
		});
		return () => {
			alive = false;
		};
	}, [code, period]);
	useEffect(() => {
		let alive = true;
		setFflowErr("");
		api(API.fflow + `?code=${code}&count=30`).then((d) => {
			if (alive) setFflow(d.rows ?? []);
		}).catch((e) => {
			if (alive) {
				setFflow(null);
				setFflowErr(describeError(e));
			}
		});
		return () => {
			alive = false;
		};
	}, [code, extraTick]);
	useEffect(() => {
		let alive = true;
		setF10Err("");
		api(API.f10 + `?code=${code}`).then((d) => {
			if (alive) setF10(d.reports ?? []);
		}).catch((e) => {
			if (alive) {
				setF10(null);
				setF10Err(describeError(e));
			}
		});
		return () => {
			alive = false;
		};
	}, [code, extraTick]);
	useTradingInterval(
		() => {
			api(API.quote + `?codes=${code}`).then((d) => setQ((d.quotes ?? [])[0] ?? null)).catch(() => {
			});
		},
		1e4,
		[code]
	);
	const toggleWatch = () => {
		api(API.watchlist + (watching ? "/remove" : "/add"), { method: "POST", body: { code, name } }).then(() => {
			setWatching(!watching);
			onWatched?.();
		}).catch(notifyFailure(watching ? "移出自选" : "加入自选"));
	};
	const onHeadDown = (e) => {
		if (e.button !== 0) return;
		if (e.target.closest("button") !== null) return;
		e.preventDefault();
		const rect = cardRef.current !== null ? cardRef.current.getBoundingClientRect() : null;
		if (rect === null) return;
		const startX = e.clientX;
		const startY = e.clientY;
		const baseLeft = rect.left;
		const baseTop = rect.top;
		const clampX = (v) => Math.max(8 - rect.width + 80, Math.min(v, window.innerWidth - 80));
		const clampY = (v) => Math.max(8, Math.min(v, window.innerHeight - 40));
		const onMove = (ev) => setPos({ x: clampX(baseLeft + ev.clientX - startX), y: clampY(baseTop + ev.clientY - startY) });
		const onUp = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			document.body.style.userSelect = "";
		};
		document.body.style.userSelect = "none";
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	};
	const centerWindow = () => {
		const rect = cardRef.current !== null ? cardRef.current.getBoundingClientRect() : null;
		if (rect === null) return;
		setPos({
			x: Math.max(8, Math.round((window.innerWidth - rect.width) / 2)),
			y: Math.max(8, Math.round((window.innerHeight - rect.height) / 2))
		});
	};
	const item = (label, value, cls) => h("div", { className: "lkb-qItem" }, h("div", { className: "lkb-qLabel" }, label), h("div", { className: "lkb-qValue " + (cls ?? "") }, value));
	const mkt = cnMarket(String(code ?? "").slice(0, 2).toUpperCase());
	return h(
		"div",
		{ className: "lkb-win", ref: cardRef, style: { left: pos.x, top: pos.y, zIndex: z }, onPointerDown: onFocus },
		h(
			"div",
			{ className: "lkb_head", title: "拖动移动窗口 · 双击居中", onPointerDown: onHeadDown, onDoubleClick: centerWindow },
			h("span", { className: "lkb-headTitle" }, h("span", { className: "lkb-logo" }, "📈"), name ?? code, h("span", { className: "lkb-code" }, code), mkt === "" ? null : h("span", { className: "lkb-mktTag" }, mkt)),
			h(
				"div",
				{ className: "lkb_headRight" },
				isIndex ? h("span", { className: "lkb-mktTag", title: "指数不可交易" }, "指数") : h("button", { className: "lkb-btnGhost", onClick: toggleWatch }, watching ? "★ 已自选" : "☆ 加自选"),
				h("button", { className: "lkb_close", title: "关闭", onClick: onClose }, "✕")
			)
		),
		h(
			"div",
			{ className: "lkb_body" },
			error === "" ? null : h("div", { className: "lkb-error" }, error),
			h(
				"div",
				{ className: "lkb-hero" },
				h(
					"div",
					{ className: "lkb-heroMain" },
					h("div", { className: "lkb-heroPrice " + trend(q?.change) }, fmt(q?.price)),
					h(
						"div",
						{ className: "lkb-heroSub " + trend(q?.change) },
						h("span", null, fmtSign(q?.change)),
						h("span", null, fmtPct(q?.changePct))
					),
					q?.time ? h("div", { className: "lkb-heroMeta" }, "更新 ", fmtTime(q.time)) : null,
					isIndex ? null : h("div", { className: "lkb-heroMeta" }, `涨停 ${fmt(q?.limitUp)} · 跌停 ${fmt(q?.limitDown)}`)
				),
				h(
					"div",
					{ className: "lkb-heroGrid" },
					item("今开", fmt(q?.open)),
					item("昨收", fmt(q?.prevClose)),
					item("最高", fmt(q?.high), "lkb-up"),
					item("最低", fmt(q?.low), "lkb-down"),
					item("成交量", q?.volume === null || q?.volume === void 0 ? "—" : fmtVol(q.volume)),
					item("成交额", q?.amount === null || q?.amount === void 0 ? "—" : fmtAmount((q?.amount ?? 0) * 1e4)),
					item("换手率", q?.turnoverRate === null || q?.turnoverRate === void 0 ? "—" : fmt(q?.turnoverRate) + "%"),
					item("量比", fmt(q?.volumeRatio)),
					item("振幅", q?.amplitude === null || q?.amplitude === void 0 ? "—" : fmt(q?.amplitude) + "%"),
					item("市盈率", fmt(q?.pe)),
					item("市净率", fmt(q?.pb)),
					item("总市值", q?.totalMv === null || q?.totalMv === void 0 ? "—" : fmt(q?.totalMv) + "亿"),
					item("流通市值", q?.floatMv === null || q?.floatMv === void 0 ? "—" : fmt(q?.floatMv) + "亿")
				)
			),
			h(
				"div",
				{ className: "lkb-chartBox" },
				h(
					"div",
					{ className: "lkb-chartTitle" },
					period === "m1" ? "当日分时（均价线为成交量加权）" : "K线（前复权）",
					h(
						"span",
						{ className: "lkb-periodRow" },
						["day", "week", "month", "m1", "m5", "m15", "m30", "m60"].map(
							(p) => h("button", { key: p, className: "lkb-period", "data-active": period === p ? "true" : "false", onClick: () => setPeriod(p) }, { day: "日K", week: "周K", month: "月K", m1: "分时", m5: "5分", m15: "15分", m30: "30分", m60: "60分" }[p])
						)
					)
				),
				kError === "" ? null : h("div", { className: "lkb-error" }, kError),
				period === "m1" ? h(MinuteChart, { points: minute?.points, prevClose: q?.prevClose, date: minute?.date }) : h(KlineChart, { klines })
			),
			fflow !== null && fflow.length > 0 ? h(
				"div",
				{ className: "lkb-chartBox" },
				h("div", { className: "lkb-chartTitle" }, "资金流向（主力净流入柱状图，单位：亿）"),
				h(FflowChart, { rows: fflow.slice(-15) })
			) : fflowErr === "" ? null : h(
				"div",
				{ className: "lkb-chartBox" },
				h("div", { className: "lkb-chartTitle" }, "资金流向（主力净流入柱状图，单位：亿）"),
				h(
					"div",
					{ className: "lkb-error" },
					fflowErr,
					h("button", { className: "lkb-btnGhost", style: { marginLeft: 8 }, onClick: () => setExtraTick((v) => v + 1) }, "重试")
				)
			),
			fflow !== null && fflow.length > 0 ? h(
				"div",
				{ className: "lkb-chartBox" },
				h(
					"div",
					{ className: "lkb-chartTitle" },
					"资金流分明细 · 最近 8 日（亿）",
					h(
						"span",
						{ className: "lkb-flowSum" },
						"近8日主力合计 ",
						h("b", { className: trend(fflow.slice(-8).reduce((acc, r) => acc + (Number(r.main) || 0), 0)) }, fmtYi(fflow.slice(-8).reduce((acc, r) => acc + (Number(r.main) || 0), 0)), "亿")
					)
				),
				h(FlowDetailSection, { rows: fflow })
			) : null,
			f10 !== null && f10.length > 0 ? h(
				"div",
				{ className: "lkb-chartBox" },
				h("div", { className: "lkb-chartTitle" }, "财务摘要（F10 · 最新报告期在前）"),
				h(F10Section, { reports: f10 })
			) : f10Err === "" ? null : h(
				"div",
				{ className: "lkb-chartBox" },
				h("div", { className: "lkb-chartTitle" }, "财务摘要（F10 · 最新报告期在前）"),
				h(
					"div",
					{ className: "lkb-error" },
					f10Err,
					h("button", { className: "lkb-btnGhost", style: { marginLeft: 8 }, onClick: () => setExtraTick((v) => v + 1) }, "重试")
				)
			)
		)
	);
}
