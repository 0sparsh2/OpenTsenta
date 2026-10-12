# Ferry mobile (iOS + Android)

Native shells around the Ferry dashboard, built with Capacitor. The web app is already an installable
PWA (Add to Home Screen, push notifications, offline shell); these wrappers are for App Store / Play Store builds.

Requirements: Xcode 16+ (iOS) or Android Studio (Android), and a Ferry API reachable over HTTPS.

```bash
npm install
export FERRY_API_URL=https://your-ferry.example.com   # the deployed API
npm run ios --workspace apps/mobile                     # or: npm run android --workspace apps/mobile
```

On the server, allow the app's origins: `CORS_ORIGINS=capacitor://localhost,https://localhost,https://your-ferry.example.com`.
