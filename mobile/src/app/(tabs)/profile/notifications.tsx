import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AppNotification, NotificationPrefs } from '@df/types';
import { useUnread } from '@/features/notifications';
import { useSession } from '@/lib/session';
import { cardShadow, makeStyles, radius, space } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Body, Button, Chip, Heading, Loading, Notice, Screen } from '@/ui';
import { FlowHeader } from '@/ui/brand';
import { Icon } from '@/ui/icons';
import { Text, TextInput } from '@/ui/text';
import { Toggle } from '@/ui/toggle';

// Stored as SQLite UTC time without a zone.
const parseTime = (value: string) => new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
const clock = (date: Date) => date.toLocaleTimeString('ru-RU', { hour: 'numeric', minute: '2-digit' });
/** «сегодня, 8:00», «вчера, 18:00», older ones by date. */
function when(value: string) {
  const date = parseTime(value);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(date); day.setHours(0, 0, 0, 0);
  const ago = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (ago === 0) return `сегодня, ${clock(date)}`;
  if (ago === 1) return `вчера, ${clock(date)}`;
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}
const PREFS = [
  ['reminders', 'Напоминания о записях', 'Перед записью и план дня — как настроил центр'],
  ['news', 'Новости и опросы DetailFlow', 'Обновления сервиса и короткие вопросы о работе'],
  ['viaMessenger', 'Дублировать в Telegram или MAX', 'Если вход привязан к мессенджеру']
] as const;

/** The member's feed: reminders, the plan of the day, messages from DetailFlow; and what they want to get. */
export default function NotificationsScreen() {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const { api } = useSession();
  const { markedRead } = useUnread();
  const feed = useResource(useCallback((signal: AbortSignal) => api.notifications(signal), [api]));
  const prefs = useResource(useCallback((signal: AbortSignal) => api.notificationPrefs(signal), [api]));
  const [edited, setEdited] = useState<NotificationPrefs | null>(null);
  const [error, setError] = useState('');
  const [answered, setAnswered] = useState<string[]>([]);

  // Opening the feed is reading it: the badge goes away, the new ones stay marked here until next time.
  useEffect(() => {
    if (feed.data?.unread) api.markNotificationsRead().then(markedRead, () => {});
  }, [api, feed.data, markedRead]);

  if (!feed.data && !feed.error) return <Loading label="Загружаем уведомления…"/>;
  const current = edited ?? prefs.data;
  const unread = feed.data?.items.filter((item) => !item.read).length ?? 0;
  const toggle = async (key: keyof NotificationPrefs, value: boolean) => {
    if (!current) return;
    setEdited({ ...current, [key]: value });
    try { setEdited(await api.updateNotificationPrefs({ [key]: value })); }
    catch (failure) { setEdited(current); setError((failure as Error).message); }
  };

  return (
    <Screen contentStyle={{ paddingTop: insets.top + 18, gap: 14 }}>
      <FlowHeader title="Уведомления" note={unread ? `Новых: ${unread}` : undefined}/>
      {feed.error ? <Notice>{feed.error}</Notice> : null}
      {feed.data && !feed.data.items.length ? (
        <View style={styles.empty}>
          <Icon name="bell" size={28}/>
          <Body muted style={{ textAlign: 'center' }}>Уведомлений пока нет. Здесь появятся напоминания о записях, план дня и новости DetailFlow.</Body>
        </View>
      ) : null}
      {feed.data?.items.map((item) => {
        // The feed loaded before it was marked read, so the new ones keep their dot while the screen is open.
        const isNew = !item.read;
        const opensBookings = Boolean(item.link?.startsWith('/bookings'));
        return (
          <Pressable key={item.id} accessibilityRole={opensBookings ? 'button' : undefined} disabled={!opensBookings} onPress={() => router.navigate('/bookings')} style={styles.item} testID="notification">
            <View style={styles.timeRow}>
              {isNew ? <View style={styles.dot} accessibilityLabel="новое"/> : null}
              <Text style={styles.meta}>{when(item.createdAt)}{item.kind === 'broadcast' ? ' · DetailFlow' : ''}</Text>
            </View>
            <Text style={styles.title}>{item.title}</Text>
            {item.body ? <Text style={styles.body}>{item.body}</Text> : null}
            {item.survey ? (item.answered || answered.includes(item.id)
              ? <View style={styles.doneRow}><Icon name="check" size={16} strokeWidth={2.4}/><Text style={styles.done}>Спасибо, ответ отправлен</Text></View>
              : <SurveyAnswer item={item} onAnswered={() => setAnswered((list) => [...list, item.id])}/>) : null}
          </Pressable>
        );
      })}

      {current ? <>
        <Heading style={{ marginTop: 4 }}>Что присылать мне</Heading>
        <View style={styles.list}>
          {PREFS.map(([key, title, note], index) => (
            <View key={key} style={[styles.pref, index > 0 && styles.prefLine]}>
              <View style={{ flex: 1, gap: 2 }}><Text style={styles.prefTitle}>{title}</Text><Text style={styles.prefNote}>{note}</Text></View>
              <Toggle value={current[key]} onValueChange={(value) => void toggle(key, value)} label={title} testID={`pref-${key}`}/>
            </View>
          ))}
        </View>
        {error ? <Notice>{error}</Notice> : null}
      </> : null}
    </Screen>
  );
}

/** A survey from DetailFlow answered right in the feed: one choice, a rating, a comment — once. */
function SurveyAnswer({ item, onAnswered }: { item: AppNotification; onAnswered: () => void }) {
  const styles = useStyles();
  const { api } = useSession();
  const [option, setOption] = useState<number | null>(null);
  const [rating, setRating] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const survey = item.survey!;
  const send = async () => {
    setBusy(true); setError('');
    try { await api.answerSurvey(item.broadcastId!, { option, rating, comment: comment.trim() }); onAnswered(); }
    catch (failure) { setError((failure as Error).message); setBusy(false); }
  };
  return (
    <View style={styles.survey}>
      {survey.options.length ? <View style={styles.chips}>{survey.options.map((label, index) => (
        <Chip key={index} label={label} selected={option === index} onPress={() => setOption(index)}/>
      ))}</View> : null}
      {survey.rating ? <View style={{ gap: 6 }}>
        <View style={styles.scale}>{[1, 2, 3, 4, 5].map((value) => (
          <Pressable key={value} accessibilityRole="button" accessibilityState={{ selected: rating === value }} onPress={() => setRating(value)} style={[styles.grade, rating === value && styles.gradeOn]}>
            <Text style={[styles.gradeText, rating === value && styles.gradeTextOn]}>{value}</Text>
          </Pressable>
        ))}</View>
        <View style={styles.scaleNotes}><Text style={styles.scaleNote}>неудобно</Text><Text style={styles.scaleNote}>очень удобно</Text></View>
      </View> : null}
      {survey.comment ? <TextInput value={comment} onChangeText={setComment} multiline maxLength={1000} placeholder="Комментарий" accessibilityLabel="Комментарий — по желанию" style={styles.comment}/> : null}
      {error ? <Notice>{error}</Notice> : null}
      <Button title="Ответить" busy={busy} disabled={option === null && rating === null && !comment.trim()} onPress={() => void send()} testID="send-survey"/>
    </View>
  );
}

const useStyles = makeStyles((colors, scheme) => StyleSheet.create({
  empty: { alignItems: 'center', gap: space.m, paddingVertical: space.xl, paddingHorizontal: space.l },
  item: { borderRadius: 24, backgroundColor: colors.surface, padding: space.l, gap: 6, ...cardShadow(scheme) },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent },
  meta: { color: colors.muted, fontSize: 12 },
  title: { fontSize: 16, fontWeight: '600' },
  body: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  doneRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  done: { fontSize: 14, fontWeight: '600' },
  survey: { gap: 10, marginTop: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  scale: { flexDirection: 'row', gap: 6 },
  grade: { flex: 1, height: 44, borderRadius: 15, backgroundColor: colors.soft, alignItems: 'center', justifyContent: 'center' },
  gradeOn: { backgroundColor: colors.pill },
  gradeText: { fontSize: 16, fontWeight: '600' },
  gradeTextOn: { color: colors.pillInk },
  scaleNotes: { flexDirection: 'row', justifyContent: 'space-between' },
  scaleNote: { color: colors.muted, fontSize: 11 },
  comment: { minHeight: 48, borderRadius: 16, backgroundColor: colors.soft, paddingHorizontal: space.l, paddingVertical: 13, fontSize: 14 },
  list: { borderRadius: radius.l, backgroundColor: colors.surface, paddingHorizontal: space.l, paddingVertical: 4, ...cardShadow(scheme) },
  pref: { flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: 60, paddingVertical: 8 },
  prefLine: { borderTopWidth: 1, borderTopColor: colors.line },
  prefTitle: { fontSize: 15, fontWeight: '600' },
  prefNote: { color: colors.muted, fontSize: 12 }
}));
