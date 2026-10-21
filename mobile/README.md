# DetailFlow — нативное приложение

React Native (Expo SDK 58, TypeScript). План и решения — `docs/MOBILE.md` в корне репозитория.

- Экраны: `src/app/` (Expo Router), общий код веба и сервера — `../src/shared` (`@df/shared/*`), типы API — `../src/types.ts` (`@df/types`).
- Нативные каталоги `android/` и `ios/` генерирует `npx expo prebuild`; руками их не правят, настройки — в `app.json` и `plugins/`.

## Сборка релиза (Windows)

C++-часть React Native не собирается из длинного пути Windows, поэтому скрипт копирует исходники в короткую папку `C:\dfb` и собирает там. Результат — в `artifacts/` корня репозитория.

```powershell
node scripts/build-mobile.mjs apk   # artifacts\DetailFlow-<версия>.apk (arm64 + x86_64 для эмулятора)
node scripts/build-mobile.mjs aab   # artifacts\DetailFlow-<версия>.aab для магазинов (все ABI)
```

Нужны JDK из Android Studio и Android SDK (пути по умолчанию; можно задать `JAVA_HOME`, `ANDROID_HOME`, `DF_BUILD_DIR`).

Один раз на машине: включить длинные пути Windows (`LongPathsEnabled = 1`, от администратора, затем перезагрузка) и поставить CMake 3.31.6 из Android SDK (`sdkmanager "cmake;3.31.6"`): в нём ninja 1.12, который работает с длинными путями. Скрипт сам указывает Gradle этот CMake.

Без этого (или на другой машине) приложение собирает GitHub Actions — workflow «Mobile» выкладывает неподписанные APK и AAB в предварительный релиз `mobile-ci`, а `node scripts/sign-mobile.mjs` подписывает их ключом загрузки локально.

Подпись — ключ загрузки из `~/.detailflow/keystore.properties` (вне проекта; `plugins/with-release-signing.js`, путь меняется переменной `DF_KEYSTORE_PROPERTIES`). Это тот же ключ, что был у прежней WebView-оболочки: приложение ставится поверх неё как обновление. Без файла релиз подписывается отладочным ключом.

## Проверка

Установите APK на эмулятор или телефон (`adb install -r artifacts\DetailFlow-<версия>.apk`) и из корня репозитория запустите `node tests/android/native-smoke.mjs`. Сценарий поднимает отдельный сервер с демо-данными и проходит экраны, скриншоты — в `artifacts/native/`.
