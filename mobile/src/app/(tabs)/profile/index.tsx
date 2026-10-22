import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import Constants from 'expo-constants';
import * as WebBrowser from 'expo-web-browser';
import type { SessionContext } from '@df/types';
import { wipeOfflineData } from '@df/offline/store';
import { useSession, useSignedIn } from '@/lib/session';
import { colors, radius, space } from '@/lib/theme';
import { Body, Button, Card, Label, Notice, Screen, Title } from '@/ui';

const capabilityLabels: [keyof SessionContext['capabilities'], string][] = [
  ['manageCustomers', 'Клиенты и автомобили'], ['manageBookings', 'Записи'], ['manageIntake', 'Приёмка'],
  ['approveEstimates', 'Смета и согласование'], ['assignMasters', 'Назначение мастеров'], ['performWork', 'Выполнение работ'],
  ['acceptAssignments', 'Исполнитель заказов'], ['closeOrders', 'Выдача автомобилей'], ['manageCatalog', 'Каталог и цены'],
  ['manageSettings', 'Настройки центра'], ['manageTeam', 'Команда и роли'], ['viewAnalytics', 'Статистика']
];
/** How this person is signed in, in words: the messenger by name when the server knows it. */
function signedInWith(actor: SessionContext['actor']) {
  if (actor.authMethod === 'demo') return 'Демо-режим';
  if (actor.authMethod === 'access_token') return 'Вы вошли по коду доступа';
  return actor.authProvider === 'max' ? 'Вы вошли через MAX' : actor.authProvider === 'telegram' ? 'Вы вошли через Telegram' : 'Вы вошли через мессенджер';
}
const badges = { telegram: { mark: '✈', color: '#229ed9' }, max: { mark: 'M', color: '#5b4cf0' }, other: { mark: '#', color: colors.surfaceRaised } };

export default function ProfileScreen() {
  const { api, server, signOut } = useSession();
  const session = useSignedIn();
  const [busy, setBusy] = useState<'out' | 'delete' | null>(null);
  const [error, setError] = useState('');
  const granted = capabilityLabels.filter(([key]) => session.capabilities[key]);
  const badge = badges[session.actor.authProvider ?? 'other'];
  const management = [
    session.capabilities.manageCatalog && { href: '/profile/catalog' as const, title: 'Каталог услуг', note: 'Разделы, услуги, время и цены' },
    session.capabilities.manageTeam && { href: '/profile/team' as const, title: 'Команда и роли', note: 'Сотрудники, доступы, приглашения' },
    session.capabilities.manageSettings && { href: '/profile/settings' as const, title: 'График центра', note: 'Рабочие дни, часы, шаг записи' }
  ].filter((item) => item !== false);

  const leave = async () => {
    setBusy('out');
    // A messenger session is revoked on the server; an access code or the demo is only forgotten here.
    if (session.actor.authMethod === 'messenger') await api.logout().catch(() => {});
    await signOut();
  };

  const confirmDelete = () => Alert.alert(
    `Удалить аккаунт в «${session.tenant.name}»?`,
    'Удалим ваше имя, привязку к Telegram или MAX, коды доступа и все входы. Войти в этот центр снова будет нельзя.\n\nЗаказы, акты и история работ останутся у центра: это его рабочие документы.',
    [
      { text: 'Отмена', style: 'cancel' },
      { text: 'Удалить навсегда', style: 'destructive', onPress: async () => {
        setBusy('delete'); setError('');
        // The phone's copy of the center's data goes too: nothing of it stays on this device.
        try { await api.deleteAccount(); await wipeOfflineData(); await signOut(); }
        catch (requestError) { setError((requestError as Error).message); setBusy(null); }
      } }
    ]
  );

  return (
    <Screen>
      <View style={styles.hero}>
        <View style={styles.avatar}><Text style={styles.avatarText}>{session.actor.displayName.slice(0, 1).toLocaleUpperCase('ru-RU')}</Text></View>
        <View style={{ flex: 1 }}>
          <Title>{session.actor.displayName}</Title>
          <Body muted>{(session.actor.roleNames?.length ? session.actor.roleNames : session.actor.roles).join(' · ')}</Body>
        </View>
      </View>

      {management.length ? <View style={styles.group}>
        <Label>Управление центром</Label>
        {management.map((item) => (
          <Pressable key={item.href} accessibilityRole="button" onPress={() => router.push(item.href)} android_ripple={{ color: 'rgba(255,255,255,.06)' }} style={styles.link}>
            <View style={{ flex: 1 }}><Text style={styles.linkLabel}>{item.title}</Text><Text style={styles.linkNote}>{item.note}</Text></View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        ))}
      </View> : null}

      <Card>
        <Label>Рабочий центр</Label>
        <Text style={styles.center}>{session.tenant.name}</Text>
        <Body muted>Записи, заказы и статистика показываются только для этого центра.</Body>
      </Card>

      <Card>
        <Label>Доступы</Label>
        {granted.map(([key, label]) => <Text key={key} style={styles.capability}>✓  {label}</Text>)}
      </Card>

      <Card style={styles.account}>
        <View style={styles.accountHead}>
          <View style={[styles.badge, { backgroundColor: badge.color }]}><Text style={styles.badgeText}>{badge.mark}</Text></View>
          <View style={{ flex: 1 }}>
            <Label>Аккаунт</Label>
            <Text style={styles.accountTitle}>{signedInWith(session.actor)}</Text>
          </View>
        </View>
        <Button title={session.actor.authMethod === 'demo' ? 'Выйти из демо-режима' : 'Выйти'} tone="secondary" busy={busy === 'out'} onPress={leave} testID="sign-out"/>
        {session.actor.memberId ? <Button title="Удалить аккаунт" tone="dangerQuiet" busy={busy === 'delete'} onPress={confirmDelete} testID="delete-account"/> : null}
        {error ? <Notice>{error}</Notice> : null}
      </Card>

      <Pressable accessibilityRole="link" onPress={() => WebBrowser.openBrowserAsync(`${server}/privacy/`, { toolbarColor: colors.ground, controlsColor: colors.primary })}
        android_ripple={{ color: 'rgba(255,255,255,.06)' }} style={styles.link}>
        <Text style={styles.linkLabel}>Политика конфиденциальности</Text><Text style={styles.linkValue}>Открыть</Text>
      </Pressable>

      <Text style={styles.version}>DetailFlow {Constants.expoConfig?.version ?? ''} · нативная версия</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { flexDirection: 'row', alignItems: 'center', gap: space.l, paddingVertical: space.s },
  avatar: { width: 56, height: 56, borderRadius: 28, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: colors.primaryInk, fontSize: 24, fontWeight: '800' },
  center: { color: colors.text, fontSize: 20, fontWeight: '800' },
  capability: { color: colors.text, fontSize: 15, lineHeight: 26 },
  link: { minHeight: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.m, paddingHorizontal: space.l, backgroundColor: colors.surface, borderRadius: radius.l, overflow: 'hidden' },
  linkLabel: { color: colors.text, fontSize: 16, fontWeight: '600' },
  linkValue: { color: colors.primary, fontSize: 15, flexShrink: 1 },
  linkNote: { color: colors.muted, fontSize: 13 },
  chevron: { color: colors.muted, fontSize: 24 },
  group: { gap: space.s },
  account: { gap: space.m },
  accountHead: { flexDirection: 'row', alignItems: 'center', gap: space.m },
  badge: { width: 44, height: 44, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: '#fff', fontSize: 20, fontWeight: '900' },
  accountTitle: { color: colors.text, fontSize: 17, fontWeight: '800' },
  version: { color: colors.soft, fontSize: 12, textAlign: 'center', marginTop: space.l }
});
