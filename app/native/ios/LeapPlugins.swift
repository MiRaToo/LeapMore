import Capacitor
import CryptoKit
import Foundation
import LocalAuthentication
import Network
import Security
import UIKit
import WidgetKit

final class LeapBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(LeapVaultPlugin())
        bridge?.registerPluginInstance(LeapAuthPlugin())
        bridge?.registerPluginInstance(LeapWidgetPlugin())
        bridge?.registerPluginInstance(LeapSettingsPlugin())
        bridge?.registerPluginInstance(LeapRecorderPlugin())
    }
}

@objc(LeapVaultPlugin)
final class LeapVaultPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "LeapVaultPlugin"
    let jsName = "LeapVault"
    let pluginMethods: [CAPPluginMethod] = ["get", "set", "remove", "biometricsAvailable", "getWithBiometrics"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }
    private let biometricPrefix = "remote-control-biometric:"

    private func query(_ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.leapmore.app.vault",
            kSecAttrAccount as String: key
        ]
    }

    @objc func get(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.hasPrefix(biometricPrefix) else { call.reject("无法读取安全存储"); return }
        read(call, key: key)
    }

    private func read(_ call: CAPPluginCall, key: String) {
        var attributes = query(key)
        attributes[kSecReturnData as String] = true
        attributes[kSecMatchLimit as String] = kSecMatchLimitOne
        var entry: CFTypeRef?
        let result = SecItemCopyMatching(attributes as CFDictionary, &entry)
        if result == errSecItemNotFound { call.resolve(); return }
        guard result == errSecSuccess, let data = entry as? Data, let string = String(data: data, encoding: .utf8) else {
            call.reject("安全存储读取失败")
            return
        }
        call.resolve(["value": string])
    }

    @objc func biometricsAvailable(_ call: CAPPluginCall) {
        let available = LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        call.resolve(["available": available])
    }

    @objc func getWithBiometrics(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), key.hasPrefix(biometricPrefix) else { call.reject("无法读取操作密码"); return }
        let context = LAContext()
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil) else {
            call.reject("本机生物识别不可用")
            return
        }
        context.localizedFallbackTitle = "改用操作密码"
        context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: "验证身份以控车") { [weak self] approved, _ in
            guard approved, let self else {
                call.reject("生物识别未通过")
                return
            }
            self.read(call, key: key)
        }
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), let value = call.getString("value") else {
            call.reject("参数不完整")
            return
        }
        let base = query(key)
        let update: [String: Any] = [
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]
        var result = SecItemUpdate(base as CFDictionary, update as CFDictionary)
        if result == errSecItemNotFound {
            result = SecItemAdd(base.merging(update) { current, _ in current } as CFDictionary, nil)
        }
        if result == errSecSuccess { call.resolve() }
        else { call.reject("安全存储写入失败") }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { call.reject("参数不完整"); return }
        let result = SecItemDelete(query(key) as CFDictionary)
        if result == errSecSuccess || result == errSecItemNotFound { call.resolve() }
        else { call.reject("安全存储删除失败") }
    }
}

@objc(LeapAuthPlugin)
final class LeapAuthPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "LeapAuthPlugin"
    let jsName = "LeapAuth"
    let pluginMethods: [CAPPluginMethod] = ["begin", "take"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }
    private static let callbackPath = "/leapmore-ha"
    private var listener: NWListener?
    private var callback: String?
    private var timeout: DispatchWorkItem?

    @objc func begin(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in self?.openLoopback(call) }
    }

    private func openLoopback(_ call: CAPPluginCall) {
        guard let state = call.getString("state"),
              state.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else {
            call.reject("无效授权参数")
            return
        }
        listener?.cancel()
        timeout?.cancel()
        callback = nil
        let options = NWParameters.tcp
        options.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        do {
            let server = try NWListener(using: options)
            listener = server
            var answered = false
            server.stateUpdateHandler = { state in
                guard !answered else { return }
                switch state {
                case .ready:
                    answered = true
                    guard let port = server.port else { call.reject("无法启动授权回调"); return }
                    call.resolve(["redirect": "http://127.0.0.1:\(port.rawValue)" + Self.callbackPath])
                case .failed, .cancelled:
                    answered = true
                    call.reject("无法启动授权回调")
                default:
                    break
                }
            }
            server.newConnectionHandler = { [weak self, weak server] connection in
                guard let self, let server, let port = server.port else { connection.cancel(); return }
                connection.start(queue: .main)
                self.receive(connection, server: server, expectedState: state, port: port.rawValue, data: Data())
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) { connection.cancel() }
            }
            let abort = DispatchWorkItem { [weak server] in server?.cancel() }
            timeout = abort
            DispatchQueue.main.asyncAfter(deadline: .now() + 600, execute: abort)
            server.start(queue: .main)
        } catch { call.reject("无法启动授权回调") }
    }

    private func receive(_ connection: NWConnection, server: NWListener, expectedState: String, port: UInt16, data: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] chunk, _, finished, error in
            guard let self, self.listener === server else { connection.cancel(); return }
            var content = data
            if let chunk { content.append(chunk) }
            guard content.count <= 8192 else { connection.cancel(); return }
            guard let end = content.firstIndex(of: 10) else {
                if !finished && error == nil { self.receive(connection, server: server, expectedState: expectedState, port: port, data: content) }
                else { connection.cancel() }
                return
            }
            let request = String(decoding: content[..<end], as: UTF8.self).split(separator: " ")
            let redirect = "http://127.0.0.1:\(port)"
            var valid = false
            if request.count == 3, request[0] == "GET",
               request[1].hasPrefix(Self.callbackPath + "?"),
               let url = URLComponents(string: redirect + request[1]) {
                let params = url.queryItems ?? []
                valid = params.first { $0.name == "state" }?.value == expectedState
                    && params.contains { $0.name == "code" || $0.name == "error" }
                if valid { self.callback = url.string; server.cancel() }
            }
            let html = valid ? """
            <meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
            <title>返回 LeapMore</title><p><a href="com.leapmore.app://ha-auth">返回 LeapMore</a></p>
            """ : "Not found"
            let response = "HTTP/1.1 \(valid ? "200 OK" : "404 Not Found")\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Length: \(html.utf8.count)\r\nConnection: close\r\n\r\n" + html
            connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in connection.cancel() })
        }
    }

    @objc func take(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { call.resolve(); return }
            if let url = self.callback { call.resolve(["url": url]) }
            else { call.resolve() }
            self.callback = nil
        }
    }
}

@objc(LeapWidgetPlugin)
final class LeapWidgetPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "LeapWidgetPlugin"
    let jsName = "LeapWidget"
    let pluginMethods: [CAPPluginMethod] = ["update", "clear", "take"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }
    private let storage = UserDefaults(suiteName: "group.com.leapmore.app")

    @objc func update(_ call: CAPPluginCall) {
        guard let summary = call.getObject("summary"),
              let data = try? JSONSerialization.data(withJSONObject: summary), let storage else {
            call.reject("桌面卡片共享存储不可用")
            return
        }
        storage.set(data, forKey: "vehicle-summary")
        storage.set(Date.now, forKey: "vehicle-summary-at")
        WidgetCenter.shared.reloadTimelines(ofKind: "LeapMoreVehicle")
        call.resolve()
    }

    @objc func take(_ call: CAPPluginCall) {
        let action = storage?.string(forKey: "widget-action")
        let at = storage?.object(forKey: "widget-action-at") as? Date
        storage?.removeObject(forKey: "widget-action")
        storage?.removeObject(forKey: "widget-action-at")
        if let action, let at, Date.now.timeIntervalSince(at) < 60 { call.resolve(["action": action]) }
        else { call.resolve() }
    }

    @objc func clear(_ call: CAPPluginCall) {
        storage?.removeObject(forKey: "vehicle-summary")
        storage?.removeObject(forKey: "vehicle-summary-at")
        WidgetCenter.shared.reloadTimelines(ofKind: "LeapMoreVehicle")
        call.resolve()
    }
}

@objc(LeapSettingsPlugin)
final class LeapSettingsPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    let identifier = "LeapSettingsPlugin"
    let jsName = "LeapSettings"
    let pluginMethods: [CAPPluginMethod] = ["open", "openAmap", "saveCsv", "getAppIcon", "setAppIcon"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }
    private var csvExport: (call: CAPPluginCall, folder: URL)?

    @objc func getAppIcon(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let app = UIApplication.shared
            let icon = app.alternateIconName == "AppIconOriginal" ? "original" : "simple"
            call.resolve(["icon": icon, "canChange": app.supportsAlternateIcons])
        }
    }

    @objc func setAppIcon(_ call: CAPPluginCall) {
        guard let icon = call.getString("icon"), ["simple", "original"].contains(icon) else {
            call.reject("应用图标无效")
            return
        }
        DispatchQueue.main.async {
            let app = UIApplication.shared
            guard app.supportsAlternateIcons else { call.reject("当前系统不支持更换桌面图标"); return }
            let name = icon == "original" ? "AppIconOriginal" : nil
            guard app.alternateIconName != name else { call.resolve(); return }
            app.setAlternateIconName(name) { error in
                if error == nil { call.resolve() } else { call.reject("系统未能切换应用图标") }
            }
        }
    }

    @objc func openAmap(_ call: CAPPluginCall) {
        guard let appText = call.getString("app"), let app = URL(string: appText), app.scheme == "iosamap", app.host == "path",
              let webText = call.getString("web"), let web = URL(string: webText), web.scheme == "https",
              web.host == "uri.amap.com", web.path == "/navigation" else {
            call.reject("导航地址无效")
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(app) { opened in
                if opened { call.resolve(); return }
                UIApplication.shared.open(web) { fallback in
                    if fallback { call.resolve() } else { call.reject("无法打开高德地图") }
                }
            }
        }
    }

    @objc func saveCsv(_ call: CAPPluginCall) {
        guard let name = call.getString("name"), name.range(of: #"^[a-zA-Z0-9_-]+\.csv$"#, options: .regularExpression) != nil,
              let text = call.getString("text") else {
            call.reject("CSV 文件无效")
            return
        }
        DispatchQueue.main.async {
            guard let controller = self.bridge?.viewController, self.csvExport == nil else {
                call.reject("无法打开系统保存窗口")
                return
            }
            let manager = FileManager.default
            let folder = manager.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
            let file = folder.appendingPathComponent(name)
            do {
                try manager.createDirectory(at: folder, withIntermediateDirectories: false)
                try text.write(to: file, atomically: true, encoding: .utf8)
            } catch {
                try? manager.removeItem(at: folder)
                call.reject("无法准备 CSV 文件")
                return
            }
            self.csvExport = (call, folder)
            let picker = UIDocumentPickerViewController(forExporting: [file], asCopy: true)
            picker.delegate = self
            controller.present(picker, animated: true)
        }
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        finishCsvExport(saved: !urls.isEmpty)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        finishCsvExport(saved: false)
    }

    private func finishCsvExport(saved: Bool) {
        guard let export = csvExport else { return }
        csvExport = nil
        try? FileManager.default.removeItem(at: export.folder)
        export.call.resolve(["saved": saved])
    }

    @objc func open(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString) else {
                call.reject("无法打开系统设置")
                return
            }
            UIApplication.shared.open(url) { ok in
                if ok { call.resolve() } else { call.reject("无法打开系统设置") }
            }
        }
    }
}

@objc(LeapRecorderPlugin)
final class LeapRecorderPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "LeapRecorderPlugin"
    let jsName = "LeapRecorder"
    let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise)]

    @objc func clear(_ call: CAPPluginCall) {
        guard let vehicle = call.getString("vehicle"), !vehicle.isEmpty else {
            call.reject("车辆未选择")
            return
        }
        do {
            let manager = FileManager.default
            let support = try manager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: false)
            let name = SHA256.hash(data: Data(vehicle.utf8)).map { String(format: "%02x", $0) }.joined()
            let file = support.appendingPathComponent("LeapMoreLocation").appendingPathComponent(name).appendingPathExtension("json")
            if manager.fileExists(atPath: file.path) { try manager.removeItem(at: file) }
            call.resolve()
        } catch let error as CocoaError where error.code == .fileNoSuchFile {
            call.resolve()
        } catch {
            call.reject("无法清理旧版定位采样")
        }
    }
}
