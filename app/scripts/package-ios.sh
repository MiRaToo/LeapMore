#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."
project="$PWD/ios/App"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
xcodebuild -project "$project/App.xcodeproj" -scheme App -configuration Release \
  -sdk iphoneos -destination 'generic/platform=iOS' -derivedDataPath "$work/build" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build

app="$work/Payload/App.app"
widget="$app/PlugIns/LeapWidget.appex"
mkdir -p "$work/Payload"
ditto "$work/build/Build/Products/Release-iphoneos/App.app" "$app"
plist=/usr/libexec/PlistBuddy
version=$(node -p "require('./package.json').version")
for bundle in "$app" "$widget"; do
  test "$("$plist" -c 'Print CFBundleShortVersionString' "$bundle/Info.plist")" = "$version"
  test -n "$("$plist" -c 'Print CFBundleName' "$bundle/Info.plist")"
  test ! -e "$bundle/embedded.mobileprovision"
  binary="$bundle/$("$plist" -c 'Print CFBundleExecutable' "$bundle/Info.plist")"
  lipo "$binary" -verify_arch arm64
  xcrun vtool -arch arm64 -show-build "$binary" | grep -Eq 'platform[[:space:]]+IOS$'
  # xcodebuild build leaves object-file paths in the linker debug map.
  xcrun strip -S "$binary"
  if LC_ALL=C grep -aEq '/Users/|/var/folders/' "$binary"; then
    echo 'iOS release executable contains a build-machine path' >&2
    exit 1
  fi
done

# Carry the requested App Group through to the user's installation-time signature.
shopt -s nullglob
for framework in "$widget"/Frameworks/*.{framework,dylib} "$app"/Frameworks/*.{framework,dylib}; do
  codesign --force --sign - "$framework"
done
codesign --force --sign - --entitlements "$project/LeapWidget/LeapWidget.entitlements" "$widget"
codesign --force --sign - --entitlements "$project/App/LeapMore.entitlements" "$app"
codesign --verify --deep --strict "$app"
for bundle in "$app" "$widget"; do
  codesign --display --xml --entitlements - "$bundle" > "$work/entitlements.plist"
  test "$("$plist" -c 'Print :com.apple.security.application-groups:0' "$work/entitlements.plist")" = group.com.leapmore.app
done
name="LeapMore-v$version-ios.ipa"
ditto -c -k --keepParent "$work/Payload" "$work/$name"
unzip -tq "$work/$name"
mkdir -p ios/build
mv "$work/$name" "ios/build/$name"
echo "ios/build/$name"
