import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSession, useSignedIn } from '@/lib/session';
import { cardShadow, makeStyles, radius, space, useTheme } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Button, Screen } from '@/ui';
import { RoundButton } from '@/ui/brand';
import { Icon } from '@/ui/icons';
import { Text } from '@/ui/text';

type Setup = { services: number; members: number; bookings: number };

/**
 * What a new center still has to do before the first customer: services, then a booking. Only for those who set
 * the center up; offline, or once both are done, nothing (null): the home screen shows the day instead.
 */
export function useFirstSteps() {
  const { api } = useSession();
  const session = useSignedIn();
  const allowed = session.capabilities.manageSettings;
  const setup = useResource(useCallback((signal: AbortSignal) => allowed ? api.centerSetup(signal) : Promise.resolve(null), [api, allowed]));
  const { refresh } = setup;
  // Back from the catalog, the team or a booking: the ticks follow.
  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));
  const data = setup.data;
  return { ready: !allowed || setup.data !== null || Boolean(setup.error), setup: data && (data.services === 0 || data.bookings === 0) ? data : null };
}

const SOLO = (tenantId: string) => `detailflow.solo.${tenantId.replace(/[^\w.-]/g, '_')}`;

/** The home screen of a new center: the steps left, and the team, which can wait. */
export function FirstStepsHome({ setup }: { setup: Setup }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const session = useSignedIn();
  const insets = useSafeAreaInsets();
  const [solo, setSolo] = useState(true);
  useEffect(() => { SecureStore.getItemAsync(SOLO(session.tenant.id)).then((value) => setSolo(value === '1')).catch(() => setSolo(false)); }, [session.tenant.id]);
  const workAlone = () => { setSolo(true); void SecureStore.setItemAsync(SOLO(session.tenant.id), '1').catch(() => {}); };

  const steps = [
    { title: 'Добавьте услуги', text: 'Название, время и цена — без них не записать клиента.', done: setup.services > 0, action: 'Добавить', go: () => router.push('/profile/catalog') },
    { title: 'Запишите первого клиента', text: 'Телефон, автомобиль, услуги и время.', done: setup.bookings > 0, action: 'Записать', go: () => router.navigate('/new') }
  ];
  const done = steps.filter((step) => step.done).length;
  const current = steps.findIndex((step) => !step.done);
  const left = steps.length - done;

  return (
    <Screen contentStyle={{ paddingTop: insets.top + space.l, gap: 18 }}>
      <View style={styles.top}>
        <Text style={styles.center} numberOfLines={1}>{session.tenant.name}</Text>
        <RoundButton icon="bell" label="Уведомления" onPress={() => router.navigate('/profile/notifications')}/>
      </View>
      <View style={{ gap: 6 }}>
        <Text style={styles.h1} accessibilityRole="header">Центр создан.{'\n'}{left === 1 ? 'Остался один шаг' : `Осталось ${left} шага`}</Text>
        <Text style={styles.meta}>{done} из {steps.length} готово</Text>
      </View>
      <View style={styles.progress} accessibilityLabel={`Готово ${done} из ${steps.length}`}>
        {steps.map((step) => <View key={step.title} style={[styles.bar, { backgroundColor: step.done ? colors.pill : colors.line }]}/>)}
      </View>

      <View style={styles.card} testID="first-steps">
        {steps.map((step, index) => (
          <Pressable key={step.title} accessibilityRole="button" accessibilityState={{ checked: step.done }} onPress={step.go}
            android_ripple={{ color: 'rgba(127,127,127,.12)' }} style={[styles.step, index > 0 && styles.stepLine]}>
            <View style={[styles.mark, step.done ? styles.markDone : index === current ? styles.markNow : null]}>
              {step.done ? <Icon name="check" size={16} color={colors.pillInk} strokeWidth={2.2}/> : <Text style={[styles.markText, index === current && { color: colors.accentInk }]}>{index + 1}</Text>}
            </View>
            <View style={styles.copy}>
              <Text style={[styles.stepTitle, step.done && styles.stepDone]}>{step.title}</Text>
              {step.done ? null : <Text style={styles.meta}>{step.text}</Text>}
              {index === current ? <Button title={step.action} style={styles.stepButton} onPress={step.go}/> : null}
            </View>
          </Pressable>
        ))}
      </View>

      {!solo && setup.members <= 1 ? (
        <View style={styles.team}>
          <Text style={styles.teamLabel}>Если работаете не один</Text>
          <Text style={styles.teamTitle}>Пригласите команду</Text>
          <Text style={styles.teamText}>Администраторы и мастера войдут по своему коду или через Telegram. Можно сделать позже в профиле.</Text>
          <View style={styles.teamButtons}>
            <Button title="Команда" style={{ flex: 1 }} onPress={() => router.push('/profile/team')}/>
            <Button title="Работаю один" tone="raised" style={{ flex: 1 }} onPress={workAlone}/>
          </View>
        </View>
      ) : null}

      <Text style={styles.hint}>Часы работы — в «Профиль → График центра».</Text>
    </Screen>
  );
}

const useStyles = makeStyles((colors, scheme) => StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.m },
  center: { flex: 1, fontSize: 16, fontWeight: '700' },
  h1: { fontSize: 30, lineHeight: 36, fontWeight: '500', letterSpacing: -0.9 },
  meta: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  progress: { flexDirection: 'row', gap: 4 },
  bar: { flex: 1, height: 6, borderRadius: 3 },
  card: { backgroundColor: colors.surface, borderRadius: radius.l, paddingHorizontal: space.l, ...cardShadow(scheme) },
  step: { flexDirection: 'row', gap: 14, paddingVertical: space.l },
  stepLine: { borderTopWidth: 1, borderTopColor: colors.line },
  mark: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.soft },
  markNow: { backgroundColor: colors.accent },
  markDone: { backgroundColor: colors.pill },
  markText: { fontSize: 14, fontWeight: '700', color: colors.muted },
  copy: { flex: 1, gap: 4 },
  stepTitle: { fontSize: 15, fontWeight: '600' },
  stepDone: { color: colors.muted, textDecorationLine: 'line-through' },
  stepButton: { alignSelf: 'flex-start', minHeight: 44, marginTop: 8 },
  team: { borderRadius: radius.l, backgroundColor: colors.tileSky, padding: space.l, gap: 6 },
  teamLabel: { color: colors.tileInk, fontSize: 12, fontWeight: '600', opacity: 0.75 },
  teamTitle: { color: colors.tileInk, fontSize: 18, fontWeight: '600' },
  teamText: { color: colors.tileInk, fontSize: 13, lineHeight: 19, opacity: 0.8 },
  teamButtons: { flexDirection: 'row', gap: space.s, marginTop: space.s },
  hint: { color: colors.muted, fontSize: 13, textAlign: 'center' }
}));
