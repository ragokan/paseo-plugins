// Embedded: Paseo evaluates server bundles without a source directory or a Swift text loader.
export const macHelperSource = String.raw`
import AppKit
import ApplicationServices
import ScreenCaptureKit
import CoreMedia
import CoreVideo
import CoreImage
import ImageIO
import UniformTypeIdentifiers
import CryptoKit
import Carbon
import Darwin

struct HelperError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
let null = NSNull()
func number(_ p: [String: Any], _ key: String, _ fallback: Int = 0) -> Int { (p[key] as? NSNumber)?.intValue ?? fallback }
func fitPixels(_ width: Double, _ height: Double, _ maxWidth: Double, _ maxHeight: Double) -> CGSize {
    let scale = min(1, maxWidth / width, maxHeight / height)
    return CGSize(width: max(1, floor(width * scale)), height: max(1, floor(height * scale)))
}
func cleanTitle(_ title: String) -> String {
    title.replacingOccurrences(of: #"\s[-–]\sBrowserOS.*$"#, with: "", options: [.regularExpression, .caseInsensitive])
}
let namedKeys: [String: CGKeyCode] = [
    "Enter": 36, "Return": 36, "Tab": 48, " ": 49, "Spacebar": 49,
    "Backspace": 51, "Escape": 53, "Esc": 53, "Delete": 117,
    "Home": 115, "End": 119, "PageUp": 116, "PageDown": 121,
    "ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126,
    "F1": 122, "F2": 120, "F3": 99, "F4": 118, "F5": 96, "F6": 97,
    "F7": 98, "F8": 100, "F9": 101, "F10": 109, "F11": 103, "F12": 111,
]
func modifierFlags(_ modifiers: [String], _ key: String) -> CGEventFlags {
    var flags: CGEventFlags = []
    for modifier in modifiers {
        switch modifier {
        case "ctrl": flags.insert(key == "Tab" ? .maskControl : .maskCommand)
        case "meta": flags.insert(.maskControl)
        case "alt": flags.insert(.maskAlternate)
        case "shift": flags.insert(.maskShift)
        default: break
        }
    }
    return flags
}
let ansiKeys: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7,
    "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
    "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22,
    "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
    "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37,
    "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44,
    "n": 45, "m": 46, ".": 47, " ": 49, "\u{0060}": 50,
]
func ansiKey(_ key: String) -> (CGKeyCode, CGEventFlags)? {
    guard key.count == 1 else { return nil }
    if let code = ansiKeys[key] { return (code, []) }
    if let code = ansiKeys[key.lowercased()] { return (code, .maskShift) }
    let plain = Array("1234567890-=[]\\;',./\u{0060}")
    let shifted = Array("!@#$%^&*()_+{}|:\"<>?~")
    if let index = shifted.firstIndex(of: Character(key)), let code = ansiKeys[String(plain[index])] { return (code, .maskShift) }
    return nil
}
func characterKey(_ key: String) -> (CGKeyCode, CGEventFlags)? {
    let source = TISCopyCurrentKeyboardLayoutInputSource().takeRetainedValue()
    if let pointer = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) {
        let data = Unmanaged<CFData>.fromOpaque(pointer).takeUnretainedValue()
        let layout = UnsafeRawPointer(CFDataGetBytePtr(data)!).assumingMemoryBound(to: UCKeyboardLayout.self)
        for (carbon, flags): (UInt32, CGEventFlags) in [(0, []), (UInt32(shiftKey >> 8), .maskShift), (UInt32(optionKey >> 8), .maskAlternate), (UInt32((shiftKey | optionKey) >> 8), [.maskShift, .maskAlternate])] {
            for code in UInt16(0)..<128 {
                var dead: UInt32 = 0
                var length = 0
                var chars = [UniChar](repeating: 0, count: 8)
                let status = UCKeyTranslate(layout, code, UInt16(kUCKeyActionDown), carbon, UInt32(LMGetKbdType()), OptionBits(kUCKeyTranslateNoDeadKeysMask), &dead, chars.count, &length, &chars)
                if status == noErr && String(utf16CodeUnits: chars, count: length) == key { return (code, flags) }
            }
        }
    }
    return ansiKey(key)
}
func textChunks(_ text: String) -> [[UniChar]] {
    let units = Array(text.utf16)
    var result: [[UniChar]] = []
    var offset = 0
    while offset < units.count {
        var end = min(offset + 20, units.count)
        if end < units.count && (0xD800...0xDBFF).contains(units[end - 1]) { end -= 1 }
        result.append(Array(units[offset..<end]))
        offset = end
    }
    return result
}
func attribute(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
    var result: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, key as CFString, &result) == .success ? result : nil
}
func axFrame(_ window: AXUIElement) -> CGRect? {
    guard let position = attribute(window, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
          let size = attribute(window, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    var dimensions = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else { return nil }
    return CGRect(origin: point, size: dimensions)
}
func setFrame(_ window: AXUIElement, _ frame: CGRect) throws {
    var size = frame.size
    var point = frame.origin
    guard let s = AXValueCreate(.cgSize, &size), let p = AXValueCreate(.cgPoint, &point),
          AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, s) == .success,
          AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, p) == .success else {
        throw HelperError("Accessibility could not resize or position the BrowserOS window.")
    }
}
struct BrowserWindow {
    let id: CGWindowID
    let app: NSRunningApplication
    let title: String
    let frame: CGRect
    let minimized: Bool
    let focused: Bool
    var hex: String { "0x" + String(id, radix: 16) }
    var json: [String: Any] { ["id": hex, "title": cleanTitle(title.isEmpty ? (app.localizedName ?? "BrowserOS") : title),
        "width": Int(frame.width.rounded()), "height": Int(frame.height.rounded()), "minimized": minimized, "focused": focused] }
}
func isBrowser(_ app: NSRunningApplication) -> Bool {
    [app.bundleIdentifier, app.localizedName, app.executableURL?.path].compactMap { $0 }.contains {
        let name = $0.lowercased(); return name.contains("browseros") || name.contains("browserclaw")
    }
}
func matchingAX(_ target: BrowserWindow) -> AXUIElement? {
    let app = AXUIElementCreateApplication(target.app.processIdentifier)
    guard let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement] else { return nil }
    let matches = windows.filter { window in
        guard let frame = axFrame(window) else { return false }
        return abs(frame.minX - target.frame.minX) < 3 && abs(frame.minY - target.frame.minY) < 3 &&
            abs(frame.width - target.frame.width) < 3 && abs(frame.height - target.frame.height) < 3
    }
    if matches.count == 1 { return matches[0] }
    let titled = (matches.isEmpty ? windows : matches).filter {
        guard let title = attribute($0, kAXTitleAttribute) as? String else { return false }
        return !target.title.isEmpty && cleanTitle(title) == cleanTitle(target.title)
    }
    return titled.count == 1 ? titled[0] : nil
}

// Callbacks never encode or hash. Retain only the latest complete surface under the lock.
final class StreamFrames: NSObject, SCStreamOutput, SCStreamDelegate {
    private let lock = NSLock()
    private var buffer: CVPixelBuffer?
    private var version: UInt64 = 0
    private var failed = false
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let rawStatus = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: rawStatus) == .complete,
              let image = sampleBuffer.imageBuffer else { return }
        lock.lock(); buffer = image; version &+= 1; lock.unlock()
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) { lock.lock(); failed = true; lock.unlock() }
    func snapshot() -> (CVPixelBuffer?, UInt64, Bool) { lock.lock(); defer { lock.unlock() }; return (buffer, version, failed) }
}
struct SavedFrame {
    let pixels: String
    let changedAt: Double
    let hash: String
    let image: String
    let mime: String
    let width: Int
    let height: Int
}

@MainActor final class Desktop {
    private var stream: SCStream?
    private var output: StreamFrames?
    private var streamKey = ""
    private var streamWindow: String?
    private var consumed: UInt64 = 0
    private var lastRequest = ProcessInfo.processInfo.systemUptime
    private var retryAt: Double = 0
    private let context = CIContext(options: [.cacheIntermediates: false])
    private var frames: [String: SavedFrame] = [:]
    private var lastImages: [String: CGImage] = [:]
    private var originals: [CGWindowID: (AXUIElement, CGRect, pid_t)] = [:]
    private var heldKeys: Set<CGKeyCode> = []
    private var heldButtons: [Int: CGPoint] = [:]
    private var timer: Timer?
    private var requested: Set<String> = []
    private let permissionDirectory = ProcessInfo.processInfo.environment["PASEO_BROWSEROS_PERMISSION_DIR"] ?? NSHomeDirectory() + "/Library/Application Support/Paseo/browseros-neo"
    private let permissionOwner = ProcessInfo.processInfo.environment["PASEO_BROWSEROS_PERMISSION_OWNER"] ?? ProcessInfo.processInfo.arguments[0]
    init() {
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self = self else { return }
                if ProcessInfo.processInfo.systemUptime - self.lastRequest > 30 {
                    await self.stopStream()
                    self.frames.removeAll(); self.lastImages.removeAll()
                }
            }
        }
    }
    private func requestOnce(_ permission: String, _ action: @escaping () -> Void) {
        guard !requested.contains(permission) else { return }
        requested.insert(permission)
        try? FileManager.default.createDirectory(atPath: permissionDirectory, withIntermediateDirectories: true)
        let ownerID = SHA256.hash(data: Data(permissionOwner.utf8)).prefix(12).map { String(format: "%02x", $0) }.joined()
        let marker = "/requested-" + ownerID + "-" + permission
        let fd = Darwin.open(permissionDirectory + marker, O_WRONLY | O_CREAT | O_EXCL, S_IRUSR | S_IWUSR)
        if fd >= 0 {
            Darwin.close(fd)
            // Preserve once-only requests when upgrading from the old cache path.
            let legacyDirectory = NSHomeDirectory() + "/Library/Caches/paseo-browseros-neo"
            if !FileManager.default.fileExists(atPath: legacyDirectory + marker) { action() }
        }
    }
    private func permissions() -> String? {
        let screen = CGPreflightScreenCaptureAccess()
        let accessibility = AXIsProcessTrusted()
        if !screen { requestOnce("screen-capture") { DispatchQueue.global().async { _ = CGRequestScreenCaptureAccess() } } }
        if !accessibility { requestOnce("accessibility") { _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary) } }
        if screen && accessibility { return nil }
        let appName = permissionOwner.contains("/Paseo.app/") ? "Paseo (Paseo Helper)" : permissionOwner
        var missing: [String] = []
        if !screen { missing.append("Screen & System Audio Recording (Screen Recording on macOS 14)") }
        if !accessibility { missing.append(ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 27 ? "Device Control and Data Access (Accessibility)" : "Accessibility") }
        return "Allow " + appName + " in System Settings → Privacy & Security → " + missing.joined(separator: " and ") + ". If macOS lists the native helper instead, allow " + ProcessInfo.processInfo.arguments[0] + ". Permission prompts are requested only once."
    }
    func windows() -> [BrowserWindow] {
        let apps = Dictionary(uniqueKeysWithValues: NSWorkspace.shared.runningApplications.filter(isBrowser).map { ($0.processIdentifier, $0) })
        let info = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        var result: [BrowserWindow] = []
        for item in info {
            guard number(item, kCGWindowLayer as String, -1) == 0,
                  let app = apps[pid_t(number(item, kCGWindowOwnerPID as String))],
                  let bounds = item[kCGWindowBounds as String] as? NSDictionary,
                  let frame = CGRect(dictionaryRepresentation: bounds), frame.width > 0, frame.height > 0 else { continue }
            let id = CGWindowID(number(item, kCGWindowNumber as String))
            let title = item[kCGWindowName as String] as? String ?? ""
            let provisional = BrowserWindow(id: id, app: app, title: title, frame: frame, minimized: false, focused: false)
            let ax = AXIsProcessTrusted() ? matchingAX(provisional) : nil
            let minimized = ax.flatMap { attribute($0, kAXMinimizedAttribute) as? Bool } ?? false
            let focused = app.isActive && ax.map { window in
                guard let current = attribute(AXUIElementCreateApplication(app.processIdentifier), kAXFocusedWindowAttribute) else { return false }
                return CFEqual(current, window)
            } == true
            result.append(BrowserWindow(id: id, app: app, title: title, frame: frame, minimized: minimized, focused: focused))
        }
        return result.sorted {
            if $0.minimized != $1.minimized { return !$0.minimized }
            let a = $0.frame.width * $0.frame.height, b = $1.frame.width * $1.frame.height
            return a == b ? $0.id < $1.id : a > b
        }
    }
    private func selected(_ id: String) throws -> BrowserWindow {
        guard let window = windows().first(where: { $0.hex == id }) else { throw HelperError("The BrowserOS window no longer exists.") }
        return window
    }
    private func empty(_ status: String, _ reason: Any = null, _ windows: [BrowserWindow] = []) -> [String: Any] {
        ["status": status, "reason": reason, "windows": windows.map { $0.json }, "windowId": null,
         "windowWidth": 0, "windowHeight": 0, "hash": null, "changed": false, "image": null,
         "mimeType": "image/jpeg", "imageWidth": 0, "imageHeight": 0]
    }
    private func cacheKey(_ params: [String: Any], _ id: String) -> String {
        [id, String(number(params, "maxWidth")), String(number(params, "maxHeight")), String(number(params, "quality")), String(params["lossless"] as? Bool ?? false)].joined(separator: ":")
    }
    private func stopStream() async {
        let old = stream
        stream = nil; output = nil; streamKey = ""; streamWindow = nil
        try? await old?.stopCapture()
    }
    private func captureImage(_ target: BrowserWindow, _ params: [String: Any]) async throws -> CGImage? {
        let maxWidth = Double(number(params, "maxWidth", 1280)), maxHeight = Double(number(params, "maxHeight", 800))
        let sourceKey = target.hex + ":" + NSStringFromRect(target.frame) + ":" + String(Int(maxWidth)) + ":" + String(Int(maxHeight))
        if streamKey != sourceKey || (output?.snapshot().2 ?? false) {
            await stopStream()
            streamKey = sourceKey
            retryAt = 0
        }
        if stream == nil && ProcessInfo.processInfo.systemUptime < retryAt {
            return try await screenshot(target, maxWidth, maxHeight)
        }
        if stream == nil {
            let (filter, config) = try await configuration(target, maxWidth, maxHeight)
            let receiver = StreamFrames()
            let candidate = SCStream(filter: filter, configuration: config, delegate: receiver)
            do {
                try candidate.addStreamOutput(receiver, type: .screen, sampleHandlerQueue: DispatchQueue(label: "browseros.frames"))
                try await candidate.startCapture()
                stream = candidate; output = receiver; streamWindow = target.hex; consumed = 0
            } catch {
                try? await candidate.stopCapture()
                retryAt = ProcessInfo.processInfo.systemUptime + 5
                return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            }
        }
        // First complete frame arrives asynchronously; never treat idle/blank frames as pixels.
        for _ in 0..<40 {
            if let (buffer, version, failed) = output?.snapshot() {
                if failed { await stopStream(); return try await screenshot(target, maxWidth, maxHeight) }
                if let buffer = buffer {
                    consumed = version
                    let image = CIImage(cvPixelBuffer: buffer)
                    return context.createCGImage(image, from: image.extent)
                }
            }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        await stopStream()
        retryAt = ProcessInfo.processInfo.systemUptime + 5
        return try await screenshot(target, maxWidth, maxHeight)
    }
    private func configuration(_ target: BrowserWindow, _ maxWidth: Double, _ maxHeight: Double) async throws -> (SCContentFilter, SCStreamConfiguration) {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let app = content.applications.first(where: { $0.processID == target.app.processIdentifier }),
              let display = content.displays.max(by: { a, b in
                  let x = a.frame.intersection(target.frame), y = b.frame.intersection(target.frame)
                  return (x.isNull ? 0 : x.width * x.height) < (y.isNull ? 0 : y.width * y.height)
              }), display.frame.intersects(target.frame) else { throw HelperError("BrowserOS is not on a capturable display.") }
        let filter = SCContentFilter(display: display, including: [app], exceptingWindows: [])
        let config = SCStreamConfiguration()
        let size = fitPixels(target.frame.width * Double(filter.pointPixelScale), target.frame.height * Double(filter.pointPixelScale), maxWidth, maxHeight)
        config.width = Int(size.width); config.height = Int(size.height)
        config.sourceRect = target.frame.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY)
        config.showsCursor = false
        config.minimumFrameInterval = CMTime(value: 1, timescale: 60)
        config.queueDepth = 3
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.ignoreShadowsDisplay = true
        config.shouldBeOpaque = true
        return (filter, config)
    }
    private func screenshot(_ target: BrowserWindow, _ width: Double, _ height: Double) async throws -> CGImage {
        let (filter, config) = try await configuration(target, width, height)
        return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    }
    private func pixelID(_ image: CGImage, _ quality: Int, _ lossless: Bool) throws -> String {
        // Canonical tightly packed pixels exclude row padding and uninitialized alpha.
        let stride = image.width * 4
        guard let canvas = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: stride,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue), let data = canvas.data else { throw HelperError("Could not read BrowserOS pixels.") }
        canvas.setFillColor(CGColor(gray: 0, alpha: 1)); canvas.fill(CGRect(x: 0, y: 0, width: image.width, height: image.height))
        canvas.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        var digest = SHA256()
        digest.update(data: Data((String(image.width) + ":" + String(image.height) + ":" + String(quality) + ":" + String(lossless)).utf8))
        // The fourth byte of noneSkipLast is unspecified. Normalize it before hashing.
        let bytes = data.assumingMemoryBound(to: UInt8.self)
        for index in Swift.stride(from: 3, to: stride * image.height, by: 4) { bytes[index] = 255 }
        digest.update(data: Data(bytes: data, count: stride * image.height))
        return digest.finalize().prefix(12).map { String(format: "%02x", $0) }.joined()
    }
    private func encoded(_ image: CGImage, _ quality: Int, _ lossless: Bool) throws -> (Data, String) {
        func encode(_ type: CFString, _ q: Int) throws -> Data {
            let data = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(data, type, 1, nil) else { throw HelperError("Could not encode BrowserOS frame.") }
            CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: Double(q) / 100] as CFDictionary)
            guard CGImageDestinationFinalize(destination) else { throw HelperError("Could not finish BrowserOS frame encoding.") }
            return data as Data
        }
        if lossless {
            let png = try encode(UTType.png.identifier as CFString, quality)
            if png.count <= 1_572_864 { return (png, "image/png") }
        }
        return (try encode(UTType.jpeg.identifier as CFString, lossless ? 95 : quality), "image/jpeg")
    }
    func frame(_ params: [String: Any]) async throws -> [String: Any] {
        lastRequest = ProcessInfo.processInfo.systemUptime
        if let reason = permissions() { return empty("unsupported", reason) }
        let available = windows()
        guard let target = available.first(where: { $0.hex == params["windowId"] as? String }) ?? available.first else {
            await stopStream(); frames.removeAll(); lastImages.removeAll()
            return empty("not-running", "No BrowserOS window is open.")
        }
        let liveIds = Set(available.map { $0.hex })
        frames = frames.filter { liveIds.contains(String($0.key.split(separator: ":")[0])) }
        lastImages = lastImages.filter { liveIds.contains($0.key) }
        var result = empty("ready", null, available)
        result["windowId"] = target.hex; result["windowWidth"] = Int(target.frame.width.rounded()); result["windowHeight"] = Int(target.frame.height.rounded())
        let key = cacheKey(params, target.hex)
        let cached = frames[key]
        var image: CGImage?
        if !target.minimized {
            image = try await captureImage(target, params)
            if let image = image {
                if lastImages.count >= 4 && lastImages[target.hex] == nil { lastImages.removeValue(forKey: lastImages.keys.sorted()[0]) }
                lastImages[target.hex] = image
            }
        } else if let retained = lastImages[target.hex] {
            let size = fitPixels(Double(retained.width), Double(retained.height), Double(number(params, "maxWidth", 1280)), Double(number(params, "maxHeight", 800)))
            if Int(size.width) == retained.width && Int(size.height) == retained.height { image = retained }
            else {
                guard let canvas = CGContext(data: nil, width: Int(size.width), height: Int(size.height), bitsPerComponent: 8, bytesPerRow: Int(size.width) * 4,
                    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { throw HelperError("Could not scale the retained BrowserOS frame.") }
                canvas.interpolationQuality = .high
                canvas.draw(retained, in: CGRect(origin: .zero, size: size))
                image = canvas.makeImage()
            }
        }
        guard let image = image else { return result }
        let quality = number(params, "quality", 70), lossless = params["lossless"] as? Bool ?? false
        let pixels = try pixelID(image, quality, lossless)
        let now = ProcessInfo.processInfo.systemUptime
        let same = cached?.pixels == pixels
        let changedAt = same ? cached!.changedAt : now
        let refined = same && cached!.hash.hasSuffix(".p")
        let tier = lossless && (refined || (params["since"] as? String == pixels + ".j" && now - changedAt >= 0.150)) ? ".p" : ".j"
        let hash = pixels + tier
        let saved: SavedFrame
        if let cached = cached, cached.hash == hash { saved = cached }
        else {
            let (bytes, mime) = try encoded(image, quality, tier == ".p")
            saved = SavedFrame(pixels: pixels, changedAt: changedAt, hash: hash, image: bytes.base64EncodedString(), mime: mime, width: image.width, height: image.height)
            if frames.count >= 24 && frames[key] == nil { frames.removeValue(forKey: frames.keys.sorted()[0]) }
            frames[key] = saved
        }
        let send = params["since"] as? String != hash || params["includeImage"] as? Bool == true
        result["hash"] = hash; result["image"] = send ? saved.image as Any : null; result["changed"] = send
        result["mimeType"] = saved.mime; result["imageWidth"] = saved.width; result["imageHeight"] = saved.height
        return result
    }
    func changed(_ params: [String: Any]) -> [String: Any] {
        let id = params["windowId"] as? String ?? ""
        let cached = frames[cacheKey(params, id)]
        let refine = params["lossless"] as? Bool == true && cached != nil && params["since"] as? String == cached!.pixels + ".j" && ProcessInfo.processInfo.systemUptime - cached!.changedAt >= 0.150
        let snapshot = output?.snapshot()
        let supported = stream != nil && snapshot?.2 == false && streamWindow == id
        return ["supported": supported, "changed": !supported || snapshot!.1 != consumed || refine]
    }
    private func focused(_ target: BrowserWindow, _ ax: AXUIElement) -> Bool {
        guard target.app.isActive, let window = attribute(AXUIElementCreateApplication(target.app.processIdentifier), kAXFocusedWindowAttribute) else { return false }
        return CFEqual(window, ax)
    }
    private func activate(_ target: BrowserWindow) async throws -> AXUIElement {
        guard let ax = matchingAX(target) else { throw HelperError("Accessibility could not identify the exact BrowserOS window; no input was sent.") }
        if target.minimized { _ = AXUIElementSetAttributeValue(ax, kAXMinimizedAttribute as CFString, kCFBooleanFalse) }
        target.app.activate(options: [.activateIgnoringOtherApps])
        let app = AXUIElementCreateApplication(target.app.processIdentifier)
        _ = AXUIElementSetAttributeValue(ax, kAXMainAttribute as CFString, kCFBooleanTrue)
        _ = AXUIElementSetAttributeValue(app, kAXFocusedWindowAttribute as CFString, ax)
        guard AXUIElementPerformAction(ax, kAXRaiseAction as CFString) == .success else { throw HelperError("Accessibility could not raise the BrowserOS window; no input was sent.") }
        for _ in 0..<40 {
            if focused(target, ax) { return ax }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        throw HelperError("The desktop did not activate the exact BrowserOS window; no input was sent.")
    }
    private func keyEvent(_ code: CGKeyCode, _ down: Bool, _ flags: CGEventFlags = []) throws {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down) else { throw HelperError("Could not create keyboard event.") }
        event.flags = flags; event.post(tap: .cghidEventTap)
        if down { heldKeys.insert(code) } else { heldKeys.remove(code) }
    }
    private func mouseEvent(_ button: Int, _ down: Bool, _ point: CGPoint, _ count: Int = 1) throws {
        let type: CGEventType = button == 0 ? (down ? .leftMouseDown : .leftMouseUp) : button == 1 ? (down ? .rightMouseDown : .rightMouseUp) : (down ? .otherMouseDown : .otherMouseUp)
        guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: CGMouseButton(rawValue: UInt32(button))!) else { throw HelperError("Could not create mouse event.") }
        event.setIntegerValueField(.mouseEventClickState, value: Int64(count)); event.post(tap: .cghidEventTap)
        if down { heldButtons[button] = point } else { heldButtons.removeValue(forKey: button) }
    }
    func releaseInput() {
        for code in Array(heldKeys) { try? keyEvent(code, false) }
        for (button, point) in heldButtons { try? mouseEvent(button, false, point) }
        heldButtons.removeAll(); heldKeys.removeAll()
    }
    private func input(_ params: [String: Any]) async throws -> [String: Any] {
        do {
            let target = try selected(params["windowId"] as? String ?? "")
            let ax = try await activate(target)
            for event in params["events"] as? [[String: Any]] ?? [] {
                guard focused(target, ax) else { throw HelperError("The BrowserOS window lost focus; remaining input was stopped.") }
                let kind = event["type"] as? String ?? ""
                if ["move", "down", "up", "click", "scroll"].contains(kind) {
                    guard let frame = axFrame(ax), let x = event["x"] as? Double, let y = event["y"] as? Double, x.isFinite, y.isFinite else { throw HelperError("Invalid BrowserOS pointer coordinates.") }
                    let point = CGPoint(x: frame.minX + max(0, min(frame.width - 1, x)), y: frame.minY + max(0, min(frame.height - 1, y)))
                    let held = heldButtons.keys.sorted().first
                    let move: CGEventType = held == 0 ? .leftMouseDragged : held == 1 ? .rightMouseDragged : held == nil ? .mouseMoved : .otherMouseDragged
                    CGEvent(mouseEventSource: nil, mouseType: move, mouseCursorPosition: point, mouseButton: CGMouseButton(rawValue: UInt32(held ?? 0))!)?.post(tap: .cghidEventTap)
                    if let held = held { heldButtons[held] = point }
                    let button = ["left": 0, "right": 1, "middle": 2][event["button"] as? String ?? "left"] ?? 0
                    if kind == "click" {
                        for count in 1...max(1, min(3, number(event, "count", 1))) {
                            try mouseEvent(button, true, point, count); try mouseEvent(button, false, point, count)
                            try await Task.sleep(nanoseconds: 40_000_000)
                        }
                    } else if kind == "down" || kind == "up" { try mouseEvent(button, kind == "down", point) }
                    else if kind == "scroll" {
                        CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: -Int32(number(event, "dy")), wheel2: -Int32(number(event, "dx")), wheel3: 0)?.post(tap: .cghidEventTap)
                    }
                } else if kind == "text" {
                    for chunk in textChunks(event["text"] as? String ?? "") {
                        guard focused(target, ax) else { throw HelperError("The BrowserOS window lost focus; remaining text was stopped.") }
                        for down in [true, false] {
                            guard let key = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down) else { throw HelperError("Could not create Unicode keyboard event.") }
                            key.flags = []
                            chunk.withUnsafeBufferPointer { key.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: $0.baseAddress) }
                            key.post(tap: .cghidEventTap)
                        }
                        try await Task.sleep(nanoseconds: 5_000_000)
                    }
                } else if kind == "key" {
                    let key = event["key"] as? String ?? ""
                    let modifiers = event["modifiers"] as? [String] ?? []
                    var flags = modifierFlags(modifiers, key)
                    let code: CGKeyCode
                    if let named = namedKeys[key] { code = named }
                    else if key.count == 1 && modifiers.isEmpty {
                        _ = try await input(["windowId": target.hex, "events": [["type": "text", "text": key]]]); continue
                    } else if key.count == 1, let (mapped, additional) = characterKey(key) { code = mapped; flags.formUnion(additional) }
                    else { throw HelperError("Unsupported key: " + key) }
                    try keyEvent(code, true, flags); try keyEvent(code, false, flags)
                } else { throw HelperError("Unknown BrowserOS input event.") }
                try await Task.sleep(nanoseconds: 8_000_000)
            }
            return ["ok": true, "error": null]
        } catch { releaseInput(); throw error }
    }
    private func fit(_ params: [String: Any]) async throws -> [String: Any] {
        let available = windows()
        // Shrinking a window must not make the next fit resize a different one.
        guard let target = available.first(where: { originals[$0.id] != nil }) ?? available.first,
              !target.minimized, let ax = matchingAX(target), let original = axFrame(ax),
              let main = NSScreen.screens.first else { throw HelperError("No BrowserOS window is available to resize through Accessibility.") }
        let visible = main.visibleFrame
        let size = fitPixels(Double(number(params, "width")), Double(number(params, "height")), visible.width, visible.height)
        let origin = CGPoint(x: visible.minX, y: CGDisplayBounds(CGMainDisplayID()).height - visible.maxY)
        originals[target.id] = originals[target.id] ?? (ax, original, target.app.processIdentifier)
        try setFrame(ax, CGRect(origin: origin, size: size))
        try await Task.sleep(nanoseconds: 100_000_000)
        guard let actual = axFrame(ax) else { throw HelperError("Accessibility could not read the resized BrowserOS window.") }
        return ["ok": true, "width": Int(actual.width.rounded()), "height": Int(actual.height.rounded()), "error": null]
    }
    func restore() async throws -> [String: Any] {
        var last = CGSize.zero
        var errors: [String] = []
        for (id, (window, frame, pid)) in originals {
            // A closed window is no longer ours to restore, even if CG reuses its numeric id.
            guard let target = windows().first(where: { $0.id == id && $0.app.processIdentifier == pid }) else { originals.removeValue(forKey: id); continue }
            guard let current = matchingAX(target), CFEqual(current, window) else {
                errors.append("Accessibility could not identify the BrowserOS window to restore; its original frame is retained.")
                continue
            }
            do { try setFrame(window, frame); last = frame.size; originals.removeValue(forKey: id) }
            catch { errors.append(error.localizedDescription) }
        }
        if !errors.isEmpty { throw HelperError(errors.joined(separator: "; ")) }
        return ["ok": true, "width": Int(last.width.rounded()), "height": Int(last.height.rounded()), "error": null]
    }
    private func launch() async throws -> [String: Any] {
        let roots = ["/Applications", NSHomeDirectory() + "/Applications"]
        let paths = roots.flatMap { root in (try? FileManager.default.contentsOfDirectory(atPath: root))?.filter {
            let name = $0.lowercased(); return $0.hasSuffix(".app") && (name.contains("browseros") || name.contains("browserclaw"))
        }.sorted().map { root + "/" + $0 } ?? [] }
        guard let path = paths.first else { throw HelperError("BrowserOS was not found in /Applications or ~/Applications.") }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        if let bundle = Bundle(path: path)?.bundleIdentifier { process.arguments = ["-b", bundle] } else { process.arguments = ["-a", path] }
        process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
        let status: Int32 = try await withCheckedThrowingContinuation { continuation in
            process.terminationHandler = { continuation.resume(returning: $0.terminationStatus) }
            do { try process.run() } catch { continuation.resume(throwing: error) }
        }
        guard status == 0 else { throw HelperError("macOS could not launch BrowserOS (open exited " + String(status) + ").") }
        return ["ok": true, "error": null]
    }
    func handle(_ method: String, _ params: [String: Any]) async throws -> [String: Any] {
        if method == "frame" { return try await frame(params) }
        if method == "changed" { return changed(params) }
        if method == "launch" { return try await launch() }
        if method == "restore" { return try await restore() }
        if let reason = permissions() { releaseInput(); throw HelperError(reason) }
        if method == "input" { return try await input(params) }
        if method == "activate" {
            _ = try await activate(selected(params["windowId"] as? String ?? ""))
            return ["ok": true, "error": null]
        }
        if method == "fit" { return try await fit(params) }
        throw HelperError("Unknown helper method.")
    }
    func shutdown() async { releaseInput(); _ = try? await restore(); await stopStream() }
}

func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
       let json = String(data: data, encoding: .utf8) {
        // Node readline also splits on Unicode line/paragraph separators.
        let line = json.replacingOccurrences(of: "\u{2028}", with: "\\u2028", options: .literal)
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029", options: .literal)
        // A vanished parent closes stdout before stdin EOF is handled. Avoid
        // SIGPIPE/Foundation exceptions so the reader can reach shutdown/restore.
        Data((line + "\n").utf8).withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(STDOUT_FILENO, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                if count < 0 { if errno == EINTR { continue }; return }
                if count == 0 { return }
                offset += count
            }
        }
    }
}
if CommandLine.arguments.contains("--permissions") {
    emit(["screenRecording": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted()])
} else if CommandLine.arguments.contains("--selftest") {
    let p = (try? JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile())) as? [String: Any] ?? [:]
    emit(["keys": (p["keys"] as? [String] ?? []).map { namedKeys[$0].map { Int($0) as Any } ?? ansiKey($0).map { Int($0.0) as Any } ?? null },
          "modifiers": (p["modifiers"] as? [[String: Any]] ?? []).map { modifierFlags($0["modifiers"] as? [String] ?? [], $0["key"] as? String ?? "").rawValue },
          "sizes": (p["sizes"] as? [[Double]] ?? []).map { let s = fitPixels($0[0], $0[1], $0[2], $0[3]); return [Int(s.width), Int(s.height)] },
          "chunks": textChunks(p["text"] as? String ?? "").map { $0.map { Int($0) } }])
} else {
    // AppKit and SCK need a live main run loop. Only stdin reading runs off-main.
    let application = NSApplication.shared
    application.setActivationPolicy(.prohibited)
    let desktop = MainActor.assumeIsolated { Desktop() }
    signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN); signal(SIGPIPE, SIG_IGN)
    let sources = [SIGTERM, SIGINT].map { code -> DispatchSourceSignal in
        let source = DispatchSource.makeSignalSource(signal: code, queue: .main)
        source.setEventHandler { Task { @MainActor in await desktop.shutdown(); exit(0) } }
        source.resume(); return source
    }
    DispatchQueue.global().async {
        while let line = readLine() {
            let finished = DispatchSemaphore(value: 0)
            Task { @MainActor in
                var id: Any = null
                // DesktopHelper puts its numeric id first. Preserve it even if
                // Foundation rejects JSON containing an unpaired UTF-16 escape.
                if line.hasPrefix("{\"id\":"), let pendingID = Int(line.dropFirst(6).prefix(while: { $0 != "," })) { id = pendingID }
                do {
                    guard let data = line.data(using: .utf8), let request = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let method = request["method"] as? String else { throw HelperError("Invalid JSONL request.") }
                    id = request["id"] ?? null
                    let result = try await desktop.handle(method, request["params"] as? [String: Any] ?? [:])
                    emit(["id": id, "result": result])
                } catch { desktop.releaseInput(); emit(["id": id, "error": error.localizedDescription]) }
                finished.signal()
            }
            finished.wait()
        }
        Task { @MainActor in await desktop.shutdown(); exit(0) }
    }
    withExtendedLifetime(sources) { application.run() }
}
`;
