#!/bin/sh
# Build and install onto Justin's iPhone over Wi-Fi (no cable). Phone must be on the
# same network as the Mac, unlocked, and Xcode-paired.
set -e
cd "$(dirname "$0")"
UDID=37DC3DBB-5BB7-5BA7-B2CA-704EDF2D09CF

xcodebuild -project Co.xcodeproj -scheme Co \
  -destination "platform=iOS,id=$UDID" -allowProvisioningUpdates -quiet build
APP=$(xcodebuild -project Co.xcodeproj -scheme Co \
  -destination "platform=iOS,id=$UDID" -showBuildSettings 2>/dev/null |
  awk -F' = ' '/TARGET_BUILD_DIR/{d=$2} /WRAPPER_NAME/{w=$2} END{print d "/" w}')

xcrun devicectl device install app --device "$UDID" "$APP"
xcrun devicectl device process launch --device "$UDID" --terminate-existing app.kyo.app
