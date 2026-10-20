// Drives the native app on an Android emulator or phone through adb: finds elements by visible text or
// accessibility label (uiautomator), taps, types, waits and takes screenshots. Used by the native smoke run.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const ADB = process.env.ADB ?? `${process.env.LOCALAPPDATA}\\Android\\Sdk\\platform-tools\\adb.exe`;
export const adb = (...args) => execFileSync(ADB, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** The screen's hierarchy; empty while uiautomator cannot read it (start-up, an animation in progress). */
export function dump() {
  try {
    adb('shell', 'rm', '-f', '/sdcard/df-ui.xml');
    adb('shell', 'uiautomator', 'dump', '/sdcard/df-ui.xml');
    return adb('shell', 'cat', '/sdcard/df-ui.xml').toString('utf8');
  } catch {
    return '';
  }
}

const decode = (value) => value.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#10;/g, '\n');

/** Nodes whose text, content-desc or resource-id matches. */
export function find(matcher, xml = dump()) {
  const nodes = [...xml.matchAll(/<node [^>]*>/g)].map(([tag]) => {
    const attr = (name) => decode(tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? '');
    const [x1, y1, x2, y2] = attr('bounds').match(/\d+/g)?.map(Number) ?? [0, 0, 0, 0];
    return { text: attr('text'), desc: attr('content-desc'), id: attr('resource-id'), x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2), enabled: attr('enabled') === 'true' };
  });
  const test = (value) => typeof matcher === 'string' ? value === matcher : matcher.test(value);
  return nodes.filter((node) => test(node.text) || test(node.desc) || test(node.id));
}

export async function waitFor(matcher, { timeout = 15_000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const [node] = find(matcher);
    if (node) return node;
    await sleep(500);
  }
  throw new Error(`Not on screen: ${matcher}`);
}

export async function tap(matcher, options) {
  const node = await waitFor(matcher, options);
  adb('shell', 'input', 'tap', String(node.x), String(node.y));
  await sleep(400);
  return node;
}

/** Scrolls the screen up until the element shows (uiautomator only sees what is on screen). */
export async function scrollTo(matcher, { swipes = 8 } = {}) {
  for (let attempt = 0; attempt <= swipes; attempt += 1) {
    const [node] = find(matcher);
    if (node) return node;
    adb('shell', 'input', 'swipe', '540', '1800', '540', '900', '350');
    await sleep(600);
  }
  throw new Error(`Not found after scrolling: ${matcher}`);
}

/** Taps an element already found (e.g. the last of several with the same text: a dialog's button). */
export async function tapNode(node) {
  adb('shell', 'input', 'tap', String(node.x), String(node.y));
  await sleep(400);
}

/** Types into the focused field; adb input needs spaces escaped and works for ASCII. */
export async function type(text) {
  adb('shell', 'input', 'text', text.replace(/ /g, '%s'));
  await sleep(300);
}

export const back = () => adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');

export function screenshot(path) {
  writeFileSync(path, adb('exec-out', 'screencap', '-p'));
}

export async function launch(pkg = 'ru.detailflow.app', { clear = false } = {}) {
  if (clear) adb('shell', 'pm', 'clear', pkg);
  adb('shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1');
  await sleep(1500);
}

export { sleep };
