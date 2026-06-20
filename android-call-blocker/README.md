# Call Blocker (Android)

A small native Android app that **silently rejects incoming phone calls whose
number starts with a configurable prefix** — defaulting to **`140`**, the
number series reserved for telemarketing / promotional calls in India.

It uses Android's official [`CallScreeningService`](https://developer.android.com/reference/android/telecom/CallScreeningService)
API, so it can block calls **without** having to become your default phone
dialer. Matching calls are rejected before the phone rings and no missed-call
notification is shown.

## Features

- Blocks incoming calls starting with a prefix (`140` by default).
- Prefix is configurable in-app (e.g. set it to `1909` or any other series).
- Toggle blocking on/off.
- Normalizes numbers so `+91 140…`, `0140…`, and `140…` all match.
- Keeps a running count and a list of recently blocked calls.
- No internet permission — everything stays on-device.

## How it works

`CallBlockerService` extends `CallScreeningService`. For every **incoming**
call the system hands the number to `onScreenCall()`; if blocking is enabled and
the (normalized) number starts with the configured prefix, the service responds
with `setDisallowCall(true) + setRejectCall(true)` and the call is dropped.

On Android 10 (API 29) and above the app must hold the
`ROLE_CALL_SCREENING` role — the app requests it from the home screen with
**"Set as call-screening app"**. On Android 9 and below the system binds the
service automatically.

## Project layout

```
android-call-blocker/
├── settings.gradle / build.gradle / gradle.properties
├── gradle/wrapper/gradle-wrapper.properties
└── app/
    ├── build.gradle
    ├── proguard-rules.pro
    └── src/main/
        ├── AndroidManifest.xml
        ├── java/com/autodialer/callblocker/
        │   ├── CallBlockerService.kt   # the screening logic
        │   ├── MainActivity.kt         # settings UI + role request
        │   └── Prefs.kt                # config + blocked-call log
        └── res/                        # layout, strings, theme, icon
```

## Building

**Easiest:** open the `android-call-blocker/` folder in
[Android Studio](https://developer.android.com/studio) and press **Run**.
Android Studio generates the Gradle wrapper automatically and installs the app.

**Command line:** generate the Gradle wrapper once, then assemble:

```bash
cd android-call-blocker
gradle wrapper --gradle-version 8.7   # creates ./gradlew + wrapper jar
./gradlew assembleDebug               # builds app/build/outputs/apk/debug/app-debug.apk
./gradlew installDebug                # installs onto a connected device/emulator
```

> The committed project includes everything except the binary
> `gradle/wrapper/gradle-wrapper.jar`. Running `gradle wrapper` (or opening the
> project in Android Studio) creates it.

## Using the app

1. Install and open **Call Blocker**.
2. Tap **"Set as call-screening app"** and allow the permission
   (Android 10+).
3. Make sure **"Block matching calls"** is on. Adjust the prefix if you want
   to block a different series.

That's it — any incoming call starting with `140` is now rejected automatically.

## Requirements

- Android 7.0 (API 24) or newer; full screening control on Android 10+ (API 29).
- Requires a real device or an emulator image that supports telephony to test
  live call rejection.
