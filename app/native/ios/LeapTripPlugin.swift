import Capacitor
import Foundation

@available(iOS 26.0, *)
@objc(LeapTripPlugin)
final class LeapTripPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "LeapTripPlugin"
    let jsName = "LeapTrip"
    let pluginMethods: [CAPPluginMethod] = ["configure", "reading", "state", "start", "stop", "batch", "ack", "clear", "pendingShortcut", "applyShortcut"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }

    override func load() {
        DispatchQueue.main.async {
            RecordingShortcutRequest.notify = { [weak self] in self?.notifyListeners("recordingShortcut", data: [:]) }
        }
    }

    @objc func pendingShortcut(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let request = RecordingShortcutRequest.current else { call.resolve(); return }
            call.resolve(["id": request.id, "target": request.target, "start": request.start])
        }
    }

    @objc func applyShortcut(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let request = RecordingShortcutRequest.current, request.id == call.getString("id") else {
                call.reject("快捷指令已失效"); return
            }
            if let issue = call.getString("issue") {
                request.finish(id: request.id, error: issue)
                call.reject(issue); return
            }
            do { try request.apply(demo: call.getBool("demo") == true); call.resolve() }
            catch { request.finish(id: request.id, error: error.localizedDescription); call.reject(error.localizedDescription) }
        }
    }

    @objc func configure(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            do {
                let cars = call.getArray("cars", [String: Any].self) ?? []
                let account = call.getString("account") ?? ""
                var grants = [String: Bool]()
                for car in cars {
                    guard let id = car["id"] as? String, let vin = car["vin"] as? String else { continue }
                    grants[TripBinding(account: account, id: id, vin: vin, name: "").key] = car["location"] as? Bool ?? false
                }
                try TripRecorder.shared.configure(account: account, cars: grants)
                call.resolve()
            } catch { call.reject(error.localizedDescription) }
        }
    }
    private func bound(_ call: CAPPluginCall, _ action: @escaping (TripRecorder, TripBinding) throws -> [String: Any]) {
        DispatchQueue.main.async {
            guard let account = call.getString("account"), let id = call.getString("id"), let vin = call.getString("vin"),
                  !account.isEmpty, !vin.isEmpty, !id.isEmpty else { call.reject("车辆未选择"); return }
            let car = TripBinding(account: account, id: id, vin: vin, name: call.getString("name") ?? "我的车辆")
            do { try call.resolve(action(.shared, car)) } catch { call.reject(error.localizedDescription) }
        }
    }
    @objc func reading(_ call: CAPPluginCall) { bound(call) { $0.reading($1) } }
    @objc func state(_ call: CAPPluginCall) { bound(call) { try $0.snapshot($1) } }
    @objc func start(_ call: CAPPluginCall) { bound(call) { try $0.start($1); return try $0.snapshot($1) } }
    @objc func stop(_ call: CAPPluginCall) { bound(call) { recorder, car in
        let state = try recorder.state(car)
        if state.vehicle.account == car.account, state.vehicle.key == call.getString("scope") { try recorder.stop(scope: state.vehicle.key) }
        return try recorder.snapshot(car)
    } }
    @objc func batch(_ call: CAPPluginCall) { bound(call) { try $0.batch($1) } }
    @objc func ack(_ call: CAPPluginCall) { bound(call) { try $0.ack($1, cursor: call.getInt("cursor") ?? 0); return [:] } }
    @objc func clear(_ call: CAPPluginCall) { bound(call) { try $0.clear($1); return [:] } }
}
