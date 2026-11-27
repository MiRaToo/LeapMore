import AppIntents

@available(iOS 16.0, *)
protocol VehicleControlShortcut: AppIntent {
    static var action: QuickVehicleAction { get }
    var vehicle: QuickVehicleEntity { get }
}

@available(iOS 16.0, *)
extension VehicleControlShortcut {
    func perform() async throws -> some IntentResult & ProvidesDialog {
        try await runVehicleControl(Self.action, targetID: vehicle.targetID ?? "")
    }
}

@available(iOS 16.0, *)
struct PrepareVehicleShortcut: AppIntent {
    static let title: LocalizedStringResource = "一键备车"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    @Parameter(title: "车辆与备车预设") var preset: QuickPresetEntity
    static var parameterSummary: some ParameterSummary { Summary("使用 \(\.$preset) 备车") }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        try await runVehicleControl(.prepare, targetID: preset.targetID ?? "")
    }
}

@available(iOS 16.0, *)
struct StartClimateShortcut: VehicleControlShortcut {
    static let title: LocalizedStringResource = "开启空调"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    static let action = QuickVehicleAction.climateOn
    @Parameter(title: "车辆") var vehicle: QuickVehicleEntity
    static var parameterSummary: some ParameterSummary { Summary("为 \(\.$vehicle) 开启空调") }
}

@available(iOS 16.0, *)
struct StopClimateShortcut: VehicleControlShortcut {
    static let title: LocalizedStringResource = "关闭空调"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    static let action = QuickVehicleAction.climateOff
    @Parameter(title: "车辆") var vehicle: QuickVehicleEntity
    static var parameterSummary: some ParameterSummary { Summary("为 \(\.$vehicle) 关闭空调") }
}

@available(iOS 16.0, *)
struct LockVehicleShortcut: VehicleControlShortcut {
    static let title: LocalizedStringResource = "锁车"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    static let action = QuickVehicleAction.lock
    @Parameter(title: "车辆") var vehicle: QuickVehicleEntity
    static var parameterSummary: some ParameterSummary { Summary("为 \(\.$vehicle) 锁车") }
}

@available(iOS 16.0, *)
struct FindVehicleShortcut: VehicleControlShortcut {
    static let title: LocalizedStringResource = "鸣笛寻车"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    static let action = QuickVehicleAction.find
    @Parameter(title: "车辆") var vehicle: QuickVehicleEntity
    static var parameterSummary: some ParameterSummary { Summary("让 \(\.$vehicle) 鸣笛寻车") }
}

@available(iOS 16.0, *)
struct CoolVehicleShortcut: VehicleControlShortcut {
    static let title: LocalizedStringResource = "极速降温"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    static let action = QuickVehicleAction.cool
    @Parameter(title: "车辆") var vehicle: QuickVehicleEntity
    static var parameterSummary: some ParameterSummary { Summary("为 \(\.$vehicle) 极速降温") }
}

@available(iOS 16.0, *)
struct HeatVehicleShortcut: VehicleControlShortcut {
    static let title: LocalizedStringResource = "极速升温"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    static let action = QuickVehicleAction.heat
    @Parameter(title: "车辆") var vehicle: QuickVehicleEntity
    static var parameterSummary: some ParameterSummary { Summary("为 \(\.$vehicle) 极速升温") }
}

@available(iOS 16.0, *)
struct VentVehicleShortcut: VehicleControlShortcut {
    static let title: LocalizedStringResource = "快速除味"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    static let action = QuickVehicleAction.vent
    @Parameter(title: "车辆") var vehicle: QuickVehicleEntity
    static var parameterSummary: some ParameterSummary { Summary("为 \(\.$vehicle) 快速除味") }
}

@available(iOS 16.0, *)
struct DefrostVehicleShortcut: VehicleControlShortcut {
    static let title: LocalizedStringResource = "风挡除霜"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    static let action = QuickVehicleAction.defrost
    @Parameter(title: "车辆") var vehicle: QuickVehicleEntity
    static var parameterSummary: some ParameterSummary { Summary("为 \(\.$vehicle) 开启风挡除霜") }
}

@available(iOS 16.0, *)
struct CloseWindowsShortcut: VehicleControlShortcut {
    static let title: LocalizedStringResource = "关闭车窗"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    static let action = QuickVehicleAction.windowClose
    @Parameter(title: "车辆") var vehicle: QuickVehicleEntity
    static var parameterSummary: some ParameterSummary { Summary("关闭 \(\.$vehicle) 的车窗") }
}

@available(iOS 16.0, *)
struct VentWindowsShortcut: VehicleControlShortcut {
    static let title: LocalizedStringResource = "车窗通风"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    static let action = QuickVehicleAction.windowVent
    @Parameter(title: "车辆") var vehicle: QuickVehicleEntity
    static var parameterSummary: some ParameterSummary { Summary("为 \(\.$vehicle) 开启车窗通风") }
}

@available(iOS 17.4, *)
struct LeapMoreShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: PrepareVehicleShortcut(), phrases: ["用\(.applicationName)一键备车"], shortTitle: "一键备车", systemImageName: "sparkles")
        AppShortcut(intent: StartClimateShortcut(), phrases: ["用\(.applicationName)开启空调"], shortTitle: "开启空调", systemImageName: "fan")
        AppShortcut(intent: StopClimateShortcut(), phrases: ["用\(.applicationName)关闭空调"], shortTitle: "关闭空调", systemImageName: "power")
        AppShortcut(intent: LockVehicleShortcut(), phrases: ["用\(.applicationName)锁车"], shortTitle: "锁车", systemImageName: "lock")
        AppShortcut(intent: FindVehicleShortcut(), phrases: ["用\(.applicationName)鸣笛寻车"], shortTitle: "鸣笛寻车", systemImageName: "speaker.wave.2")
        if #available(iOS 26.0, *) {
            AppShortcut(intent: StartRecordingShortcut(), phrases: ["用\(.applicationName)开始记录行程和充电"], shortTitle: "开始记录", systemImageName: "record.circle")
            AppShortcut(intent: StopRecordingShortcut(), phrases: ["用\(.applicationName)结束记录行程和充电"], shortTitle: "结束记录", systemImageName: "stop.circle")
        }
    }
}
