import ReplayKit
import CoreImage
import ImageIO
import Network

/// Broadcast upload extension: iOS gives it every picture of the screen. It shrinks them, makes JPEGs and sends them to the QuickMessage app
/// over a loopback connection (the app must be running, i.e. you are in a call). Memory is tight here (about 50 MB), so frames are dropped rather than queued.
class SampleHandler: RPBroadcastSampleHandler {
    private let queue = DispatchQueue(label: "qm.screen")
    private let ci = CIContext()
    private var conn: NWConnection?
    private var ready = false
    private var attempts = 0
    private var edge: CGFloat = 1024
    private var quality: CGFloat = 0.55
    private var fps = 5.0
    private var last = Date.distantPast
    private var pending = 0
    private var inbox = ""

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        connect()
    }

    override func broadcastFinished() {
        conn?.cancel()
    }

    private func connect() {
        let c = NWConnection(host: "127.0.0.1", port: 47931, using: .tcp)
        conn = c
        c.stateUpdateHandler = { [weak self] st in
            guard let self = self else { return }
            switch st {
            case .ready:
                self.ready = true
                self.attempts = 0
                self.listen(c)
            case .waiting, .failed:
                self.ready = false
                c.cancel()
                self.retry()
            case .cancelled:
                if self.ready { self.ready = false; self.finish("Screen sharing stopped.") }
            default:
                break
            }
        }
        c.start(queue: queue)
    }

    private func retry() {
        attempts += 1
        if attempts > 8 { finish("Open QuickMessage and join a call first, then start sharing from the app."); return }
        queue.asyncAfter(deadline: .now() + 1) { [weak self] in self?.connect() }
    }

    private func finish(_ why: String) {
        let err = NSError(domain: "app.quickmessage.chat", code: 1, userInfo: [NSLocalizedFailureReasonErrorKey: why])
        finishBroadcastWithError(err)
    }

    /// Messages from the app: "Q edge jpeg fps" (quality) and "STOP".
    private func listen(_ c: NWConnection) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 512) { [weak self] data, _, done, error in
            guard let self = self else { return }
            if let d = data, let s = String(data: d, encoding: .utf8) {
                self.inbox += s
                while let nl = self.inbox.firstIndex(of: "\n") {
                    let line = String(self.inbox[self.inbox.startIndex..<nl])
                    self.inbox.removeSubrange(self.inbox.startIndex...nl)
                    if line == "STOP" { self.finish("Screen sharing stopped."); return }
                    let p = line.split(separator: " ")
                    if p.count == 4, p[0] == "Q", let e = Double(p[1]), let j = Double(p[2]), let f = Double(p[3]) {
                        self.edge = CGFloat(max(480, min(2560, e)))
                        self.quality = CGFloat(max(30, min(95, j)) / 100)
                        self.fps = max(1, min(30, f))
                    }
                }
            }
            if done || error != nil { return }
            self.listen(c)
        }
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        guard sampleBufferType == .video, ready, let c = conn, pending < 2 else { return }
        let now = Date()
        if now.timeIntervalSince(last) < 1.0 / fps { return }
        guard let px = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        last = now
        var img = CIImage(cvPixelBuffer: px)
        // ReplayKit hands over the screen already upright for portrait (a 180° "down" / mirrored value there is how the DEVICE is held, not how the
        // picture is stored: applying it turned the shared screen upside down). Only the sideways landscape values need turning.
        if let o = CMGetAttachment(sampleBuffer, key: RPVideoSampleOrientationKey as CFString, attachmentModeOut: nil) as? NSNumber,
           let ori = CGImagePropertyOrientation(rawValue: o.uint32Value) {
            switch ori {
            case .left, .leftMirrored, .right, .rightMirrored:
                // only if the picture really is stored portrait while the device is landscape (otherwise it is already sideways-correct)
                if img.extent.height > img.extent.width { img = img.oriented(ori == .left || ori == .leftMirrored ? .left : .right) }
            default:
                break
            }
        }
        let longest = max(img.extent.width, img.extent.height)
        if longest > edge { let s = edge / longest; img = img.transformed(by: CGAffineTransform(scaleX: s, y: s)) }
        let opts: [CIImageRepresentationOption: Any] = [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): quality]
        guard let jpg = ci.jpegRepresentation(of: img, colorSpace: CGColorSpaceCreateDeviceRGB(), options: opts) else { return }
        var len = UInt32(jpg.count).bigEndian
        var out = Data(bytes: &len, count: 4)
        out.append(jpg)
        pending += 1
        c.send(content: out, completion: .contentProcessed { [weak self] _ in self?.queue.async { self?.pending -= 1 } })
    }
}
