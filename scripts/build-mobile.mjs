// Builds the native Android app in a short folder (C:\dfb by default): the C++ parts of React Native
// do not build from a long Windows path. Sources stay in the repository; the folder is only where Gradle runs.
//   node scripts/build-mobile.mjs [apk|aab] [--abis arm64-v8a,x86_64]
// The result is copied to artifacts/: DetailFlow-<version>.apk or .aab.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const kind = process.argv[2] === 'aab' ? 'aab' : 'apk';
const abisFlag = process.argv.indexOf('--abis');
const abis = abisFlag > 0 ? process.argv[abisFlag + 1] : kind === 'apk' ? 'arm64-v8a,x86_64' : 'armeabi-v7a,arm64-v8a,x86_64';
const root = resolve('.');
const work = process.env.DF_BUILD_DIR ?? 'C:\\dfb';
const env = {
  ...process.env,
  JAVA_HOME: process.env.JAVA_HOME || 'C:\\Program Files\\Android\\Android Studio\\jbr',
  ANDROID_HOME: process.env.ANDROID_HOME || `${process.env.LOCALAPPDATA}\\Android\\Sdk`,
  DF_KEYSTORE_PROPERTIES: resolve(root, 'android', 'keystore.properties')
};

// robocopy exit codes below 8 mean success.
const mirror = (from, to, ...extra) => {
  const result = spawnSync('robocopy', [from, to, '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', ...extra], { stdio: 'inherit' });
  if (result.status >= 8) throw new Error(`robocopy ${from} failed (${result.status})`);
};
const run = (command, args, cwd) => execFileSync(command, args, { cwd, env, stdio: 'inherit', shell: true });

console.log(`→ sources to ${work}`);
mirror(resolve(root, 'mobile'), `${work}\\mobile`, '/XD', 'node_modules', 'android', 'ios', '.expo');
// The web code the phone shares: shared rules, the offline queue and local rules, and what they import.
mirror(resolve(root, 'src', 'shared'), `${work}\\src\\shared`);
mirror(resolve(root, 'src', 'offline'), `${work}\\src\\offline`);
mkdirSync(`${work}\\src`, { recursive: true });
for (const file of ['types.ts', 'apiError.ts', 'platform.ts']) copyFileSync(resolve(root, 'src', file), `${work}\\src\\${file}`);

// Dependencies are reinstalled whenever package-lock.json changes (a new Expo module, an update).
const lock = createHash('sha256').update(readFileSync(resolve(root, 'mobile', 'package-lock.json'))).digest('hex');
const lockMark = `${work}\\mobile\\node_modules\\.df-lock`;
if (!existsSync(lockMark) || readFileSync(lockMark, 'utf8') !== lock) {
  run('npm', ['ci', '--no-audit', '--no-fund'], `${work}\\mobile`);
  writeFileSync(lockMark, lock);
}
run('npx', ['expo', 'prebuild', '--platform', 'android', '--clean', '--no-install'], `${work}\\mobile`);
// The SDK's CMake 3.31.6 ships ninja 1.12, which handles long Windows paths (with LongPathsEnabled);
// the default 3.22 does not. Install it once: sdkmanager "cmake;3.31.6".
const cmake = resolve(env.ANDROID_HOME, 'cmake', '3.31.6');
const slash = (path) => path.replace(/\\/g, '/');
writeFileSync(`${work}\\mobile\\android\\local.properties`, `sdk.dir=${slash(env.ANDROID_HOME)}\n${existsSync(cmake) ? `cmake.dir=${slash(cmake)}\n` : ''}`);
run(`${work}\\mobile\\android\\gradlew.bat`, ['--console=plain', kind === 'aab' ? 'bundleRelease' : 'assembleRelease', `-PreactNativeArchitectures=${abis}`], `${work}\\mobile\\android`);

const version = JSON.parse(readFileSync(resolve(root, 'mobile', 'app.json'), 'utf8')).expo.version;
const built = kind === 'aab'
  ? `${work}\\mobile\\android\\app\\build\\outputs\\bundle\\release\\app-release.aab`
  : `${work}\\mobile\\android\\app\\build\\outputs\\apk\\release\\app-release.apk`;
mkdirSync(resolve(root, 'artifacts'), { recursive: true });
const target = resolve(root, 'artifacts', `DetailFlow-${version}.${kind}`);
copyFileSync(built, target);
console.log(`✓ ${target}`);
