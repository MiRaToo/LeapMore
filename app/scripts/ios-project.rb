require 'fileutils'
require 'json'
require 'xcodeproj'

root = File.expand_path('..', __dir__)
version = JSON.parse(File.read(File.join(root, 'package.json'))).fetch('version')
project_root = File.join(root, 'ios', 'App')
project = Xcodeproj::Project.open(File.join(project_root, 'App.xcodeproj'))
native = File.join(root, 'native', 'ios')
main = project.targets.find { |target| target.name == 'App' }
app_group = project.main_group['App']
raise '找不到 Capacitor App target' unless main && app_group

def add_source(group, target, path)
  file = group.files.find { |entry| entry.path == path } || group.new_file(path)
  target.source_build_phase.add_file_reference(file, true)
end

%w[LeapPlugins.swift VehicleActionIntent.swift].each do |name|
  FileUtils.cp(File.join(native, name), File.join(project_root, 'App'))
  add_source(app_group, main, name)
end
delegate = File.join(project_root, 'App', 'SceneDelegate.swift')
source = File.read(delegate)
File.write(delegate, source.gsub('= CAPBridgeViewController()', '= LeapBridgeViewController()'))

info_path = File.join(project_root, 'App', 'Info.plist')
info = Xcodeproj::Plist.read_from_path(info_path)
info['CFBundleURLTypes'] = [{ 'CFBundleURLName' => 'com.leapmore.app', 'CFBundleURLSchemes' => ['com.leapmore.app'] }]
info['NSLocalNetworkUsageDescription'] = '读取你在本地网络中配置的 Home Assistant 车况和记录。'
info['NSFaceIDUsageDescription'] = '验证身份以使用本机保存的车辆操作密码。'
info.delete('NSLocationWhenInUseUsageDescription')
info.delete('NSLocationAlwaysAndWhenInUseUsageDescription')
background_modes = (info['UIBackgroundModes'] || []) - ['location']
background_modes.empty? ? info.delete('UIBackgroundModes') : info['UIBackgroundModes'] = background_modes
ats = { 'NSAllowsLocalNetworking' => true }
host = ENV['LEAPMORE_IOS_HA_HTTP_HOST']
if host && !host.empty?
  raise '仅支持显式 .local HA 明文主机' unless host.match?(/\A[a-z0-9][a-z0-9.-]*\.local\z/i)
  ats['NSExceptionDomains'] = { host.downcase => { 'NSExceptionAllowsInsecureHTTPLoads' => true, 'NSIncludesSubdomains' => false } }
end
info['NSAppTransportSecurity'] = ats
Xcodeproj::Plist.write_to_path(info, info_path)
groups = { 'com.apple.security.application-groups' => ['group.com.leapmore.app'] }
Xcodeproj::Plist.write_to_path(groups, File.join(project_root, 'App', 'LeapMore.entitlements'))

widget_folder = File.join(project_root, 'LeapWidget')
FileUtils.mkdir_p(widget_folder)
%w[LeapWidget.swift VehicleActionIntent.swift].each { |name| FileUtils.cp(File.join(native, name), widget_folder) }
Xcodeproj::Plist.write_to_path(groups, File.join(widget_folder, 'LeapWidget.entitlements'))
Xcodeproj::Plist.write_to_path({
  'CFBundleDisplayName' => 'LeapMore 车辆',
  'CFBundleIdentifier' => '$(PRODUCT_BUNDLE_IDENTIFIER)',
  'CFBundleExecutable' => '$(EXECUTABLE_NAME)',
  'CFBundlePackageType' => 'XPC!',
  'CFBundleVersion' => '$(CURRENT_PROJECT_VERSION)',
  'CFBundleShortVersionString' => '$(MARKETING_VERSION)',
  'NSExtension' => { 'NSExtensionPointIdentifier' => 'com.apple.widgetkit-extension' }
}, File.join(widget_folder, 'Info.plist'))
widget_group = project.main_group['LeapWidget'] || project.main_group.new_group('LeapWidget', 'LeapWidget')
widget = project.targets.find { |target| target.name == 'LeapWidget' }
unless widget
  widget = project.new_target(:app_extension, 'LeapWidget', :ios, '15.0')
  main.add_dependency(widget)
  phase = main.new_copy_files_build_phase('Embed App Extensions')
  phase.symbol_dst_subfolder_spec = :plug_ins
  embedded = phase.add_file_reference(widget.product_reference)
  embedded.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy', 'CodeSignOnCopy'] }
end
%w[LeapWidget.swift VehicleActionIntent.swift].each { |name| add_source(widget_group, widget, name) }
[main, widget].each do |target|
  target.build_configurations.each do |config|
    settings = config.build_settings
    settings['DEVELOPMENT_TEAM'] = ENV['LEAPMORE_IOS_TEAM'] if ENV['LEAPMORE_IOS_TEAM']
    settings['CURRENT_PROJECT_VERSION'] = '1'
    settings['MARKETING_VERSION'] = version
    if target == main
      settings['CODE_SIGN_ENTITLEMENTS'] = 'App/LeapMore.entitlements'
      settings['ASSETCATALOG_COMPILER_APPICON_NAME'] = 'AppIcon'
      settings['ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES'] = 'AppIconOriginal'
    else
      settings['CODE_SIGN_ENTITLEMENTS'] = 'LeapWidget/LeapWidget.entitlements'
      settings['INFOPLIST_FILE'] = 'LeapWidget/Info.plist'
      settings['PRODUCT_BUNDLE_IDENTIFIER'] = 'com.leapmore.app.widget'
      settings['PRODUCT_NAME'] = '$(TARGET_NAME)'
      settings['APPLICATION_EXTENSION_API_ONLY'] = 'YES'
      settings['SKIP_INSTALL'] = 'YES'
      settings['SWIFT_VERSION'] = '5.0'
      settings['TARGETED_DEVICE_FAMILY'] = '1,2'
    end
  end
end

{ 'AppIcon' => 'leaplink-icon-simple.png', 'AppIconOriginal' => 'leaplink-icon.png' }.each do |name, filename|
  icon_source = File.join(root, 'public', 'assets', filename)
  icon_catalog = File.join(project_root, 'App', 'Assets.xcassets', name + '.appiconset')
  FileUtils.mkdir_p(icon_catalog)
  target_icon = File.join(icon_catalog, 'LeapMore.png')
  system('swift', File.join(__dir__, 'ios-icon.swift'), icon_source, target_icon) || raise("无法生成 #{name} 图标")
  File.write(File.join(icon_catalog, 'Contents.json'), JSON.pretty_generate({
    'images' => [{ 'filename' => 'LeapMore.png', 'idiom' => 'universal', 'platform' => 'ios', 'size' => '1024x1024' }],
    'info' => { 'author' => 'xcode', 'version' => 1 }
  }))
end
project.save
