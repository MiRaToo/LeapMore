import BackgroundTasks
import Foundation
import JavaScriptCore

private struct RecordingProblem: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

// Created and used on the sampling queue. The system task owns its lifetime independently of the WebView.
private final class CloudTripSampler {
    private var sample: JSValue?
    private var reply: [String: Any]?
    init(credentials: String, vehicle: TripBinding) {
        let transport = QuickTransport()
        let http: @convention(block) (String) -> String = { raw in
            transport.send(raw, deadline: ProcessInfo.processInfo.systemUptime + 6)
        }
        let finish: @convention(block) (String, String) -> Void = { [weak self] _, raw in
            self?.reply = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any]
        }
        let js = DirectQuickRuntime.scriptContext(host: ["http": http as Any, "finish": finish as Any])
        sample = js?.objectForKeyedSubscript("LeapDirect")?.invokeMethod("tripSampler", withArguments: [credentials, vehicle.account, vehicle.id, vehicle.vin])
    }
    func poll(location: Bool) -> [String: Any] {
        reply = nil
        _ = sample?.call(withArguments: [location])
        return reply ?? ["interrupt": "采样服务未能启动"]
    }
}

@available(iOS 26.0, *)
final class TripRecorder {
    static let shared = TripRecorder()
    private let activityTitle = "LeapMore 正在记录行程和充电"
    private let identifier = (Bundle.main.bundleIdentifier ?? "com.leapmore.app") + ".trip.manual"
    private let queue = DispatchQueue(label: "com.leapmore.trip.samples", qos: .utility)
    private var registered = false
    private var store: TripRecordingStore?
    private var account = ""
    private var allowed = [String: Bool]()
    private var current: TripRecordingState?
    private var task: BGContinuedProcessingTask?
    private var latestReport: [String: Any]?
    private var reportVersion = 0
    private var generation = UUID()
    private var poll: ((Bool) -> [String: Any])?

    private func database() throws -> TripRecordingStore {
        if let store { return store }
        let manager = FileManager.default
        var dir = try manager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("TripRecording")
        try manager.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try dir.setResourceValues(values)
        let opened = try TripRecordingStore(url: dir.appendingPathComponent("records.sqlite"))
        for previous in try opened.states() where previous.active {
            _ = try opened.finish(previous, interrupted: true, note: "上次记录意外中断")
        }
        store = opened
        return opened
    }
    func register() {
        registered = BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { job in
            guard let job = job as? BGContinuedProcessingTask, self.current != nil, self.task == nil else {
                job.setTaskCompleted(success: false); return
            }
            self.task = job
            let run = self.generation
            job.expirationHandler = {
                DispatchQueue.main.async {
                    guard self.generation == run else { return }
                    try? self.finish(interrupted: true, note: (self.current?.count ?? 0) > 0 ? "已保留中断前的采样" : "中断前尚未收到车辆上报")
                }
            }
            job.progress.totalUnitCount = -1
            self.next(run)
        }
    }
    func configure(account: String, cars: [String: Bool]) throws {
        self.account = account
        allowed = cars
        if let car = current?.vehicle, account != car.account || cars[car.key] == nil {
            try finish(interrupted: true, note: "账号或记录授权已变更")
        } else if let car = current?.vehicle, cars[car.key] == false, latestReport != nil {
            latestReport?["latitude"] = NSNull()
            latestReport?["longitude"] = NSNull()
            reportVersion += 1
        }
    }
    func state(_ car: TripBinding) throws -> TripRecordingState {
        if let current, current.vehicle.account == car.account { return current }
        return try database().states().first { $0.vehicle.key == car.key } ?? TripRecordingState(vehicle: car, phase: "idle")
    }
    func reading(_ car: TripBinding) -> [String: Any] {
        let ownsSampling = current?.vehicle.key == car.key
        var result: [String: Any] = ["ownsSampling": ownsSampling]
        if ownsSampling, let latestReport {
            result["report"] = latestReport
            result["reportVersion"] = reportVersion
        }
        return result
    }
    func snapshot(_ car: TripBinding) throws -> [String: Any] {
        try state(car).payload.merging(reading(car)) { _, new in new }
    }
    func start(_ car: TripBinding) throws {
        guard registered, current == nil else { throw RecordingProblem("系统暂时无法开始新的记录") }
        guard car.account == account, allowed[car.key] != nil else { throw RecordingProblem("该车的手机记录未启用") }
        guard let secret = DirectQuickVault.read("leapmotor-session") else { throw RecordingProblem("请解锁并刷新登录后重试") }
        let db = try database()
        let previous = try state(car)
        let next = TripRecordingState(vehicle: car, phase: "starting", lastSample: previous.lastSample, sampledAt: previous.sampledAt)
        let request = BGContinuedProcessingTaskRequest(identifier: identifier, title: activityTitle,
                                                      subtitle: "\(car.name) · 等待首次采样")
        request.strategy = .fail
        try db.save(next)
        do { try BGTaskScheduler.shared.submit(request) }
        catch {
            try db.save(previous)
            throw RecordingProblem("系统暂未允许后台记录，请稍后重试")
        }
        generation = UUID()
        current = next
        let run = generation
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) {
            if self.generation == run, self.task == nil { try? self.finish(interrupted: true, note: "系统未启动采样，请重试") }
        }
        var sampler: CloudTripSampler?
        poll = { location in
            if sampler == nil { sampler = CloudTripSampler(credentials: secret, vehicle: car) }
            return sampler!.poll(location: location)
        }
    }
    private func next(_ run: UUID) {
        guard generation == run, let car = current?.vehicle, let location = allowed[car.key], let poll else { return }
        queue.async {
            let reply = autoreleasepool { poll(location) }
            DispatchQueue.main.async {
                guard self.generation == run, var state = self.current else { return }
                do {
                    if let reason = reply["interrupt"] as? String {
                        try self.finish(interrupted: true, note: reason)
                        return
                    }
                    state.note = reply["note"] as? String ?? ""
                    if var frame = reply["frame"] as? [String: Any], let at = frame["at"] as? NSNumber, at.int64Value > state.lastSample {
                        if self.allowed[car.key] != true, var data = frame["data"] as? [String: Any] {
                            data.removeValue(forKey: "position"); frame["data"] = data
                        }
                        state.phase = "recording"
                        state.lastSample = at.int64Value
                        state.sampledAt = Int64(Date().timeIntervalSince1970 * 1000)
                        state.count += 1
                        try self.database().save(state, frame: frame)
                        self.task?.progress.completedUnitCount = Int64(state.count)
                        self.task?.updateTitle(self.activityTitle, subtitle: "\(car.name) · 已保存 \(state.count) 次采样")
                    }
                    if var report = reply["report"] as? [String: Any], report["vehicleId"] as? String == car.id {
                        if self.allowed[car.key] != true {
                            report["latitude"] = NSNull(); report["longitude"] = NSNull()
                        }
                        self.latestReport = report
                        self.reportVersion += 1
                    }
                    self.current = state
                    let delay = (reply["delay"] as? NSNumber)?.doubleValue ?? 30_000
                    DispatchQueue.main.asyncAfter(deadline: .now() + max(5, min(120, delay / 1000))) { self.next(run) }
                } catch { try? self.finish(interrupted: true, note: "无法保存本机采样") }
            }
        }
    }
    private func finish(interrupted: Bool, note: String) throws {
        guard let state = current else { return }
        generation = UUID()
        let job = task
        task = nil; current = nil; poll = nil; latestReport = nil
        job?.expirationHandler = nil
        if job == nil { BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier) }
        do {
            _ = try database().finish(state, interrupted: interrupted, note: note)
            job?.setTaskCompleted(success: !interrupted)
        } catch { store = nil; job?.setTaskCompleted(success: false); throw error }
    }
    func stop(scope: String) throws {
        if current?.vehicle.key == scope { try finish(interrupted: false, note: "") }
    }
    func batch(_ car: TripBinding) throws -> [String: Any] { try database().batch(car.key) }
    func ack(_ car: TripBinding, cursor: Int) throws { try database().ack(car.key, cursor: cursor) }
    func clear(_ car: TripBinding) throws { try stop(scope: car.key); try database().clear(car.key) }
}
