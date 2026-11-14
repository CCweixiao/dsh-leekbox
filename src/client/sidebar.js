// 韭菜盒子 LeekBox — 客户端 bundle 源码：侧边栏入口
// 由 build.mjs 打包进 lib/client.js（npm run build）；不要手改产物。
//
// 入口位置两种落点：
// - "top"    侧边栏顶部区块（logo / 新建会话行之后），上游默认行为；
// - "bottom" 侧边栏页脚动作区（官方 footerActions 容器，设置按钮旁）。
// 位置存 localStorage（PLACEMENT_KEY），改动通过 PLACEMENT_EVENT 广播，
// 已挂载的入口立即重新落位；底部落点找不到页脚容器时回退顶部。

export const PLACEMENT_KEY = "leekbox.sidebarPlacement";
const PLACEMENT_EVENT = "leekbox:placement";

/** 当前入口位置："top" | "bottom"。缺省 "bottom"（设置旁）。 */
export function getSidebarPlacement() {
	try {
		return localStorage.getItem(PLACEMENT_KEY) === "top" ? "top" : "bottom";
	} catch {
		return "bottom";
	}
}

/** 写入入口位置并广播，让已挂载的入口立即重新落位。 */
export function setSidebarPlacement(value) {
	try {
		localStorage.setItem(PLACEMENT_KEY, value === "top" ? "top" : "bottom");
	} catch {}
	window.dispatchEvent(new CustomEvent(PLACEMENT_EVENT));
}

function sidebarColumn() {
	return document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]');
}
function topRoot() {
	const column = sidebarColumn();
	if (column === null) return void 0;
	return column.querySelector('[class*="logoRow"]')?.parentElement ?? column.firstElementChild;
}
/** 底部落点：页脚动作区容器（官方 `sidebar.footer.action` 槽位的渲染节点）。 */
function bottomRoot() {
	return sidebarColumn()?.querySelector('[class*="footerActions"]') ?? void 0;
}
function newSessionButton(root) {
	const nested = root.querySelector("button[class*=\"newSession\"]");
	if (nested !== null) return nested;
	for (const child of root.children) if (child.tagName === "BUTTON") return child;
}
function createEntry(options) {
	const entry = document.createElement("button");
	entry.type = "button";
	entry.setAttribute(options.rowAttribute, "");
	if (options.plugin !== void 0) {
		entry.setAttribute("data-dsh-plugin", options.plugin);
		entry.setAttribute("data-dsh-part", "sidebar-entry");
	}
	entry.className = options.css["entry"] ?? "";
	entry.setAttribute("aria-label", options.label());
	if (options.tooltip !== void 0) entry.setAttribute("title", options.tooltip());
	entry.innerHTML = "<span class=\"" + (options.css["entryIcon"] ?? "") + "\">" + options.icon + "</span><span class=\"" + (options.css["entryLabel"] ?? "") + "\">" + options.label() + "</span>";
	entry.addEventListener("click", options.onToggle);
	return entry;
}
function familyAnchor(container, entry, options) {
	const family = Array.from(container.children).filter((el) => el instanceof HTMLElement && el.matches(options.familySelectors.join(", ")));
	if (family.length > 0) return family[family.length - 1].nextElementSibling;
	if (options.position === "before") return container.firstElementChild;
	return null;
}
/** 顶部落点：锚定 logo / 新建会话行之后（上游行为）。 */
function placeTop(root, entry, options) {
	const button = newSessionButton(root);
	if (button === void 0) return false;
	if (entry.parentElement !== root) {
		const row = button.closest('[class*="logoRow"]');
		const base = row !== null && row.parentElement === root ? row : button;
		const family = Array.from(root.children).filter((el) => el instanceof HTMLElement && el.matches(options.familySelectors.join(", ")));
		const anchor =
			options.position === "before"
				? family.length > 0
					? family[0]
					: base.nextElementSibling
				: family.length > 0
					? family[family.length - 1].nextElementSibling
					: base.nextElementSibling;
		root.insertBefore(entry, anchor);
	}
	return true;
}
/** 底部落点：页脚动作区内，跟在其他同类动作之后（没有就排在最后）。 */
function placeBottom(footer, entry, options) {
	if (entry.parentElement !== footer) {
		const anchor = familyAnchor(footer, entry, options);
		if (anchor === null) footer.appendChild(entry);
		else footer.insertBefore(entry, anchor);
	}
	return true;
}
export function mountSidebarEntry(options) {
	if (typeof document !== "undefined" && document.querySelector(options.rowSelector) !== null) return () => {};
	const entry = createEntry(options);
	let target;
	let placed = false;
	let targetObserver = null;
	const disconnectTargetObserver = () => {
		if (targetObserver !== null) {
			targetObserver.disconnect();
			targetObserver = null;
		}
	};
	const tryPlace = () => {
		if (target !== void 0 && !target.isConnected) {
			disconnectTargetObserver();
			target = void 0;
			placed = false;
		}
		if (placed) {
			if (document.body.contains(entry)) return;
			disconnectTargetObserver();
			target = void 0;
			placed = false;
		}
		const wantBottom = options.placement?.() === "bottom";
		const footer = wantBottom ? bottomRoot() : void 0;
		const next = footer ?? topRoot();
		if (next === void 0) return;
		entry.classList.toggle("lkb_entryBottom", next === footer);
		target = next;
		placed = next === footer ? placeBottom(target, entry, options) : placeTop(target, entry, options);
		if (placed) {
			if (targetObserver === null) {
				targetObserver = new MutationObserver(() => {
					if (target === void 0 || !target.isConnected) {
						disconnectTargetObserver();
						placed = false;
						target = void 0;
						tryPlace();
						return;
					}
					if (!target.contains(entry)) tryPlace();
				});
			}
			targetObserver.disconnect();
			targetObserver.observe(target, { childList: true, subtree: true });
		}
	};
	const waitObserver = new MutationObserver(() => {
		tryPlace();
	});
	waitObserver.observe(document.body, { childList: true, subtree: true });
	const onPlacementChanged = () => {
		placed = false;
		tryPlace();
	};
	window.addEventListener(PLACEMENT_EVENT, onPlacementChanged);
	tryPlace();
	return () => {
		waitObserver.disconnect();
		disconnectTargetObserver();
		window.removeEventListener(PLACEMENT_EVENT, onPlacementChanged);
		entry.remove();
	};
}
