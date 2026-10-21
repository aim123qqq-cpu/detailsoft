import { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect, type Href } from 'expo-router';
import { useSession, useSignedIn } from '@/lib/session';
import { colors, radius, space } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';

/**
 * A new center's owner sees what to do before the first customer: services, the team, a booking.
 * Done steps are ticked; once all are done the card is gone. Offline it simply does not show.
 */
export function FirstSteps() {
  const { api } = useSession();
  const session = useSignedIn();
  const allowed = session.capabilities.manageSettings;
  const setup = useResource(useCallback((signal: AbortSignal) => allowed ? api.centerSetup(signal) : Promise.resolve(null), [api, allowed]));
  const { refresh } = setup;
  // Back from the catalog or the team: the ticks follow.
  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));

  const data = setup.data;
  if (!data) return null;
  const steps: { title: string; text: string; done: boolean; href: Href }[] = [
    { title: 'Добавьте услуги', text: 'Название, время и цена — без них не записать клиента.', done: data.services > 0, href: '/profile/catalog' },
    { title: 'Пригласите команду', text: 'Администраторы и мастера войдут по своему коду или через Telegram.', done: data.members > 1, href: '/profile/team' },
    { title: 'Запишите первого клиента', text: 'Телефон, автомобиль, услуги и время.', done: data.bookings > 0, href: '/new' }
  ];
  if (steps.every((step) => step.done)) return null;

  return (
    <View style={styles.card} testID="first-steps">
      <Text style={styles.title}>Первые шаги</Text>
      <Text style={styles.lead}>Часы работы — в «Профиль → График центра».</Text>
      {steps.map((step, index) => (
        <Pressable key={step.title} accessibilityRole="button" accessibilityState={{ checked: step.done }} onPress={() => router.push(step.href)}
          android_ripple={{ color: 'rgba(255,255,255,.06)' }} style={styles.step}>
          <View style={[styles.mark, step.done && styles.markDone]}><Text style={[styles.markText, step.done && styles.markTextDone]}>{step.done ? '✓' : index + 1}</Text></View>
          <View style={styles.copy}>
            <Text style={[styles.stepTitle, step.done && styles.stepTitleDone]}>{step.title}</Text>
            {step.done ? null : <Text style={styles.stepText}>{step.text}</Text>}
          </View>
          {step.done ? null : <Text style={styles.chevron}>›</Text>}
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: radius.l, padding: space.l, gap: space.s, borderWidth: 1, borderColor: 'rgba(255,121,57,.35)' },
  title: { color: colors.text, fontSize: 20, fontWeight: '800' },
  lead: { color: colors.muted, fontSize: 14, marginBottom: space.xs },
  step: { flexDirection: 'row', alignItems: 'center', gap: space.m, paddingVertical: space.s, minHeight: 48 },
  mark: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,121,57,.15)' },
  markDone: { backgroundColor: 'rgba(54,201,150,.18)' },
  markText: { color: colors.primary, fontSize: 15, fontWeight: '800' },
  markTextDone: { color: colors.ok },
  copy: { flex: 1, gap: 2 },
  stepTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  stepTitleDone: { color: colors.muted, textDecorationLine: 'line-through' },
  stepText: { color: colors.muted, fontSize: 14 },
  chevron: { color: colors.muted, fontSize: 24 }
});
