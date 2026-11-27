import Foundation
import Security
import JavaScriptCore
import CryptoKit
import CommonCrypto

enum DirectQuickVault {
    static func supported(_ key: String) -> Bool {
        key == "leapmotor-session" || key.range(of: "^remote-control:(mode|pin):[0-9a-f]{64}$", options: .regularExpression) != nil
    }
    static func query(_ key: String) -> [String: Any] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.leapmore.app.vault", kSecAttrAccount as String: key]
        if supported(key), let group = LeapWidgetStorage.group { q[kSecAttrAccessGroup as String] = group }
        return q
    }

    // Move existing items in place so the extension and main app use a single, device-only credential.
    private static let migrationLock = NSLock()
    private static var migrated = false
    static func ensureMigrated() {
        migrationLock.lock()
        defer { migrationLock.unlock() }
        if migrated { return }
        guard let group = LeapWidgetStorage.group else { return }
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.leapmore.app.vault"]
        let find = base.merging([kSecReturnAttributes as String: true, kSecMatchLimit as String: kSecMatchLimitAll]) { _, new in new }
        var result: CFTypeRef?
        let status = SecItemCopyMatching(find as CFDictionary, &result)
        if status == errSecItemNotFound { migrated = true; return }
        guard status == errSecSuccess, let items = result as? [[String: Any]] else { return }
        var allMoved = true
        for item in items {
            guard let key = item[kSecAttrAccount as String] as? String, supported(key),
                  let previous = item[kSecAttrAccessGroup as String] as? String, previous != group else { continue }
            let old = base.merging([kSecAttrAccount as String: key, kSecAttrAccessGroup as String: previous]) { _, new in new }
            var update: [String: Any] = [kSecAttrAccessGroup as String: group]
            if key == "leapmotor-session" {
                var data: CFTypeRef?
                let get = old.merging([kSecReturnData as String: true]) { _, new in new }
                guard SecItemCopyMatching(get as CFDictionary, &data) == errSecSuccess, let data = data as? Data else {
                    allMoved = false; continue
                }
                update[kSecAttrGeneric as String] = Data(SHA256.hash(data: data))
            }
            if SecItemUpdate(old as CFDictionary, update as CFDictionary) != errSecSuccess { allMoved = false }
        }
        migrated = allMoved
    }
    static func appQuery(_ key: String) -> [String: Any] {
        ensureMigrated()
        let shared = query(key)
        migrationLock.lock()
        let pending = !migrated
        migrationLock.unlock()
        guard pending, supported(key) else { return shared }
        // Keep legacy app-only items usable if migration was interrupted.
        var find = shared
        find.removeValue(forKey: kSecAttrAccessGroup as String)
        find[kSecReturnAttributes as String] = true
        var item: CFTypeRef?
        guard SecItemCopyMatching(find as CFDictionary, &item) == errSecSuccess,
              let attributes = item as? [String: Any], let group = attributes[kSecAttrAccessGroup as String] as? String else { return shared }
        return shared.merging([kSecAttrAccessGroup as String: group]) { _, new in new }
    }

    static func tag(_ value: String) -> Data { Data(SHA256.hash(data: Data(value.utf8))) }
    static func replaceSession(_ previous: String, _ next: String) -> Bool {
        var q = query("leapmotor-session")
        q[kSecAttrGeneric as String] = tag(previous)
        let update: [String: Any] = [kSecValueData as String: Data(next.utf8), kSecAttrGeneric as String: tag(next)]
        return SecItemUpdate(q as CFDictionary, update as CFDictionary) == errSecSuccess
    }

    static func read(_ key: String) -> String? {
        guard supported(key) else { return nil }
        var q = query(key)
        q[kSecReturnData as String] = true
        var value: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &value) == errSecSuccess, let data = value as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

final class QuickTransport: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }

    func send(_ raw: String, deadline: TimeInterval) -> String {
        let remaining = min(6, deadline - ProcessInfo.processInfo.systemUptime)
        guard remaining > 0, let options = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any],
              let text = options["url"] as? String, let url = URL(string: text), let host = url.host?.lowercased(),
              url.scheme == "https", url.user == nil, url.password == nil, url.port == nil,
              host.hasSuffix(".leapmotor.com") || host.hasSuffix(".leapmotor.cn") else { return "" }
        var request = URLRequest(url: url, timeoutInterval: remaining)
        request.httpMethod = options["method"] as? String
        request.allHTTPHeaderFields = options["headers"] as? [String: String]
        request.httpBody = (options["body"] as? String).map { Data($0.utf8) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let semaphore = DispatchSemaphore(value: 0)
        final class Reply: @unchecked Sendable { var value = "" }
        let reply = Reply()
        session.dataTask(with: request) { data, response, _ in
            defer { semaphore.signal() }
            if let status = (response as? HTTPURLResponse)?.statusCode, let data, data.count < 2_000_000,
               let body = String(data: data, encoding: .utf8) {
                reply.value = DirectQuickRuntime.json(["status": status, "body": body])
            }
        }.resume()
        guard semaphore.wait(timeout: .now() + remaining) == .success else { return "" }
        return reply.value
    }
}

enum DirectQuickRuntime {
    private static let work = DispatchQueue(label: "com.leapmore.quick", attributes: .concurrent)
    private static let lock = NSLock()
    private static var active: Set<String> = []
    static func json(_ object: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .fragmentsAllowed]) else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }
    static func takeDemo() -> String {
        return withDemoFile { url in
            let data = (try? Data(contentsOf: url)) ?? Data("[]".utf8)
            try? FileManager.default.removeItem(at: url)
            return String(data: data, encoding: .utf8) ?? "[]"
        } ?? "[]"
    }

    // File coordination serializes extension writes and foreground reads across process boundaries.
    private static func withDemoFile<T>(_ body: (URL) -> T) -> T? {
        guard let group = LeapWidgetStorage.group, let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return nil }
        var value: T?
        NSFileCoordinator().coordinate(writingItemAt: dir.appendingPathComponent("quick-demo.json"), options: [], error: nil) { value = body($0) }
        return value
    }

    private static func recordDemo(_ effect: String) {
        guard let event = try? JSONSerialization.jsonObject(with: Data(effect.utf8)) as? [String: Any] else { return }
        withDemoFile { url in
            let data = try? Data(contentsOf: url)
            let existing = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [[String: Any]] } ?? []
            try? Data(json(Array(existing.suffix(99)) + [event]).utf8).write(to: url, options: [.atomic, .completeFileProtection])
        }
    }

    static func run(action: String, target: String, approval: String = "") async -> String {
        guard let key = try? JSONSerialization.jsonObject(with: Data(target.utf8)) as? [String], key.count >= 3 else { return "请先绑定车辆和预设" }
        let vehicle = json([key[0], key[2]])
        return await withCheckedContinuation { continuation in
            work.async {
                lock.lock()
                let inserted = active.insert(vehicle).inserted
                lock.unlock()
                guard inserted else { continuation.resume(returning: "该车正在执行操作"); return }
                let result = evaluate(action: action, target: target, approval: approval)
                lock.lock(); active.remove(vehicle); lock.unlock()
                continuation.resume(returning: result)
            }
        }
    }

    private static func evaluate(action: String, target: String, approval: String) -> String {
        let deadline = ProcessInfo.processInfo.systemUptime + 28
        let input: @convention(block) () -> String = {
            guard ProcessInfo.processInfo.systemUptime < deadline,
                  let data = LeapWidgetStorage.defaults?.data(forKey: "quick-targets"),
                  let rows = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]],
                  let row = rows.first(where: { $0["id"] as? String == target }) else { return "null" }
            return json(row)
        }
        var result: String?
        let finish: @convention(block) (String, String) -> Void = { message, effect in
            guard result == nil else { return }
            if !effect.isEmpty && input() != "null" { recordDemo(effect) }
            result = message
        }
        let vault: @convention(block) (String) -> String? = { key in input() == "null" ? nil : DirectQuickVault.read(key) }
        let transport = QuickTransport()
        let http: @convention(block) (String) -> String = { raw in input() == "null" ? "" : transport.send(raw, deadline: deadline) }
        let session: @convention(block) (String, String) -> Bool = { previous, next in
            input() != "null" && DirectQuickVault.replaceSession(previous, next)
        }
        guard let js = scriptContext(host: ["input": input as Any, "session": session as Any, "finish": finish as Any,
                                            "vault": vault as Any, "http": http as Any]) else { return "无法载入快捷控制" }
        js.objectForKeyedSubscript("LeapDirect")?.invokeMethod("run", withArguments: [action, target, approval])
        return result ?? "快捷控制执行失败"
    }

    static func scriptContext(host: [String: Any]) -> JSContext? {
        let bundle = Bundle.main.bundleURL
        let app = bundle.pathExtension == "appex" ? Bundle(url: bundle.deletingLastPathComponent().deletingLastPathComponent()) : Bundle.main
        guard let url = app?.url(forResource: "quick", withExtension: "js", subdirectory: "public/native"),
              let script = try? String(contentsOf: url, encoding: .utf8), let js = JSContext() else { return nil }
        js.setObject(host, forKeyedSubscript: "QuickHost" as NSString)
        let crypt: @convention(block) (String, String, String, String) -> String? = crypto
        js.setObject(crypt, forKeyedSubscript: "nativeCrypto" as NSString)
        js.evaluateScript(environment)
        js.evaluateScript(script)
        return js.exception == nil ? js : nil
    }

    private static func crypto(_ operation: String, _ bytes: String, _ key: String, _ iv: String) -> String? {
        let data = Data(base64Encoded: bytes) ?? Data()
        let secret = Data(base64Encoded: key) ?? Data()
        switch operation {
        case "sha": return Data(SHA256.hash(data: data)).base64EncodedString()
        case "hmac": return Data(HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: secret))).base64EncodedString()
        case "random":
            guard let count = Int(bytes), (1...65536).contains(count) else { return nil }
            var random = [UInt8](repeating: 0, count: count)
            guard SecRandomCopyBytes(kSecRandomDefault, count, &random) == errSecSuccess else { return nil }
            return Data(random).base64EncodedString()
        case "aes":
            guard secret.count == 16, let vector = Data(base64Encoded: iv), vector.count == 16 else { return nil }
            let capacity = data.count + kCCBlockSizeAES128
            var output = [UInt8](repeating: 0, count: capacity), written = 0
            let status = secret.withUnsafeBytes { k in vector.withUnsafeBytes { v in data.withUnsafeBytes { d in
                CCCrypt(CCOperation(kCCEncrypt), CCAlgorithm(kCCAlgorithmAES), CCOptions(kCCOptionPKCS7Padding),
                        k.baseAddress, secret.count, v.baseAddress, d.baseAddress, data.count, &output, capacity, &written)
            } } }
            return status == kCCSuccess ? Data(output.prefix(written)).base64EncodedString() : nil
        default: return nil
        }
    }
    private static let environment = """
    globalThis.window = globalThis;
    globalThis.navigator = {};
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    globalThis.btoa = str => {
      let value=0, bits=0, result='';
      for (const c of str) { value=(value<<8)|c.charCodeAt(0); bits+=8;
        while(bits>=6) { bits-=6; result+=alphabet[(value>>>bits)&63]; } }
      if(bits) result+=alphabet[(value<<(6-bits))&63];
      return result.padEnd(Math.ceil(result.length/4)*4,'=');
    };
    globalThis.atob = str => {
      let value=0, bits=0, result='';
      for(const c of str.replace(/=+$/,'')) { value=(value<<6)|alphabet.indexOf(c); bits+=6;
        if(bits>=8) { bits-=8; result+=String.fromCharCode((value>>>bits)&255); } } return result;
    };
    globalThis.TextEncoder = class { encode(s) { return Uint8Array.from(unescape(encodeURIComponent(s)), c=>c.charCodeAt(0)); } };
    const encode = v => btoa(String.fromCharCode(...new Uint8Array(v)));
    const decode = s => { if(s == null) throw Error(); return Uint8Array.from(atob(s), c=>c.charCodeAt(0)); };
    globalThis.crypto = {
      getRandomValues(view) { new Uint8Array(view.buffer,view.byteOffset,view.byteLength).set(decode(nativeCrypto('random',String(view.byteLength),'',''))); return view; },
      subtle: { importKey: async (_,v)=>encode(v),
        digest: async (_,v)=>decode(nativeCrypto('sha',encode(v),'','')).buffer,
        sign: async (_,key,v)=>decode(nativeCrypto('hmac',encode(v),key,'')).buffer,
        encrypt: async (options,key,v)=>decode(nativeCrypto('aes',encode(v),key,encode(options.iv))).buffer }
    };
    """
}
