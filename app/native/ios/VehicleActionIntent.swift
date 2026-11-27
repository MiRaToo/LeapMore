import AppIntents
import Foundation

@available(iOS 17.0, *)
struct VehicleActionIntent: AppIntent {
    static var title: LocalizedStringResource = "打开 LeapMore 控车确认"
    static let isDiscoverable = false
    static var openAppWhenRun = true
    @Parameter(title: "操作") var action: String

    init() {}
    init(_ action: String) { self.action = action }

    func perform() async throws -> some IntentResult {
        if ["lock", "climate"].contains(action), let prefs = LeapWidgetStorage.defaults {
            prefs.set(action, forKey: "widget-action")
            prefs.set(Date.now, forKey: "widget-action-at")
        }
        return .result()
    }
}
