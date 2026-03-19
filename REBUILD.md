# MusicsAura — APK Rebuild Guide

## Jab bhi koi change karo (HTML, CSS, JS, JSON) — ye ek command chalao:

```powershell
cd C:\Users\shakt\Downloads\musicsaura; Copy-Item index.html www\ -Force; Copy-Item auth.html www\ -Force; Copy-Item admin-dashboard.html www\ -Force; Copy-Item user-dashboard.html www\ -Force; Copy-Item 404.html www\ -Force; Copy-Item manifest.json www\ -Force; Copy-Item service-worker.js www\ -Force; npx cap sync android; cd android; .\gradlew.bat assembleDebug
```

## APK milega yahan:
```
C:\Users\shakt\Downloads\musicsaura\android\app\build\outputs\apk\debug\app-debug.apk
```

## APK folder directly kholne ke liye:
```powershell
explorer C:\Users\shakt\Downloads\musicsaura\android\app\build\outputs\apk\debug
```

---

## Agar scripts/styles/jsons bhi change kiye toh pehle ye chalao:
```powershell
xcopy /E /I /Y scripts www\scripts\ /exclude:www
xcopy /E /I /Y styles www\styles\
xcopy /E /I /Y jsons www\jsons\
xcopy /E /I /Y assets www\assets\
```
Phir upar wali main rebuild command chalao.

---

## Full rebuild (sab kuch fresh):
```powershell
cd C:\Users\shakt\Downloads\musicsaura; Copy-Item index.html www\ -Force; Copy-Item auth.html www\ -Force; Copy-Item admin-dashboard.html www\ -Force; Copy-Item user-dashboard.html www\ -Force; Copy-Item 404.html www\ -Force; Copy-Item manifest.json www\ -Force; Copy-Item service-worker.js www\ -Force; xcopy /E /I /Y scripts www\scripts\; xcopy /E /I /Y styles www\styles\; xcopy /E /I /Y jsons www\jsons\; xcopy /E /I /Y assets www\assets\; npx cap sync android; cd android; .\gradlew.bat assembleDebug
```

---

## Notes:
- Pehli baar build slow hoga (Gradle download) — baad mein fast
- `BUILD SUCCESSFUL` aaya matlab APK ready hai
- Phone mein install karne se pehle: Settings > Security > Unknown Sources ON karo
- google-services.json already add hai — Google login kaam karega
