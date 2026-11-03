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
    // 宿主版本由调用方给出（RP 9 / RP 11 双版本可以同时装着，不能靠名字猜）。
    let versionArg = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "11"
    let bundleId: String
    let procName: String
    switch versionArg {
    case "9": bundleId = "com.axure.AxureRP9"; procName = "Axure RP 9"
    case "11": bundleId = "com.axure.AxureRP11"; procName = "Axure RP 11"
    default: throw GuiFailure.message("Unsupported Axure version argument: \(versionArg) (expected 9 or 11)")
    }
    guard !path.contains("\n"), !path.contains("\r") else { throw GuiFailure.message("GUI path must not contain newlines") }
    let title = URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent
    if (try? appleScript("tell application id \"\(bundleId)\" to activate")) == nil {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        proc.arguments = ["-b", bundleId]
        try? proc.run(); proc.waitUntilExit()
        Thread.sleep(forTimeInterval: 1.0)
    }
    guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == bundleId }) else {
        throw GuiFailure.message("\(procName) is unavailable")
    }
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    func axAttr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
        var v: CFTypeRef?
        return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
    }
    func axTitle(_ el: AXUIElement) -> String { (axAttr(el, kAXTitleAttribute as String) as? String) ?? "" }
    func axChildren(_ el: AXUIElement) -> [AXUIElement] { (axAttr(el, kAXChildrenAttribute as String) as? [AXUIElement]) ?? [] }

    func windows() -> [[String: Any]] {
        let axWins = (axAttr(axApp, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
        let axTitles = Set(axWins.map { axTitle($0) }.filter { !$0.isEmpty })
        let all = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []
        let cgCandidates = all.filter { item in
            let bounds = item[kCGWindowBounds as String] as? [String: Any] ?? [:]
            let candidate = (item[kCGWindowOwnerPID as String] as? Int) == Int(app.processIdentifier)
                && (item[kCGWindowLayer as String] as? Int) == 0 && (bounds["Height"] as? Double ?? 0) > 100
                && (item[kCGWindowAlpha as String] as? Double ?? 0) > 0
            guard candidate else { return false }
            let wTitle = item[kCGWindowName as String] as? String ?? ""
            if axTitles.contains(wTitle) { return true }
            if let exists = try? appleScript("tell application \"System Events\" to tell process \"\(procName)\" to exists window " + literal(wTitle)) {
                return exists.booleanValue
            }
            return !wTitle.isEmpty
        }
        // CG can still expose an older document title while AX already reports
        // the newly opened owned window. Keep both observations instead of
        // discarding AX as soon as any (possibly unrelated) CG window exists.
        let cgTitles = Set(cgCandidates.map { $0[kCGWindowName as String] as? String ?? "" })
        return cgCandidates + axTitles.filter { !cgTitles.contains($0) }.map { [kCGWindowName as String: $0] }
    }
    func name(_ window: [String: Any]) -> String { window[kCGWindowName as String] as? String ?? "" }
    func matchesTitle(_ wTitle: String) -> Bool {
        wTitle == title
            || wTitle == title + ".rp"
            || wTitle == procName + " - " + title
            || wTitle == procName + " - " + title + ".rp"
            || wTitle.hasPrefix(title + " - " + procName)
            || wTitle.hasPrefix(title + ".rp - " + procName)
            || wTitle.hasPrefix(title + "* - " + procName)
            || wTitle.hasPrefix(title + ".rp* - " + procName)
    }
    func isTarget(_ window: [String: Any]) -> Bool { matchesTitle(name(window)) }
    var observedDocument = false
    func focusTarget() throws {
        try waitUntil({ windows().contains(where: isTarget) }, "Owned job document is unavailable")
        guard let target = windows().first(where: isTarget) else {
            throw GuiFailure.message("Owned job document is unavailable")
        }
        if !observedDocument {
            observedDocument = true
            FileHandle.standardError.write(Data("AXURE_GUI_DOCUMENT_OPENED\n".utf8))
        }
        let actualTitle = name(target)
        if (try? appleScript("""
        tell application "System Events" to tell process "\(procName)"
          set frontmost to true
          perform action "AXRaise" of window \(literal(actualTitle))
        end tell
        """)) != nil {
            try waitUntil({
                let focused = try? appleScript("tell application \"System Events\" to tell process \"\(procName)\" to get name of value of attribute \"AXFocusedWindow\"")
                return app.isActive && focused?.stringValue == actualTitle
            }, "Owned job document is not the active Axure document")
            return
        }
        // AXUIElement fallback when System Events is blocked by TCC
        app.activate(options: [.activateAllWindows])
        Thread.sleep(forTimeInterval: 0.3)
        let axWins = (axAttr(axApp, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
        for w in axWins where matchesTitle(axTitle(w)) {
            AXUIElementPerformAction(w, kAXRaiseAction as CFString)
            AXUIElementSetAttributeValue(w, kAXMainAttribute as CFString, kCFBooleanTrue)
        }
        Thread.sleep(forTimeInterval: 0.3)
    }
    func openTarget() throws {
        for attempt in 0..<2 {
            // A successful Apple event can precede the document window. If it
            // never appears, redeliver once through LaunchServices in this same
            // owned job; do not restart the whole save/close/reopen sequence.
            if attempt > 0 || (try? appleScript("tell application id \"\(bundleId)\" to open POSIX file " + literal(path))) == nil {
                let proc = Process()
                proc.executableURL = URL(fileURLWithPath: "/usr/bin/open")
                proc.arguments = ["-b", bundleId, path]
                try proc.run(); proc.waitUntilExit()
            }
            do { try focusTarget(); return }
            catch GuiFailure.message(let message) where message == "Owned job document is unavailable" && attempt == 0 {
                FileHandle.standardError.write(Data("AXURE_GUI_RETRY open-document (1/1)\n".utf8))
                Thread.sleep(forTimeInterval: 0.35)
            }
        }
    }
    func axPressMenu(_ menuNames: [String], _ itemNames: [String]) -> Bool {
        guard let bar = axAttr(axApp, kAXMenuBarAttribute as String) else { return false }
        let barEl = bar as! AXUIElement
        for m in axChildren(barEl) where menuNames.contains(axTitle(m)) {
            for sub in axChildren(m) {
                for item in axChildren(sub) where itemNames.contains(axTitle(item)) {
                    return AXUIElementPerformAction(item, kAXPressAction as CFString) == .success
                }
            }
        }
        return false
    }
    func fileAction(_ chinese: String, _ english: String) throws {
        try focusTarget()
        if (try? appleScript("""
        tell application "System Events" to tell process "\(procName)"
          if exists menu bar item "文件" of menu bar 1 then
            click menu item \(literal(chinese)) of menu "文件" of menu bar item "文件" of menu bar 1
          else
            click menu item \(literal(english)) of menu "File" of menu bar item "File" of menu bar 1
          end if
        end tell
        """)) != nil {
            return
        }
        guard axPressMenu(["文件", "File"], [chinese, english]) else {
            throw GuiFailure.message("AX menu press failed for \(english)/\(chinese)")
        }
    }
    guard !windows().contains(where: isTarget) else { throw GuiFailure.message("A document with this title is already open; refusing ambiguous GUI target") }
    let before = try FileManager.default.attributesOfItem(atPath: path)[.modificationDate] as? Date
    var lastPhaseTime = Date()
    func phase(_ value: String) {
        let now = Date()
        let ms = Int((now.timeIntervalSince(lastPhaseTime) * 1000.0).rounded())
        lastPhaseTime = now
        FileHandle.standardError.write(Data(("AXURE_GUI_PHASE \(value) (\(ms)ms)\n").utf8))
    }
    let wantPreview = CommandLine.arguments.count > 3 && CommandLine.arguments[3] == "preview"
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
    if wantPreview {
        try focusTarget()
        if (try? appleScript("""
        tell application "System Events" to tell process "\(procName)"
          if exists menu bar item "发布" of menu bar 1 then
            if exists menu item "预览" of menu "发布" of menu bar item "发布" of menu bar 1 then
              click menu item "预览" of menu "发布" of menu bar item "发布" of menu bar 1
            else
              click menu item "预览..." of menu "发布" of menu bar item "发布" of menu bar 1
            end if
          else if exists menu bar item "Publish" of menu bar 1 then
            if exists menu item "Preview" of menu "Publish" of menu bar item "Publish" of menu bar 1 then
              click menu item "Preview" of menu "Publish" of menu bar item "Publish" of menu bar 1
            else
              click menu item "Preview..." of menu "Publish" of menu bar item "Publish" of menu bar 1
            end if
          end if
        end tell
        """)) == nil {
            _ = axPressMenu(["发布", "Publish"], ["预览", "预览...", "Preview", "Preview..."])
        }
        phase("preview")
    }
    print("saved-closed-reopened")
} catch {
    FileHandle.standardError.write(Data(String(describing: error).utf8))
    exit(1)
}
