// 通过 Accessibility API 驱动本机 Axure（本项目里 osascript/System Events 被拒绝，
// 但 AXUIElement 直接调用可用）。用法：
//   swift axtool.swift menus  com.axure.AxureRP9
//   swift axtool.swift dump   com.axure.AxureRP9 <菜单名>
//   swift axtool.swift press  com.axure.AxureRP9 <菜单名> <菜单项名>
//   swift axtool.swift enable com.axure.AxureRP9 <菜单名> <菜单项名>
import AppKit
import ApplicationServices

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}
func children(_ el: AXUIElement) -> [AXUIElement] {
    (attr(el, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
}
func title(_ el: AXUIElement) -> String { (attr(el, kAXTitleAttribute as String) as? String) ?? "" }

func raiseById(_ app: NSRunningApplication, _ num: Int) {
    app.activate(options: [])
    Thread.sleep(forTimeInterval: 0.4)
    let ax = AXUIElementCreateApplication(app.processIdentifier)
    if let wins = attr(ax, kAXWindowsAttribute as String) as? [AXUIElement] {
        for w in wins {
            var n: CFTypeRef?
            AXUIElementCopyAttributeValue(w, "AXWindowNumber" as CFString, &n)
            if let v = n as? Int, v == num {
                AXUIElementPerformAction(w, kAXRaiseAction as CFString)
                AXUIElementSetAttributeValue(w, kAXMainAttribute as CFString, kCFBooleanTrue)
                print("RAISED_ID \(num)")
            }
        }
    }
    Thread.sleep(forTimeInterval: 0.5)
}

func raiseTarget(_ app: NSRunningApplication, _ sub: String) {
    app.activate(options: [])
    Thread.sleep(forTimeInterval: 0.5)
    let ax = AXUIElementCreateApplication(app.processIdentifier)
    if let wins = attr(ax, kAXWindowsAttribute as String) as? [AXUIElement] {
        for w in wins where title(w).contains(sub) {
            AXUIElementPerformAction(w, kAXRaiseAction as CFString)
            AXUIElementSetAttributeValue(w, kAXMainAttribute as CFString, kCFBooleanTrue)
        }
    }
    Thread.sleep(forTimeInterval: 0.5)
}

let args = CommandLine.arguments
guard args.count >= 3 else { print("usage: axtool.swift <menus|dump|press|enable|windows> <bundleId> [menu] [item] [--raise substr]"); exit(2) }
let action = args[1], bundleId = args[2]
guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == bundleId }) else {
    print("NOT_RUNNING \(bundleId)"); exit(3)
}
if let i = args.firstIndex(of: "--raise"), i + 1 < args.count { raiseTarget(app, args[i + 1]) }
if let i = args.firstIndex(of: "--raise-id"), i + 1 < args.count, let n = Int(args[i + 1]) { raiseById(app, n) }
let ax = AXUIElementCreateApplication(app.processIdentifier)
guard let mbRef = attr(ax, kAXMenuBarAttribute as String) else { print("NO_MENUBAR"); exit(4) }
let mb = mbRef as! AXUIElement
let topItems = children(mb)

func windows(_ app: NSRunningApplication) -> [[String: Any]] {
    // AXWindows 常为空，用 Quartz 窗口表（限定 PID + 普通文档层）
    let all = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []
    return all.filter { item in
        let b = item[kCGWindowBounds as String] as? [String: Any] ?? [:]
        return (item[kCGWindowOwnerPID as String] as? Int) == Int(app.processIdentifier)
            && (item[kCGWindowLayer as String] as? Int) == 0
            && (b["Height"] as? Double ?? 0) > 100
            && (item[kCGWindowAlpha as String] as? Double ?? 0) > 0
    }
}

switch action {
case "windows":
    for w in windows(app) {
        let n = (w[kCGWindowName as String] as? String) ?? ""
        print("\(w[kCGWindowNumber as String] ?? "?") | \(n)")
    }
case "menus":
    for it in topItems { print(title(it)) }
case "dump":
    guard args.count >= 4 else { exit(2) }
    guard let menu = topItems.first(where: { title($0) == args[3] }) else { print("NO_MENU"); exit(5) }
    for m in children(menu) {
        for item in children(m) {
            let en = (attr(item, kAXEnabledAttribute as String) as? Bool) ?? false
            let t = title(item)
            if !t.isEmpty { print("\(en ? "ON " : "off") \(t)") }
        }
    }
case "press", "enable":
    guard args.count >= 5 else { exit(2) }
    guard let menu = topItems.first(where: { title($0) == args[3] }) else { print("NO_MENU"); exit(5) }
    var found: AXUIElement?
    outer: for m in children(menu) {
        for item in children(m) where title(item) == args[4] { found = item; break outer }
    }
    guard let item = found else { print("NO_ITEM"); exit(6) }
    let en = (attr(item, kAXEnabledAttribute as String) as? Bool) ?? false
    if action == "enable" { print(en ? "true" : "false"); exit(en ? 0 : 1) }
    guard en else { print("ITEM_DISABLED"); exit(7) }
    let r = AXUIElementPerformAction(item, kAXPressAction as CFString)
    print(r == .success ? "PRESSED" : "PRESS_FAILED \(r.rawValue)")
    exit(r == .success ? 0 : 8)
default:
    print("unknown action"); exit(2)
}
