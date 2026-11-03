import UIKit
import UserNotifications
import AVFoundation
import WebKit

/// Local notifications for the website running in the web view (js/ios-notify.js talks to this through the "qmNotify" message handler).
/// A web view has no web push, and real push (APNs) needs a paid Apple developer account, so instead: while the app is in the background the page keeps
/// receiving messages (the app plays inaudible silence, which iOS allows to keep running), and every new message becomes a local notification.
/// It cannot work after iOS or you quit the app.
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()
    weak var web: WKWebView?
    private var player: AVAudioPlayer?
    private var inCall = false
    private var uploading = false            // files are being uploaded: keep the page running in the background
    private let key = "qm-notify-enabled"
    private var enabled: Bool {
        get { UserDefaults.standard.bool(forKey: key) }
        set { UserDefaults.standard.set(newValue, forKey: key) }
    }

    func start(web: WKWebView) {
        self.web = web
        UNUserNotificationCenter.current().delegate = self
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(resume), name: UIApplication.didBecomeActiveNotification, object: nil)
        nc.addObserver(self, selector: #selector(resume), name: UIApplication.didEnterBackgroundNotification, object: nil)
        nc.addObserver(self, selector: #selector(resume), name: AVAudioSession.interruptionNotification, object: nil)
        if enabled { startKeepAlive() }
    }

    @objc private func resume() {
        if enabled || inCall || uploading { startKeepAlive() }
        if UIApplication.shared.applicationState == .active { UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ["qm-upload"]) }
    }

    func handle(_ body: Any) {
        guard let m = body as? [String: Any], let op = m["op"] as? String else { return }
        switch op {
        case "status":
            report()
        case "enable":
            if (m["on"] as? Bool) == true {
                UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in
                    DispatchQueue.main.async { self.enabled = true; self.startKeepAlive(); self.report() }
                }
            } else {
                enabled = false; stopKeepAlive(); report()
            }
        case "show":
            show(m)
        case "call":
            // While a call (or a screen share) is running the app keeps itself alive in the background too, so the shared screen and the call
            // don't freeze when you switch to another app: the silence plays (mixed with the call's own audio) and the page plays a silent sound.
            inCall = (m["on"] as? Bool) == true
            stopKeepAlive()
            if inCall || enabled || uploading { startKeepAlive() }
        case "upload":
            // Uploads keep running when you leave the app (the silence keeps the page alive); in the background a quiet notification shows the progress.
            let on = (m["on"] as? Bool) == true
            let was = uploading
            uploading = on
            if on {
                if !was { UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge]) { _, _ in } }
                startKeepAlive()
                uploadNote(m)
            } else {
                UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ["qm-upload"])
                if !inCall && !enabled { stopKeepAlive() }
            }
        case "uploadFailed":
            let c = UNMutableNotificationContent()
            c.title = "Upload failed"
            c.body = (m["text"] as? String) ?? "A file couldn't be sent."
            c.sound = .default
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil), withCompletionHandler: nil)
        default:
            break
        }
    }

    private func report() {
        UNUserNotificationCenter.current().getNotificationSettings { s in
            let allowed = s.authorizationStatus == .authorized || s.authorizationStatus == .provisional || s.authorizationStatus == .ephemeral
            DispatchQueue.main.async {
                self.web?.evaluateJavaScript("window.__qmIosNotify && window.__qmIosNotify({enabled:\(self.enabled), allowed:\(allowed)})", completionHandler: nil)
            }
        }
    }

    private func uploadNote(_ m: [String: Any]) {
        guard UIApplication.shared.applicationState != .active else { return }
        let n = (m["count"] as? Int) ?? 1
        let pct = (m["pct"] as? Int) ?? -1
        let c = UNMutableNotificationContent()
        c.title = n == 1 ? "Uploading a file" : "Uploading \(n) files"
        c.body = (pct >= 0 ? "\(pct)% - " : "") + ((m["text"] as? String) ?? "") + "\nLeave QuickMessage in the app switcher: swiping it away stops the upload."
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "qm-upload", content: c, trigger: nil), withCompletionHandler: nil)
    }

    private func show(_ m: [String: Any]) {
        guard enabled else { return }
        let c = UNMutableNotificationContent()
        c.title = (m["title"] as? String) ?? "QuickMessage"
        c.body = (m["body"] as? String) ?? ""
        c.sound = .default
        if let chat = m["chatId"] as? String { c.userInfo = ["chatId": chat]; c.threadIdentifier = chat }
        let id = (m["id"] as? String) ?? UUID().uuidString
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: c, trigger: nil), withCompletionHandler: nil)
    }

    // ---- keep the page alive in the background: inaudible looping silence (the app has the "audio" background mode)
    private func startKeepAlive() {
        if let p = player, p.isPlaying { return }
        do {
            if inCall { try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .default, options: [.mixWithOthers, .defaultToSpeaker, .allowBluetooth]) }
            else { try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [.mixWithOthers]) }
            try AVAudioSession.sharedInstance().setActive(true)
            let p = try AVAudioPlayer(data: Notifier.silentWav())
            p.numberOfLoops = -1
            p.volume = 0.01
            p.prepareToPlay()
            p.play()
            player = p
        } catch {
            player = nil
        }
    }

    private func stopKeepAlive() {
        player?.stop()
        player = nil
    }

    /// One second of 16-bit mono silence as a WAV file, made in memory.
    static func silentWav() -> Data {
        let rate: UInt32 = 8000
        let dataSize: UInt32 = rate * 2
        var d = Data()
        func u32(_ v: UInt32) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 4)) }
        func u16(_ v: UInt16) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 2)) }
        d.append("RIFF".data(using: .ascii)!); u32(36 + dataSize); d.append("WAVE".data(using: .ascii)!)
        d.append("fmt ".data(using: .ascii)!); u32(16); u16(1); u16(1); u32(rate); u32(rate * 2); u16(2); u16(16)
        d.append("data".data(using: .ascii)!); u32(dataSize); d.append(Data(count: Int(dataSize)))
        return d
    }

    // ---- notifications: none while the app is on screen; tapping one opens that chat
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        if let chat = response.notification.request.content.userInfo["chatId"] as? String,
           let data = try? JSONEncoder().encode(chat), let json = String(data: data, encoding: .utf8) {
            web?.evaluateJavaScript("window.QM && window.QM.openChat && window.QM.openChat(\(json))", completionHandler: nil)
        }
        completionHandler()
    }
}
