import AppKit
import ApplicationServices

// 宿主驱动。两种调用形态：
//   旧形态（保持兼容，jobs.mjs / axure-preview.mjs 都在用）：
//     gui-roundtrip.swift <file.rp> [9|11] [preview]
//   辅助形态（flag 前缀，不会和 .rp 路径冲突）：
//     gui-roundtrip.swift --tcc                 打印 trusted / untrusted
//     gui-roundtrip.swift --windows <9|11>      每个已打开的文档窗口一行
//     gui-roundtrip.swift --close <file> <9|11> 精确关闭该文档（不碰其它文档）
//     gui-roundtrip.swift --quit <9|11>         退出应用
//
// 生命周期约定：关闭只操作已确认归属的窗口。RP9 的窗口按钮可能仅隐藏文档，
// 所以优先使用关闭菜单，但必须先验证目标窗口，并在点击前再次验证焦点。

enum GuiFailure: Error { case message(String) }
func fail(_ message: String) throws { throw GuiFailure.message(message) }
func literal(_ value: String) -> String {
    "\"" + value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
}
func emit(_ line: String) { FileHandle.standardOutput.write(Data((line + "\n").utf8)) }
@discardableResult
func appleScript(_ source: String, timeout: Int = 5) throws -> NSAppleEventDescriptor? {
    var error: NSDictionary?
    let boundedSource = "with timeout of \(timeout) seconds\n\(source)\nend timeout"
    let result = NSAppleScript(source: boundedSource)?.executeAndReturnError(&error)
    if let error = error { try fail(String(describing: error)) }
    return result
}
func tryScript(_ source: String, timeout: Int = 5) -> NSAppleEventDescriptor? {
    (try? appleScript(source, timeout: timeout)) ?? nil
}
func waitUntil(_ test: () -> Bool, _ message: String) throws {
    if !pollUntil(10, test) { try fail(message) }
}
/// 有界等待：超时返回 false 而不抛错（辅助模式用）。
func pollUntil(_ timeout: TimeInterval, _ test: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if test() { return true }
        Thread.sleep(forTimeInterval: 0.1)
    }
    return test()
}

func waitForTermination(_ app: NSRunningApplication, timeout: TimeInterval) -> Bool {
    let pid = app.processIdentifier
    let deadline = ProcessInfo.processInfo.systemUptime + timeout
    repeat {
        // Allow AppKit to deliver termination notifications. The saved PID
        // also covers a stale workspace entry or a new instance of this bundle.
        if app.isTerminated || (kill(pid, 0) == -1 && errno == ESRCH) { return true }
        if ProcessInfo.processInfo.systemUptime >= deadline { return false }
        _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
    } while true
}

do {
    let arguments = Array(CommandLine.arguments.dropFirst())
    let mode = arguments.first.flatMap { $0.hasPrefix("--") ? $0 : nil }

    // 版本 → bundle 只解析一次；双版本并装时不能靠「第一个 Axure 进程」猜。
    let versionArg: String
    switch mode {
    case "--windows", "--quit": versionArg = arguments.count > 1 ? arguments[1] : "11"
    case "--close": versionArg = arguments.count > 2 ? arguments[2] : "11"
    case "--tcc": versionArg = "11"
    default: versionArg = arguments.count > 1 ? arguments[1] : "11"
    }
    let bundleId: String
    let procName: String
    switch versionArg {
    case "9": bundleId = "com.axure.AxureRP9"; procName = "Axure RP 9"
    case "11": bundleId = "com.axure.AxureRP11"; procName = "Axure RP 11"
    default: throw GuiFailure.message("Unsupported Axure version argument: \(versionArg) (expected 9 or 11)")
    }

    func axAttr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
        var v: CFTypeRef?
        return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
    }
    func axTitle(_ el: AXUIElement) -> String { (axAttr(el, kAXTitleAttribute as String) as? String) ?? "" }
    func axChildren(_ el: AXUIElement) -> [AXUIElement] { (axAttr(el, kAXChildrenAttribute as String) as? [AXUIElement]) ?? [] }

    // 辅助形态绝不启动应用：查询/关闭/退出都不该有「顺手开一个」的副作用。
    func runningApp() -> NSRunningApplication? {
        NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == bundleId })
    }

    /// 文档名：去掉 Axure 追加的版本/授权后缀。
    /// AX 标题是「doc - Axure RP 9 Team Edition : Licensed to …」，窗口服务器只给「doc」，
    /// 不归一会把同一个窗口算两次，也会让按标题匹配落空。
    func documentKey(_ windowTitle: String) -> String {
        var text = windowTitle
        let prefix = "\(procName) - "
        if text.hasPrefix(prefix) { text = String(text.dropFirst(prefix.count)) }
        if let range = text.range(of: " - \(procName)") { text = String(text[text.startIndex..<range.lowerBound]) }
        text = text.trimmingCharacters(in: .whitespaces)
        if text.hasSuffix("*") { text.removeLast() }
        if text.lowercased().hasSuffix(".rp") { text = String(text.dropLast(3)) }
        return text
    }

    /// 文档窗口名单（已去重、已归一）。
    /// 这里不再逐个窗口问 System Events——宿主弹着模态框时，那一次查询会阻塞数分钟。
    func documentWindows(_ app: NSRunningApplication) -> [String] {
        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        let axTitles = ((axAttr(axApp, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []).map { axTitle($0) }
        let all = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []
        let cgTitles = all.compactMap { item -> String? in
            let bounds = item[kCGWindowBounds as String] as? [String: Any] ?? [:]
            let candidate = (item[kCGWindowOwnerPID as String] as? Int) == Int(app.processIdentifier)
                && (item[kCGWindowLayer as String] as? Int) == 0
                && (bounds["Height"] as? Double ?? 0) > 100
                && (item[kCGWindowAlpha as String] as? Double ?? 0) > 0
            guard candidate else { return nil }
            return item[kCGWindowName as String] as? String
        }
        var seen = Set<String>()
        var keys: [String] = []
        for title in cgTitles + axTitles {
            if title == procName { continue }
            let key = documentKey(title)
            if key.isEmpty || seen.contains(key) { continue }
            seen.insert(key)
            keys.append(key)
        }
        return keys
    }

    func axWindowList(_ app: NSRunningApplication) -> [AXUIElement] {
        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        return (axAttr(axApp, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
    }

    func ownedWindow(_ app: NSRunningApplication, path: String, title: String) -> AXUIElement? {
        let matches = axWindowList(app).filter { documentKey(axTitle($0)) == title }
        if path.hasPrefix("/") {
            let target = URL(fileURLWithPath: path).resolvingSymlinksInPath().path
            let identified = matches.compactMap { window -> (AXUIElement, String)? in
                guard let value = axAttr(window, kAXDocumentAttribute as String) as? String else { return nil }
                if value.hasPrefix("/") { return (window, URL(fileURLWithPath: value).resolvingSymlinksInPath().path) }
                guard let url = URL(string: value), url.isFileURL else { return nil }
                return (window, url.resolvingSymlinksInPath().path)
            }
            if !identified.isEmpty {
                let exact = identified.filter { $0.1 == target }
                return exact.count == 1 ? exact[0].0 : nil
            }
        }
        // 某些 Axure 版本只公开标题。只有唯一同名 AX 窗口才可操作。
        return matches.count == 1 ? matches[0] : nil
    }

    /// Axure（Mono/.NET）只在应用被激活后才把窗口暴露给可访问性 API：
    /// 未激活时 AXWindows 与 System Events 都是 0 个窗口，而窗口服务器照样能看到。
    /// 任何按窗口操作之前都必须先过这一步，否则「找不到窗口」会被误判成「文档没打开」。
    func ensureExposed(_ app: NSRunningApplication, timeout: TimeInterval = 15) -> Bool {
        if axWindowList(app).isEmpty {
            // 判据只看「AX 窗口有没有出现」：NSRunningApplication.isActive 是取用时的快照，
            // 可能停在 true，实际应用已在后台，于是跳过激活、白等到超时。
            let axApp = AXUIElementCreateApplication(app.processIdentifier)
            _ = AXUIElementSetAttributeValue(axApp, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
            if axWindowList(app).isEmpty {
                // AppleScript activate 对 Axure 才有效；NSRunningApplication.activate 在
                // 后台激活被系统限制时不会把窗口带出来。
                _ = tryScript("tell application id \"\(bundleId)\" to activate")
            }
            app.activate(options: [.activateAllWindows])
        }
        let exposed = pollUntil(timeout) { !axWindowList(app).isEmpty }
        if !exposed {
            FileHandle.standardError.write(Data("AXURE_GUI_AX_NOT_EXPOSED windows=0\n".utf8))
        }
        return exposed
    }

    /// 按窗口自己的关闭按钮关闭指定文档。
    /// 不能用「文件 → 关闭」：它作用在最前面的文档上，连续作业时会关错并把该关的留下。
    func pressCloseButton(_ window: AXUIElement) -> Bool {
        guard let ref = axAttr(window, kAXCloseButtonAttribute as String),
              CFGetTypeID(ref) == AXUIElementGetTypeID() else { return false }
        return AXUIElementPerformAction(ref as! AXUIElement, kAXPressAction as CFString) == .success
    }

    func windowIsFocused(_ app: NSRunningApplication, _ window: AXUIElement) -> Bool {
        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        guard let focused = axAttr(axApp, kAXFocusedWindowAttribute as String) else { return false }
        return CFEqual(window, focused)
    }

    func raiseWindow(_ app: NSRunningApplication, _ window: AXUIElement) {
        if windowIsFocused(app, window) { return }
        app.activate(options: [.activateAllWindows])
        _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        _ = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
    }

    func pressFocusedFileMenu(_ app: NSRunningApplication, _ window: AXUIElement, _ chinese: String, _ english: String) -> Bool {
        let windowTitle = axTitle(window)
        guard !windowTitle.isEmpty, windowIsFocused(app, window) else { return false }
        return tryScript("""
        tell application "System Events" to tell process "\(procName)"
          if name of value of attribute "AXFocusedWindow" is not \(literal(windowTitle)) then return false
          if exists menu bar item "文件" of menu bar 1 then
            click menu item \(literal(chinese)) of menu "文件" of menu bar item "文件" of menu bar 1
          else
            click menu item \(literal(english)) of menu "File" of menu bar item "File" of menu bar 1
          end if
          return true
        end tell
        """)?.booleanValue == true
    }

    func axMenuItem(_ app: NSRunningApplication, _ menuNames: [String], _ itemNames: [String]) -> AXUIElement? {
        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        guard let bar = axAttr(axApp, kAXMenuBarAttribute as String), CFGetTypeID(bar) == AXUIElementGetTypeID() else { return nil }
        for menu in axChildren(bar as! AXUIElement) where menuNames.contains(axTitle(menu)) {
            for sub in axChildren(menu) {
                for item in axChildren(sub) where itemNames.contains(axTitle(item)) { return item }
            }
        }
        return nil
    }

    /// 把某个已打开的文档抬到最前。Axure 只把「活动文档」暴露给可访问性 API，
    /// 并排打开两个作业时，另一个既不在 AXWindows 里也不在 System Events 的窗口列表里。
    /// 用 LaunchServices 再投递一次同一路径：宿主会把已有窗口抬起来，而不是开第二份。
    func raiseDocument(_ app: NSRunningApplication, _ path: String, _ docTitle: String) -> Bool {
        // 仅在窗口服务器已看到这份文档、AX 尚未暴露它时重新投递路径。
        guard path.hasPrefix("/"), documentWindows(app).contains(docTitle),
              !axWindowList(app).contains(where: { documentKey(axTitle($0)) == docTitle }) else { return false }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        proc.arguments = ["-b", bundleId, path]
        guard (try? proc.run()) != nil else { return false }
        proc.waitUntilExit()
        return proc.terminationStatus == 0 && pollUntil(5) { ownedWindow(app, path: path, title: docTitle) != nil }
    }

    /// 关闭后同时检查 AX 和窗口服务器，只有目标标题消失才返回成功。
    func closeDocument(_ app: NSRunningApplication, _ path: String, _ docTitle: String) -> Bool {
        if ownedWindow(app, path: path, title: docTitle) == nil {
            _ = raiseDocument(app, path, docTitle)
        }
        guard let window = ownedWindow(app, path: path, title: docTitle) else { return false }
        if versionArg == "9" {
            raiseWindow(app, window)
            guard pollUntil(3, { windowIsFocused(app, window) }) else { return false }
            if let item = axMenuItem(app, ["文件", "File"], ["关闭", "Close"]),
               (axAttr(item, kAXEnabledAttribute as String) as? Bool) != false,
               windowIsFocused(app, window),
               AXUIElementPerformAction(item, kAXPressAction as CFString) == .success,
               pollUntil(2, { !documentWindows(app).contains(docTitle) }) { return true }
            guard pressFocusedFileMenu(app, window, "关闭", "Close") else { return false }
            return pollUntil(8) { !documentWindows(app).contains(docTitle) }
        }
        if pressCloseButton(window), pollUntil(2, { !documentWindows(app).contains(docTitle) }) { return true }
        if ownedWindow(app, path: path, title: docTitle) == nil {
            _ = raiseDocument(app, path, docTitle)
        }
        guard let focused = ownedWindow(app, path: path, title: docTitle),
              pressFocusedFileMenu(app, focused, "关闭", "Close") else { return false }
        return pollUntil(8) { !documentWindows(app).contains(docTitle) }
    }

    // ------------------------------------------------------------------ 辅助模式
    if let mode {
        switch mode {
        case "--tcc":
            emit(AXIsProcessTrusted() ? "trusted" : "untrusted")
            exit(0)
        case "--windows":
            guard let app = runningApp() else { exit(0) }
            for key in documentWindows(app) { emit(key) }
            exit(0)
        case "--close":
            guard arguments.count >= 2 else { throw GuiFailure.message("usage: --close <file.rp> <9|11>") }
            let target = URL(fileURLWithPath: arguments[1])
            guard !target.path.contains("\n"), !target.path.contains("\r") else { throw GuiFailure.message("GUI path must not contain newlines") }
            let docTitle = target.deletingPathExtension().lastPathComponent
            guard let app = runningApp() else { emit("not-open"); exit(0) }
            let exposed = ensureExposed(app, timeout: 5)
            if !documentWindows(app).contains(docTitle) {
                guard exposed else { throw GuiFailure.message("Cannot verify whether the owned document is open") }
                emit("not-open")
                exit(0)
            }
            guard closeDocument(app, target.path, docTitle) else { throw GuiFailure.message("Owned job document did not close") }
            emit("closed")
            exit(0)
        case "--quit":
            guard let app = runningApp() else { emit("not-running"); exit(0) }
            // 可选标题：先按窗口关闭调用方自己的文档，避免 Axure 的「是否保存」提示挡住退出。
            for docTitle in arguments.dropFirst(2) where !docTitle.hasPrefix("--") {
                _ = ensureExposed(app)
                _ = closeDocument(app, docTitle, documentKey(URL(fileURLWithPath: docTitle).lastPathComponent))
            }
            // Request normal termination of this instance. Axure owns any
            // unsaved-document prompt; the driver does not dismiss it.
            let requested = app.isTerminated || app.terminate()
            if waitForTermination(app, timeout: requested ? 45 : 0) { emit("quit"); exit(0) }
            if !requested { throw GuiFailure.message("\(procName) refused the quit request (PID \(app.processIdentifier))") }
            throw GuiFailure.message("\(procName) is still running after the quit request (PID \(app.processIdentifier))")
        default:
            throw GuiFailure.message("Unknown mode \(mode)")
        }
    }

    // ------------------------------------------------------------------ 旧形态：roundtrip
    guard let inputPath = arguments.first else { throw GuiFailure.message("usage: <file.rp> [9|11] [preview]") }
    let path = URL(fileURLWithPath: inputPath).path
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
    // Axure can show an upgrade notice even when the document window already exists.
    // Only observe this application's windows. Never accept a dialog on behalf of a job.
    func blockingDialog() -> String? {
        func upgradeHint(_ text: String) -> Bool {
            let lower = text.lowercased()
            return lower.contains("your project has been loaded")
                || lower.contains("save your project to a new file")
                || lower.contains("save to a new file")
                || text.contains("保存到新文件")
                || text.contains("另存为新文件")
        }

        for window in axWindowList(app) {
            let windowTitle = axTitle(window)
            // The built-in progress window is modal while normal open/save work
            // completes. Other documents' dialogs cannot describe this job.
            if ["progress", "进度"].contains(windowTitle.lowercased()) { continue }
            if documentKey(windowTitle) != title && !windowIsFocused(app, window) { continue }
            var items = [window]
            var inspected = 0
            while let item = items.popLast(), inspected < 80 {
                inspected += 1
                let role = axAttr(item, kAXRoleAttribute as String) as? String
                let subrole = axAttr(item, kAXSubroleAttribute as String) as? String
                let modal = role == (kAXSheetRole as String) || (inspected == 1
                    && (subrole == (kAXDialogSubrole as String) || (axAttr(item, "AXModal") as? Bool == true)))
                let title = axTitle(item)
                let value = role == (kAXStaticTextRole as String) ? axAttr(item, kAXValueAttribute as String) as? String : nil
                let descriptions = [title, value ?? ""].filter { !$0.isEmpty }
                if let hint = descriptions.first(where: upgradeHint) { return hint }
                if modal {
                    let body = axChildren(item).flatMap { child -> [String] in
                        guard axAttr(child, kAXRoleAttribute as String) as? String == (kAXStaticTextRole as String) else { return [] }
                        return [axTitle(child), axAttr(child, kAXValueAttribute as String) as? String ?? ""]
                    }.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
                    return body.first(where: upgradeHint) ?? body.first ?? descriptions.first
                        ?? (windowTitle.isEmpty ? "Axure modal dialog" : windowTitle)
                }
                if inspected == 1 || role == (kAXGroupRole as String) || role == (kAXSplitGroupRole as String) {
                    items.append(contentsOf: axChildren(item).prefix(25))
                }
            }
        }
        return nil
    }

    func rejectBlockingDialog() throws {
        if let message = blockingDialog() {
            let line = message.split(whereSeparator: \.isNewline).joined(separator: " ")
            let diagnostic = line.trimmingCharacters(in: .whitespaces).isEmpty ? "Axure modal dialog" : line
            FileHandle.standardError.write(Data("AXURE_GUI_MODAL \(diagnostic.prefix(400))\n".utf8))
            captureSaveBlock()
            try fail("Axure is waiting on a modal dialog")
        }
    }

    func captureSaveBlock() {
        // Some WPF/Mono dialogs only paint text. Preserve a capture of the owned Axure
        // window if window capture is available so the real message survives cleanup.
        let windows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] ?? []
        let window = windows.first { info in
            guard info[kCGWindowOwnerPID as String] as? Int == Int(app.processIdentifier),
                  let name = info[kCGWindowName as String] as? String else { return false }
            return documentKey(name) == title
        }
        if let id = window?[kCGWindowNumber as String] as? Int {
            let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".png")
            let destination = URL(fileURLWithPath: path + ".blocked.png")
            defer { try? FileManager.default.removeItem(at: temporary) }
            let capture = Process()
            capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            capture.arguments = ["-x", "-l", String(id), temporary.path]
            capture.standardError = FileHandle.nullDevice
            if (try? capture.run()) != nil {
                capture.waitUntilExit()
                if capture.terminationStatus == 0, (try? FileManager.default.copyItem(at: temporary, to: destination)) != nil {
                    FileHandle.standardError.write(Data("AXURE_GUI_BLOCKED_SCREENSHOT \(destination.path)\n".utf8))
                }
            }
        }
        let titles = axWindowList(app).map { axTitle($0).split(whereSeparator: \.isNewline).joined(separator: " ") }.filter { !$0.isEmpty }
        FileHandle.standardError.write(Data("AXURE_GUI_BLOCKED_WINDOWS \(titles.joined(separator: " | ").prefix(400))\n".utf8))
    }

    func isOpen() -> Bool { documentWindows(app).contains(title) }
    func isTargetFocused() -> Bool {
        guard let window = ownedWindow(app, path: path, title: title) else { return false }
        return windowIsFocused(app, window)
    }
    var observedDocument = false
    func focusTarget() throws {
        guard pollUntil(10, { isOpen() || blockingDialog() != nil }) else {
            try fail("Owned job document is unavailable")
            return
        }
        try rejectBlockingDialog()
        if !observedDocument {
            observedDocument = true
            FileHandle.standardError.write(Data("AXURE_GUI_DOCUMENT_OPENED\n".utf8))
        }
        guard ensureExposed(app, timeout: 5),
              let window = ownedWindow(app, path: path, title: title) else {
            throw GuiFailure.message("Axure did not expose the owned document window")
        }
        raiseWindow(app, window)
        guard pollUntil(10, { isTargetFocused() || blockingDialog() != nil }) else {
            try fail("Owned job document is not the active Axure document")
            return
        }
        try rejectBlockingDialog()
    }
    func openTarget() throws {
        for attempt in 0..<2 {
            // Apple event 成功不等于窗口已经出现；同一次作业里再经 LaunchServices 投递一次，
            // 而不是把整段保存/关闭/重开重来。
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
    /// 菜单项存在且已启用。刚打开文档 / 正在保存时菜单会短暂禁用，
    /// 这时按下 AXPress 会「成功但什么都不做」，是保存静默失败的来源。
    func axMenuReady(_ menuNames: [String], _ itemNames: [String]) -> Bool {
        guard let item = axMenuItem(app, menuNames, itemNames) else { return false }
        return (axAttr(item, kAXEnabledAttribute as String) as? Bool) ?? true
    }
    func axPressMenu(_ menuNames: [String], _ itemNames: [String]) -> Bool {
        guard let item = axMenuItem(app, menuNames, itemNames) else { return false }
        return AXUIElementPerformAction(item, kAXPressAction as CFString) == .success
    }
    func waitMenuReady(_ chinese: String, _ english: String, timeout: TimeInterval = 10) -> Bool {
        pollUntil(timeout) { axMenuReady(["文件", "File"], [chinese, english]) || blockingDialog() != nil }
    }
    func fileAction(_ chinese: String, _ english: String, directFirst: Bool = false) throws -> Date {
        try focusTarget()
        _ = waitMenuReady(chinese, english)
        try rejectBlockingDialog()
        if directFirst, let item = axMenuItem(app, ["文件", "File"], [chinese, english]), isTargetFocused() {
            let requestedAt = Date()
            if AXUIElementPerformAction(item, kAXPressAction as CFString) == .success {
                return requestedAt
            }
        }
        if let window = ownedWindow(app, path: path, title: title),
           windowIsFocused(app, window) {
            let requestedAt = Date()
            if pressFocusedFileMenu(app, window, chinese, english) { return requestedAt }
        }
        try rejectBlockingDialog()
        let requestedAt = Date()
        guard isTargetFocused(), axPressMenu(["文件", "File"], [chinese, english]) else {
            throw GuiFailure.message("AX menu press failed for \(english)/\(chinese)")
        }
        return requestedAt
    }
    guard !isOpen() else { throw GuiFailure.message("A document with this title is already open; refusing ambiguous GUI target") }
    let before = try FileManager.default.attributesOfItem(atPath: path)[.modificationDate] as? Date
    var lastPhaseTime = Date()
    func phase(_ value: String) {
        let now = Date()
        let ms = Int((now.timeIntervalSince(lastPhaseTime) * 1000.0).rounded())
        lastPhaseTime = now
        FileHandle.standardError.write(Data(("AXURE_GUI_PHASE \(value) (\(ms)ms)\n").utf8))
    }
    let wantPreview = arguments.count > 2 && arguments[2] == "preview"
    FileHandle.standardError.write(Data("AXURE_GUI_DOCUMENT_OPENING\n".utf8))
    try openTarget()
    phase("opened")
    // 保存必须校验：磁盘 mtime 没变就是没保存，重新聚焦再按一次（最多三次）。
    var saved = false
    for attempt in 1...3 {
        let requestedAt = try fileAction("保存", "Save", directFirst: attempt == 1)
        var writtenAt: Date?
        _ = pollUntil(6) {
            let after = (try? FileManager.default.attributesOfItem(atPath: path)[.modificationDate]) as? Date
            if let after = after, after != before {
                writtenAt = after
                return true
            }
            return blockingDialog() != nil
        }
        try rejectBlockingDialog()
        if let writtenAt = writtenAt {
            saved = true
            let ms = max(0, Int((writtenAt.timeIntervalSince(requestedAt) * 1000.0).rounded()))
            FileHandle.standardError.write(Data("AXURE_GUI_SAVE_DISK_MS \(ms)\n".utf8))
            break
        }
        FileHandle.standardError.write(Data("AXURE_GUI_RETRY save (\(attempt)/3)\n".utf8))
        Thread.sleep(forTimeInterval: 0.5)
    }
    if !saved {
        captureSaveBlock()
        throw GuiFailure.message("Native Save did not modify the owned output file")
    }
    phase("saved")
    guard closeDocument(app, path, title) else { throw GuiFailure.message("Owned job document did not close") }
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
            guard isTargetFocused(), axPressMenu(["发布", "Publish"], ["预览", "预览...", "Preview", "Preview..."]) else {
                throw GuiFailure.message("Axure Preview menu press failed for the owned document")
            }
        }
        phase("preview")
    }
    print("saved-closed-reopened")
} catch {
    FileHandle.standardError.write(Data(String(describing: error).utf8))
    exit(1)
}
