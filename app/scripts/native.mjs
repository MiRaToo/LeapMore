import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isIP } from 'node:net';

process.chdir(resolve(import.meta.dirname, '..'));
const platform = process.argv[2];
const { version, buildNumber } = JSON.parse(readFileSync('package.json', 'utf8'));
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('命令失败：' + command + ' ' + args[0]);
}
const js = (file, ...args) => run(process.execPath, [file, ...args]);
function edit(path, change) {
  const before = readFileSync(path, 'utf8'), after = change(before);
  if (after !== before) writeFileSync(path, after);
}

if (!['android', 'ios', 'harmony'].includes(platform)) throw new Error('指定 android、ios 或 harmony');
js('scripts/assets.mjs', ...((process.env.LEAPMORE_LOCAL_CAR_ASSETS === '1' || process.env.LEAPMORE_LOCAL_3D_DEMO === '1') ? ['--demo'] : []));
js('node_modules/typescript/bin/tsc', '--noEmit');
js('node_modules/vite/bin/vite.js', 'build');
if (platform !== 'harmony') js('scripts/quick-worker.mjs', platform);
const cap = 'node_modules/@capacitor/cli/bin/capacitor';
if (platform === 'android') {
  if (!existsSync('android/app')) js(cap, 'add', 'android');
  js(cap, 'sync', 'android');
  const main = 'android/app/src/main';
  cpSync('native/android', main + '/java/com/leapmore/app', {
    recursive: true, filter: source => !source.includes('/res') && !source.endsWith('.xml'),
  });
  cpSync('native/android/res', main + '/res', { recursive: true });
  js('scripts/widget-assets.mjs', 'android');
  if (existsSync('../icons/android')) cpSync('../icons/android', main + '/res', { recursive: true });
  const host = process.env.LEAPMORE_ANDROID_HA_HTTP_HOST;
  if (host && !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.local$/i.test(host) &&
      !(isIP(host) === 4 && /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(host))) {
    throw new Error('明文 HA 主机须为单个局域网 IPv4 或 .local 主机名。');
  }
  const domains = ['127.0.0.1', 'localhost', ...(host ? [host] : [])];
  writeFileSync(main + '/res/xml/leap_network.xml', `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="${host ? 'false' : 'true'}" />
    <domain-config cleartextTrafficPermitted="true">
        ${domains.map(domain => '<domain includeSubdomains="false">' + domain + '</domain>').join('\n        ')}
    </domain-config>
</network-security-config>
`);
  edit(main + '/AndroidManifest.xml', xml => {
    if (!xml.includes('android.permission.USE_BIOMETRIC')) {
      xml = xml.replace('</manifest>', '    <uses-permission android:name="android.permission.USE_BIOMETRIC" />\n    <uses-permission android:name="android.permission.USE_FINGERPRINT" android:maxSdkVersion="29" />\n</manifest>');
    }
    xml = xml.replace(/^[ \t]*<uses-permission android:name="android\.permission\.(ACCESS_COARSE_LOCATION|ACCESS_FINE_LOCATION|FOREGROUND_SERVICE_LOCATION)"\s*\/>\s*?\n/gm, '');
    for (const permission of ['ACCESS_NETWORK_STATE', 'FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_DATA_SYNC', 'POST_NOTIFICATIONS', 'WAKE_LOCK']) {
      if (!xml.includes('android.permission.' + permission + '"')) {
        xml = xml.replace('</manifest>', '    <uses-permission android:name="android.permission.' + permission + '" />\n</manifest>');
      }
    }
    const service = '<service android:name=".LeapRecordingService" android:exported="false" android:foregroundServiceType="dataSync" android:stopWithTask="true" />';
    if (xml.includes('LeapRecordingService')) xml = xml.replace(/<service android:name="\.LeapRecordingService"[^>]*\/>/, service);
    else xml = xml.replace('</application>', '    ' + service + '\n    </application>');
    if (!xml.includes('android:networkSecurityConfig')) xml = xml.replace('<application', '<application android:networkSecurityConfig="@xml/leap_network" android:allowBackup="false"')
      .replace(/\s+android:allowBackup="true"/, '');
    xml = xml.replace(/(<application\b[^>]*>)/, tag => tag
      .replace('android:icon="@mipmap/ic_launcher"', 'android:icon="@mipmap/ic_launcher_simple"')
      .replace('android:roundIcon="@mipmap/ic_launcher_round"', 'android:roundIcon="@mipmap/ic_launcher_simple"'));
    xml = xml.replace(/\s*<intent-filter>\s*<action android:name="android.intent.action.MAIN"\s*\/>\s*<category android:name="android.intent.category.LAUNCHER"\s*\/>\s*<\/intent-filter>/, match =>
      xml.includes('android:name=".LauncherSimple"') ? match : '');
    if (!xml.includes('android:scheme="com.leapmore.app"')) xml = xml.replace('</activity>', `
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="com.leapmore.app" android:host="ha-auth" />
                <data android:scheme="com.leapmore.app" android:host="widget" />
            </intent-filter>
        </activity>`);
    if (!xml.includes('android:name=".LauncherSimple"')) {
      const aliases = [['Simple', true, 'ic_launcher_simple', 'ic_launcher_simple'], ['Original', false, 'ic_launcher', 'ic_launcher_round']];
      xml = xml.replace('</activity>', '</activity>\n\n' + aliases.map(([name, enabled, icon, round]) =>
        `        <activity-alias android:name=".Launcher${name}" android:targetActivity=".MainActivity" android:exported="true"
            android:enabled="${enabled}" android:label="@string/title_activity_main" android:icon="@mipmap/${icon}" android:roundIcon="@mipmap/${round}">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity-alias>`).join('\n'));
    }
    if (!xml.includes('android.service.quicksettings.action.QS_TILE_PREFERENCES')) {
      xml = xml.replace('</activity>', '<intent-filter><action android:name="android.service.quicksettings.action.QS_TILE_PREFERENCES" /><category android:name="android.intent.category.DEFAULT" /></intent-filter>\n        </activity>');
    }
    for (const [service, title, icon] of [
      ['Prepare', '一键备车', 'leap_tile_prepare'], ['PrepareSecond', '一键备车 2', 'leap_tile_prepare'],
      ['ClimateOn', '开启空调', 'leap_widget_icon_fan'], ['ClimateOff', '关闭空调', 'leap_widget_icon_fan'],
      ['Cool', '极速降温', 'leap_widget_icon_fan'],
      ['Heat', '极速升温', 'leap_widget_icon_fan'],
      ['Vent', '快速除味', 'leap_widget_icon_fan'],
      ['Defrost', '风挡除霜', 'leap_widget_icon_fan'],
      ['WindowClose', '关闭车窗', 'leap_tile_window'],
      ['WindowVent', '车窗通风', 'leap_tile_window'],
      ['Lock', '锁车', 'leap_widget_icon_lock'], ['Find', '鸣笛寻车', 'leap_widget_icon_find'],
    ]) {
      const name = '.VehicleTile$' + service;
      if (xml.includes('android:name="' + name + '"')) {
        xml = xml.replace(/<service\b[^>]*>/g, tag => tag.includes('android:name="' + name + '"')
          ? tag.replace(/android:label="[^"]*"/, 'android:label="' + title + '"').replace(/android:icon="[^"]*"/, 'android:icon="@drawable/' + icon + '"') : tag);
        continue;
      }
      xml = xml.replace('</application>', `    <service android:name="${name}" android:label="${title}" android:icon="@drawable/${icon}"
            android:permission="android.permission.BIND_QUICK_SETTINGS_TILE" android:exported="true">
            <intent-filter><action android:name="android.service.quicksettings.action.QS_TILE" /></intent-filter>
        </service>\n    </application>`);
    }
    if (!xml.includes('WidgetControlActivity')) xml = xml.replace('</application>', `        <activity android:name=".WidgetControlActivity" android:exported="false" android:excludeFromRecents="true"
            android:taskAffinity="\${applicationId}.widget" android:theme="@style/Leap.WidgetControl" android:windowSoftInputMode="adjustResize" />\n    </application>`);
    if (!xml.includes('LeapWidget$Small')) xml = xml.replace('</application>', ['Small', 'Medium', 'Large'].map((size, i) =>
      `        <receiver android:name=".LeapWidget$${size}" android:label="LeapMore ${['2×2','4×2','4×4'][i]}" android:exported="false">
            <intent-filter><action android:name="android.appwidget.action.APPWIDGET_UPDATE" /></intent-filter>
            <meta-data android:name="android.appwidget.provider" android:resource="@xml/leap_widget_${size.toLowerCase()}" />
        </receiver>`).join('\n') + '\n    </application>');
    xml = xml.replace(/<activity\b[^>]*>/g, tag => /android:name="\.(?:MainActivity|WidgetControlActivity)"/.test(tag)
      ? tag.replace(/\s+android:screenOrientation="[^"]*"/g, '').replace('<activity', '<activity android:screenOrientation="portrait"') : tag);
    const orientationProperty = 'android.window.PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY';
    if (!xml.includes(orientationProperty)) xml = xml.replace('</application>', '    <property android:name="' + orientationProperty + '" android:value="true" />\n    </application>');
    return xml;
  });
  edit('android/app/build.gradle', source => source.replace(/versionName\s+"[^"]+"/, `versionName "${version}"`)
    .replace(/versionCode\s+\d+/, `versionCode ${buildNumber}`));
} else if (platform === 'ios') {
  if (!existsSync('ios/App')) js(cap, 'add', 'ios', '--packagemanager', 'SPM');
  js(cap, 'sync', 'ios');
  js('scripts/widget-assets.mjs', 'ios');
  run('ruby', ['scripts/ios-project.rb']);
} else {
  const hionic = 'node_modules/hionic/bin/hcap';
  if (!existsSync('openharmony/entry')) js(hionic, 'platform', 'add', 'openharmony');
  // hcap overlays dist on its native bridge. Replace the Vite asset directories to drop stale bundles and demo models.
  for (const folder of ['assets', 'viewer', 'car3d-demo']) {
    rmSync('openharmony/entry/src/main/resources/rawfile/www/' + folder, { recursive: true, force: true });
  }
  js(hionic, 'copy', 'openharmony');
  js('scripts/widget-assets.mjs', 'harmony');
  js('scripts/harmony-project.mjs');
}
