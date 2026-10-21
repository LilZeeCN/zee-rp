#!/usr/bin/env node
// zee-axure 核心脚本：设计规格(spec) → Axvg JSON → 系统剪贴板 → Axure RP 11 粘贴。
// 零依赖，Node ≥ 18，macOS / Windows 双路径。所有编码规则经 2026-09 落画实测。
//
// 用法：
//   node axvg.mjs build <spec.json> -o <out.axvg.json>   规格展开为完整 Axvg
//   node axvg.mjs paste <file.axvg.json> [--no-menu] [--version 9|11 | --bundle-id <id>]
//                                                        写剪贴板并触发 Axure 粘贴（宿主按版本显式绑定）
//   node axvg.mjs selftest                                内置几何/编码自检
//
// spec 结构（坐标系：frame 内相对像素，y 向下）：
// {
//   "frames": [{
//     "x": 0, "y": 0, "w": 1440, "h": 900, "name": "页面", "bg": "#FFFFFF",
//     "children": [
//       { "kind": "rect",   "x":0,"y":0,"w":200,"h":40, "fill":"#FFFFFF",
//         "border":{"color":"#E6E6E6","thickness":1}, "corners":6, "name":"卡片" },
//       { "kind": "text",   "x":16,"y":14,"w":120,"h":18, "content":"标题",
//         "size":14, "color":"#333333", "weight":700, "align":"left" },
//       { "kind": "circle", "x":20,"y":10,"d":28, "fill":"#D9D9D9" },
//       { "kind": "hline",  "x":0,"y":58,"w":1186, "color":"#EBEBEB", "thickness":1 },
//       { "kind": "line",   "x1":83,"y1":227,"x2":115,"y2":119, "color":"#565656", "thickness":2 },
//       { "kind": "pie",    "cx":156,"cy":123,"r":65,
//         "slices":[{"name":"炒菜","pct":55,"color":"#8C8C8C"},
//                   {"name":"盖饭","pct":25,"color":"#B3B3B3","a1Deg":0,"a2Deg":90}] },
//       { "kind": "shape",  "x":91,"y":58,"w":130,"h":130,
//         "paths":[{ "closed":true, "points":[{"x":0.5,"y":0},{"x":1,"y":0.5},{"x":0.5,"y":1}] }] }
//     ]
//   }]
// }
// 颜色一律 CSS hex；angle 单位为度，0°=3 点方向，正值顺时针（屏幕 y 向下）。

import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolvePasteTarget } from "./version.mjs";
import { pathToFileURL } from "node:url";

const IS_MAIN = import.meta.url === pathToFileURL(process.argv[1] || import.meta.url).href;

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

// ---------- 颜色 ----------
export function hex(h, a = 1) {
  let s = String(h).replace("#", "");
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  const v = parseInt(s, 16);
  return { r: ((v >> 16) & 0xff) / 255, g: ((v >> 8) & 0xff) / 255, b: (v & 0xff) / 255, a };
}

// ---------- widget 默认值（经粘贴实测的最小完整集合，缺 id 会崩） ----------
let nextId = 1;
export function resetIds() { nextId = 1; }
const wid = (p) => `${p}-${nextId++}`;

const widgetDefaults = (name) => ({
  itemType: 1,
  id: wid("w"),
  name: name || "Unnamed",
  visible: true, isLocked: false, isNameDynamic: false, rotation: 0, opacity: 1,
  resizingConstraints: { hasFixedLeft: true, hasFixedRight: false, hasFixedTop: true, hasFixedBottom: false, hasFixedWidth: true, hasFixedHeight: true },
  strokes: [], strokeThickness: 0, strokePattern: [], backgroundFills: [], effects: [],
  textAlignment: 1, textPadding: [], textShadows: [], textRotation: 0,
  isMask: false, booleanOperation: 0, flippedHorizontal: false, flippedVertical: false,
  corners: [0, 0, 0, 0], border: [0, 0, 0, 0], type: 0,
});

const rect_ = (x, y, w, h) => ({ location: { x, y }, size: { width: w, height: h } });
const solid = (c) => [{ type: 1, enabled: true, color: c }];

function fills(fill) {
  if (!fill) return [];
  if (typeof fill === "string") return solid(hex(fill));
  const gradientType = { linear: 0, radial: 1 }[fill.type];
  if (fill.type === "angular") throw new Error("Axure RP 11.0.0.4137 imports angular fills as linear gradients; use linear or radial");
  if (gradientType === undefined) throw new Error(`Unknown gradient type: ${fill.type}`);
  const from = fill.from ?? (gradientType === 0 ? { x: 0, y: 0.5 } : { x: 0.5, y: 0.5 });
  const to = fill.to ?? { x: 1, y: 0.5 };
  if (![from.x, from.y, to.x, to.y].every(Number.isFinite)) throw new Error("Gradient endpoints must have finite x/y");
  if (!Array.isArray(fill.stops) || fill.stops.length < 2) throw new Error("Gradient requires at least two stops");
  let previous = -1;
  const stops = fill.stops.map(stop => {
    const offset = stop.offset;
    if (!Number.isFinite(offset) || offset < 0 || offset > 1 || offset < previous) throw new Error("Gradient offsets must be ordered within 0..1");
    previous = offset;
    return { color: hex(stop.color, stop.opacity ?? 1), offset,
      location: { x: from.x + (to.x - from.x) * offset, y: from.y + (to.y - from.y) * offset } };
  });
  return [{ type: 2, enabled: true, gradientType, from, to, stops,
    ...(gradientType === 1 ? { ellipseLength: fill.ellipseLength ?? 1 } : {}) }];
}

function shadows(items = []) {
  return items.map(shadow => {
    const type = shadow.type ?? "outer";
    if (!["outer", "inner"].includes(type)) throw new Error(`Unknown shadow type: ${type}`);
    return { type: 1, shadowType: type === "inner" ? 1 : 0, enabled: true,
      color: hex(shadow.color ?? "#000000", shadow.opacity ?? 0.25),
      blur: shadow.blur ?? 8, offset: { x: shadow.x ?? 0, y: shadow.y ?? 4 }, spread: shadow.spread ?? 0 };
  });
}

// ---------- 组件展开 ----------
export function expandChild(c) {
  if (c.kind === "group") {
    const items = (c.children || []).flatMap((ch) => { const r = expandChild(ch); return Array.isArray(r) ? r : [r]; });
    return {
      itemType: 0, id: wid("grp"), name: c.name || "Group",
      visible: true, isLocked: false, isNameDynamic: false,
      flippedHorizontal: false, flippedVertical: false, rotation: 0,
      rect: rect_(c.x ?? 0, c.y ?? 0, c.w ?? 0, c.h ?? 0),
      resizingConstraints: { hasFixedLeft: true, hasFixedRight: false, hasFixedTop: true, hasFixedBottom: false, hasFixedWidth: true, hasFixedHeight: true },
      effects: shadows(c.shadows), scene: { items },
    };
  }
  if (c.kind === "rect" || c.kind === "card") {
    const t = c.border?.thickness ?? 0;
    const corners = typeof c.corners === "number" ? [c.corners, c.corners, c.corners, c.corners] : (c.corners ?? [0, 0, 0, 0]);
    return { ...widgetDefaults(c.name), rect: rect_(c.x, c.y, c.w, c.h),
      strokes: c.border ? [{ alignment: 0, fill: fills(c.border.fill ?? c.border.color)[0] }] : [],
      strokeThickness: t, backgroundFills: fills(c.fill), effects: shadows(c.shadows), corners, border: [t, t, t, t] };
  }
  if (c.kind === "circle" || c.kind === "ellipse") {
    const w = c.w ?? c.d ?? 0, h = c.h ?? c.d ?? 0;
    const t = c.border?.thickness ?? 0;
    return { ...widgetDefaults(c.name || "圆形"), rect: rect_(c.x, c.y, w, h),
      strokes: c.border ? [{ alignment: 0, fill: fills(c.border.fill ?? c.border.color)[0] }] : [],
      strokeThickness: t, backgroundFills: fills(c.fill), effects: shadows(c.shadows),
      corners: [999, 999, 999, 999], border: [t, t, t, t] };
  }
  if (c.kind === "hline") {
    const t = c.thickness ?? 1;
    return { ...widgetDefaults(c.name || "分隔线"), rect: rect_(c.x, c.y, c.w, t), backgroundFills: solid(hex(c.color)) };
  }
  if (c.kind === "text") {
    const size = c.size ?? 14;
    const typeface = (c.weight === 700) ? "Inter - Bold" : (c.weight === 600) ? "Inter - Semi Bold" : (c.weight === 500) ? "Inter - Medium" : "Inter - Regular";
    const weight = c.weight === 600 ? 500 : (c.weight ?? 400);
    const align = c.align === "center" ? 1 : c.align === "right" ? 2 : 0;
    const color = hex(c.color ?? "#333333");
    const inlines = Array.from(String(c.content ?? "")).map((ch) => ({
      type: 0, text: ch, family: "Inter", typeface, style: 0, weight,
      textColor: color, size, underline: false, strikethrough: false, superscript: 0,
      baselineOffset: 0, highlight: { a: 1, r: 0, g: 0, b: 0 }, characterSpacing: 0, transform: 0, stretch: 5,
    }));
    const explicitName = typeof c.name === "string" && c.name.trim() !== "";
    return { ...widgetDefaults(explicitName ? c.name.trim() : String(c.content ?? "")), isNameDynamic: !explicitName,
      rect: rect_(c.x, c.y, c.w, c.h), strokes: [], strokeThickness: 0,
      backgroundFills: [], corners: [0, 0, 0, 0], border: [0, 0, 0, 0], textAlignment: 0,
      text: { paragraphs: [{ horizontalAlignment: align, lineSpacing: 0, inlines }] } };
  }
  if (c.kind === "line") {
    // 零高描边旋转矩形 = 精确 SVG 线段（Axure 原生渲染，颜色粗细角度全可控）
    const dx = c.x2 - c.x1, dy = c.y2 - c.y1;
    const L = Math.hypot(dx, dy);
    const theta = (Math.atan2(dy, dx) * 180) / Math.PI;
    const t = c.thickness ?? 2;
    const color = hex(c.color ?? "#565656");
    const mx = (c.x1 + c.x2) / 2, my = (c.y1 + c.y2) / 2;
    return { ...widgetDefaults(c.name || "线段"), rotation: theta,
      rect: rect_(mx - L / 2, my, L, 0),
      strokes: [{ alignment: 0, fill: { type: 1, enabled: true, color } }],
      strokeThickness: t, border: [t, t, t, t] };
  }
  if (c.kind === "image") {
    // 图片填充：fill type 3 + imageMap 引用（Figma 插件逆向实测编码）
    const key = c.imageKey;
    return { ...widgetDefaults(c.name || "图片"), rect: rect_(c.x, c.y, c.w, c.h),
      backgroundFills: [{ type: 3, enabled: true, image: key, isHash: true,
        alignment: { horizontal: c.alignH ?? 1, vertical: c.alignV ?? 1 }, patternFillType: c.patternFillType ?? 4 }] };
  }
  if (c.kind === "shape") {
    // 任意矢量形状：paths 锚点模型（见 references/axvg-format.md）
    const out = { ...widgetDefaults(c.name || "形状"), rect: rect_(c.x, c.y, c.w, c.h),
      backgroundFills: fills(c.fill), effects: shadows(c.shadows), type: 2, svgPaths: [] };
    out.paths = (c.paths || []).map((p) => ({
      closed: !!p.closed, startDecoration: 1, endDecoration: 1,
      data: (p.points || []).map((pt, i) => ({
        type: 3,
        to: { x: pt.x, y: pt.y },
        lowerHandle: { x: pt.in?.x ?? pt.x, y: pt.in?.y ?? pt.y },
        higherHandle: { x: pt.out?.x ?? pt.x, y: pt.out?.y ?? pt.y },
        ...(i === 0 ? {} : {}),
      })),
    }));
    return out;
  }
  if (c.kind === "pie") {
    // 饼图：多个楔形 widget，共用同一 rect —— 圆心与半径在归一化空间严格一致
    const out = [];
    const rect = { x: c.cx - c.r, y: c.cy - c.r, w: c.r * 2, h: c.r * 2 };
    const nx = (px) => (px - rect.x) / rect.w;
    const ny = (py) => (py - rect.y) / rect.h;
    const P = (aDeg) => [c.cx + c.r * Math.cos((aDeg * Math.PI) / 180), c.cy + c.r * Math.sin((aDeg * Math.PI) / 180)];
    const T = (aDeg) => { const a = (aDeg * Math.PI) / 180; return [-Math.sin(a), Math.cos(a)]; };
    let acc = c.startDeg ?? -90; // 默认 12 点方向起，顺时针
    const total = c.slices.reduce((s, sl) => s + (sl.a2Deg != null ? 0 : sl.pct), 0);
    for (const sl of c.slices) {
      const sweepDeg = sl.a2Deg != null ? sl.a2Deg - (sl.a1Deg ?? acc) : (sl.pct / (total || 100)) * 360;
      const a1 = sl.a1Deg ?? acc, a2 = a1 + sweepDeg;
      const nSub = Math.max(1, Math.ceil(Math.abs(sweepDeg) / 72));
      const D = sweepDeg / nSub;
      const K = ((4 / 3) * Math.tan((D * Math.PI / 180) / 4)) * c.r;
      const anchors = [];
      const A = P(a1), TA = T(a1);
      anchors.push({ to: A, lower: A, higher: [A[0] + K * TA[0], A[1] + K * TA[1]] });
      for (let i = 1; i < nSub; i++) {
        const a = a1 + D * i, Pm = P(a), Tm = T(a);
        anchors.push({ to: Pm, lower: [Pm[0] - K * Tm[0], Pm[1] - K * Tm[1]], higher: [Pm[0] + K * Tm[0], Pm[1] + K * Tm[1]] });
      }
      const B = P(a2), TB = T(a2);
      anchors.push({ to: B, lower: [B[0] - K * TB[0], B[1] - K * TB[1]], higher: B });
      const cN = [c.cx, c.cy];
      anchors.push({ to: cN, lower: cN, higher: cN });
      const data = anchors.map((an) => seg3([nx(an.to[0]), ny(an.to[1])], [nx(an.lower[0]), ny(an.lower[1])], [nx(an.higher[0]), ny(an.higher[1])]));
      out.push({ ...widgetDefaults(sl.name || "楔形"),
        rect: rect_(rect.x, rect.y, rect.w, rect.h),
        backgroundFills: solid(hex(sl.color ?? "#CCCCCC")), type: 2,
        paths: [{ closed: true, data, startDecoration: 1, endDecoration: 1 }], svgPaths: [] });
      acc = a2;
    }
    return out;
  }
  throw new Error(`未知 kind: ${c.kind}`);
}

function seg3(to, lower, higher) {
  return { type: 3, to: { x: to[0], y: to[1] }, lowerHandle: { x: lower[0], y: lower[1] }, higherHandle: { x: higher[0], y: higher[1] } };
}

// ---------- frame / 组装 ----------
export function expandSpec(spec) {
  resetIds();
  const imageMap = {};
  for (const [k, v] of Object.entries(spec.images || {})) imageMap[k] = v;
  const frames = (spec.frames || []).map((f) => ({
    id: wid("frame"), name: f.name || "Frame", itemType: 2, isNameDynamic: false,
    rect: rect_(f.x ?? 0, f.y ?? 0, f.w, f.h),
    resizingConstraints: { hasFixedLeft: true, hasFixedRight: false, hasFixedTop: true, hasFixedBottom: false, hasFixedWidth: true, hasFixedHeight: true },
    backgroundFill: { type: 1, enabled: true, color: hex(f.bg ?? "#FFFFFF") },
    backgroundShape: (() => {
      const bg = { ...widgetDefaults(f.name || "Frame"), rect: rect_(0, 0, f.w, f.h),
        resizingConstraints: { hasFixedLeft: true, hasFixedRight: true, hasFixedTop: true, hasFixedBottom: true, hasFixedWidth: false, hasFixedHeight: false },
        backgroundFills: solid(hex(f.bg ?? "#FFFFFF")) };
      return bg;
    })(),
    scene: { items: (f.children || []).flatMap((c) => { const r = expandChild(c); return Array.isArray(r) ? r : [r]; }) },
  }));
  return { masters: {}, imageMap, scene: { items: frames } };
}

// ---------- 剪贴板 + 粘贴 ----------
export function pasteAxvg(axvgJson, { menu = true, version, bundleId } = {}) {
  let text = typeof axvgJson === "string" ? axvgJson : JSON.stringify(axvgJson);
  if (!text.startsWith("// axvg")) text = "// axvg\n" + text;
  const dir = mkdtempSync(join(tmpdir(), "zee-axure-"));
  try {
    const payload = join(dir, "payload.axvg.json");
    writeFileSync(payload, text, "utf8");

    if (IS_MAC) {
      const swift = join(dir, "clip.swift");
      // 关键：mac 版 Axure 从纯文本检测 "// axvg" 头（自定义类型粘贴无效，实测 2026-09）
      writeFileSync(swift, `
import AppKit
let text = try! String(contentsOfFile: "${payload}", encoding: .utf8)
let pb = NSPasteboard.general
pb.clearContents()
let ok = pb.setString(text, forType: NSPasteboard.PasteboardType(rawValue: "public.utf8-plain-text"))
if !ok { print("ERR_SET"); exit(2) }
print("CLIP_OK")
`);
      const r = spawnSync("/usr/bin/env", ["swift", swift], { encoding: "utf8" });
      if (r.status !== 0 || !r.stdout?.includes("CLIP_OK")) throw new Error(`剪贴板写入失败: ${r.error?.message ?? r.stderr ?? r.stdout}`);
    } else if (IS_WIN) {
      const ps = join(dir, "clip.ps1");
      writeFileSync(ps, `
Add-Type -AssemblyName System.Windows.Forms
$text = [System.IO.File]::ReadAllText("${payload.replace(/'/g, "''")}", [System.Text.Encoding]::UTF8)
[System.Windows.Forms.Clipboard]::SetData("Axvg", $text)
[System.Windows.Forms.Clipboard]::SetDataObject($text, $true)
Write-Output "CLIP_OK"
`);
      const r = spawnSync("powershell", ["-ExecutionPolicy", "Bypass", "-NoProfile", "-File", ps], { encoding: "utf8" });
      if (r.status !== 0 || !r.stdout?.includes("CLIP_OK")) throw new Error(`剪贴板写入失败: ${r.error?.message ?? r.stderr ?? r.stdout}`);
    } else {
      throw new Error(`不支持的平台: ${process.platform}（仅 macOS / Windows）`);
    }

    if (!menu || !IS_MAC) return { ok: true, chars: text.length, pasteCommandSent: false, pasted: false, hint: "剪贴板已就绪。请在 Axure 中 Ctrl/Cmd+V。自动菜单粘贴仅支持 macOS 中文界面。" };

    // Axure 缓存剪贴板评估 → 粘贴菜单会变灰；焦点切走再切回强制刷新，然后走菜单粘贴（菜单比模拟按键可靠）。
    // 双版本并行时「第一个名字含 Axure 的进程」会选错程序，所以宿主显式绑定：
    // --bundle-id / AXURE_PASTE_BUNDLE_ID > --version / AXURE_TARGET_VERSION > 唯一在跑的那一版。
    let host;
    try {
      host = resolvePasteTarget({ version, bundleId: bundleId ?? process.env.AXURE_PASTE_BUNDLE_ID });
    } catch (e) {
      throw new Error(`${e.message}\n（Axvg 粘贴需要明确的目标 Axure；双版本并行时不自动选择。）`);
    }
    const PROC = host.processName;
    const focusToggle = () => {
      if (!IS_MAC) return;
      spawnSync("osascript", ["-e", 'tell application "System Events" to set frontmost of (first process whose name contains "Finder") to true'], { encoding: "utf8" });
      spawnSync("sleep", ["0.6"]);
      spawnSync("osascript", ["-e", `tell application "System Events" to set frontmost of (first process whose name is "${PROC}") to true`], { encoding: "utf8" });
    };
    const menuPaste = () => spawnSync("osascript", ["-e",
      `tell application "System Events" to click menu item "粘贴" of menu "编辑" of menu bar 1 of (first process whose name is "${PROC}")`], { encoding: "utf8" });
    const pasteEnabled = () => spawnSync("osascript", ["-e",
      `tell application "System Events" to tell (first process whose name is "${PROC}") to get enabled of menu item "粘贴" of menu "编辑" of menu bar 1`], { encoding: "utf8" }).stdout?.trim() ?? "false";

    let attempts = 0;
    while (attempts < 2) {
      if (pasteEnabled() === "true") break;
      focusToggle();
      attempts++;
    }
    if (pasteEnabled() !== "true") throw new Error('剪贴板已准备，但粘贴菜单不可用；请检查文档页、界面语言及辅助功能权限。');
    spawnSync("osascript", ["-e", 'tell application "System Events" to key code 53']); // Escape 取消选中，避免嵌进选中容器
    const result = menuPaste();
    if (result.status !== 0) throw new Error(`粘贴菜单命令失败: ${result.error?.message ?? result.stderr}`);
    return { ok: true, chars: text.length, host: { version: host.version, label: host.label, bundleId: host.bundleId },
      pasteCommandSent: true, pasted: null,
      hint: "粘贴菜单命令已发送；是否落画尚未验证。先检查画布、大纲和错误对话框，避免重复粘贴叠层，再生成预览对照。" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- selftest ----------
function selftest() {
  const spec = { frames: [{ x: 0, y: 0, w: 300, h: 300, name: "T", bg: "#FFFFFF", children: [
    { kind: "rect", x: 10, y: 10, w: 100, h: 40, fill: "#FFFFFF", border: { color: "#E6E6E6", thickness: 1 }, corners: 6 },
    { kind: "text", x: 20, y: 20, w: 80, h: 18, content: "测试文本", size: 14, weight: 700 },
    { kind: "circle", x: 130, y: 10, d: 40, fill: "#D9D9D9" },
    { kind: "hline", x: 10, y: 60, w: 200, color: "#EEEEEE" },
    { kind: "line", x1: 10, y1: 100, x2: 110, y2: 200, color: "#565656", thickness: 2 },
    { kind: "pie", cx: 230, cy: 90, r: 60, slices: [{ name: "A", pct: 55, color: "#8C8C8C" }, { name: "B", pct: 25, color: "#B3B3B3" }, { name: "C", pct: 20, color: "#D0D0D0" }] },
    { kind: "shape", x: 10, y: 220, w: 60, h: 60, fill: "#E11D48", paths: [{ closed: true, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }] }] },
  ] }] };
  const axvg = expandSpec(spec);
  const w = axvg.scene.items[0].scene.items;
  const assert = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exit(1); } };
  assert(axvg.scene.items.length === 1, "frame 数量");
  // rect
  assert(w[0].corners.join() === "6,6,6,6" && w[0].border[0] === 1, "rect corners/border");
  // text：逐字符 inlines
  assert(w[1].text.paragraphs[0].inlines.length === 4 && w[1].isNameDynamic === true, "text inlines");
  // circle
  assert(w[2].corners.join() === "999,999,999,999", "circle corners");
  // line：旋转 + 零高
  const line = w[4];
  assert(line.rect.size.height === 0 && line.strokeThickness === 2, "line zero-height stroked");
  const expectDeg = (Math.atan2(100, 100) * 180) / Math.PI;
  assert(Math.abs(line.rotation - expectDeg) < 1e-9, `line rotation ${line.rotation} vs ${expectDeg}`);
  // pie：3 个楔形 widget 共享同一 rect（同心同半径），锚点循环模型
  const pie = [w[5], w[6], w[7]];
  assert(pie.every((p) => p?.type === 2 && p?.paths), "pie 楔形为 type:2 矢量");
  const r0 = JSON.stringify(pie[0].rect), r1 = JSON.stringify(pie[1].rect), r2 = JSON.stringify(pie[2].rect);
  assert(r0 === r1 && r1 === r2, "pie 楔形 rect 严格一致（同心同半径）");
  const d = pie[0].paths[0].data;
  assert(d.length === 5, "55% 楔形锚点数 = 起点+2弧中+终点+圆心 (198°分3段)");
  assert(d[0].to.x > 0.4 && d[0].to.y < 0.1, "起点在 12 点方向");
  assert(Math.abs(Math.hypot(d[0].to.x - 0.5, d[0].to.y - 0.5) - 0.5) < 1e-9, "起点在半径 0.5 圆上");
  assert(d[4].to.x === 0.5 && d[4].to.y === 0.5, "末锚点为圆心");
  const mid = d[2];
  const vlen = (p) => Math.hypot(p.x - 0.5, p.y - 0.5);
  assert(Math.abs(vlen(mid.to) - 0.5) < 1e-9, "弧中点在圆上");
  // shape：paths 锚点模型（pie 占 5,6,7，shape 是 8）
  const sh = w[8];
  assert(sh.type === 2 && sh.paths[0].data.length === 3 && sh.paths[0].closed === true, "shape paths");
  console.log("selftest OK — 全部断言通过");
}

// ---------- CLI ----------
const args = IS_MAIN ? process.argv.slice(2) : null;
const cmd = args ? args[0] : null;
if (cmd === "build") {
  const specPath = args[1];
  const oi = args.indexOf("-o");
  const out = oi > 0 ? args[oi + 1] : specPath.replace(/\.spec\.json$/, "") + ".axvg.json";
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  const axvg = expandSpec(spec);
  writeFileSync(out, JSON.stringify(axvg), { encoding: "utf8", flag: "wx" });
  let n = 0;
  const walk = (items) => items.forEach((it) => { n++; if (it.scene?.items) walk(it.scene.items); });
  walk(axvg.scene.items);
  console.log(`built: ${out}  widgets=${n}  frames=${axvg.scene.items.length}`);
  console.log(`下一步: node axvg.mjs paste ${out}`);
} else if (cmd === "paste") {
  const f = args[1];
  if (!f || !existsSync(f)) { console.error(`文件不存在: ${f}`); process.exit(1); }
  const menu = !args.includes("--no-menu");
  const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const r = pasteAxvg(readFileSync(f, "utf8"), { menu, version: flag("--version"), bundleId: flag("--bundle-id") });
  console.log(JSON.stringify(r, null, 2));
} else if (cmd === "selftest") {
  selftest();
} else if (cmd !== null) {
  console.log("用法: node axvg.mjs build <spec.json> -o <out.axvg.json> | paste <axvg.json> [--no-menu] [--version 9|11] [--bundle-id <id>] | selftest");
  process.exit(1);
}
