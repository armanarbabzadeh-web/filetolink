#!/usr/bin/env bash
# Android TV emulator test + screenshots (run by .github/workflows/tv-apk.yml).
# Pairs for real: the app shows a known code, then this script sends "/start tv_<code>" to the
# bot as the demo user (exactly what scanning the QR does) and checks that the app moves on.
set -x
P=com.teletvshare.tv
APK=$(ls apk/*.apk | head -1)
mkdir -p shots
shot() { sleep "$2"; adb exec-out screencap -p > "shots/$1.png"; }
CODE=$(python3 -c "import random; print(''.join(random.choice('ABCDEFGHJKLMNPQRSTUVWXYZ23456789') for _ in range(8)))")

adb install -r "$APK"
adb logcat -c
adb shell settings put system screen_off_timeout 1800000

# 1. pairing screen with a known code
adb shell am start -W -n $P/.PairActivity --es code "$CODE"
shot 1-pairing 10

# 2. the demo user confirms the code in Telegram -> the TV should open its files by itself
curl -s -A ttvs-ci -X POST "$WORKER_URL/tg/$WEBHOOK_SECRET" \
  -H "content-type: application/json" -H "x-telegram-bot-api-secret-token: $WEBHOOK_SECRET" \
  -d "{\"update_id\": $(date +%s%N | cut -c1-15), \"message\": {\"message_id\": 1, \"date\": $(date +%s), \"from\": {\"id\": 1000000099, \"is_bot\": false, \"first_name\": \"Ali\"}, \"chat\": {\"id\": 1000000099, \"type\": \"private\"}, \"text\": \"/start tv_$CODE\"}}"
shot 2-home 25
adb shell dumpsys activity activities | grep -E "mResumedActivity|topResumedActivity" | head -2

# 3. focus moves across the cards
adb shell input keyevent KEYCODE_DPAD_LEFT
adb shell input keyevent KEYCODE_DPAD_LEFT
shot 3-focus 2

# 4. videos tab (fresh start keeps the saved connection)
adb shell am start -S -W -n $P/.MainActivity --es filter video
shot 4-videos 15

# 5. video player
adb shell input keyevent KEYCODE_DPAD_CENTER
shot 5-player 12
adb shell input keyevent KEYCODE_DPAD_CENTER
shot 5b-player-controls 2

# 6. photo viewer
adb shell am start -S -W -n $P/.MainActivity --es filter image
sleep 15
adb shell input keyevent KEYCODE_DPAD_CENTER
shot 6-photo 10

# 7. log-out dialog
adb shell am start -S -W -n $P/.MainActivity
sleep 15
for k in UP UP UP; do adb shell input keyevent KEYCODE_DPAD_$k; done
adb shell input keyevent KEYCODE_DPAD_LEFT
adb shell input keyevent KEYCODE_DPAD_LEFT
adb shell input keyevent KEYCODE_DPAD_LEFT
shot 7-header 2
adb shell input keyevent KEYCODE_DPAD_CENTER
shot 8-logout 3

echo "=== APP LOG ==="
adb logcat -d ActivityTaskManager:I TeleTVShare:V AndroidRuntime:E *:S | grep -iE "teletvshare|FATAL|Exception|at com" | head -60
exit 0
