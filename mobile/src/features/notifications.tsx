import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { useSession, useSignedIn } from '@/lib/session';

type UnreadValue = { unread: number; refresh: () => void; markedRead: () => void };
const Unread = createContext<UnreadValue>({ unread: 0, refresh: () => {}, markedRead: () => {} });

/** Unread notifications of the signed-in member: checked every minute and when the app comes back. */
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { api } = useSession();
  const memberId = useSignedIn().actor.memberId;
  const [unread, setUnread] = useState(0);
  const refresh = useCallback(() => {
    if (!memberId) return;
    api.notifications().then((feed) => setUnread(feed.unread), () => {});
  }, [api, memberId]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 60_000);
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') refresh(); });
    return () => { clearInterval(timer); subscription.remove(); };
  }, [refresh]);

  const value = useMemo(() => ({ unread, refresh, markedRead: () => setUnread(0) }), [unread, refresh]);
  return <Unread.Provider value={value}>{children}</Unread.Provider>;
}

export const useUnread = () => useContext(Unread);
