// DF_MOCKUPS=1: the app's real screens built for a browser, so scripts/mockups can draw them as layers.
// Only what has no browser version is replaced. Android builds never come through here.
const path = require('node:path');

module.exports = function useMockupShims(config) {
  const shims = { 'expo-secure-store': 'secure-store.js', 'expo-sqlite': 'sqlite.js' };
  const resolve = config.resolver.resolveRequest;
  config.watchFolders.push(__dirname);
  config.resolver.resolveRequest = (context, moduleName, platform) => shims[moduleName]
    ? { type: 'sourceFile', filePath: path.join(__dirname, 'shims', shims[moduleName]) }
    : resolve(context, moduleName, platform);
};
