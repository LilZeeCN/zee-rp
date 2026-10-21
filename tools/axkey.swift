// 依次按键（AX 不可用时用键盘菜单等价键）。用法: swift axkey.swift <bundleId> <titleSubstr> <key> [cmd|shift|cmdshift]
import AppKit
import ApplicationServices
func attr(_ el: AXUIElement, _ n: String) -> CFTypeRef? { var v: CFTypeRef?; return AXUIElementCopyAttributeValue(el, n as CFString, &v) == .success ? v : nil }
func children(_ el: AXUIElement) -> [AXUIElement] { (attr(el, kAXChildrenAttribute as String) as? [AXUIElement]) ?? [] }
func title(_ el: AXUIElement) -> String { (attr(el, kAXTitleAttribute as String) as? String) ?? "" }
func sleepMs(_ ms: Int) { Thread.sleep(forTimeInterval: Double(ms)/1000.0) }
let a = CommandLine.arguments
guard a.count >= 4 else { print("usage: axkey.swift <bundleId> <titleSubstr> <key> [mods]"); exit(2) }
guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == a[1] }) else { print("NOT_RUNNING"); exit(3) }
app.activate(options: [.activateAllWindows]); sleepMs(700)
let ax = AXUIElementCreateApplication(app.processIdentifier)
if let wins = attr(ax, kAXWindowsAttribute as String) as? [AXUIElement] {
    for w in wins where title(w).contains(a[2]) { AXUIElementPerformAction(w, kAXRaiseAction as CFString) }
}
sleepMs(600)
let mods = a.count > 4 ? a[4] : "cmd"
var flags: CGEventFlags = []
if mods.contains("cmd") { flags.insert(.maskCommand) }
if mods.contains("shift") { flags.insert(.maskShift) }
let src = CGEventSource(stateID: .hidSystemState)
let map: [String: CGKeyCode] = ["a": 0, "z": 6, "s": 1, "w": 13, "v": 9, "0": 29]
guard let code = map[a[3].lowercased()] else { print("UNSUPPORTED_KEY"); exit(4) }
let kd = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true)
let ku = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false)
kd?.flags = flags; ku?.flags = flags
kd?.post(tap: .cghidEventTap); sleepMs(60); ku?.post(tap: .cghidEventTap); sleepMs(400)
print("KEY \(a[3]) mods=\(mods)")
