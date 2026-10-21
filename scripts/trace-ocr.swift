import Foundation
import Vision
import AppKit
import CoreGraphics

guard CommandLine.arguments.count > 1 else {
    fputs("Usage: swift trace-ocr.swift <image_path>\n", stderr)
    exit(1)
}

let imagePath = CommandLine.arguments[1]
guard let nsImage = NSImage(contentsOfFile: imagePath),
      let cgImage = nsImage.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    fputs("Failed to load image: \(imagePath)\n", stderr)
    exit(1)
}

let origW = cgImage.width
let origH = cgImage.height
let width = Double(origW)
let height = Double(origH)

func toSimplified(_ s: String) -> String {
    return s.applyingTransform(StringTransform("Traditional-Simplified"), reverse: false) ?? s
}

let colorSpace = CGColorSpaceCreateDeviceRGB()
var rawPixels = [UInt8](repeating: 0, count: origW * origH * 4)
if let rawCtx = CGContext(
    data: &rawPixels,
    width: origW,
    height: origH,
    bitsPerComponent: 8,
    bytesPerRow: origW * 4,
    space: colorSpace,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) {
    rawCtx.draw(cgImage, in: CGRect(x: 0, y: 0, width: origW, height: origH))
}

func getRGB(_ x: Int, _ y: Int) -> (Double, Double, Double) {
    let cx = max(0, min(origW - 1, x))
    let cy = max(0, min(origH - 1, y))
    let idx = (cy * origW + cx) * 4
    return (Double(rawPixels[idx]), Double(rawPixels[idx + 1]), Double(rawPixels[idx + 2]))
}

var ocrImage = cgImage
if origW < 1800 && origH < 1800 {
    let upW = origW * 2
    let upH = origH * 2
    if let ctx = CGContext(
        data: nil,
        width: upW,
        height: upH,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) {
        ctx.interpolationQuality = .high
        ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: upW, height: upH))
        if let upscaled = ctx.makeImage() {
            ocrImage = upscaled
        }
    }
}

struct OcrItem {
    var text: String
    var confidence: Float
    var x0: Int
    var y0: Int
    var x1: Int
    var y1: Int
}

var pass1Items: [OcrItem] = []

let request = VNRecognizeTextRequest { req, _ in
    guard let observations = req.results as? [VNRecognizedTextObservation] else { return }
    for obs in observations {
        guard let candidate = obs.topCandidates(1).first else { continue }
        let box = obs.boundingBox
        let x0 = Int(round(box.origin.x * width))
        let y0 = Int(round((1.0 - box.origin.y - box.size.height) * height))
        let w = Int(round(box.size.width * width))
        let h = Int(round(box.size.height * height))
        pass1Items.append(OcrItem(
            text: toSimplified(candidate.string),
            confidence: candidate.confidence,
            x0: max(0, x0),
            y0: max(0, y0),
            x1: min(origW, x0 + w),
            y1: min(origH, y0 + h)
        ))
    }
}

request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.usesLanguageCorrection = true
request.minimumTextHeight = 0.004

let handler = VNImageRequestHandler(cgImage: ocrImage, options: [:])
try handler.perform([request])

// ---------- Pass 2: 同進程內存 Contact Sheet 二次精認 + 圖文解耦 + 豎排文字重排 + Y 軸刻度補全 ----------

struct PatchTask {
    var kind: String          // "replace_box", "split_box", "replace_text", "vertical"
    var parentIdx: Int
    var x0: Int
    var y0: Int
    var x1: Int
    var y1: Int
    var subBoxes: [(Int, Int, Int, Int)]
    var rowY0: Int
    var rowY1: Int
}

func estimateBoxBg(_ x0: Int, _ y0: Int, _ x1: Int, _ y1: Int) -> (Double, Double, Double) {
    var rs: [Double] = [], gs: [Double] = [], bs: [Double] = []
    for x in x0..<x1 {
        let pTop = getRGB(x, y0)
        let pBot = getRGB(x, max(y0, y1 - 1))
        rs.append(pTop.0); gs.append(pTop.1); bs.append(pTop.2)
        rs.append(pBot.0); gs.append(pBot.1); bs.append(pBot.2)
    }
    rs.sort(); gs.sort(); bs.sort()
    let mid = max(0, rs.count / 2)
    return (rs.isEmpty ? 255 : rs[mid], gs.isEmpty ? 255 : gs[mid], bs.isEmpty ? 255 : bs[mid])
}

func colorDist(_ a: (Double, Double, Double), _ b: (Double, Double, Double)) -> Double {
    let dr = a.0 - b.0, dg = a.1 - b.1, db = a.2 - b.2
    return (dr * dr + dg * dg + db * db).squareRoot()
}

func stripLeadingIconPrefix(_ s: String) -> String {
    let t = s.trimmingCharacters(in: .whitespaces)
    if t.count <= 1 { return t }
    let first = t.first!
    let rest = String(t.dropFirst()).trimmingCharacters(in: .whitespaces)
    if rest.isEmpty { return t }
    if "■●•▪◆▲▶〇QDGnE②国".contains(first) || (!first.isNumber && t.contains(" ")) {
        if rest.first == "." || rest.first == "·" {
            let r2 = String(rest.dropFirst()).trimmingCharacters(in: .whitespaces)
            if !r2.isEmpty { return r2 }
        }
        return rest
    }
    if first == "t" && rest.allSatisfy({ $0.isNumber }) {
        return rest
    }
    return t
}

func cleanReocrText(_ s: String) -> String {
    var t = toSimplified(s).trimmingCharacters(in: .whitespacesAndNewlines)
    while let first = t.first, "，,。·•●".contains(first) {
        t = String(t.dropFirst()).trimmingCharacters(in: .whitespaces)
    }
    while let last = t.last, "，,·•●".contains(last) {
        t = String(t.dropLast()).trimmingCharacters(in: .whitespaces)
    }
    return t
}

var tasks: [PatchTask] = []
var dropIndices = Set<Int>()

for (idx, var it) in pass1Items.enumerated() {
    let bw = it.x1 - it.x0
    let bh = it.y1 - it.y0
    if bw < 6 || bh < 6 { continue }

    let bg = estimateBoxBg(it.x0, it.y0, it.x1, it.y1)
    let bgLuma = (bg.0 + bg.1 + bg.2) / 3.0

    let trimmedText = it.text.trimmingCharacters(in: .whitespaces)
    // Rule 1: 獨立單字符檢測 —— 若左側緊鄰漏檢的同高漢字則向左擴展重認 (如 B站「动画」漏「动」、「资讯」漏「资」)；
    //         否則若為低置信度 (<= 0.55) 的非數字單字符圖標幻覺 (如 'E'、'②'、'国'、'X'、'C'、'大'、'★')，直接剔除交由圖標引擎 1:1 裁切
    if trimmedText.count == 1, let ch = trimmedText.first {
        let isCjk = ("\u{4E00}"..."\u{9FFF}").contains(ch)
        if isCjk && bgLuma >= 170 && it.x0 > bh + 4 {
            let lookX0 = max(0, it.x0 - bh - 6)
            let lookX1 = max(0, it.x0 - 2)
            let lookW = lookX1 - lookX0
            if lookW >= 6 {
                var lInkCols = 0
                var minLx = lookW, maxLx = -1
                for lx in 0..<lookW {
                    var cCnt = 0
                    for ly in 0..<bh {
                        if colorDist(getRGB(lookX0 + lx, it.y0 + ly), bg) > 18.0 {
                            cCnt += 1
                        }
                    }
                    if cCnt >= 2 {
                        lInkCols += 1
                        if lx < minLx { minLx = lx }
                        if lx > maxLx { maxLx = lx }
                    }
                }
                let spanW = maxLx >= minLx ? (maxLx - minLx + 1) : 0
                let coveredByOther = pass1Items.enumerated().contains { (otherIdx, other) in
                    otherIdx != idx && other.x1 > lookX0 + minLx && other.x0 < lookX0 + maxLx && abs(other.y0 - it.y0) <= bh
                }
                if !coveredByOther && lInkCols >= 5 && Double(spanW) >= Double(bh) * 0.55 && Double(spanW) <= Double(bh) * 1.35 {
                    let newX0 = max(0, lookX0 + minLx - 1)
                    pass1Items[idx].x0 = newX0
                    tasks.append(PatchTask(
                        kind: "replace_box",
                        parentIdx: idx,
                        x0: newX0, y0: it.y0, x1: it.x1, y1: it.y1,
                        subBoxes: [],
                        rowY0: 0, rowY1: 0
                    ))
                    continue
                }
            }
        }
        let keepSingle = ch.isNumber || "+-x×%".contains(ch)
        if !keepSingle && it.confidence <= 0.55 && Double(bw) <= Double(bh) * 2.2 {
            dropIndices.insert(idx)
            continue
        }
    }

    if bgLuma < 170 { continue }

    var colInk = [Int](repeating: 0, count: bw)
    var colSatSum = [Double](repeating: 0, count: bw)
    for cx in 0..<bw {
        var cnt = 0
        var sSum = 0.0
        for cy in 0..<bh {
            let rgb = getRGB(it.x0 + cx, it.y0 + cy)
            if colorDist(rgb, bg) > 18.0 {
                cnt += 1
                let mx = max(rgb.0, max(rgb.1, rgb.2))
                let mn = min(rgb.0, min(rgb.1, rgb.2))
                sSum += (mx - mn)
            }
        }
        colInk[cx] = cnt
        colSatSum[cx] = sSum
    }

    // Rule 2a: 尾部高飽和認證徽標剝離 (如 X 藍勾被讀成 'Lilzeeの'、'向阳乔木•'、'Jason Lee...●'，即便 confidence == 1.0 也必須剝離)
    if bw >= 24 {
        let searchStart = max(8, bw - Int(round(Double(bh) * 1.65)))
        let searchEnd = max(searchStart, bw - 5)
        var bestSplit: Int? = nil
        for sx in searchStart..<searchEnd {
            if colInk[sx] <= 1 {
                var rInk = 0, rSat = 0.0, rMinX = bw, rMaxX = 0
                for rx in (sx + 1)..<bw {
                    if colInk[rx] > 0 {
                        rInk += colInk[rx]
                        rSat += colSatSum[rx]
                        if rx < rMinX { rMinX = rx }
                        if rx > rMaxX { rMaxX = rx }
                    }
                }
                let rw = rMaxX >= rMinX ? (rMaxX - rMinX + 1) : 0
                var lInk = 0, lSat = 0.0
                for lx in 0..<sx {
                    lInk += colInk[lx]
                    lSat += colSatSum[lx]
                }
                let rMeanSat = rInk > 0 ? (rSat / Double(rInk)) : 0.0
                let lMeanSat = lInk > 0 ? (lSat / Double(lInk)) : 0.0
                if rInk >= 15 && rw >= 6 && Double(rw) <= Double(bh) * 1.45 && rMeanSat > 42.0 && lMeanSat < 28.0 {
                    bestSplit = sx
                    break
                }
            }
        }
        if let splitX = bestSplit {
            var newX1 = it.x0 + splitX
            while newX1 > it.x0 + 6 && colInk[newX1 - it.x0 - 1] == 0 {
                newX1 -= 1
            }
            pass1Items[idx].x1 = newX1
            var cleanT = trimmedText
            if cleanT.count >= 2, let lastCh = cleanT.last {
                if "•●・.。のvV✓✔®©〇".contains(lastCh) || (!lastCh.isASCII && cleanT.dropLast().allSatisfy({ $0.isASCII })) {
                    cleanT = String(cleanT.dropLast()).trimmingCharacters(in: .whitespaces)
                    if cleanT.last == "." || cleanT.last == "・" {
                        cleanT = String(cleanT.dropLast()).trimmingCharacters(in: .whitespaces)
                    }
                }
            }
            pass1Items[idx].text = cleanT
            it = pass1Items[idx]
        }
    }

    let curBw = it.x1 - it.x0
    let iconGap = max(2, Int(round(Double(bh) * 0.16)))
    var segs: [(Int, Int)] = []
    var inSeg = false, sStart = 0, gapRun = 0
    for cx in 0..<curBw {
        if colInk[cx] > 0 {
            if !inSeg { inSeg = true; sStart = cx }
            gapRun = 0
        } else if inSeg {
            gapRun += 1
            if gapRun >= iconGap {
                segs.append((sStart, cx - gapRun + 1))
                inSeg = false
                gapRun = 0
            }
        }
    }
    if inSeg { segs.append((sStart, curBw)) }

    // Rule 2b: 尾部微小下拉箭頭/符號剝離 (如 '为你推荐♥' 尾部的 '∨' 箭頭)
    if segs.count >= 2 {
        let lastSeg = segs[segs.count - 1]
        let prevSeg = segs[segs.count - 2]
        let lw = lastSeg.1 - lastSeg.0
        let gapBefore = lastSeg.0 - prevSeg.1
        var lMinY = bh, lMaxY = 0
        for x in lastSeg.0..<lastSeg.1 {
            for y in 0..<bh {
                if colorDist(getRGB(it.x0 + x, it.y0 + y), bg) > 18.0 {
                    if y < lMinY { lMinY = y }
                    if y > lMaxY { lMaxY = y }
                }
            }
        }
        let lh = max(1, lMaxY - lMinY + 1)
        if gapBefore >= 3 && lw >= 3 && lw <= bh && Double(lh) <= Double(bh) * 0.55 {
            if let lastCh = it.text.trimmingCharacters(in: .whitespaces).last, "♥vVˇ^•●>".contains(lastCh) {
                pass1Items[idx].x1 = it.x0 + prevSeg.1
                pass1Items[idx].text = String(it.text.trimmingCharacters(in: .whitespaces).dropLast()).trimmingCharacters(in: .whitespaces)
                it = pass1Items[idx]
                segs.removeLast()
            }
        }
    }

    // Rule 3: 前置圖標或相鄰圖標殘邊剝離 (如 'n五'->'主页', 'G Grok'->'Grok', '〇17'->'17', 't26'->'6', '122'->'22', '■ Promoted'->'Promoted')
    let firstCh = it.text.trimmingCharacters(in: .whitespaces).first
    let hasLeadingBulletGlyph = firstCh != nil && "■●•▪◆▲▶〇".contains(firstCh!)
    if (it.confidence <= 0.55 || hasLeadingBulletGlyph) && segs.count >= 2 {
        var textSegs: [(Int, Int)] = []
        var hasIconOrWideSplit = false
        var idxS = 0
        while idxS < segs.count {
            let (sx0, sx1) = segs[idxS]
            let sw = sx1 - sx0
            var minY = bh, maxY = 0
            for x in sx0..<sx1 {
                for y in 0..<bh {
                    if colorDist(getRGB(it.x0 + x, it.y0 + y), bg) > 18.0 {
                        if y < minY { minY = y }
                        if y > maxY { maxY = y }
                    }
                }
            }
            let sh = max(1, maxY - minY + 1)
            let startsWithDigit = it.text.first?.isNumber ?? false
            let isClippedEdge = (idxS == 0 && sx0 <= 1 && sw <= 3 && (idxS + 1 < segs.count) && (segs[idxS + 1].0 - sx1) >= 2)
            let isMultiDigitPrefix = startsWithDigit && sw >= 6 && !isClippedEdge
            let isIconLike = isClippedEdge || ((!isMultiDigitPrefix || idxS > 0) && (Double(sw) <= Double(sh) * 1.45) && (sw <= Int(Double(bh) * 1.35)) && (idxS + 1 < segs.count))
            if isIconLike {
                hasIconOrWideSplit = true
                let tx0 = segs[idxS + 1].0
                var tx1 = segs[idxS + 1].1
                var nextIdx = idxS + 2
                while nextIdx < segs.count {
                    let gapToNext = segs[nextIdx].0 - tx1
                    if Double(gapToNext) >= Double(bh) * 0.72 { break }
                    tx1 = segs[nextIdx].1
                    nextIdx += 1
                }
                textSegs.append((tx0, tx1))
                idxS = nextIdx
            } else {
                var tx1 = sx1
                var nextIdx = idxS + 1
                while nextIdx < segs.count {
                    let gapToNext = segs[nextIdx].0 - tx1
                    if Double(gapToNext) >= Double(bh) * 0.72 {
                        hasIconOrWideSplit = true
                        break
                    }
                    tx1 = segs[nextIdx].1
                    nextIdx += 1
                }
                textSegs.append((sx0, tx1))
                idxS = nextIdx
            }
        }
        if hasIconOrWideSplit && !textSegs.isEmpty {
            if textSegs.count == 1 {
                let (tsx0, tsx1) = textSegs[0]
                if tsx1 - tsx0 >= 4 {
                    let newX0 = max(0, it.x0 + tsx0 - 1)
                    let newX1 = min(origW, it.x0 + tsx1 + 1)
                    pass1Items[idx].x0 = newX0
                    pass1Items[idx].x1 = newX1
                    pass1Items[idx].text = stripLeadingIconPrefix(it.text)
                    tasks.append(PatchTask(
                        kind: "replace_box",
                        parentIdx: idx,
                        x0: newX0, y0: it.y0, x1: newX1, y1: it.y1,
                        subBoxes: [],
                        rowY0: 0, rowY1: 0
                    ))
                }
            } else {
                for (tsx0, tsx1) in textSegs where tsx1 - tsx0 >= 4 {
                    tasks.append(PatchTask(
                        kind: "split_box",
                        parentIdx: idx,
                        x0: max(0, it.x0 + tsx0 - 1),
                        y0: it.y0,
                        x1: min(origW, it.x0 + tsx1 + 1),
                        y1: it.y1,
                        subBoxes: [],
                        rowY0: 0, rowY1: 0
                    ))
                }
            }
            continue
        }
    }

    if it.confidence <= 0.45 && curBw <= 120 && bh <= 32 {
        tasks.append(PatchTask(
            kind: "replace_text",
            parentIdx: idx,
            x0: it.x0, y0: it.y0, x1: it.x1, y1: it.y1,
            subBoxes: [],
            rowY0: 0, rowY1: 0
        ))
    }
}

// 檢測 Y 軸等距漏檢的 "0" (如 8000, 6000, 4000, 2000 下方)
var numAxisItems: [(Int, OcrItem)] = []
for (idx, it) in pass1Items.enumerated() where !dropIndices.contains(idx) {
    let trimmed = it.text.trimmingCharacters(in: .whitespaces)
    if let v = Int(trimmed), v >= 100 && v <= 100000 {
        numAxisItems.append((v, it))
    }
}
for i in 0..<numAxisItems.count {
    let (v1, it1) = numAxisItems[i]
    var chain: [(Int, OcrItem)] = [(v1, it1)]
    for j in 0..<numAxisItems.count where j != i {
        let (v2, it2) = numAxisItems[j]
        if abs(it2.x1 - it1.x1) <= 6 && it2.y0 > it1.y0 {
            chain.append((v2, it2))
        }
    }
    chain.sort { $0.1.y0 < $1.1.y0 }
    if chain.count >= 3 {
        let last = chain[chain.count - 1]
        let prev = chain[chain.count - 2]
        let dy = last.1.y0 - prev.1.y0
        let dv = prev.0 - last.0
        if dy > 12 && dy < 80 && dv > 0 && last.0 == dv {
            let expY0 = last.1.y0 + dy - 2
            let expY1 = last.1.y1 + dy + 2
            let expX0 = last.1.x1 - max(10, (last.1.x1 - last.1.x0) / 2)
            let expX1 = last.1.x1 + 2
            let alreadyCovered = pass1Items.contains {
                abs($0.y0 - expY0) <= 8 && abs($0.x1 - expX1) <= 10
            }
            if !alreadyCovered && expY1 < origH {
                let bg = estimateBoxBg(expX0, expY0, expX1, expY1)
                var inkPx = 0
                var minX = expX1, maxX = expX0, minY = expY1, maxY = expY0
                for y in max(0, expY0)..<min(origH, expY1) {
                    for x in max(0, expX0)..<min(origW, expX1) {
                        if colorDist(getRGB(x, y), bg) > 16.0 {
                            inkPx += 1
                            if x < minX { minX = x }
                            if x > maxX { maxX = x }
                            if y < minY { minY = y }
                            if y > maxY { maxY = y }
                        }
                    }
                }
                if inkPx >= 8 {
                    pass1Items.append(OcrItem(
                        text: "0",
                        confidence: 0.90,
                        x0: max(0, minX - 1),
                        y0: max(0, minY - 1),
                        x1: min(origW, maxX + 2),
                        y1: min(origH, maxY + 2)
                    ))
                }
            }
        }
    }
}

// 檢測右側未覆蓋的豎排窄高按鈕文字 (如「換一換」按鈕)
let scaleEst = origW >= 1800 ? 2 : 1
let stripW = 42 * scaleEst
let scanY0 = Int(Double(origH) * 0.25)
let scanY1 = Int(Double(origH) * 0.60)
var stripX0 = Int(Double(origW) * 0.88)
while stripX0 + 16 * scaleEst < origW {
    let stripX1 = min(origW - 2 * scaleEst, stripX0 + stripW)
    var rowBlobs: [(Int, Int, Int, Int)] = []
    var inRow = false, ry0 = 0, gapY = 0
    for y in scanY0..<scanY1 {
        var minX = origW, maxX = 0, cnt = 0
        for x in stripX0..<stripX1 {
            let covered = pass1Items.contains { x >= $0.x0 - 2 && x <= $0.x1 + 2 && y >= $0.y0 - 2 && y <= $0.y1 + 2 }
            if covered { continue }
            let c = getRGB(x, y)
            if (c.0 + c.1 + c.2) / 3.0 < 185.0 {
                cnt += 1
                if x < minX { minX = x }
                if x > maxX { maxX = x }
            }
        }
        let spanW = maxX >= minX ? (maxX - minX + 1) : 0
        if cnt >= 2 && spanW >= 3 * scaleEst && spanW <= 18 * scaleEst {
            if !inRow { inRow = true; ry0 = y }
            gapY = 0
        } else if inRow {
            gapY += 1
            if gapY >= 3 * scaleEst {
                let ry1 = y - gapY + 1
                if ry1 - ry0 >= 1 * scaleEst && ry1 - ry0 <= 18 * scaleEst {
                    var bx0 = origW, bx1 = 0
                    for yy in ry0..<ry1 {
                        for xx in stripX0..<stripX1 {
                            let c = getRGB(xx, yy)
                            if (c.0 + c.1 + c.2) / 3.0 < 185.0 {
                                if xx < bx0 { bx0 = xx }
                                if xx > bx1 { bx1 = xx }
                            }
                        }
                    }
                    if bx1 >= bx0 && (bx1 - bx0 + 1) <= 18 * scaleEst {
                        rowBlobs.append((bx0, ry0, bx1 + 1, ry1))
                    }
                }
                inRow = false
                gapY = 0
            }
        }
    }
    if rowBlobs.count >= 3 {
        let refCx = (rowBlobs.last!.0 + rowBlobs.last!.2) / 2
        let aligned = rowBlobs.filter { abs(($0.0 + $0.2) / 2 - refCx) <= 6 * scaleEst }
        if aligned.count >= 3 {
            let charBlobs = aligned.count >= 4 ? Array(aligned.suffix(3)) : aligned
            tasks.append(PatchTask(
                kind: "vertical",
                parentIdx: -1,
                x0: charBlobs[0].0, y0: charBlobs[0].1, x1: charBlobs[0].2, y1: charBlobs.last!.3,
                subBoxes: charBlobs,
                rowY0: 0, rowY1: 0
            ))
            break
        }
    }
    stripX0 += 20 * scaleEst
}

// Rule 4: 分批構建 Contact Sheet (每批最多 8 行，高度 <= 536px，徹底避免 Apple Vision 因長條圖過高而截斷頂部行)
if !tasks.isEmpty {
    var splitReplacements: [Int: [OcrItem]] = [:]
    let batchSize = 8
    let rowStride = 64
    let sheetW = 640

    var batchStart = 0
    while batchStart < tasks.count {
        let batchEnd = min(tasks.count, batchStart + batchSize)
        let batch = Array(tasks[batchStart..<batchEnd])
        let sheetH = batch.count * rowStride + 24
        var sheetPixels = [UInt8](repeating: 255, count: sheetW * sheetH * 4)

        for (bIdx, t) in batch.enumerated() {
            let baseY = 12 + bIdx * rowStride
            if t.kind == "vertical" {
                var curX = 24
                let sc = 2
                for (bx0, by0, bx1, by1) in t.subBoxes {
                    let rawW = bx1 - bx0
                    let rawH = by1 - by0
                    let boxSide = max(rawW, rawH) + 6
                    let cx = (bx0 + bx1) / 2
                    let cy = (by0 + by1) / 2
                    let sx0 = cx - boxSide / 2
                    let sy0 = cy - boxSide / 2
                    let dstW = boxSide * sc
                    let dstH = min(rowStride - 8, boxSide * sc)
                    let dstY = baseY + max(2, (rowStride - dstH) / 2)
                    for dy in 0..<dstH {
                        let srcY = sy0 + dy / sc
                        for dx in 0..<dstW {
                            let srcX = sx0 + dx / sc
                            let c = getRGB(srcX, srcY)
                            let gray = UInt8(max(0, min(255, Int((c.0 + c.1 + c.2) / 3.0))))
                            let sIdx = ((dstY + dy) * sheetW + (curX + dx)) * 4
                            if sIdx + 3 < sheetPixels.count {
                                sheetPixels[sIdx] = gray
                                sheetPixels[sIdx + 1] = gray
                                sheetPixels[sIdx + 2] = gray
                                sheetPixels[sIdx + 3] = 255
                            }
                        }
                    }
                    curX += dstW + 4
                }
            } else {
                // replace_box 已精確定位文字區間，水平不再向圖標側擴展，避免蹭入圖標邊緣偽影
                let hPad = t.kind == "replace_box" ? 0 : 2
                let padX0 = max(0, t.x0 - hPad)
                let padY0 = max(0, t.y0 - 2)
                let padX1 = min(origW, t.x1 + hPad)
                let padY1 = min(origH, t.y1 + 2)
                let pw = max(1, padX1 - padX0)
                let ph = max(1, padY1 - padY0)
                var grays: [Double] = []
                for dy in 0..<ph {
                    for dx in 0..<pw {
                        let c = getRGB(padX0 + dx, padY0 + dy)
                        grays.append((c.0 + c.1 + c.2) / 3.0)
                    }
                }
                let sortedG = grays.sorted()
                let lo = sortedG[max(0, Int(Double(sortedG.count) * 0.04))]
                let hi = sortedG[min(sortedG.count - 1, Int(Double(sortedG.count) * 0.72))]
                let denom = max(10.0, hi - lo)
                let sc = ph < 22 ? 3 : 2
                let dstW = min(sheetW - 40, pw * sc)
                let dstH = min(rowStride - 12, ph * sc)
                for dy in 0..<dstH {
                    let srcY = Double(dy) / Double(sc)
                    let iy0 = min(ph - 1, Int(srcY))
                    let iy1 = min(ph - 1, iy0 + 1)
                    let fy = srcY - Double(iy0)
                    for dx in 0..<dstW {
                        let srcX = Double(dx) / Double(sc)
                        let ix0 = min(pw - 1, Int(srcX))
                        let ix1 = min(pw - 1, ix0 + 1)
                        let fx = srcX - Double(ix0)
                        let g00 = grays[iy0 * pw + ix0]
                        let g01 = grays[iy0 * pw + ix1]
                        let g10 = grays[iy1 * pw + ix0]
                        let g11 = grays[iy1 * pw + ix1]
                        let gVal = (1 - fx) * (1 - fy) * g00 + fx * (1 - fy) * g01 + (1 - fx) * fy * g10 + fx * fy * g11
                        let norm = UInt8(max(0, min(255, Int(round((gVal - lo) / denom * 240.0 + 15.0)))))
                        let sIdx = ((baseY + 6 + dy) * sheetW + (24 + dx)) * 4
                        if sIdx + 3 < sheetPixels.count {
                            sheetPixels[sIdx] = norm
                            sheetPixels[sIdx + 1] = norm
                            sheetPixels[sIdx + 2] = norm
                            sheetPixels[sIdx + 3] = 255
                        }
                    }
                }
            }
        }

        if let sheetCtx = CGContext(
            data: &sheetPixels,
            width: sheetW,
            height: sheetH,
            bitsPerComponent: 8,
            bytesPerRow: sheetW * 4,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ), let sheetCg = sheetCtx.makeImage() {
            let req2 = VNRecognizeTextRequest { req, _ in
                guard let obsList = req.results as? [VNRecognizedTextObservation] else { return }
                for obs in obsList {
                    guard let cand = obs.topCandidates(1).first else { continue }
                    let box = obs.boundingBox
                    let cy = Int(round((1.0 - box.origin.y - box.size.height * 0.5) * Double(sheetH)))
                    let bIdx = (cy - 12) / rowStride
                    if bIdx < 0 || bIdx >= batch.count { continue }
                    let task = batch[bIdx]
                    let cleanStr = cleanReocrText(cand.string)
                    if cleanStr.isEmpty { continue }

                    if task.kind == "vertical" {
                        let chars = Array(cleanStr.replacingOccurrences(of: " ", with: ""))
                        if chars.count == task.subBoxes.count {
                            for (ci, ch) in chars.enumerated() {
                                let sb = task.subBoxes[ci]
                                pass1Items.append(OcrItem(
                                    text: String(ch),
                                    confidence: max(0.85, cand.confidence),
                                    x0: sb.0, y0: sb.1, x1: sb.2, y1: sb.3
                                ))
                            }
                        }
                    } else if task.kind == "replace_box" {
                        let oldLen = pass1Items[task.parentIdx].text.count
                        let boxRatio = Double(task.x1 - task.x0) / Double(max(1, task.y1 - task.y0))
                        if !(boxRatio > 2.5 && cleanStr.count == 1 && oldLen >= 3) {
                            pass1Items[task.parentIdx] = OcrItem(
                                text: cleanStr,
                                confidence: max(pass1Items[task.parentIdx].confidence, cand.confidence),
                                x0: task.x0, y0: task.y0, x1: task.x1, y1: task.y1
                            )
                        }
                    } else if task.kind == "split_box" {
                        splitReplacements[task.parentIdx, default: []].append(OcrItem(
                            text: cleanStr,
                            confidence: max(0.80, cand.confidence),
                            x0: task.x0, y0: task.y0, x1: task.x1, y1: task.y1
                        ))
                    } else if task.kind == "replace_text" {
                        let oldLen = pass1Items[task.parentIdx].text.count
                        if cand.confidence >= pass1Items[task.parentIdx].confidence && cleanStr.count >= max(1, oldLen - 1) {
                            pass1Items[task.parentIdx].text = cleanStr
                            pass1Items[task.parentIdx].confidence = cand.confidence
                        }
                    }
                }
            }
            req2.recognitionLevel = .accurate
            req2.recognitionLanguages = ["zh-Hans", "en-US"]
            req2.usesLanguageCorrection = true
            req2.minimumTextHeight = 0.008
            try? VNImageRequestHandler(cgImage: sheetCg, options: [:]).perform([req2])
        }
        batchStart = batchEnd
    }

    var newItems: [OcrItem] = []
    for (idx, it) in pass1Items.enumerated() {
        if dropIndices.contains(idx) { continue }
        if let rep = splitReplacements[idx], !rep.isEmpty {
            newItems.append(contentsOf: rep.sorted { $0.x0 < $1.x0 })
        } else {
            newItems.append(it)
        }
    }
    pass1Items = newItems
} else if !dropIndices.isEmpty {
    pass1Items = pass1Items.enumerated().compactMap { dropIndices.contains($0.offset) ? nil : $0.element }
}

pass1Items = pass1Items.filter { it in
    let t = it.text.trimmingCharacters(in: .whitespaces)
    if t.count == 1, let ch = t.first {
        if "①②③④⑤⑥⑦⑧⑨⑩〇◯○●•·■□▲▼◆◇★☆".contains(ch) && it.confidence <= 0.65 {
            return false
        }
        let keepSingle = ch.isNumber || "+-×%".contains(ch)
        let bw = it.x1 - it.x0
        let bh = max(1, it.y1 - it.y0)
        if !keepSingle && it.confidence <= 0.55 && Double(bw) <= Double(bh) * 2.2 {
            return false
        }
    }
    return true
}

let results: [[String: Any]] = pass1Items.map { it in
    return [
        "text": it.text,
        "confidence": it.confidence,
        "x0": it.x0,
        "y0": it.y0,
        "x1": it.x1,
        "y1": it.y1,
        "w": it.x1 - it.x0,
        "h": it.y1 - it.y0
    ]
}

let data = try JSONSerialization.data(withJSONObject: [
    "imageWidth": origW,
    "imageHeight": origH,
    "items": results
], options: [.prettyPrinted])

if let str = String(data: data, encoding: .utf8) {
    print(str)
}
