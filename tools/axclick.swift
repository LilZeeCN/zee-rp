// 在指定 Axure 文档窗口的画布上发一次真实鼠标点击（用于把粘贴锚点放到页面原点附近）。
//   swift axclick.swift <bundleId> <titleSubstring> <canvasX> <canvasY>
// canvasX/Y 是相对文档窗口左上角的逻辑像素（screencapture 图像坐标 / 2）。
import AppKit
import ApplicationServices

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}
func children(_ el: AXUIElement) -> [AXUIElement] { (attr(el, kAXChildrenAttribute as String) as? [AXUIElement]) ?? [] }
func title(_ el: AXUIElement) -> String { (attr(el, kAXTitleAttribute as String) as? String) ?? "" }
func sleepMs(_ ms: Int) { Thread.sleep(forTimeInterval: Double(ms) / 1000.0) }

let a = CommandLine.arguments
guard a.count >= 5 else { print("usage: axclick.swift <bundleId> <titleSubstr> <dx> <dy>"); exit(2) }
let bundleId = a[1], want = a[2]
let dx = Double(a[3]) ?? 0, dy = Double(a[4]) ?? 0
guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == bundleId }) else { print("NOT_RUNNING"); exit(3) }
app.activate(options: [.activateAllWindows])
sleepMs(700)
let ax = AXUIElementCreateApplication(app.processIdentifier)
if let wins = attr(ax, kAXWindowsAttribute as String) as? [AXUIElement] {
    for w in wins where title(w).contains(want) {
        AXUIElementPerformAction(w, kAXRaiseAction as CFString)
    }
}
sleepMs(600)

let all = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []
guard let win = all.first(where: { item in
    let b = item[kCGWindowBounds as String] as? [String: Any] ?? [:]
    return (item[kCGWindowOwnerPID as String] as? Int) == Int(app.processIdentifier)
        && (item[kCGWindowLayer as String] as? Int) == 0
        && ((item[kCGWindowName as String] as? String) ?? "").contains(want)
        && (b["Height"] as? Double ?? 0) > 100
}), let b = win[kCGWindowBounds as String] as? [String: Any],
   let wx = b["X"] as? Double, let wy = b["Y"] as? Double else {
    print("WINDOW_NOT_FOUND"); exit(4)
}
let pt = CGPoint(x: wx + dx, y: wy + dy)
let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: pt, mouseButton: .left)
move?.post(tap: .cghidEventTap)
sleepMs(150)
if a.contains("move") {
    print("MOVED to screen \(pt.x),\(pt.y)")
    exit(0)
}
let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: pt, mouseButton: .left)
let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: pt, mouseButton: .left)
down?.post(tap: .cghidEventTap)
sleepMs(60)
up?.post(tap: .cghidEventTap)
sleepMs(300)
print("CLICKED at screen \(pt.x),\(pt.y) (window \(wx),\(wy) + \(dx),\(dy))")
