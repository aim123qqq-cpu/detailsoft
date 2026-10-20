// Metro sees the web app's shared logic (car diagrams, booking rules, act content, phone and plate
// normalization) in ../src/shared, so the native app runs exactly the code the server and web run.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, '../src/shared')];

module.exports = config;
