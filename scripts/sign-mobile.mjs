// Signs the native app built in GitHub Actions (the "mobile-ci" pre-release) with the Google Play upload key
// on this machine; the key never leaves it. Output: artifacts/DetailFlow-<version>.apk and .aab.
//   node scripts/sign-mobile.mjs [--from <folder with DetailFlow-unsigned.apk/.aab>]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO = 'aim123qqq-cpu/detailsoft';
const root = resolve('.');
const out = resolve(root, 'artifacts');
mkdirSync(out, { recursive: true });

const props = Object.fromEntries(readFileSync(resolve(root, 'android', 'keystore.properties'), 'utf8').split(/\r?\n/)
  .filter((line) => line && !line.startsWith('#') && line.includes('=')).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const sdk = process.env.ANDROID_HOME || `${process.env.LOCALAPPDATA}\\Android\\Sdk`;
const buildTools = join(sdk, 'build-tools', readdirSync(join(sdk, 'build-tools')).sort().at(-1));
const jdk = process.env.JAVA_HOME || 'C:\\Program Files\\Android\\Android Studio\\jbr';
// Passwords go through the environment, never the command line.
const env = { ...process.env, JAVA_HOME: jdk, PATH: `${join(jdk, 'bin')};${process.env.PATH}`, DF_KS_PASS: props.storePassword, DF_KEY_PASS: props.keyPassword };
const version = JSON.parse(readFileSync(resolve(root, 'mobile', 'app.json'), 'utf8')).expo.version;

async function unsigned(kind) {
  const fromFlag = process.argv.indexOf('--from');
  if (fromFlag > 0) return resolve(process.argv[fromFlag + 1], `DetailFlow-unsigned.${kind}`);
  const target = resolve(out, `DetailFlow-unsigned.${kind}`);
  const response = await fetch(`https://github.com/${REPO}/releases/download/mobile-ci/DetailFlow-unsigned.${kind}`);
  if (!response.ok) throw new Error(`No ${kind} in the mobile-ci pre-release yet (${response.status})`);
  writeFileSync(target, Buffer.from(await response.arrayBuffer()));
  return target;
}

const apkIn = await unsigned('apk');
const aligned = resolve(out, 'DetailFlow-aligned.apk');
const apk = resolve(out, `DetailFlow-${version}.apk`);
execFileSync(join(buildTools, 'zipalign.exe'), ['-p', '-f', '4', apkIn, aligned], { env, stdio: 'inherit' });
execFileSync(join(buildTools, 'apksigner.bat'), ['sign', '--ks', props.storeFile, '--ks-key-alias', props.keyAlias, '--ks-pass', 'env:DF_KS_PASS', '--key-pass', 'env:DF_KEY_PASS', '--out', apk, aligned], { env, stdio: 'inherit', shell: true });
execFileSync(join(buildTools, 'apksigner.bat'), ['verify', apk], { env, stdio: 'inherit', shell: true });
console.log(`✓ ${apk}`);

const aabIn = await unsigned('aab');
const aab = resolve(out, `DetailFlow-${version}.aab`);
copyFileSync(aabIn, aab);
execFileSync(join(jdk, 'bin', 'jarsigner.exe'), ['-keystore', props.storeFile, '-storepass:env', 'DF_KS_PASS', '-keypass:env', 'DF_KEY_PASS', '-sigalg', 'SHA256withRSA', '-digestalg', 'SHA-256', aab, props.keyAlias], { env, stdio: 'inherit' });
execFileSync(join(jdk, 'bin', 'jarsigner.exe'), ['-verify', aab], { env, stdio: 'inherit' });
console.log(`✓ ${aab}`);
if (existsSync(aligned)) execFileSync('cmd', ['/c', 'del', aligned]);
