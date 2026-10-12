import AppKit
import ApplicationServices

enum GuiFailure: Error { case message(String) }
func fail(_ message: String) throws { throw GuiFailure.message(message) }
func literal(_ value: String) -> String {
    "\"" + value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
}
@discardableResult
func appleScript(_ source: String) throws -> NSAppleEventDescriptor? {
    var error: NSDictionary?
    let result = NSAppleScript(source: source)?.executeAndReturnError(&error)
    if let error = error { try fail(String(describing: error)) }
    return result
}
func waitUntil(_ test: () -> Bool, _ message: String) throws {
    for _ in 0..<100 {
        if test() { return }
        Thread.sleep(forTimeInterval: 0.1)
    }
    try fail(message)
}

do {
    let path = CommandLine.arguments[1]
    guard !path.contains("\n"), !path.contains("\r") else { throw GuiFailure.message("GUI path must not contain newlines") }
    let title = URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent
    try appleScript("tell application id \"com.axure.AxureRP11\" to activate")
    guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == "com.axure.AxureRP11" }) else {
        throw GuiFailure.message("Axure RP 11 is unavailable")
    }
    func windows() -> [[String: Any]] {
        // 当前 Axure 进程的 AXWindows 可能为空；Quartz 仍提供真实文档标题及顺序，且限定 PID/普通文档层。
        let all = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []
        return all.filter { item in
            let bounds = item[kCGWindowBounds as String] as? [String: Any] ?? [:]
            let candidate = (item[kCGWindowOwnerPID as String] as? Int) == Int(app.processIdentifier)
                && (item[kCGWindowLayer as String] as? Int) == 0 && (bounds["Height"] as? Double ?? 0) > 100
                && (item[kCGWindowAlpha as String] as? Double ?? 0) > 0
            guard candidate else { return false }
            let title = item[kCGWindowName as String] as? String ?? ""
            let exists = try? appleScript("tell application \"System Events\" to tell process \"Axure RP 11\" to exists window " + literal(title))
            return exists?.booleanValue == true
        }
    }
    func name(_ window: [String: Any]) -> String { window[kCGWindowName as String] as? String ?? "" }
    func isTarget(_ window: [String: Any]) -> Bool { name(window) == title || name(window) == "Axure RP 11 - " + title }
    func focusTarget() throws {
        try waitUntil({ windows().contains(where: isTarget) }, "Owned job document is unavailable")
        let actualTitle = name(windows().first(where: isTarget)!)
        try appleScript("""
        tell application "System Events" to tell process "Axure RP 11"
          set frontmost to true
          perform action "AXRaise" of window \(literal(actualTitle))
        end tell
        """)
        // Quartz optionAll 的顺序会含旧窗口；实际焦点属性比缓存顺序可靠。
        try waitUntil({
            let focused = try? appleScript("tell application \"System Events\" to tell process \"Axure RP 11\" to get name of value of attribute \"AXFocusedWindow\"")
            return app.isActive && focused?.stringValue == actualTitle
        }, "Owned job document is not the active Axure document")
    }
    func openTarget() throws {
        try appleScript("tell application id \"com.axure.AxureRP11\" to open POSIX file " + literal(path))
        try focusTarget()
    }
    func fileAction(_ chinese: String, _ english: String) throws {
        try focusTarget()
        try appleScript("""
        tell application "System Events" to tell process "Axure RP 11"
          if exists menu bar item "文件" of menu bar 1 then
            click menu item \(literal(chinese)) of menu "文件" of menu bar item "文件" of menu bar 1
          else
            click menu item \(literal(english)) of menu "File" of menu bar item "File" of menu bar 1
          end if
        end tell
        """)
    }
    guard !windows().contains(where: isTarget) else { throw GuiFailure.message("A document with this title is already open; refusing ambiguous GUI target") }
    let before = try FileManager.default.attributesOfItem(atPath: path)[.modificationDate] as? Date
    func phase(_ value: String) { FileHandle.standardError.write(Data(("AXURE_GUI_PHASE " + value + "\n").utf8)) }
    try openTarget()
    phase("opened")
    try fileAction("保存", "Save")
    try waitUntil({
        let after = (try? FileManager.default.attributesOfItem(atPath: path)[.modificationDate]) as? Date
        return after != nil && after != before
    }, "Native Save did not modify the owned output file")
    phase("saved")
    try fileAction("关闭", "Close")
    try waitUntil({ !windows().contains(where: isTarget) }, "Owned job document did not close")
    phase("closed")
    try openTarget()
    phase("reopened")
    print("saved-closed-reopened")
} catch {
    FileHandle.standardError.write(Data(String(describing: error).utf8))
    exit(1)
}
