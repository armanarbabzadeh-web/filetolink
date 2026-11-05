#!/usr/bin/env bash
# Takes screenshots of the TV app in an Android TV emulator (run by .github/workflows/tv-apk.yml).
set -x
P=com.teletvshare.tv
APK=$(ls apk/*.apk | head -1)
mkdir -p shots
shot() { sleep "$2"; adb exec-out screencap -p > "shots/$1.png"; }

curl -s -o /dev/null -w "runner manifest HTTP %{http_code}
" "$DEMO_MANIFEST"
adb shell date
adb install -r "$APK"
adb logcat -c
adb shell settings put system screen_off_timeout 1800000

# 1. pairing screen
adb shell am start -W -n $P/.PairActivity
shot 1-pairing 8

# 2. home with the demo account
adb shell am start -W -n $P/.PairActivity --es manifest "$DEMO_MANIFEST"
shot 2-home 20

# 3. focus moved to another card
adb shell input keyevent KEYCODE_DPAD_LEFT
adb shell input keyevent KEYCODE_DPAD_LEFT
shot 3-focus 2

# 4. videos tab
adb shell am start -W -n $P/.MainActivity --es filter video
shot 4-videos 12

# 5. video player
adb shell input keyevent KEYCODE_DPAD_CENTER
shot 5-player 12
adb shell input keyevent KEYCODE_DPAD_CENTER
shot 5b-player-controls 2
adb shell input keyevent KEYCODE_BACK
adb shell input keyevent KEYCODE_BACK
sleep 3

# 6. photo viewer
adb shell am start -W -n $P/.MainActivity --es filter image
sleep 10
adb shell input keyevent KEYCODE_DPAD_CENTER
shot 6-photo 10
adb shell input keyevent KEYCODE_BACK
sleep 2

# 7. log-out dialog (focus the header button and press it)
adb shell am start -W -n $P/.MainActivity
sleep 10
adb shell input keyevent KEYCODE_DPAD_UP
adb shell input keyevent KEYCODE_DPAD_UP
adb shell input keyevent KEYCODE_DPAD_UP
adb shell input keyevent KEYCODE_MOVE_END
shot 7-header-focus 2
adb logcat -d | grep -iE "TeleTVShare|AndroidRuntime|SSL|Cleartext" | tail -40
exit 0
