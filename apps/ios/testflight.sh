#!/bin/bash
# TestFlight ship — archive + upload with an App Store Connect API key (no password ever).
#
# Needs, in apps/ios/.env (git-ignored) or the shell:
#   CO_TEAM_ID=XXXXXXXXXX          # membership page → Team ID
#   CO_ASC_KEY_ID=XXXXXXXXXX       # App Store Connect → Users and Access → Integrations
#   CO_ASC_ISSUER_ID=xxxx-xxxx     # same page, top
#   CO_ASC_KEY_P8=~/keys/AuthKey_XXXXXXXXXX.p8
#
# One-time human steps before the first run (cannot be done by CLI):
#   1. Paid Apple Developer membership active on the Apple ID.
#   2. App Store Connect → My Apps → "+" → New App: name "co", bundle id app.co.Co
#      (register the id at developer.apple.com/account/resources/identifiers if the
#      picker doesn't offer it), SKU "co-ios".
#   3. The API key above, role App Manager. Download the .p8 once, keep it.
#
# Every subsequent release is just: ./testflight.sh
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] && set -a && . ./.env && set +a

: "${CO_TEAM_ID:?set CO_TEAM_ID}"
: "${CO_ASC_KEY_ID:?set CO_ASC_KEY_ID}"
: "${CO_ASC_ISSUER_ID:?set CO_ASC_ISSUER_ID}"
KEY_P8=$(eval echo "${CO_ASC_KEY_P8:?set CO_ASC_KEY_P8}")
[ -f "$KEY_P8" ] || { echo "no key at $KEY_P8"; exit 1; }

# bump the build number monotonically (TestFlight rejects reused build numbers)
BUILD=$(( $(date +%s) / 60 ))
ARCHIVE=/tmp/co_$BUILD.xcarchive
EXPORT=/tmp/co_export_$BUILD

xcodegen generate
xcodebuild -project Co.xcodeproj -scheme Co -configuration Release \
  -destination 'generic/platform=iOS' \
  CURRENT_PROJECT_VERSION=$BUILD \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$KEY_P8" \
  -authenticationKeyID "$CO_ASC_KEY_ID" \
  -authenticationKeyIssuerID "$CO_ASC_ISSUER_ID" \
  archive -archivePath "$ARCHIVE"

cat > /tmp/co_export_options.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>$CO_TEAM_ID</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict></plist>
PLIST

xcodebuild -exportArchive -archivePath "$ARCHIVE" \
  -exportOptionsPlist /tmp/co_export_options.plist \
  -exportPath "$EXPORT" \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$KEY_P8" \
  -authenticationKeyID "$CO_ASC_KEY_ID" \
  -authenticationKeyIssuerID "$CO_ASC_ISSUER_ID"

echo "uploaded build $BUILD — processing takes ~5-15 min, then it appears in TestFlight"
