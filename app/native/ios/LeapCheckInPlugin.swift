import Capacitor
import Foundation
import WebKit

@objc(LeapCheckInPlugin)
final class LeapCheckInPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "LeapCheckInPlugin"
    let jsName = "LeapCheckIn"
    let pluginMethods: [CAPPluginMethod] = ["checkInOpen", "checkInStep", "checkInClose"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }

    @MainActor private var page: WKWebView?
    @MainActor private var run: String?
    @MainActor private var script = ""
    private let url = URL(string: "https://apptec.leapmotor.com/lpv/user-level/my-level.html?APPFullScreen=true")!

    @MainActor private func close() {
        page?.stopLoading()
        page?.removeFromSuperview()
        page = nil
        script = ""
        run = nil
    }

    @objc func checkInOpen(_ call: CAPPluginCall) {
        Task { @MainActor in
            close()
            guard let run = call.getString("run"), let stored = DirectQuickVault.read("leapmotor-session"),
                  let session = try? JSONSerialization.jsonObject(with: Data(stored.utf8)) as? [String: Any],
                  let account = session["account"] as? [String: Any], let user = account["userId"] as? String,
                  user == call.getString("account"), let token = account["token"] as? String,
                  let resource = Bundle.main.url(forResource: "checkin-page", withExtension: "js", subdirectory: "public"),
                  let source = try? String(contentsOf: resource, encoding: .utf8),
                  let data = try? JSONEncoder().encode(["LMAccID": user, "APPToken": token, "APPPlatform": "ios"]),
                  let identity = String(data: data, encoding: .utf8) else {
                call.reject("无法打开官方签到页"); return
            }
            self.run = run
            script = source + "(" + identity + ","
            let web = WKWebView(frame: bridge?.viewController?.view.bounds ?? CGRect(x: 0, y: 0, width: 390, height: 844))
            web.isUserInteractionEnabled = false
            web.accessibilityElementsHidden = true
            bridge?.viewController?.view.insertSubview(web, at: 0)
            page = web
            web.load(URLRequest(url: url))
            call.resolve()
            try? await Task.sleep(nanoseconds: 60_000_000_000)
            if self.run == run { close() }
        }
    }

    @objc func checkInStep(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard let web = page, run == call.getString("run") else { call.reject("签到已停止"); return }
            guard let location = web.url, location.scheme == url.scheme, location.host == url.host,
                  location.port == nil, location.path == url.path else { call.resolve(["state": "waiting"]); return }
            let submit = call.getBool("submit") == true ? "true" : "false"
            let value = try? await web.evaluateJavaScript(script + submit + ")") as? String
            call.resolve(["state": value ?? "waiting"])
        }
    }

    @objc func checkInClose(_ call: CAPPluginCall) {
        Task { @MainActor in
            if run == call.getString("run") { close() }
            call.resolve()
        }
    }
}
