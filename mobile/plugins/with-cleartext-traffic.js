// A center's server on the local network is reached over plain http (http://192.168.…:4173), so the app
// allows cleartext traffic, as the WebView shell did. A cloud server over HTTPS works either way.
const { withAndroidManifest } = require('expo/config-plugins');

module.exports = function withCleartextTraffic(config) {
  return withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application?.[0];
    if (application) application.$['android:usesCleartextTraffic'] = 'true';
    return mod;
  });
};
