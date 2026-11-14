// 韭菜盒子 — 宿主侧预警引擎。
//
// 以前预警只在浏览器里求值（AlertWatcher 轮询行情自己判断）：网页没开就
// 什么都不发生，规则触发一次即被删除，也没有历史。本模块把求值搬进宿主
// 进程——面板开不开都在盯盘，规则长期有效（冷却期防轰炸），触发落事件流，
// 客户端只消费事件（toast + 系统通知），不再自己判断。
//
// 设计约束：
// - 本模块不碰文件系统、不发网络请求——全部通过依赖注入（读写规则 / 读写
//   事件 / 拉行情 / 拉日K / 缓存 / 交易日历），离线可测；
// - 求值语义与寰镜 MarketLens 对齐：MA 上穿/下破用「昨收 vs 昨MA、现价 vs
//   今MA」判定真穿越，避免横盘贴线时每天误报；
// - 冷却期（默认 30 分钟）内同一条规则不重复触发——规则不再是一次性的，
//   用户删掉的才是删掉的。
//
// 触发时段：仅集合竞价（auction）与盘中（open）求值。盘后价格静止，评了
// 也不会有新穿越，还白白消耗上游配额。

import { sma } from "./indicators.js";

/** 一次求值批量拉行情的分片大小——与 /quote 路由的上游单批上限一致。 */
const QUOTE_CHUNK = 50;

/** MA 规则允许的均线周期（与客户端表单、信号体系里常用的四档对齐）。 */
export const MA_SPANS = [5, 10, 20, 60];

/** 默认冷却分钟数：同一条规则两次触发之间的最小间隔。 */
export const DEFAULT_COOLDOWN_MIN = 30;

/**
 * 规则的人类可读文案（事件流里存的是触发时刻的快照，规则删了历史还在）。
 * @param {object} rule 预警规则（shape 见 /alerts/add 的落盘）
 */
export function ruleLabel(rule) {
	switch (rule.kind) {
		case "above":
			return `价格涨到 ${rule.price}`;
		case "below":
			return `价格跌破 ${rule.price}`;
		case "pctUp":
			return `涨幅达到 ${rule.pct}%`;
		case "pctDown":
			return `跌幅达到 ${rule.pct}%`;
		case "maUp":
			return `上穿 MA${rule.span}`;
		case "maDown":
			return `下破 MA${rule.span}`;
		case "volSpike":
			return `量比达到 ${rule.volRatio}`;
		default:
			return String(rule.kind);
	}
}

/**
 * 纯求值：一条规则对一份行情（MA 类规则外加一对均线值）是否触发。
 * @param {object} rule 预警规则
 * @param {object|null} quote 归一化行情（price/prevClose/changePct/volumeRatio，缺失为 null）
 * @param {object|undefined} ma MA 类规则用：{ prev: 昨日MA, last: 今日MA }
 * @returns {boolean}
 */
export function evaluateRule(rule, quote, ma) {
	if (quote === null || quote === void 0) return false;
	const px = quote.price;
	const prevClose = quote.prevClose;
	const pct = quote.changePct;
	switch (rule.kind) {
		case "above":
			return px !== null && px !== void 0 && px >= rule.price;
		case "below":
			return px !== null && px !== void 0 && px <= rule.price;
		case "pctUp":
			return pct !== null && pct !== void 0 && pct >= rule.pct;
		case "pctDown":
			return pct !== null && pct !== void 0 && pct <= -rule.pct;
		case "volSpike":
			return quote.volumeRatio !== null && quote.volumeRatio !== void 0 && quote.volumeRatio >= rule.volRatio;
		case "maUp": {
			if (ma === void 0 || ma === null) return false;
			if (ma.prev === null || ma.last === null) return false;
			if (px === null || px === void 0 || prevClose === null || prevClose === void 0) return false;
			// 真穿越：昨收还在均线之下，现价已经站上今日均线。
			return prevClose < ma.prev && px >= ma.last;
		}
		case "maDown": {
			if (ma === void 0 || ma === null) return false;
			if (ma.prev === null || ma.last === null) return false;
			if (px === null || px === void 0 || prevClose === null || prevClose === void 0) return false;
			return prevClose > ma.prev && px <= ma.last;
		}
		default:
			return false;
	}
}

/**
 * 由日K收盘价序列算出某均线「昨日值 / 今日值」这对判定输入。
 * @param {Array<{close:number}>} klines 日K（升序）
 * @param {number} span 均线周期
 * @returns {{ prev: number|null, last: number|null }}
 */
export function maPairFromKlines(klines, span) {
	if (!Array.isArray(klines) || klines.length < span + 1) return { prev: null, last: null };
	const closes = klines.map((k) => k.close);
	const series = sma(closes, span);
	const last = series[series.length - 1];
	const prev = series[series.length - 2];
	return { prev: prev === void 0 ? null : prev, last: last === void 0 ? null : last };
}

/**
 * 创建预警引擎。所有副作用（文件、网络、日历）都从外面注入。
 * @param {object} deps
 * @param {() => Array<object>} deps.readAlerts 读规则列表
 * @param {(patches: Array<{id:string,lastFired:number,firedCount:number}>) => void} deps.applyFirePatches
 *   把一批「刚触发」补丁合并回规则存储（调用方负责加锁与持久化）
 * @param {() => {events: Array<object>, seq: number}} deps.readEvents 读事件存储
 * @param {(state: {events: Array<object>, seq: number}) => boolean} deps.writeEvents 写事件存储
 * @param {(codes: string[]) => Promise<Array<object>>} deps.fetchQuotes 批量行情
 * @param {(code: string, opts?: object) => Promise<Array<object>>} deps.fetchDailyKline 日K（前复权）
 * @param {(o: object) => Promise<unknown>} [deps.cached] 单飞缓存（缺省直连）
 * @param {() => object} deps.sessionState 交易日历时段快照（calendar.sessionState）
 * @param {{warn: (e: unknown) => void}} [deps.logger]
 * @param {number} [deps.intervalMs] 求值循环间隔
 * @param {number} [deps.maxEvents] 事件流容量上限
 * @param {() => number} [deps.now]
 */
export function createAlertEngine({
	readAlerts,
	applyFirePatches,
	readEvents,
	writeEvents,
	fetchQuotes,
	fetchDailyKline,
	cached,
	sessionState,
	logger,
	intervalMs = 30000,
	maxEvents = 200,
	now = () => Date.now(),
}) {
	let timer = null;
	let running = false;
	let ticking = false;

	const log = (error) => {
		try {
			logger?.warn?.(error);
		} catch {}
	};

	function newEventId() {
		return `${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	}

	/** 事件存储的读改写：追加、按容量裁剪、落盘。返回当前 state。 */
	function appendEvents(fired) {
		const state = readEvents();
		const events = Array.isArray(state.events) ? state.events.slice() : [];
		let seq = Number.isFinite(state.seq) ? state.seq : 0;
		for (const item of fired) {
			seq += 1;
			events.push({
				seq,
				id: newEventId(),
				alertId: item.rule.id,
				code: item.rule.code,
				name: item.rule.name,
				kind: item.rule.kind,
				label: ruleLabel(item.rule),
				price: item.quote?.price ?? null,
				changePct: item.quote?.changePct ?? null,
				ts: now(),
			});
		}
		const trimmed = events.length > maxEvents ? events.slice(events.length - maxEvents) : events;
		const next = { events: trimmed, seq };
		writeEvents(next);
		return next;
	}

	/** 事件流查询：返回 seq 大于 since 的事件与当前游标。 */
	function listEvents(since = 0) {
		const state = readEvents();
		const events = Array.isArray(state.events) ? state.events : [];
		const sinceNum = Number(since) || 0;
		return { events: events.filter((e) => e.seq > sinceNum), cursor: state.seq ?? 0 };
	}

	/**
	 * 一轮求值。幂等、可并发调用外部防护（ticking 重入锁）；
	 * 返回 { checked, fired, skipped } 便于测试断言。
	 */
	async function tick() {
		if (ticking) return { checked: 0, fired: [], skipped: "reentry" };
		ticking = true;
		try {
			const rules = readAlerts();
			if (!Array.isArray(rules) || rules.length === 0) return { checked: 0, fired: [], skipped: "no-rules" };
			// 非交易时段直接跳过：价格静止，不发任何上游请求。
			const session = sessionState?.();
			if (session && session.session !== "open" && session.session !== "auction") {
				return { checked: 0, fired: [], skipped: session.session ?? "closed" };
			}
			const nowMs = now();
			// 冷却期内的规则本轮不参与，也不再为它拉行情。
			const due = rules.filter((r) => nowMs - (Number(r.lastFired) || 0) >= (Number(r.cooldownMin ?? DEFAULT_COOLDOWN_MIN) || 0) * 60000);
			if (due.length === 0) return { checked: 0, fired: [], skipped: "cooldown" };
			const codes = Array.from(new Set(due.map((r) => r.code)));
			const quotes = [];
			for (let i = 0; i < codes.length; i += QUOTE_CHUNK) {
				try {
					quotes.push(...(await fetchQuotes(codes.slice(i, i + QUOTE_CHUNK))));
				} catch (error) {
					log(error); // 单批失败不拖垮其余批次
				}
			}
			if (quotes.length === 0) return { checked: 0, fired: [], skipped: "no-quotes" };
			const byCode = new Map(quotes.map((q) => [q.code, q]));
			// MA 规则按需拉日K：同一代码多条 MA 规则共用一份，且走缓存单飞。
			const maCache = new Map();
			const maFor = async (code, span) => {
				const key = `${code}|${span}`;
				if (maCache.has(key)) return maCache.get(key);
				let pair = { prev: null, last: null };
				try {
					const load = () => fetchDailyKline(code, { lmt: Math.max(span + 10, 40) });
					const klines = typeof cached === "function" ? await cached({ name: "alert-kline", key, ttlMs: () => 5 * 60 * 1000, max: 120, load }) : await load();
					pair = maPairFromKlines(klines, span);
				} catch (error) {
					log(error); // K线拿不到 → 该规则本轮静默跳过，不误报
				}
				maCache.set(key, pair);
				return pair;
			};
			const fired = [];
			for (const rule of due) {
				const quote = byCode.get(rule.code);
				if (quote === void 0) continue;
				const ma = rule.kind === "maUp" || rule.kind === "maDown" ? await maFor(rule.code, rule.span) : void 0;
				if (!evaluateRule(rule, quote, ma)) continue;
				fired.push({ rule, quote });
			}
			if (fired.length === 0) return { checked: due.length, fired: [], skipped: "" };
			applyFirePatches(
				fired.map(({ rule }) => ({
					id: rule.id,
					lastFired: nowMs,
					firedCount: (Number(rule.firedCount) || 0) + 1,
				}))
			);
			appendEvents(fired);
			return { checked: due.length, fired, skipped: "" };
		} finally {
			ticking = false;
		}
	}

	function schedule() {
		if (!running) return;
		timer = setTimeout(() => {
			timer = null;
			tick()
				.catch(log)
				.finally(() => schedule());
		}, intervalMs);
		// 定时器不阻止进程退出（面板/宿主关闭时引擎随进程走，无需等待）。
		timer.unref?.();
	}

	return {
		/** 启动周期求值；立即先跑一轮（启动即补一轮启动前错过的状态）。 */
		start() {
			if (running) return;
			running = true;
			tick()
				.catch(log)
				.finally(() => schedule());
		},
		stop() {
			running = false;
			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}
		},
		tick,
		listEvents,
	};
}
