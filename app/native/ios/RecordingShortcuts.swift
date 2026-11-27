import AppIntents
import Foundation

@available(iOS 26.0, *)
struct StartRecordingShortcut: AppIntent {
    static let title: LocalizedStringResource = "开始记录行程和充电"
    static let supportedModes: IntentModes = .foreground(.immediate)
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    @Parameter(title: "车辆") var vehicle: QuickVehicleEntity
    static var parameterSummary: some ParameterSummary { Summary("开始记录 \(\.$vehicle) 的行程和充电") }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let message = try await RecordingShortcutRequest.run(vehicle: vehicle, start: true)
        return .result(dialog: "\(message)")
    }
}

@available(iOS 26.0, *)
struct StopRecordingShortcut: AppIntent {
    static let title: LocalizedStringResource = "结束记录行程和充电"
    static let supportedModes: IntentModes = .foreground(.immediate)
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    @Parameter(title: "车辆") var vehicle: QuickVehicleEntity
    static var parameterSummary: some ParameterSummary { Summary("结束记录 \(\.$vehicle) 的行程和充电") }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let message = try await RecordingShortcutRequest.run(vehicle: vehicle, start: false)
        return .result(dialog: "\(message)")
    }
}

@available(iOS 26.0, *)
@MainActor
struct RecordingShortcutRequest {
    static private(set) var current: Self?
    static var notify: (() -> Void)?
    let id: String
    let target: String
    let start: Bool
    private let continuation: CheckedContinuation<String, Error>

    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    // The foreground app supplies its current data source, permissions and vehicle binding, including on cold launch.
    static func run(vehicle: QuickVehicleEntity, start: Bool) async throws -> String {
        guard current == nil else { throw Failure(message: "请等待上一个记录操作完成") }
        guard let target = vehicle.targetID else {
            throw Failure(message: "绑定的车辆已不可用，请重新选择车辆")
        }
        let id = UUID().uuidString
        let timeout = Task {
            try await Task.sleep(for: .seconds(25))
            current?.finish(id: id, error: "未能读取手机记录状态，请打开 LeapMore 检查记录数据源")
        }
        defer { timeout.cancel() }
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                current = Self(id: id, target: target, start: start, continuation: continuation)
                notify?()
            }
        } onCancel: {
            Task { @MainActor in current?.finish(id: id, error: "已取消记录操作") }
        }
    }

    func finish(id: String, error: String) {
        guard Self.current?.id == id else { return }
        Self.current = nil
        continuation.resume(throwing: Failure(message: error))
    }

    func apply(demo: Bool) throws {
        guard let record = QuickTargetRecord.catalog().first(where: { !$0.preset && $0.id == target }),
              let parts = try? JSONDecoder().decode([String].self, from: Data(target.utf8)), parts.count == 3 else {
            throw Failure(message: "绑定的车辆已不可用，请重新选择车辆")
        }
        let message: String
        if demo && parts[0] == "demo" {
            message = start ? "已开启演示记录" : "演示记录已停止"
        } else {
            guard !demo, parts[0].hasPrefix("cloud:") else { throw Failure(message: "记录账号已切换，请重新选择车辆") }
            let car = TripBinding(account: String(parts[0].dropFirst("cloud:".count)), id: parts[1], vin: parts[2], name: record.title)
            let recorder = TripRecorder.shared
            let state = try recorder.state(car)
            if state.active && state.vehicle.key != car.key {
                throw Failure(message: "正在记录另一辆车，请先结束该车的记录")
            }
            if start {
                if !state.active { try recorder.start(car) }
                message = state.active ? "该车已在记录中" : "已申请开始记录行程和充电"
            } else {
                try recorder.stop(scope: car.key)
                message = state.active ? "已结束记录行程和充电" : "该车当前没有正在运行的记录"
            }
        }
        Self.current = nil
        continuation.resume(returning: message)
    }
}
