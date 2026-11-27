import AppIntents
import CryptoKit
import Foundation
import WidgetKit

struct QuickTargetRecord: Codable {
    let id: String
    let title: String
    let preset: Bool

    // Shortcuts can be shared. Keep account identifiers and VINs out of saved action parameters.
    var shortcutID: String { SHA256.hash(data: Data(id.utf8)).map { String(format: "%02x", $0) }.joined() }

    static func resolve(_ identifier: String, preset: Bool) -> Self? {
        catalog().first { $0.preset == preset && ($0.shortcutID == identifier || $0.id == identifier) }
    }

    static func catalog() -> [Self] {
        guard let data = LeapWidgetStorage.defaults?.data(forKey: "quick-targets") else { return [] }
        return (try? JSONDecoder().decode([Self].self, from: data)) ?? []
    }
}

@available(iOS 16.0, *)
struct QuickVehicleEntity: AppEntity {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "车辆")
    static let defaultQuery = VehicleQuery()
    let id: String
    let name: String
    var targetID: String? { QuickTargetRecord.resolve(id, preset: false)?.id }
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }

    struct VehicleQuery: EntityQuery {
        func suggestedEntities() async throws -> [QuickVehicleEntity] {
            QuickTargetRecord.catalog().filter { !$0.preset }.map { QuickVehicleEntity(id: $0.shortcutID, name: $0.title) }
        }
        func entities(for identifiers: [String]) async throws -> [QuickVehicleEntity] {
            identifiers.compactMap { id in
                QuickTargetRecord.resolve(id, preset: false).map { QuickVehicleEntity(id: id, name: $0.title) }
            }
        }
    }
}

@available(iOS 16.0, *)
struct QuickPresetEntity: AppEntity {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "车辆与备车预设")
    static let defaultQuery = PresetQuery()
    let id: String
    let name: String
    var targetID: String? { QuickTargetRecord.resolve(id, preset: true)?.id }
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }

    struct PresetQuery: EntityQuery {
        func suggestedEntities() async throws -> [QuickPresetEntity] {
            QuickTargetRecord.catalog().filter(\.preset).map { QuickPresetEntity(id: $0.shortcutID, name: $0.title) }
        }
        func entities(for identifiers: [String]) async throws -> [QuickPresetEntity] {
            identifiers.compactMap { id in
                QuickTargetRecord.resolve(id, preset: true).map { QuickPresetEntity(id: id, name: $0.title) }
            }
        }
    }
}

@available(iOS 18.0, *)
struct QuickVehicleConfiguration: ControlConfigurationIntent {
    static let title: LocalizedStringResource = "绑定车辆"
    @Parameter(title: "车辆") var vehicle: QuickVehicleEntity?
}

@available(iOS 18.0, *)
struct QuickPresetConfiguration: ControlConfigurationIntent {
    static let title: LocalizedStringResource = "绑定备车预设"
    @Parameter(title: "车辆与预设") var preset: QuickPresetEntity?
}

@available(iOS 16.0, *)
enum QuickVehicleAction: String, AppEnum {
    case prepare, climateOn = "climate-on", climateOff = "climate-off", lock = "lock-only", find
    case cool = "climate-cool", heat = "climate-heat", vent = "climate-vent", defrost = "climate-def", windowClose = "window-close", windowVent = "window-vent"
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "快捷控制")
    static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .prepare: "一键备车", .climateOn: "开启空调", .climateOff: "关闭空调", .lock: "锁车", .find: "鸣笛寻车",
        .cool: "极速降温", .heat: "极速升温", .vent: "快速除味", .defrost: "风挡除霜", .windowClose: "关闭车窗", .windowVent: "车窗通风"
    ]
}

@available(iOS 16.0, *)
enum QuickControlFeedback {
    static func key(_ action: QuickVehicleAction) -> String { "quick-result-" + action.rawValue }
    static func label(_ action: QuickVehicleAction, _ target: String?) -> String? {
        guard let target, let result = LeapWidgetStorage.defaults?.dictionary(forKey: key(action)),
              result["target"] as? String == target, let date = result["at"] as? Date,
              let message = result["message"] as? String else { return nil }
        return date.formatted(date: .omitted, time: .shortened) + " · " + message
    }
}
@available(iOS 18.0, *)
struct DirectVehicleIntent: AppIntent {
    static let title: LocalizedStringResource = "执行车辆快捷控制"
    static let openAppWhenRun = false
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    static let isDiscoverable = false
    @Parameter(title: "操作") var action: QuickVehicleAction
    @Parameter(title: "绑定目标") var targetID: String

    init() {}
    init(_ action: QuickVehicleAction, _ targetID: String?) {
        self.action = action
        self.targetID = targetID ?? ""
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        try await runVehicleControl(action, targetID: targetID)
    }
}

@available(iOS 16.0, *)
extension AppIntent {
    private func actionTitle(_ action: QuickVehicleAction) -> String {
        guard let title = QuickVehicleAction.caseDisplayRepresentations[action]?.title else { return "车辆控制" }
        return String(localized: title)
    }

    func runVehicleControl(_ action: QuickVehicleAction, targetID: String) async throws -> some IntentResult & ProvidesDialog {
        var message = await DirectQuickRuntime.run(action: action.rawValue, target: targetID)
        if message.hasPrefix("confirm:"), let target = QuickTargetRecord.catalog().first(where: { $0.id == targetID }) {
            let title = actionTitle(action)
            let dialog: IntentDialog = "向「\(target.title)」发送「\(title)」？"
            if #available(iOS 18.0, *) {
                try await requestConfirmation(dialog: dialog)
            } else {
                try await requestConfirmation(result: .result(dialog: dialog))
            }
            message = await DirectQuickRuntime.run(action: action.rawValue, target: targetID, approval: message)
        }
        if message.hasPrefix("confirm:") { message = "绑定目标已变更，请重试" }
        if message.hasPrefix("pin:") {
            if #available(iOS 18.2, *) {
                return .result(opensIntent: ReviewQuickVehicleIntent(action: action.rawValue, target: targetID), dialog: "请验证车辆操作密码")
            }
            message = "请在 App 内验证操作密码，或为此车保存操作密码后重试"
        }
        LeapWidgetStorage.defaults?.set(["target": targetID, "message": message, "at": Date.now], forKey: QuickControlFeedback.key(action))
        if #available(iOS 18.0, *) { ControlCenter.shared.reloadControls(ofKind: "com.leapmore." + action.rawValue) }
        return .result(dialog: "\(message)")
    }
}

@available(iOS 18.0, *)
struct ReviewQuickVehicleIntent: AppIntent {
    static let title: LocalizedStringResource = "验证车辆操作密码"
    static let openAppWhenRun = true
    static let isDiscoverable = false
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    @Parameter(title: "操作") var action: String
    @Parameter(title: "绑定目标") var target: String

    init() {}
    init(action: String, target: String) { self.action = action; self.target = target }
    func perform() async throws -> some IntentResult {
        if QuickVehicleAction(rawValue: action) != nil && QuickTargetRecord.catalog().contains(where: { $0.id == target }) {
            LeapWidgetStorage.defaults?.set(["action": action, "target": target, "at": Date.now], forKey: "quick-review")
        }
        return .result()
    }
}
