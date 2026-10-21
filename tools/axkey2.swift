// Send a key with modifiers to a target Axure window.
// usage: swift axkey2.swift <bundleId> <titleSubstr> <key> [mods]
import AppKit
import ApplicationServices
func attr(_ el: AXUIElement, _ n: String) -> CFTypeRef? { var v: CFTypeRef?; return AXUIElementCopyAttributeValue(el, n as CFString, &v) == .success ? v : nil }
func s(_ el: AXUIElement, _ n: String) -> String { (attr(el, n) as? String) ?? "" }
let a = CommandLine.arguments
guard a.count >= 4 else { print("usage"); exit(2) }
guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == a[1] }) else { print("NOT_RUNNING"); exit(3) }
app.activate(options: [.activateAllWindows])
Thread.sleep(forTimeInterval: 0.7)
let ax = AXUIElementCreateApplication(app.processIdentifier)
if let wins = attr(ax, kAXWindowsAttribute as String) as? [AXUIElement] {
    for w in wins where s(w, kAXTitleAttribute as String).contains(a[2]) {
        AXUIElementPerformAction(w, kAXRaiseAction as CFString)
    }
}
Thread.sleep(forTimeInterval: 0.6)
let keyMap: [String: CGKeyCode] = [
  "return": 36, "enter": 76, "esc": 53, "escape": 53,
  "down": 125, "up": 126, "left": 123, "right": 124,
  "tab": 48, "space": 49, "a": 0, "s": 1, "z": 6, "v": 9, "0": 29, "1": 18,
]
guard let code = keyMap[a[3].lowercased()] else { print("UNSUPPORTED_KEY"); exit(4) }
let mods = a.count > 4 ? a[4] : ""
var flags: CGEventFlags = []
if mods.contains("cmd") { flags.insert(.maskCommand) }
if mods.contains("shift") { flags.insert(.maskShift) }
if let src = CGEventSource(stateID: .hidSystemState) {
    let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true)
    let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false)
    down?.flags = flags; up?.flags = flags
    down?.post(tap: .cghidEventTap); Thread.sleep(forTimeInterval: 0.06); up?.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.4)
    print("KEY \(a[3]) mods=\(mods)")
}
