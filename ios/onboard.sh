#!/bin/sh
# Rebuild, reinstall, and restart the onboarding-only simulator (iPhone 17, iOS 27).
# Usage: ./onboard.sh [step]   e.g. ./onboard.sh 5, ./onboard.sh 8
set -e
cd "$(dirname "$0")"
UDID=75625395-A2D6-40C6-AE8D-470A1224B13C

xcodebuild -project Co.xcodeproj -scheme Co \
  -destination "platform=iOS Simulator,id=$UDID" -quiet build
APP=$(xcodebuild -project Co.xcodeproj -scheme Co \
  -destination "platform=iOS Simulator,id=$UDID" -showBuildSettings 2>/dev/null |
  awk -F' = ' '/TARGET_BUILD_DIR/{d=$2} /WRAPPER_NAME/{w=$2} END{print d "/" w}')

xcrun simctl bootstatus "$UDID" -b >/dev/null
xcrun simctl install "$UDID" "$APP"
xcrun simctl terminate "$UDID" app.kyo.app 2>/dev/null || true
xcrun simctl launch "$UDID" app.kyo.app -coOnboarding ${1:+"$1"}
