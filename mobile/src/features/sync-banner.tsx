import { useEffect, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { confirmFailedDuplicate, discardFailed, flush, linkFailedToExisting, retryFailed, syncState, useSyncState } from '@df/offline/sync';
import { colors, radius, space } from '@/lib/theme';

const plural = (count: number, one: string, few: string, many: string) => {
  const last = count % 10; const lastTwo = count % 100;
  return last === 1 && lastTwo !== 11 ? one : last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? few : many;
};
const changes = (count: number) => `${count} ${plural(count, 'изменение', 'изменения', 'изменений')}`;

/** Sends the queue when the app comes back to the screen and, while something waits, every 15 seconds. */
export function useSyncLoop() {
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') void flush(); });
    const timer = setInterval(() => { const state = syncState(); if (state.pending > 0 && !state.failed) void flush(); }, 15_000);
    return () => { subscription.remove(); clearInterval(timer); };
  }, []);
}

/** Connection and offline-queue status at the top of a screen, as in the web app. */
export function SyncBanner() {
  const { reachable, syncing, pending, failed } = useSyncState();
  const [busy, setBusy] = useState(false);
  const act = async (action: () => Promise<unknown>) => { setBusy(true); try { await action(); } finally { setBusy(false); } };

  if (!reachable) return (
    <View style={[styles.banner, styles.offline]} accessibilityRole="alert" testID="offline-banner">
      <Text style={styles.title}>Нет связи с сервером</Text>
      <Text style={styles.text}>{pending
        ? `${changes(pending)} ${plural(pending, 'сохранено', 'сохранены', 'сохранены')} на телефоне и ${plural(pending, 'отправится само', 'отправятся сами', 'отправятся сами')}`
        : 'Показаны сохранённые данные. Работа по заказам и записи сохранятся на телефоне.'}</Text>
    </View>
  );
  // A customer made offline whose phone is already on file: the same person, or someone else?
  const existing = failed?.errorCode === 'customer_phone_exists'
    ? (failed.errorDetails?.customers as { id: string; name: string; phoneDisplay: string }[] | undefined)?.[0] : undefined;
  if (failed && existing) return (
    <View style={[styles.banner, styles.failed]} accessibilityRole="alert">
      <Text style={styles.title}>Такой телефон уже есть</Text>
      <Text style={styles.text}>Клиента «{failed.label.replace(/^Новый клиент · /, '')}» завели без сети, а на сервере с этим номером уже есть {existing.name} ({existing.phoneDisplay}).</Text>
      <View style={styles.actions}>
        <Action label={`Это ${existing.name}`} disabled={busy} onPress={() => act(() => linkFailedToExisting(existing.id))}/>
        <Action label="Это другой человек" disabled={busy} onPress={() => act(confirmFailedDuplicate)}/>
      </View>
    </View>
  );
  if (failed) return (
    <View style={[styles.banner, styles.failed]} accessibilityRole="alert" testID="sync-failed">
      <Text style={styles.title}>Не отправлено</Text>
      <Text style={styles.text}>{failed.label}: {failed.error}</Text>
      <View style={styles.actions}>
        <Action label="Повторить" disabled={busy} onPress={() => act(retryFailed)}/>
        <Action label="Отменить изменение" disabled={busy} onPress={() => act(discardFailed)}/>
      </View>
    </View>
  );
  if (pending) return (
    <View style={[styles.banner, styles.pending]} accessibilityLiveRegion="polite" testID="sync-pending">
      <Text style={styles.title}>{syncing ? 'Отправляем' : 'Ждёт отправки'}</Text>
      <Text style={styles.text}>{changes(pending)}</Text>
    </View>
  );
  return null;
}

function Action({ label, disabled, onPress }: { label: string; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={[styles.action, disabled && { opacity: 0.5 }]}>
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: { borderRadius: radius.m, padding: space.m, gap: 4 },
  offline: { backgroundColor: 'rgba(242,193,78,.14)' },
  failed: { backgroundColor: 'rgba(217,71,64,.16)' },
  pending: { backgroundColor: 'rgba(255,121,57,.12)', flexDirection: 'row', gap: space.s, alignItems: 'center' },
  title: { color: colors.text, fontSize: 15, fontWeight: '800' },
  text: { color: colors.muted, fontSize: 14, lineHeight: 20, flexShrink: 1 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s, marginTop: 4 },
  action: { minHeight: 40, paddingHorizontal: space.m, borderRadius: radius.s, backgroundColor: colors.surfaceRaised, justifyContent: 'center' },
  actionText: { color: colors.text, fontSize: 14, fontWeight: '700' }
});
