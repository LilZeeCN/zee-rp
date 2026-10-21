// 选中全部元件后用方向键把内容平移到精确位置（Shift=10px 步进）。
//   swift axnudge.swift <bundleId> <titleSubstr> <dx> <dy>
import AppKit
import ApplicationServices
func attr(_ el: AXUIElement, _ n: String) -> CFTypeRef? { var v: CFTypeRef?; return AXUIElementCopyAttributeValue(el, n as CFString, &v) == .success ? v : nil }
func children(_ el: AXUIElement) -> [AXUIElement] { (attr(el, kAXChildrenAttribute as String) as? [AXUIElement]) ?? [] }
func title(_ el: AXUIElement) -> String { (attr(el, kAXTitleAttribute as String) as? String) ?? "" }
func sleepMs(_ ms: Int) { Thread.sleep(forTimeInterval: Double(ms)/1000.0) }
let a = CommandLine.arguments
guard a.count >= 5 else { print("usage: axnudge.swift <bundleId> <titleSubstr> <dx> <dy>"); exit(2) }
guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == a[1] }) else { print("NOT_RUNNING"); exit(3) }
let dx = Int(a[3]) ?? 0, dy = Int(a[4]) ?? 0
app.activate(options: [])
sleepMs(600)
let ax = AXUIElementCreateApplication(app.processIdentifier)
if let wins = attr(ax, kAXWindowsAttribute as String) as? [AXUIElement] {
    for w in wins where title(w).contains(a[2]) {
        AXUIElementPerformAction(w, kAXRaiseAction as CFString)
        AXUIElementSetAttributeValue(w, kAXMainAttribute as CFString, kCFBooleanTrue)
    }
}
sleepMs(700)
let src = CGEventSource(stateID: .hidSystemState)
func key(_ code: CGKeyCode, _ flags: CGEventFlags, _ times: Int) {
    for _ in 0..<times {
        let kd = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true)
        let ku = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false)
        kd?.flags = flags; ku?.flags = flags
        kd?.post(tap: .cghidEventTap); sleepMs(18); ku?.post(tap: .cghidEventTap); sleepMs(28)
    }
}
// Cmd+A 全选
key(0, .maskCommand, 1)
sleepMs(400)
let LEFT: CGKeyCode = 123, RIGHT: CGKeyCode = 124, DOWN: CGKeyCode = 125, UP: CGKeyCode = 126
func move(_ d: Int, _ neg: CGKeyCode, _ pos: CGKeyCode) {
    let n = abs(d); let code = d < 0 ? neg : pos
    if ProcessInfo.processInfo.environment["NUDGE_SHIFT"] == "1" {
        key(code, .maskShift, n / 10); key(code, [], n % 10)
    } else {
        key(code, [], n)   // 单步实测 1px，最稳
    }
}
move(dx, LEFT, RIGHT)
move(dy, UP, DOWN)
print("NUDGED dx=\(dx) dy=\(dy)")
