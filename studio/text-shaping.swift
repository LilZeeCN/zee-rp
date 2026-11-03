import Foundation
import CoreText

// System shaping, including kerning, ligatures, composed characters and fallback
// glyphs. The JS caller batches prefix measurements and caches them per font run.
let input = try JSONSerialization.jsonObject(with: Data(CommandLine.arguments[1].utf8)) as! [String: Any]
let family = input["family"] as? String ?? "PingFang SC"
let size = input["size"] as? Double ?? 14
let weight = input["weight"] as? Double ?? 400
var fileValid = true
if let path = input["file"] as? String {
    let url = URL(fileURLWithPath: path) as CFURL
    let descriptors = CTFontManagerCreateFontDescriptorsFromURL(url) as? [CTFontDescriptor]
    fileValid = !(descriptors?.isEmpty ?? true)
    if fileValid { CTFontManagerRegisterFontsForURL(url, .process, nil) }
}
let traits: [CFString: Any] = [
    kCTFontWeightTrait: weight >= 700 ? 0.4 : weight >= 600 ? 0.3 : weight >= 500 ? 0.23 : 0.0,
    kCTFontSlantTrait: (input["italic"] as? Bool ?? false) ? 0.2 : 0.0
]
let descriptor = CTFontDescriptorCreateWithAttributes([
    kCTFontFamilyNameAttribute: family,
    kCTFontTraitsAttribute: traits
] as CFDictionary)
let font = CTFontCreateWithFontDescriptor(descriptor, size, nil)
func measure(_ text: String) -> Double {
    let attributes = [NSAttributedString.Key(kCTFontAttributeName as String): font]
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attributes))
    return CTLineGetTypographicBounds(line, nil, nil, nil)
}
let text = input["text"] as? String ?? ""
var prefixes: [String: Double] = [:]
var prefix = ""
for character in text.prefix(512) {
    prefix.append(character)
    prefixes[prefix] = measure(prefix)
}
let output: [String: Any] = [
    "width": measure(text), "prefixes": prefixes,
    "ascent": CTFontGetAscent(font), "descent": CTFontGetDescent(font),
    "resolvedFamily": CTFontCopyFamilyName(font) as String, "fileValid": fileValid
]
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]))
