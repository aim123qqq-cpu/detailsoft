import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { AppNotification, NotificationPrefs } from '@df/types';
import { useUnread } from '@/features/notifications';
import { useSession } from '@/lib/session';
import { colors, radius, space } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Body, Card, Label, Loading, Notice, Screen } from '@/ui';

// Stored as SQLite UTC time without a zone.
const parseTime = (value: string) => new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
const when = (value: string) => parseTime(value).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const dot: Record<AppNotification['kind'], string> = { booking_reminder: colors.primary, day_plan: colors.ok, broadcast: '#6aa8ff' };

/** The member's feed: reminders, the plan of the day, messages from DetailFlow; and what they want to get. */
export default function NotificationsScreen() {
  const { api } = useSession();
  const { markedRead } = useUnread();
  const feed = useResource(useCallback((signal: AbortSignal) => api.notifications(signal), [api]));
  const prefs = useResource(useCallback((signal: AbortSignal) => api.notificationPrefs(signal), [api]));
  const [edited, setEdited] = useState<NotificationPrefs | null>(null);
  const [error, setError] = useState('');

  // Opening the feed is reading it: the badge goes away, the new ones stay marked here until next time.
  useEffect(() => {
    if (feed.data?.unread) api.markNotificationsRead().then(markedRead, () => {});
  }, [api, feed.data, markedRead]);

  if (!feed.data && !feed.error) return <Loading label="Загружаем уведомления…"/>;
  const current = edited ?? prefs.data;
  const toggle = async (key: keyof NotificationPrefs, value: boolean) => {
    if (!current) return;
    setEdited({ ...current, [key]: value });
    try { setEdited(await api.updateNotificationPrefs({ [key]: value })); }
    catch (failure) { setEdited(current); setError((failure as Error).message); }
  };

  return (
    <Screen>
      {feed.error ? <Notice>{feed.error}</Notice> : null}
      {feed.data && !feed.data.items.length ? <Body muted>Уведомлений пока нет. Здесь появятся напоминания о записях, план дня и новости DetailFlow.</Body> : null}
      {feed.data?.items.map((item) => (
        <Pressable key={item.id} accessibilityRole="button" disabled={!item.link?.startsWith('/bookings')} onPress={() => router.navigate('/bookings')}
          android_ripple={{ color: 'rgba(255,255,255,.06)' }} style={[styles.item, !item.read && styles.unread]} testID="notification">
          <View style={[styles.dot, { backgroundColor: dot[item.kind] }]}/>
          <View style={styles.copy}>
            <Text style={styles.title}>{item.title}</Text>
            {item.body ? <Text style={styles.body}>{item.body}</Text> : null}
            <Text style={styles.time}>{when(item.createdAt)}{item.kind === 'broadcast' ? ' · DetailFlow' : ''}</Text>
          </View>
        </Pressable>
      ))}

      {current ? <Card style={{ gap: space.s }}>
        <Label>Что присылать мне</Label>
        {([
          ['reminders', 'Напоминания о записях', 'Перед записью и план дня — как настроил центр'],
          ['news', 'Новости и опросы DetailFlow', 'Обновления сервиса и короткие вопросы о работе'],
          ['viaMessenger', 'Дублировать в Telegram или MAX', 'Если вход привязан к мессенджеру']
        ] as const).map(([key, title, note]) => (
          <View key={key} style={styles.toggle}>
            <View style={styles.copy}><Text style={styles.title}>{title}</Text><Text style={styles.time}>{note}</Text></View>
            <Switch value={current[key]} onValueChange={(value) => void toggle(key, value)} trackColor={{ true: colors.primary, false: colors.line }} thumbColor="#fff" testID={`pref-${key}`}/>
          </View>
        ))}
        {error ? <Notice>{error}</Notice> : null}
      </Card> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  item: { flexDirection: 'row', gap: space.m, padding: space.m, borderRadius: radius.l, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  unread: { borderColor: 'rgba(255,121,57,.45)', backgroundColor: 'rgba(255,121,57,.06)' },
  dot: { width: 10, height: 10, borderRadius: 5, marginTop: 6 },
  copy: { flex: 1, gap: 2 },
  title: { color: colors.text, fontSize: 16, fontWeight: '700' },
  body: { color: colors.text, fontSize: 15, lineHeight: 21, opacity: 0.85 },
  time: { color: colors.muted, fontSize: 13 },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: space.m, paddingVertical: space.xs }
});
