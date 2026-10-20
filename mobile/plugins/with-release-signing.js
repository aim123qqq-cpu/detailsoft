// Release builds sign with the same Google Play upload key as the WebView shell (android/keystore.properties
// at the repository root, not in git), so the native app installs over it as an update. Without that file
// the release falls back to the debug key, as the Expo template does.
const { withAppBuildGradle } = require('expo/config-plugins');

// DF_KEYSTORE_PROPERTIES points at the file when the app is built outside the repository (scripts/build-mobile.mjs).
const HEADER = `// DetailFlow upload key (see plugins/with-release-signing.js)
def dfKeystoreFile = System.getenv('DF_KEYSTORE_PROPERTIES') ? new File(System.getenv('DF_KEYSTORE_PROPERTIES')) : rootProject.file('../../android/keystore.properties')
def dfKeystore = new Properties()
if (dfKeystoreFile.exists()) dfKeystoreFile.withInputStream { dfKeystore.load(it) }
`;

const UPLOAD = `
        if (dfKeystoreFile.exists()) {
            upload {
                storeFile file(dfKeystore['storeFile'])
                storePassword dfKeystore['storePassword']
                keyAlias dfKeystore['keyAlias']
                keyPassword dfKeystore['keyPassword']
            }
        }`;

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (mod) => {
    let gradle = mod.modResults.contents;
    if (gradle.includes('dfKeystoreFile')) return mod;
    gradle = gradle.replace(/^android\s*\{/m, (match) => `${HEADER}\n${match}`);
    gradle = gradle.replace(/signingConfigs\s*\{/, (match) => `${match}${UPLOAD}`);
    // DF_UNSIGNED=1 (the cloud build): no signature at all, so the owner signs the result locally with the upload key.
    gradle = gradle.replace(/(release\s*\{[\s\S]*?)signingConfig signingConfigs\.debug/, "$1signingConfig dfKeystoreFile.exists() ? signingConfigs.upload : (System.getenv('DF_UNSIGNED') ? null : signingConfigs.debug)");
    if (!gradle.includes('signingConfigs.upload : (System.getenv')) throw new Error('with-release-signing: the release signing line was not found in app/build.gradle');
    mod.modResults.contents = gradle;
    return mod;
  });
};
