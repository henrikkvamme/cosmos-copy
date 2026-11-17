// Native messaging host for the Cosmos Copy extension.
// It downloads a media URL, saves it under ~/Downloads/Cosmos References and
// puts the file on the macOS clipboard, like a copy in Finder. Images also go
// on the clipboard as PNG data, so apps that only take image data (such as
// Claude Code with ctrl+v) can paste them. The reference library itself lives
// in a Cosmos collection, so this helper keeps no state.

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
    }
    let file = mediaDir.appendingPathComponent(safeName(name)).appendingPathExtension(ext)
    do { try data.write(to: file) } catch {
        throw HostError(message: "Could not save the file: \(error.localizedDescription)")
    }
    let (changeCount, count) = try putOnClipboard(file: file, png: png, appendTo: appendTo)
    return (file, data.count, changeCount, count)
}

// MARK: - Main

func handle(_ msg: [String: Any]) throws -> [String: Any] {
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
