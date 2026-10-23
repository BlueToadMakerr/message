import SwiftUI
import WebKit
import AuthenticationServices

enum Config {
    /// Your site, with the trailing slash (same value as Config.SITE_URL in the Android app).
    static let siteURL = URL(string: "https://bluetoadmaker.infinityfreeapp.com/message/")!
}

struct WebContainer: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true                          // calls and videos play inside the page
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.allowsPictureInPictureMediaPlayback = true
        cfg.applicationNameForUserAgent = "QuickMessageiOS/1"
        cfg.userContentController.add(context.coordinator, name: "qmGoogle")   // "Sign in with Google" (see js/native.js)

        let web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.allowsBackForwardNavigationGestures = true
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.bounces = false
        web.isOpaque = false
        web.backgroundColor = UIColor.systemBackground
        web.scrollView.backgroundColor = UIColor.systemBackground
        context.coordinator.web = web
        web.load(URLRequest(url: Config.siteURL.appendingPathComponent("index.html")))
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, ASWebAuthenticationPresentationContextProviding {
        weak var web: WKWebView?
        private var authSession: ASWebAuthenticationSession?

        // ---- camera / microphone: the site asks, iOS shows its own permission prompt once
        @available(iOS 15.0, *)
        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            decisionHandler(origin.host == Config.siteURL.host ? .grant : .prompt)
        }

        // ---- links: the site stays in the app, everything else opens in Safari (or the matching app: mailto:, tel:, …)
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { decisionHandler(.allow); return }
            let scheme = url.scheme ?? ""
            if scheme == "about" || scheme == "blob" || scheme == "data" || scheme == "file" { decisionHandler(.allow); return }
            let isMain = action.targetFrame?.isMainFrame ?? true
            if (scheme == "http" || scheme == "https") && (!isMain || url.host == Config.siteURL.host) { decisionHandler(.allow); return }
            if action.navigationType == .linkActivated || isMain {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
            } else {
                decisionHandler(.allow)
            }
        }

        // target="_blank" / window.open: open in the same view when it is the site, otherwise outside
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url {
                if url.host == Config.siteURL.host { webView.load(action.request) } else { UIApplication.shared.open(url) }
            }
            return nil
        }

        // JavaScript alert / confirm dialogs
        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
            top()?.present(a, animated: true)
        }
        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
            a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
            top()?.present(a, animated: true)
        }

        // ---- no network: a small page with a retry link
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            let code = (error as NSError).code
            if code == NSURLErrorCancelled { return }
            let html = "<meta name='viewport' content='width=device-width,initial-scale=1'><body style='font-family:-apple-system;text-align:center;padding:4rem 1.5rem;color:#888'><h2>Can't reach QuickMessage</h2><p>\(error.localizedDescription)</p><p><a href='\(Config.siteURL.absoluteString)index.html' style='font-size:1.2rem'>Try again</a></p>"
            webView.loadHTMLString(html, baseURL: nil)
        }

        // ---- Google sign-in: done in the system browser sheet (Google refuses web views), the token comes back as quickmessage://auth?idToken=…
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "qmGoogle" else { return }
            let session = ASWebAuthenticationSession(url: Config.siteURL.appendingPathComponent("app-login.html"), callbackURLScheme: "quickmessage") { [weak self] url, error in
                var token = ""
                if let url = url, let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems {
                    token = items.first(where: { $0.name == "idToken" })?.value ?? ""
                }
                let failed = token.isEmpty && error != nil && (error as NSError?)?.code != ASWebAuthenticationSessionError.canceledLogin.rawValue
                DispatchQueue.main.async { self?.deliver(token: token, failed: failed) }
            }
            session.presentationContextProvider = self
            authSession = session
            session.start()
        }

        private func deliver(token: String, failed: Bool) {
            let t = (try? JSONEncoder().encode(token)).flatMap { String(data: $0, encoding: .utf8) } ?? "\"\""
            web?.evaluateJavaScript("window.__qmGoogleSignIn && window.__qmGoogleSignIn(\(t), \(failed ? "'failed'" : "''"))", completionHandler: nil)
        }

        func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
            top()?.view.window ?? ASPresentationAnchor()
        }

        private func top() -> UIViewController? {
            let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
            var vc = scene?.windows.first(where: { $0.isKeyWindow })?.rootViewController
            while let p = vc?.presentedViewController { vc = p }
            return vc
        }
    }
}
