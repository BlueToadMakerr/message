import SwiftUI

/// The iPhone / iPad app: the QuickMessage website inside a WKWebView (see WebView.swift).
@main
struct QuickMessageApp: App {
    var body: some Scene {
        WindowGroup {
            WebContainer()
                .ignoresSafeArea(.container)      // the page handles the notch / home indicator itself (env(safe-area-inset-*))
                .background(Color(UIColor.systemBackground))
        }
    }
}
