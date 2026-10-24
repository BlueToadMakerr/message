import UIKit
import WebKit
import Network
import ReplayKit

/// Screen sharing on iPhone. iOS only lets an app share the WHOLE screen through a "broadcast extension" (QuickMessageBroadcast), which runs in a
/// separate process. The extension sends JPEG pictures of the screen to this app over a loopback connection (127.0.0.1, never leaves the phone);
/// this app hands them to the call page (window.__qmScreenFrame), exactly like the Android app does. js/native.js → nativeScreen().
final class ScreenReceiver {
    static let shared = ScreenReceiver()
    static let port = NWEndpoint.Port(rawValue: 47931)!
    weak var web: WKWebView?
    private var listener: NWListener?
    private var conn: NWConnection?
    private var buffer = Data()
    private var delivering = false
    private var picker: RPSystemBroadcastPickerView?
    private var edge = 1024, jpeg = 55, fps = 5

    func start(web: WKWebView) {
        self.web = web
        guard listener == nil else { return }
        let params = NWParameters.tcp
        params.requiredInterfaceType = .loopback                 // only this phone can connect
        params.allowLocalEndpointReuse = true
        do {
            let l = try NWListener(using: params, on: Self.port)
            l.newConnectionHandler = { [weak self] c in self?.accept(c) }
            l.start(queue: .main)
            listener = l
        } catch {
            listener = nil
        }
    }

    func handle(_ body: Any) {
        guard let m = body as? [String: Any], let op = m["op"] as? String else { return }
        switch op {
        case "quality":
            edge = max(480, min(2560, (m["edge"] as? Int) ?? edge))
            jpeg = max(30, min(95, (m["jpeg"] as? Int) ?? jpeg))
            fps = max(1, min(30, (m["fps"] as? Int) ?? fps))
            sendSettings()
        case "start":
            presentPicker()
        case "stop":
            conn?.send(content: "STOP\n".data(using: .utf8), completion: .contentProcessed { _ in })
        default:
            break
        }
    }

    // ---- the system "Start Broadcast" sheet (the person must tap it: iOS never starts a screen broadcast by itself)
    private func presentPicker() {
        guard let host = web?.superview ?? web else { return }
        picker?.removeFromSuperview()
        let p = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 44, height: 44))
        p.preferredExtension = (Bundle.main.bundleIdentifier ?? "app.quickmessage.chat") + ".broadcast"
        p.showsMicrophoneButton = false
        p.alpha = 0.011
        host.addSubview(p)
        picker = p
        for v in p.subviews { if let b = v as? UIButton { b.sendActions(for: .touchUpInside) } }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.picker?.removeFromSuperview(); self?.picker = nil }
    }

    // ---- the extension connects, then streams: 4-byte big-endian length + JPEG
    private func accept(_ c: NWConnection) {
        conn?.cancel()
        conn = c
        buffer.removeAll()
        c.stateUpdateHandler = { [weak self] st in
            switch st {
            case .failed, .cancelled: self?.ended(c)
            default: break
            }
        }
        c.start(queue: .main)
        sendSettings()
        state("started")
        read(c)
    }

    private func sendSettings() {
        conn?.send(content: "Q \(edge) \(jpeg) \(fps)\n".data(using: .utf8), completion: .contentProcessed { _ in })
    }

    private func read(_ c: NWConnection) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { [weak self] data, _, done, error in
            guard let self = self, c === self.conn else { return }
            if let d = data, !d.isEmpty {
                self.buffer.append(d)
                self.drain()
            }
            if done || error != nil { self.ended(c) } else { self.read(c) }
        }
    }

    private func drain() {
        while buffer.count >= 4 {
            let len = Int(buffer.prefix(4).reduce(0) { ($0 << 8) | UInt32($1) })
            if len <= 0 || len > 8_000_000 { conn?.cancel(); buffer.removeAll(); return }
            if buffer.count < 4 + len { return }
            let jpegData = buffer.subdata(in: 4..<(4 + len))
            buffer.removeSubrange(0..<(4 + len))
            deliver(jpegData)
        }
    }

    private func deliver(_ jpegData: Data) {
        if delivering { return }                                  // the page is still busy with the previous picture: drop this one
        delivering = true
        let b64 = jpegData.base64EncodedString()
        web?.evaluateJavaScript("window.__qmScreenFrame&&window.__qmScreenFrame('\(b64)')") { [weak self] _, _ in self?.delivering = false }
    }

    private func ended(_ c: NWConnection) {
        guard c === conn else { return }
        conn = nil
        buffer.removeAll()
        state("stopped")
    }

    private func state(_ s: String) {
        web?.evaluateJavaScript("window.__qmScreenState&&window.__qmScreenState('\(s)')", completionHandler: nil)
    }
}
