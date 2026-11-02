// Notifications on this device (Web Push): the browser asks permission, subscribes with the server's
// public key and hands the subscription to the server. On an iPhone this works only for DetailFlow added
// to the home screen (iOS 16.4+), not in a Safari tab.
import { api } from './api';
import { iosBrowserTab } from './platform';

export type PushState = 'on' | 'off' | 'denied' | 'ios-tab' | 'unsupported';

const supported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;

async function registration() {
  return navigator.serviceWorker.ready;
}

/** Where this device stands: subscribed, can be, blocked by the person, or cannot at all. */
export async function pushState(): Promise<PushState> {
  if (iosBrowserTab()) return 'ios-tab';
  if (!supported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const subscription = await (await registration()).pushManager.getSubscription();
  return subscription && Notification.permission === 'granted' ? 'on' : 'off';
}

const keyBytes = (base64url: string) => Uint8Array.from(atob(base64url.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));

export async function enablePush(): Promise<PushState> {
  if (!supported()) return 'unsupported';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  const { publicKey } = await api.getPushKey();
  const manager = (await registration()).pushManager;
  const subscription = await manager.getSubscription() ?? await manager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await api.subscribePush(subscription.toJSON());
  return 'on';
}

export async function disablePush(): Promise<PushState> {
  if (!supported()) return 'unsupported';
  const subscription = await (await registration()).pushManager.getSubscription();
  if (subscription) {
    await api.unsubscribePush(subscription.endpoint).catch(() => {});
    await subscription.unsubscribe();
  }
  return 'off';
}
