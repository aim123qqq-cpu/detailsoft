// Metro sees the web app's code shared with the phone: car diagrams, booking rules, act content,
// phone and plate normalization (../src/shared), and the offline queue and local rules
// (../src/offline), so the native app runs exactly the code the server and web run.
// A package imported from those shared files resolves as if the app imported it: they must never
// pick up the web's own copy of React from the repository's node_modules.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, '../src')];

const appRoot = __dirname + path.sep;
const bare = (name) => !name.startsWith('.') && !path.isAbsolute(name);
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const fromShared = !context.originModulePath.startsWith(appRoot);
  const next = fromShared && bare(moduleName) ? { ...context, originModulePath: path.join(__dirname, 'package.json') } : context;
  return next.resolveRequest(next, moduleName, platform);
};

module.exports = config;
