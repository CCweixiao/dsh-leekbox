// 韭菜盒子 LeekBox — 客户端 bundle 源码：全局设置弹窗
// 由 build.mjs 打包进 lib/client.js（npm run build）；不要手改产物。
//
// 面板头部 ⚙️ 打开。AI 模型不再在这里配置：模型能力完全复用 DeepSeek Harness
// （宿主 Models 设置页配置提供方与密钥），分析页内选择模型；这里只剩外观与
// 入口偏好。
import { h, useEffect, useState } from "./react.js";
import { getTheme, setTheme } from "./core.js";
import { getSidebarPlacement, setSidebarPlacement } from "./sidebar.js";

/** 主题选项：跟随系统 / 浅色 / 深色。 */
const THEME_OPTIONS = [
	{ key: "system", label: "跟随系统" },
	{ key: "light", label: "浅色" },
	{ key: "dark", label: "深色" },
];

/** 侧边栏入口位置选项：底部（设置旁，默认）/ 顶部（新建会话下方）。 */
const PLACEMENT_OPTIONS = [
	{ key: "bottom", label: "底部（设置旁）" },
	{ key: "top", label: "顶部" },
];

export function SettingsDialog({ onClose }) {
	const [theme, setThemeState] = useState(getTheme());
	const [placement, setPlacementState] = useState(getSidebarPlacement());

	// 捕获阶段 ESC 关闭（阻止冒泡到面板自身的 ESC 链：详情窗 → 面板）。
	useEffect(() => {
		const onKey = (e) => {
			if (e.key !== "Escape") return;
			e.stopPropagation();
			e.preventDefault();
			onClose();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [onClose]);

	return h(
		"div",
		{
			className: "lkb_settingsMask",
			onMouseDown: (e) => e.stopPropagation(),
			onClick: (e) => {
				if (e.target === e.currentTarget) onClose();
			},
		},
		h(
			"div",
			{ className: "lkb_settingsBox", role: "dialog", "aria-label": "全局设置" },
			h(
				"div",
				{ className: "lkb-settingsHead" },
				h("span", { className: "lkb-settingsTitle" }, "⚙️ 全局设置"),
				h("button", { className: "lkb_close", title: "关闭", onClick: onClose }, "✕")
			),
			h(
				"div",
				{ className: "lkb-settingsBody" },
				h(
					"div",
					{ className: "lkb-settingsSection" },
					h("div", { className: "lkb-settingsSectionTitle" }, "主题"),
					h(
						"div",
						{ className: "lkb-seg", role: "radiogroup", "aria-label": "主题" },
						THEME_OPTIONS.map((t) =>
							h(
								"button",
								{
									key: t.key,
									type: "button",
									className: "lkb-segBtn",
									"data-active": theme === t.key ? "true" : "false",
									onClick: () => {
										setTheme(t.key);
										setThemeState(t.key);
									},
								},
								t.label
							)
						)
					)
				),
				h("div", { className: "lkb-settingsDivider" }),
				h(
					"div",
					{ className: "lkb-settingsSection" },
					h("div", { className: "lkb-settingsSectionTitle" }, "侧边栏入口位置"),
					h(
						"div",
						{ className: "lkb-seg", role: "radiogroup", "aria-label": "侧边栏入口位置" },
						PLACEMENT_OPTIONS.map((t) =>
							h(
								"button",
								{
									key: t.key,
									type: "button",
									className: "lkb-segBtn",
									"data-active": placement === t.key ? "true" : "false",
									onClick: () => {
										setSidebarPlacement(t.key);
										setPlacementState(getSidebarPlacement());
									},
								},
								t.label
							)
						)
					),
					h("div", { className: "lkb-anWindowHint", style: { marginTop: 6 } }, "AI 模型在 DeepSeek Harness 的 设置 → Models 页配置，分析页内选择")
				)
			)
		)
	);
}
