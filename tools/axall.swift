import AppKit
let all = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] ?? []
for w in all {
    let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
    let owner = w[kCGWindowOwnerName as String] as? String ?? ""
    let name = w[kCGWindowName as String] as? String ?? ""
    guard (b["Width"] as? Double ?? 0) > 200, (b["Height"] as? Double ?? 0) > 150 else { continue }
    print("\(w[kCGWindowNumber as String] ?? "?") | \(owner) | \(name) | x=\(Int(b["X"] as? Double ?? 0)) y=\(Int(b["Y"] as? Double ?? 0)) w=\(Int(b["Width"] as? Double ?? 0)) h=\(Int(b["Height"] as? Double ?? 0))")
}
