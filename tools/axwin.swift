import AppKit
import ApplicationServices
let args = CommandLine.arguments
let bundleId = args.count > 1 ? args[1] : "com.axure.AxureRP9"
guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == bundleId }) else { print("NOT_RUNNING"); exit(3) }
let all = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []
for item in all {
    let b = item[kCGWindowBounds as String] as? [String: Any] ?? [:]
    guard (item[kCGWindowOwnerPID as String] as? Int) == Int(app.processIdentifier),
          (item[kCGWindowLayer as String] as? Int) == 0,
          (b["Height"] as? Double ?? 0) > 100 else { continue }
    print("\(item[kCGWindowNumber as String] ?? "?") | x=\(b["X"] ?? "?") y=\(b["Y"] ?? "?") w=\(b["Width"] ?? "?") h=\(b["Height"] ?? "?") | \(item[kCGWindowName as String] as? String ?? "")")
}
