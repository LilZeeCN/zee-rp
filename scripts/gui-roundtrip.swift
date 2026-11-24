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
// 生命周期约定：关闭走窗口自己的关闭按钮。Axure 的「文件 → 关闭」作用在最前面的文档上，
// 连续作业时会把别的文档关掉、把自己的那份留下，反复调用后窗口越积越多，最终宿主不可用。

enum GuiFailure: Error { case message(String) }
func fail(_ message: String) throws { throw GuiFailure.message(message) }
func literal(_ value: String) -> String {
    "\"" + value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
}
func emit(_ line: String) { FileHandle.standardOutput.write(Data((line + "\n").utf8)) }
@discardableResult
func appleScript(_ source: String) throws -> NSAppleEventDescriptor? {
    var error: NSDictionary?
    let result = NSAppleScript(source: source)?.executeAndReturnError(&error)
    if let error = error { try fail(String(describing: error)) }
    return result
}
func tryScript(_ source: String) -> NSAppleEventDescriptor? { (try? appleScript(source)) ?? nil }
func waitUntil(_ test: () -> Bool, _ message: String) throws {
    for _ in 0..<100 {
        if test() { return }
        Thread.sleep(forTimeInterval: 0.1)
    }
    try fail(message)
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
        if let range = text.range(of: " - \(procName)") { text = String(text[text.startIndex..<range.lowerBound]) }
        return text.trimmingCharacters(in: .whitespaces)
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
                _ = tryScript("with timeout of 5 seconds\ntell application id \"\(bundleId)\" to activate\nend timeout")
            }
            app.activate(options: [.activateAllWindows])
        }
        let exposed = pollUntil(timeout) { !axWindowList(app).isEmpty }
        if !exposed {
            FileHandle.standardError.write(Data("AXURE_GUI_AX_NOT_EXPOSED windows=0 frontmost=\((tryScript("tell application \"System Events\" to tell process \"\(procName)\" to get frontmost")?.booleanValue).map(String.init) ?? "?")\n".utf8))
        }
        return exposed
    }

    /// 按窗口自己的关闭按钮关闭指定文档。
    /// 不能用「文件 → 关闭」：它作用在最前面的文档上，连续作业时会关错并把该关的留下。
    func pressCloseButton(_ app: NSRunningApplication, _ docTitle: String) -> Bool {
        _ = ensureExposed(app)
        for window in axWindowList(app) where documentKey(axTitle(window)) == docTitle {
            guard let ref = axAttr(window, kAXCloseButtonAttribute as String) else { continue }
            if AXUIElementPerformAction(ref as! AXUIElement, kAXPressAction as CFString) == .success { return true }
        }
        return false
    }

    /// 把某个已打开的文档抬到最前。Axure 只把「活动文档」暴露给可访问性 API，
    /// 并排打开两个作业时，另一个既不在 AXWindows 里也不在 System Events 的窗口列表里。
    /// 用 LaunchServices 再投递一次同一路径：宿主会把已有窗口抬起来，而不是开第二份。
    func raiseDocument(_ app: NSRunningApplication, _ path: String, _ docTitle: String) -> Bool {
        if axWindowList(app).contains(where: { documentKey(axTitle($0)) == docTitle }) { return true }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        proc.arguments = ["-b", bundleId, path]
        try? proc.run(); proc.waitUntilExit()
        return pollUntil(10) { axWindowList(app).contains { documentKey(axTitle($0)) == docTitle } }
    }

    /// 精确关闭：先按关闭按钮；找不到窗口就先抬起再按。返回是否确实关掉了。
    func closeDocument(_ app: NSRunningApplication, _ path: String, _ docTitle: String) -> Bool {
        if pressCloseButton(app, docTitle), pollUntil(15, { !documentWindows(app).contains(docTitle) }) { return true }
        if raiseDocument(app, path, docTitle), pressCloseButton(app, docTitle),
           pollUntil(15, { !documentWindows(app).contains(docTitle) }) { return true }
        return false
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
            let target = arguments[1]
            guard !target.contains("\n"), !target.contains("\r") else { throw GuiFailure.message("GUI path must not contain newlines") }
            let docTitle = URL(fileURLWithPath: target).deletingPathExtension().lastPathComponent
            guard let app = runningApp(), documentWindows(app).contains(docTitle) else { emit("not-open"); exit(0) }
            // 首次激活时 Axure 的可访问性树常常晚一拍才出现；整段重试一次比单次长等更可靠。
            for attempt in 0..<2 {
                _ = ensureExposed(app)
                if closeDocument(app, target, docTitle) {
                    emit("closed")
                    exit(0)
                }
                if attempt == 0 { Thread.sleep(forTimeInterval: 1.0) }
            }
            throw GuiFailure.message("Owned job document did not close")
        case "--quit":
            guard let app = runningApp() else { emit("not-running"); exit(0) }
            // 可选标题：先按窗口关闭调用方自己的文档，避免 Axure 的「是否保存」提示挡住退出。
            for docTitle in arguments.dropFirst(2) where !docTitle.hasPrefix("--") {
                _ = ensureExposed(app)
                _ = closeDocument(app, docTitle.hasSuffix(".rp") ? docTitle : docTitle + ".rp", docTitle.replacingOccurrences(of: ".rp", with: ""))
            }
            _ = tryScript("with timeout of 10 seconds\ntell application id \"\(bundleId)\" to quit\nend timeout")
            // Axure 退出前要落盘自己的状态；多文档或刚关闭文档时会明显变慢，45s 才算失败。
            if pollUntil(45, { runningApp() == nil }) { emit("quit"); exit(0) }
            throw GuiFailure.message("\(procName) did not quit")
        default:
            throw GuiFailure.message("Unknown mode \(mode)")
        }
    }

    // ------------------------------------------------------------------ 旧形态：roundtrip
    let path = arguments[0]
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

    func matchesTitle(_ windowTitle: String) -> Bool {
        let key = documentKey(windowTitle)
        return key == title || key == title + ".rp"
    }
    func isTarget(_ windowTitle: String) -> Bool { matchesTitle(windowTitle) }
    func isOpen() -> Bool { documentWindows(app).contains(where: isTarget) }
    var observedDocument = false
    func focusTarget() throws {
        try waitUntil({ isOpen() }, "Owned job document is unavailable")
        // 激活并等可访问性树出现；否则下面的 System Events 抬窗会因为「没有窗口」直接失败，
        // 菜单动作也会落到错误的时机上。
        guard ensureExposed(app) else { throw GuiFailure.message("Axure did not expose its document window") }
        if !observedDocument {
            observedDocument = true
            FileHandle.standardError.write(Data("AXURE_GUI_DOCUMENT_OPENED\n".utf8))
        }
        let actualTitle = documentWindows(app).first(where: isTarget) ?? title
        // 所有 System Events 调用都带 5s 超时：宿主忙或被模态框挡住时不至于挂两分钟。
        if tryScript("""
        with timeout of 5 seconds
        tell application "System Events" to tell process "\(procName)"
          set frontmost to true
          perform action "AXRaise" of window \(literal(actualTitle))
        end tell
        end timeout
        """) != nil {
            try waitUntil({
                let focused = tryScript("with timeout of 3 seconds\ntell application \"System Events\" to tell process \"\(procName)\" to get name of value of attribute \"AXFocusedWindow\"\nend timeout")
                return app.isActive && focused.map { documentKey($0.stringValue ?? "") == actualTitle } ?? false
            }, "Owned job document is not the active Axure document")
            return
        }
        // System Events 被 TCC 挡住时的 AXUIElement 兜底
        app.activate(options: [.activateAllWindows])
        Thread.sleep(forTimeInterval: 0.3)
        for w in axWindowList(app) where matchesTitle(axTitle(w)) {
            AXUIElementPerformAction(w, kAXRaiseAction as CFString)
            AXUIElementSetAttributeValue(w, kAXMainAttribute as CFString, kCFBooleanTrue)
        }
        Thread.sleep(forTimeInterval: 0.3)
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
    func axMenuItem(_ menuNames: [String], _ itemNames: [String]) -> AXUIElement? {
        guard let bar = axAttr(axApp, kAXMenuBarAttribute as String) else { return nil }
        let barEl = bar as! AXUIElement
        for m in axChildren(barEl) where menuNames.contains(axTitle(m)) {
            for sub in axChildren(m) {
                for item in axChildren(sub) where itemNames.contains(axTitle(item)) { return item }
            }
        }
        return nil
    }
    /// 菜单项存在且已启用。刚打开文档 / 正在保存时菜单会短暂禁用，
    /// 这时按下 AXPress 会「成功但什么都不做」，是保存静默失败的来源。
    func axMenuReady(_ menuNames: [String], _ itemNames: [String]) -> Bool {
        guard let item = axMenuItem(menuNames, itemNames) else { return false }
        return (axAttr(item, kAXEnabledAttribute as String) as? Bool) ?? true
    }
    func axPressMenu(_ menuNames: [String], _ itemNames: [String]) -> Bool {
        guard let item = axMenuItem(menuNames, itemNames) else { return false }
        return AXUIElementPerformAction(item, kAXPressAction as CFString) == .success
    }
    func waitMenuReady(_ chinese: String, _ english: String, timeout: TimeInterval = 10) -> Bool {
        pollUntil(timeout) { axMenuReady(["文件", "File"], [chinese, english]) }
    }
    func fileAction(_ chinese: String, _ english: String) throws {
        try focusTarget()
        _ = waitMenuReady(chinese, english)  // 来不及启用时仍然尝试点击，由调用方的校验兜底
        if (try? appleScript("""
        with timeout of 5 seconds
        tell application "System Events" to tell process "\(procName)"
          if exists menu bar item "文件" of menu bar 1 then
            click menu item \(literal(chinese)) of menu "文件" of menu bar item "文件" of menu bar 1
          else
            click menu item \(literal(english)) of menu "File" of menu bar item "File" of menu bar 1
          end if
        end tell
        end timeout
        """)) != nil {
            return
        }
        guard axPressMenu(["文件", "File"], [chinese, english]) else {
            throw GuiFailure.message("AX menu press failed for \(english)/\(chinese)")
        }
    }
    /// 关闭本次作业的文档：先按窗口关闭按钮（精确），不可用时才退到菜单。
    func closeOwnedWindow() throws {
        try focusTarget()
        if closeDocument(app, path, title) { return }
        try fileAction("关闭", "Close")
        try waitUntil({ !isOpen() }, "Owned job document did not close")
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
    try openTarget()
    phase("opened")
    // 保存必须校验：磁盘 mtime 没变就是没保存，重新聚焦再按一次（最多三次）。
    var saved = false
    for attempt in 1...3 {
        try fileAction("保存", "Save")
        saved = pollUntil(6) {
            let after = (try? FileManager.default.attributesOfItem(atPath: path)[.modificationDate]) as? Date
            return after != nil && after != before
        }
        if saved { break }
        FileHandle.standardError.write(Data("AXURE_GUI_RETRY save (\(attempt)/3)\n".utf8))
        Thread.sleep(forTimeInterval: 0.5)
    }
    guard saved else { throw GuiFailure.message("Native Save did not modify the owned output file") }
    phase("saved")
    try closeOwnedWindow()
    phase("closed")
    try openTarget()
    phase("reopened")
    if wantPreview {
        try focusTarget()
        if (try? appleScript("""
        with timeout of 5 seconds
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
        end timeout
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