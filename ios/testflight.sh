#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARCHIVE_PATH="${ARCHIVE_PATH:-${SCRIPT_DIR}/build/Co.xcarchive}"
EXPORT_PATH="${EXPORT_PATH:-${SCRIPT_DIR}/build/testflight}"
BUILD_NUMBER="${BUILD_NUMBER:-$(date -u +%Y%m%d%H%M)}"
UPLOAD="${UPLOAD:-0}"

cd "${SCRIPT_DIR}"

# Unset env ships a build where every member sees "not connected" — refuse loudly.
if [[ "${UPLOAD}" == "1" ]]; then
  for required in CO_API_BASE_URL CO_SUPABASE_URL CO_SUPABASE_PUBLISHABLE_KEY; do
    if [[ -z "${!required:-}" ]]; then
      echo "ERROR: ${required} is not set — refusing to upload a disconnected build." >&2
      exit 1
    fi
  done
fi

xcodegen generate

BUILD_SETTINGS=(CURRENT_PROJECT_VERSION="${BUILD_NUMBER}")
[[ -n "${CO_API_BASE_URL:-}" ]] && BUILD_SETTINGS+=(CO_API_BASE_URL="${CO_API_BASE_URL}")
[[ -n "${CO_SUPABASE_URL:-}" ]] && BUILD_SETTINGS+=(CO_SUPABASE_URL="${CO_SUPABASE_URL}")
[[ -n "${CO_SUPABASE_PUBLISHABLE_KEY:-}" ]] && BUILD_SETTINGS+=(CO_SUPABASE_PUBLISHABLE_KEY="${CO_SUPABASE_PUBLISHABLE_KEY}")

xcodebuild \
  -project Co.xcodeproj \
  -scheme Co \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "${ARCHIVE_PATH}" \
  "${BUILD_SETTINGS[@]}" \
  -allowProvisioningUpdates \
  archive

OPTIONS="${SCRIPT_DIR}/ExportOptions.plist"
TEMP_DIR=""
if [[ "${UPLOAD}" == "1" ]]; then
  TEMP_DIR="$(mktemp -d)"
  OPTIONS="${TEMP_DIR}/ExportOptions.plist"
  cp "${SCRIPT_DIR}/ExportOptions.plist" "${OPTIONS}"
  /usr/libexec/PlistBuddy -c 'Set :destination upload' "${OPTIONS}"
fi

cleanup() {
  if [[ -n "${TEMP_DIR}" ]]; then
    rm -rf "${TEMP_DIR}"
  fi
}
trap cleanup EXIT

xcodebuild \
  -exportArchive \
  -archivePath "${ARCHIVE_PATH}" \
  -exportPath "${EXPORT_PATH}" \
  -exportOptionsPlist "${OPTIONS}" \
  -allowProvisioningUpdates

if [[ "${UPLOAD}" == "1" ]]; then
  echo "Uploaded build ${BUILD_NUMBER} to App Store Connect."
else
  echo "Exported build ${BUILD_NUMBER} to ${EXPORT_PATH}. Set UPLOAD=1 to upload it."
fi
