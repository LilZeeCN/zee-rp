// 打印 Axure 文档窗口的 AX 元素树（用于定位 Style 面板里的 X/Y 输入框）。
//   swift axdump.swift <bundleId> <titleSubstr> [roleFilter] [maxDepth]
import AppKit
import ApplicationServices

func attr(_ el: AXUIElement, _ n: String) -> CFTypeRef? { var v: CFTypeRef?; return AXUIElementCopyAttributeValue(el, n as CFString, &v) == .success ? v : nil }
func children(_ el: AXUIElement) -> [AXUIElement] { (attr(el, kAXChildrenAttribute as String) as? [AXUIElement]) ?? [] }
func s(_ el: AXUIElement, _ n: String) -> String { (attr(el, n) as? String) ?? "" }

let a = CommandLine.arguments
guard a.count >= 3 else { print("usage: axdump.swift <bundleId> <titleSubstr> [roleFilter] [maxDepth]"); exit(2) }
let roleFilter = a.count > 3 ? a[3] : ""
let maxDepth = a.count > 4 ? (Int(a[4]) ?? 6) : 6
guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == a[1] }) else { print("NOT_RUNNING"); exit(3) }
let ax = AXUIElementCreateApplication(app.processIdentifier)
guard let wins = attr(ax, kAXWindowsAttribute as String) as? [AXUIElement] else { print("NO_WINDOWS"); exit(4) }
guard let win = wins.first(where: { s($0, kAXTitleAttribute as String).contains(a[2]) }) else { print("NO_WINDOW"); exit(5) }

var count = 0
func walk(_ el: AXUIElement, _ depth: Int, _ path: String) {
    let role = s(el, kAXRoleAttribute as String)
    let title = s(el, kAXTitleAttribute as String)
    let desc = s(el, kAXDescriptionAttribute as String)
    let value = s(el, kAXValueAttribute as String)
    var pos = ""
    if let p = attr(el, kAXPositionAttribute as String) { var pt = CGPoint.zero; AXValueGetValue(p as! AXValue, .cgPoint, &pt); pos = "@\(Int(pt.x)),\(Int(pt.y))" }
    if roleFilter.isEmpty || role.contains(roleFilter) {
        if !title.isEmpty || !desc.isEmpty || !value.isEmpty || !roleFilter.isEmpty {
            print("\(String(repeating: "  ", count: depth))[\(depth)] \(path) role=\(role) title=\(title) desc=\(desc) value=\(value) \(pos)")
            count += 1
        }
    }
    if depth >= maxDepth { return }
    for (i, c) in children(el).enumerated() { walk(c, depth + 1, path + ".\(i)") }
}
walk(win, 0, "w")
print("TOTAL_EMITTED=\(count)")
