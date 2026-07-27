# HopChat — Native App (Bluetooth Mesh)

This is the **native** HopChat: real Bluetooth LE mesh messaging that works with no
internet, based on the **public-domain BitChat** codebase (Unlicense) and rebranded
+ extended for HopChat. This is the *only* way to get true Bluetooth/offline mesh —
a web browser cannot do it.

> The web app (`hopchat.in`) remains the internet-based companion; this native app is
> the offline/Bluetooth side.

## What was changed for HopChat

- **Distinct BLE mesh identity** — new service + characteristic UUIDs in
  `bitchat/Services/BLE/BLEService.swift`, so HopChat devices form **their own**
  mesh network (they don't join BitChat's).
- **App name** → "HopChat" (`Info.plist` `CFBundleDisplayName`).
- **URL scheme** → `hopchat://` (Info.plist + `ContentView.handleOpenURL`).
- Bluetooth/permission prompt strings → "HopChat …".

Everything else (Noise Protocol encryption, Curve25519/Ed25519 identities, mesh
routing, store-and-forward, Nostr internet fallback) is the proven implementation.

## Requirements (your Mac)

- macOS with **Xcode 16+** installed
- For on-device testing: **two iPhones** (the iOS Simulator has **no Bluetooth**, so
  the mesh can only be tested on real hardware)
- A free Apple ID works for personal device installs; an Apple Developer account
  ($99/yr) is only needed for TestFlight/App Store distribution

## Build & run

### Quick try on macOS (fastest)
```bash
cd hopchat-native
brew install just      # one-time, if you don't have `just`
just run               # builds and runs the macOS app from source
just clean             # restore project state afterwards
```

### On an iPhone (to actually test the Bluetooth mesh)
```bash
cd hopchat-native
open bitchat.xcodeproj
```
Then in Xcode:
1. Select the **bitchat** target → **Signing & Capabilities**.
2. Set **Team** to your Apple ID, and give **Bundle Identifier** a unique value,
   e.g. `in.hopchat.app`.
3. Plug in an iPhone, select it as the run destination, press **▶ Run**.
4. Repeat on a **second** iPhone. Put both in airplane mode (Bluetooth on) and send a
   message — it travels over BLE with no internet. Add a third phone in between to see
   multi-hop relay.

## Notes / honest status

- The rebrand touched only names, UUIDs, and strings — **no logic changed**, so the
  proven build is intact. It has **not** been compiled in this environment (no Xcode
  here); build it on your Mac and report any Xcode signing prompts.
- The internal Xcode **project/target** is still named `bitchat` (users only ever see
  "HopChat"). Renaming the project is optional and best done inside Xcode
  (Product Name / scheme) once it builds.
- Roadmap extensions over the BitChat base (your vision): additional transports
  (Wi-Fi Direct/Aware, UWB, LAN), AI-assisted routing, post-quantum key exchange
  (the web app already ships ML-KEM hybrid — portable here), and satellite fallback.

## Credit

Built on BitChat by the BitChat contributors, released into the public domain
(see `LICENSE`). HopChat modifications continue under the same terms.
