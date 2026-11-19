// Native messaging host for the Cosmos Copy extension.
// It downloads a media URL, saves it under ~/Downloads/Cosmos References and
// puts the file on the macOS clipboard, like a copy in Finder. Images also go
// on the clipboard as PNG data, so apps that only take image data (such as
// Claude Code with ctrl+v) can paste them. An image from Cosmos gets a thin
// strip with its id at the bottom, so an agent that gets the paste knows which
// reference it is. The reference library itself lives in a Cosmos collection,
// so this helper keeps no state.

import AppKit
import CryptoKit
import Foundation

// MARK: - Native messaging

func readMessage() -> [String: Any]? {
    let stdin = FileHandle.standardInput
    let header = stdin.readData(ofLength: 4)
    guard header.count == 4 else { return nil }
    let length = Int(UInt32(littleEndian: header.withUnsafeBytes { $0.load(as: UInt32.self) }))
    let body = stdin.readData(ofLength: length)
    guard body.count == length else { return nil }
    return (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
}

func writeMessage(_ object: [String: Any]) {
    guard let body = try? JSONSerialization.data(withJSONObject: object) else { return }
    var length = UInt32(body.count).littleEndian
    FileHandle.standardOutput.write(Data(bytes: &length, count: 4) + body)
}

struct HostError: Error { let message: String }

let mediaDir = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Downloads/Cosmos References", isDirectory: true)

// MARK: - Download and clipboard

func download(_ url: URL) throws -> (Data, String?) {
    var request = URLRequest(url: url, timeoutInterval: 60)
    request.setValue("Mozilla/5.0 (Macintosh) CosmosCopy/1.0", forHTTPHeaderField: "User-Agent")
    let done = DispatchSemaphore(value: 0)
    var result: (Data?, URLResponse?, Error?)
    URLSession.shared.dataTask(with: request) { data, response, error in
        result = (data, response, error)
        done.signal()
    }.resume()
    done.wait()
    if let error = result.2 { throw HostError(message: "Download failed: \(error.localizedDescription)") }
    guard let http = result.1 as? HTTPURLResponse, let data = result.0 else {
        throw HostError(message: "Download failed: no response")
    }
    guard (200..<300).contains(http.statusCode) else {
        throw HostError(message: "Download failed: HTTP \(http.statusCode)")
    }
    return (data, http.mimeType)
}

func fileExtension(mime: String?, url: URL) -> String {
    switch mime ?? "" {
    case "video/mp4": return "mp4"
    case "video/webm": return "webm"
    case "video/quicktime": return "mov"
    case "image/png": return "png"
    case "image/jpeg": return "jpg"
    case "image/webp": return "webp"
    case "image/gif": return "gif"
    default: return url.pathExtension.isEmpty ? "bin" : url.pathExtension
    }
}

func safeName(_ raw: String) -> String {
    let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
    let cleaned = String(raw.unicodeScalars.map { allowed.contains($0) ? Character($0) : "-" })
    let trimmed = cleaned.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    return trimmed.isEmpty ? "reference-\(Int(Date().timeIntervalSince1970))" : String(trimmed.prefix(80))
}

func pngData(from data: Data) -> Data? {
    guard let image = NSImage(data: data), let tiff = image.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff) else { return nil }
    return rep.representation(using: .png, properties: [:])
}

// MARK: - Id strip

/// The label of a Cosmos reference: its id and two check digits (mod 97, as in an IBAN), so the
/// server can reject an id that an agent read wrongly. The id comes from the file name
/// `cosmos-<id>`, which the extension gives to every Cosmos element. The label ends with the name
/// of the MCP tool, because the image is the only instruction that reaches every agent: some
/// clients do not pass on the server instructions.
func idLabel(forName name: String) -> String? {
    guard name.hasPrefix("cosmos-") else { return nil }
    let digits = name.dropFirst("cosmos-".count)
    guard !digits.isEmpty, digits.count <= 19, digits.allSatisfy({ $0.isASCII && $0.isNumber }),
          let id = UInt64(digits) else { return nil }
    let check = 98 - (id % 97) * 100 % 97
    return "cosmos \(digits)-" + String(format: "%02d", check) + " · call note_references"
}

/// Adds a dark strip with the label under the image. The image itself is not covered. An image
/// that is narrower than the label gets a wider canvas, so the label is never cut.
func withStrip(png: Data, label: String) -> Data? {
    guard let source = NSBitmapImageRep(data: png), let image = source.cgImage else { return nil }
    let width = image.width, height = image.height
    // Apps shrink a pasted image by its long edge, so the text size follows the long edge.
    let fontSize = max(13, (CGFloat(max(width, height)) * 0.01).rounded())
    let strip = Int((fontSize * 1.6).rounded())
    let text = NSAttributedString(string: label, attributes: [
        .font: NSFont.monospacedSystemFont(ofSize: fontSize, weight: .medium),
        .foregroundColor: NSColor(white: 0.82, alpha: 1),
    ])
    let margin = fontSize * 0.8
    let canvasWidth = max(width, Int((text.size().width + margin * 2).rounded(.up)))
    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: canvasWidth, pixelsHigh: height + strip, bitsPerSample: 8,
        samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
        bytesPerRow: 0, bitsPerPixel: 0),
        let context = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
    rep.size = NSSize(width: canvasWidth, height: height + strip)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.cgContext.draw(image, in: CGRect(x: 0, y: strip, width: width, height: height))
    context.cgContext.setFillColor(CGColor(red: 0.05, green: 0.05, blue: 0.055, alpha: 1))
    context.cgContext.fill(CGRect(x: 0, y: 0, width: canvasWidth, height: strip))
    text.draw(at: NSPoint(x: margin, y: (CGFloat(strip) - text.size().height) / 2))
    context.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])
}

/// Puts a file on the clipboard like a copy in Finder, plus PNG data for images.
/// With `appendTo`, the files already on the clipboard stay, but only when the clipboard has not
/// changed since that change count (nothing else was copied in between).
/// Returns the new change count and the number of files on the clipboard.
func putOnClipboard(file: URL, png: Data?, appendTo changeCount: Int?) throws -> (Int, Int) {
    let pasteboard = NSPasteboard.general
    var items: [NSPasteboardItem] = []
    if let changeCount, changeCount == pasteboard.changeCount {
        // Items belong to the pasteboard, so copy them into new items before the clear. Copy only
        // the types this helper writes: macOS adds legacy types that list all files, and copying
        // those into each item breaks the batch.
        for old in pasteboard.pasteboardItems ?? [] {
            guard let oldFile = old.string(forType: .fileURL), oldFile != file.absoluteString else { continue }
            let copy = NSPasteboardItem()
            copy.setString(oldFile, forType: .fileURL)
            if let png = old.data(forType: .png) { copy.setData(png, forType: .png) }
            items.append(copy)
        }
    }
    let item = NSPasteboardItem()
    item.setString(file.absoluteString, forType: .fileURL)
    if let png { item.setData(png, forType: .png) }
    items.append(item)
    pasteboard.clearContents()
    guard pasteboard.writeObjects(items) else { throw HostError(message: "Could not write to the clipboard") }
    // macOS hands over all items after the first on the run loop. Without this, a helper that
    // exits at once leaves only the first file on the clipboard.
    RunLoop.current.run(until: Date().addingTimeInterval(0.3))
    return (pasteboard.changeCount, items.count)
}

/// Downloads media, saves it and puts it on the clipboard. Returns the file and its size.
func fetchAndCopy(url: URL, kind: String, name: String, appendTo: Int?) throws -> (URL, Int, Int, Int) {
    try FileManager.default.createDirectory(at: mediaDir, withIntermediateDirectories: true)
    var (data, mime) = try download(url)
    var ext = fileExtension(mime: mime, url: url)
    var png: Data?
    if kind == "image" {
        // Convert still images to PNG. A GIF stays a GIF, so its animation is kept.
        if ext == "png" {
            png = data
        } else if let converted = pngData(from: data) {
            png = converted
            if ext != "gif" { data = converted; ext = "png" }
        } else {
            throw HostError(message: "The file is not an image")
        }
        // A Cosmos reference gets its id strip. A GIF file stays as it is; its PNG copy gets the strip.
        if let label = idLabel(forName: name), let current = png, let labelled = withStrip(png: current, label: label) {
            png = labelled
            if ext == "png" { data = labelled }
        }
    }
    let file = mediaDir.appendingPathComponent(safeName(name)).appendingPathExtension(ext)
    do { try data.write(to: file) } catch {
        throw HostError(message: "Could not save the file: \(error.localizedDescription)")
    }
    let (changeCount, count) = try putOnClipboard(file: file, png: png, appendTo: appendTo)
    return (file, data.count, changeCount, count)
}

// MARK: - Main

/// Replaces the clipboard with saved reference files, for example after one is removed in the
/// popup. Only files in the media folder are allowed.
func setClipboard(paths: [String], expect changeCount: Int) throws -> Int {
    // Refuse when something else was copied since the extension last looked, so a removal
    // never overwrites newer clipboard content.
    guard NSPasteboard.general.changeCount == changeCount else {
        throw HostError(message: "The clipboard changed. Open the popup again.")
    }
    let dir = mediaDir.standardizedFileURL.path + "/"
    let items = try paths.map { path -> NSPasteboardItem in
        let file = URL(fileURLWithPath: path).standardizedFileURL
        guard file.path.hasPrefix(dir), FileManager.default.fileExists(atPath: file.path) else {
            throw HostError(message: "Not a saved reference: \(file.lastPathComponent)")
        }
        let item = NSPasteboardItem()
        item.setString(file.absoluteString, forType: .fileURL)
        // The same image data as the first copy: PNG as is (it has its strip), a GIF converted
        // to PNG with its strip.
        let ext = file.pathExtension.lowercased()
        if ext == "png", let data = try? Data(contentsOf: file) {
            item.setData(data, forType: .png)
        } else if ext == "gif", let data = try? Data(contentsOf: file), let png = pngData(from: data) {
            let label = idLabel(forName: file.deletingPathExtension().lastPathComponent)
            item.setData(label.flatMap { withStrip(png: png, label: $0) } ?? png, forType: .png)
        }
        return item
    }
    let pasteboard = NSPasteboard.general
    // Check again after the file reads and conversions, right before the clear.
    guard pasteboard.changeCount == changeCount else {
        throw HostError(message: "The clipboard changed. Open the popup again.")
    }
    pasteboard.clearContents()
    if !items.isEmpty {
        guard pasteboard.writeObjects(items) else { throw HostError(message: "Could not write to the clipboard") }
        RunLoop.current.run(until: Date().addingTimeInterval(0.3))
    }
    return pasteboard.changeCount
}

func handle(_ msg: [String: Any]) throws -> [String: Any] {
    switch msg["type"] as? String {
    case "status":
        return ["ok": true, "changeCount": NSPasteboard.general.changeCount]
    case "set":
        let paths = msg["paths"] as? [String] ?? []
        guard let expect = (msg["expect"] as? NSNumber)?.intValue else { throw HostError(message: "Missing expect") }
        return ["ok": true, "changeCount": try setClipboard(paths: paths, expect: expect), "count": paths.count]
    default:
        break
    }
    guard let raw = msg["url"] as? String, let url = URL(string: raw),
          ["http", "https"].contains(url.scheme ?? "") else {
        throw HostError(message: "Bad URL")
    }
    let kind = msg["kind"] as? String ?? "image"
    let name = msg["name"] as? String
        ?? "web-" + SHA256.hash(data: Data(raw.utf8)).map { String(format: "%02x", $0) }.joined().prefix(16)
    let appendTo = (msg["appendTo"] as? NSNumber)?.intValue
    let (file, bytes, changeCount, count) = try fetchAndCopy(url: url, kind: kind, name: name, appendTo: appendTo)
    return ["ok": true, "path": file.path, "bytes": bytes, "kind": kind, "changeCount": changeCount, "count": count]
}

guard let msg = readMessage() else { exit(0) }
do {
    writeMessage(try handle(msg))
} catch let error as HostError {
    writeMessage(["ok": false, "error": error.message])
} catch {
    writeMessage(["ok": false, "error": error.localizedDescription])
}
