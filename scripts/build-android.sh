#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [[ ! -f dist/index.html ]]; then
  echo 'First run npm run build to prepare the web application.' >&2
  exit 1
fi
mkdir -p android/app/src/main/assets/www artifacts
rm -rf android/app/src/main/assets/www/*
cp -R dist/. android/app/src/main/assets/www/
# The native package supplies its own offline assets. A service worker would
# preserve stale assets across APK updates and is disabled by the app in native mode.
rm -f android/app/src/main/assets/www/sw.js
GRADLE_TASK=assembleDebug
APK_SOURCE=android/app/build/outputs/apk/debug/app-debug.apk
APK_DEST=artifacts/MOB-1.0.0-debug.apk
if [[ "${1:-}" == '--release' ]]; then
  : "${MOB_ANDROID_KEYSTORE:?Set MOB_ANDROID_KEYSTORE for a signed release}"
  : "${MOB_ANDROID_STORE_PASSWORD:?Set MOB_ANDROID_STORE_PASSWORD}"
  : "${MOB_ANDROID_KEY_ALIAS:?Set MOB_ANDROID_KEY_ALIAS}"
  : "${MOB_ANDROID_KEY_PASSWORD:?Set MOB_ANDROID_KEY_PASSWORD}"
  GRADLE_TASK=assembleRelease
  APK_SOURCE=android/app/build/outputs/apk/release/app-release.apk
  APK_DEST=artifacts/MOB-1.0.0.apk
fi
./android/gradlew -p android --no-daemon "$GRADLE_TASK" lint
cp "$APK_SOURCE" "$APK_DEST"
echo "APK ready: $APK_DEST"
