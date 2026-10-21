// 把 already-on-clipboard 的 Axvg 文本粘贴进指定 Axure 文档窗口，然后保存。
// osascript/System Events 在本项目被拒绝，故全程走 AXUIElement。
//   swift axpaste.swift <bundleId> <windowTitleSubstring> [--save]
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
func sleepMs(_ ms: Int) { Thread.sleep(forTimeInterval: Double(ms) / 1000.0) }

let args = CommandLine.arguments
guard args.count >= 3 else { print("usage: axpaste.swift <bundleId> <titleSubstring> [--save]"); exit(2) }
let bundleId = args[1], want = args[2]
let doSave = args.contains("--save")
guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == bundleId }) else {
    print("NOT_RUNNING"); exit(3)
}

func quartzWindows() -> [[String: Any]] {
    let all = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []
    return all.filter { item in
        let b = item[kCGWindowBounds as String] as? [String: Any] ?? [:]
        return (item[kCGWindowOwnerPID as String] as? Int) == Int(app.processIdentifier)
            && (item[kCGWindowLayer as String] as? Int) == 0
            && (b["Height"] as? Double ?? 0) > 100
            && (item[kCGWindowAlpha as String] as? Double ?? 0) > 0
    }
}
func targetTitles() -> [String] { quartzWindows().compactMap { $0[kCGWindowName as String] as? String } }
func isTarget(_ t: String) -> Bool { t.contains(want) }

// 1) 激活 app 并把目标文档窗口置顶
app.activate(options: [.activateAllWindows])
sleepMs(700)
let ax = AXUIElementCreateApplication(app.processIdentifier)
guard let mbRef = attr(ax, kAXMenuBarAttribute as String) else { print("NO_MENUBAR"); exit(4) }
let mb = mbRef as! AXUIElement
let topItems = children(mb)
func menuItem(_ menu: String, _ item: String) -> AXUIElement? {
    guard let m = topItems.first(where: { title($0) == menu }) else { return nil }
    for sub in children(m) { for it in children(sub) where title(it) == item { return it } }
    return nil
}

// 用 AXWindows 找到对应窗口并 raise
var raised = false
if let winsRef = attr(ax, kAXWindowsAttribute as String) as? [AXUIElement] {
    for w in winsRef where isTarget(title(w)) {
        AXUIElementPerformAction(w, kAXRaiseAction as CFString)
        attr(w, kAXMainAttribute as String)
        raised = true
    }
}
if !raised {
    print("AX_WINDOWS_EMPTY_FALLBACK quartz=\(targetTitles().filter(isTarget))")
}
sleepMs(800)

// 2) 检查 Paste 可用
guard let pasteItem = menuItem("Edit", "Paste") else { print("NO_PASTE_ITEM"); exit(5) }
let enabled = (attr(pasteItem, kAXEnabledAttribute as String) as? Bool) ?? false
print("pasteEnabled=\(enabled)")
guard enabled else { print("PASTE_DISABLED"); exit(6) }
let r = AXUIElementPerformAction(pasteItem, kAXPressAction as CFString)
print("paste=\(r == .success ? "PRESSED" : "FAILED:\(r.rawValue)")")
guard r == .success else { exit(7) }
sleepMs(2500)

// 3) 保存
if doSave {
    guard let saveItem = menuItem("File", "Save") else { print("NO_SAVE_ITEM"); exit(8) }
    let sen = (attr(saveItem, kAXEnabledAttribute as String) as? Bool) ?? false
    print("saveEnabled=\(sen)")
    if sen {
        let sr = AXUIElementPerformAction(saveItem, kAXPressAction as CFString)
        print("save=\(sr == .success ? "PRESSED" : "FAILED:\(sr.rawValue)")")
    }
}
print("DONE")
