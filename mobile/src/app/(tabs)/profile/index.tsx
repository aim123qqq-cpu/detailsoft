import { useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import Constants from 'expo-constants';
import * as WebBrowser from 'expo-web-browser';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { SessionContext } from '@df/types';
import { wipeOfflineData } from '@df/offline/store';
import { Segmented } from '@/features/booking-ui';
import { useUnread } from '@/features/notifications';
import { useSession, useSignedIn } from '@/lib/session';
import { cardShadow, makeStyles, radius, space, useTheme } from '@/lib/theme';
import { Heading, Notice, Screen } from '@/ui';
import { Icon } from '@/ui/icons';
import { Sheet } from '@/ui/sheet';
import { Text } from '@/ui/text';

const capabilityLabels: [keyof SessionContext['capabilities'], string][] = [
  ['manageCustomers', 'Клиенты и автомобили'], ['manageBookings', 'Записи'], ['manageIntake', 'Приёмка'],
  ['approveEstimates', 'Смета и согласование'], ['assignMasters', 'Назначение мастеров'], ['performWork', 'Выполнение работ'],
  ['acceptAssignments', 'Исполнитель заказов'], ['closeOrders', 'Выдача автомобилей'], ['manageCatalog', 'Каталог и цены'],
  ['manageSettings', 'Настройки центра'], ['manageTeam', 'Команда и роли'], ['viewAnalytics', 'Статистика']
];
const DOCUMENTS = [['Политика обработки данных', '/privacy/'], ['Пользовательское соглашение', '/terms/'], ['Согласие на обработку данных', '/consent/'], ['Лицензии', '/licenses/']] as const;

/** How this person is signed in, in words: the messenger by name when the server knows it. */
function signedInWith(actor: SessionContext['actor']) {
  if (actor.authMethod === 'demo') return 'Демо-режим';
  if (actor.authMethod === 'access_token') return 'Вы вошли по коду доступа';
  return actor.authProvider === 'max' ? 'Вы вошли через MAX' : actor.authProvider === 'telegram' ? 'Вы вошли через Telegram'
    : actor.authProvider === 'email' ? 'Вы вошли по email' : 'Вы вошли через мессенджер';
}

export default function ProfileScreen() {
  const styles = useStyles();
  const { colors, preference, setPreference } = useTheme();
  const insets = useSafeAreaInsets();
  const { api, server, signOut } = useSession();
  const session = useSignedIn();
  const { unread } = useUnread();
  const [busy, setBusy] = useState<'out' | 'delete' | null>(null);
  const [error, setError] = useState('');
  const [accessOpen, setAccessOpen] = useState(false);
  const granted = capabilityLabels.filter(([key]) => session.capabilities[key]);
  const roles = session.actor.roleNames?.length ? session.actor.roleNames : session.actor.roles;
  // The name on two lines, as on a badge: the first word, then the rest.
  const [first, ...rest] = session.actor.displayName.trim().split(/\s+/);
  const management = [
    session.capabilities.manageCatalog && { href: '/profile/catalog' as const, title: 'Каталог услуг', note: 'Разделы, услуги, время и цены' },
    session.capabilities.manageTeam && { href: '/profile/team' as const, title: 'Команда и роли', note: 'Сотрудники, доступы, приглашения' },
    session.capabilities.manageSettings && { href: '/profile/settings' as const, title: 'График центра', note: 'Рабочие дни, часы, шаг записи' }
  ].filter((item) => item !== false);
  const openDocument = (path: string) => WebBrowser.openBrowserAsync(`${server}${path}`, { toolbarColor: colors.ground, controlsColor: colors.ink });

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
    <Screen contentStyle={{ paddingTop: insets.top + 18, gap: 14 }}>
      {session.actor.memberId ? <View style={styles.top}>
        <Pressable accessibilityRole="button" accessibilityLabel={unread ? `Уведомления, новых: ${unread}` : 'Уведомления'} onPress={() => router.push('/profile/notifications')} style={styles.round} testID="notifications-entry">
          <Icon name="bell" size={20} strokeWidth={1.7}/>
          {unread ? <View style={styles.badge}><Text style={styles.badgeText}>{unread > 99 ? '99+' : unread}</Text></View> : null}
        </Pressable>
      </View> : null}

      <View style={styles.who}>
        <Text style={styles.meta}>{roles.join(' · ')}</Text>
        <Text style={styles.name} accessibilityRole="header" accessibilityLabel={session.actor.displayName}>{first}{rest.length ? `\n${rest.join(' ')}` : ''}</Text>
        <Text style={styles.meta}>{signedInWith(session.actor)}</Text>
      </View>

      <View style={styles.center}>
        <Text style={styles.centerLabel}>Рабочий центр</Text>
        <Text style={styles.centerName}>{session.tenant.name}</Text>
      </View>

      <Heading style={styles.section}>Управление центром</Heading>
      <View style={styles.list}>
        <Row title="Ваши доступы" note={`${granted.length} из ${capabilityLabels.length}`} onPress={() => setAccessOpen(true)}/>
        {management.map((item) => <Row key={item.href} title={item.title} note={item.note} onPress={() => router.push(item.href)} line/>)}
      </View>

      <Heading style={styles.section}>Оформление</Heading>
      <Segmented value={preference} onChange={setPreference} options={[{ value: 'system', label: 'Как в системе' }, { value: 'light', label: 'Светлая' }, { value: 'dark', label: 'Тёмная' }]}/>

      <Heading style={styles.section}>Аккаунт</Heading>
      <View style={styles.list}>
        <Row title={busy === 'out' ? 'Выходим…' : session.actor.authMethod === 'demo' ? 'Выйти из демо-режима' : 'Выйти'} onPress={() => { if (!busy) void leave(); }} testID="sign-out"/>
        {session.actor.memberId ? <Row title={busy === 'delete' ? 'Удаляем…' : 'Удалить аккаунт'} danger onPress={() => { if (!busy) confirmDelete(); }} line testID="delete-account"/> : null}
      </View>
      {error ? <Notice>{error}</Notice> : null}

      <View style={styles.documents}>
        {DOCUMENTS.map(([label, path]) => (
          <Pressable key={path} accessibilityRole="link" onPress={() => void openDocument(path)} hitSlop={6}>
            <Text style={styles.document}>{label}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={styles.version}>DetailFlow {Constants.expoConfig?.version ?? ''}</Text>

      <Sheet visible={accessOpen} title="Ваши доступы" note={`${roles.length > 1 ? 'Роли' : 'Роль'} ${roles.map((role) => `«${role}»`).join(', ')} · ${granted.length} из ${capabilityLabels.length}`} onClose={() => setAccessOpen(false)}>
        <View>
          {granted.map(([key, label]) => (
            <View key={key} style={styles.access}>
              <View style={styles.tick}><Icon name="check" size={14} strokeWidth={2.6} color={colors.pillInk}/></View>
              <Text style={styles.accessText}>{label}</Text>
            </View>
          ))}
        </View>
        <Text style={styles.meta}>Доступы меняет владелец центра в разделе «Команда и роли»</Text>
      </Sheet>
    </Screen>
  );
}

/** A line of a grouped list: a title, what it is about, and a chevron when it leads somewhere. */
function Row({ title, note, onPress, line, danger, testID }: { title: string; note?: string; onPress: () => void; line?: boolean; danger?: boolean; testID?: string }) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={[styles.row, line && styles.rowLine]} testID={testID}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[styles.rowTitle, danger && { color: colors.danger }]}>{title}</Text>
        {note ? <Text style={styles.rowNote}>{note}</Text> : null}
      </View>
      {note ? <Icon name="chevronRight" size={18}/> : null}
    </Pressable>
  );
}

const useStyles = makeStyles((colors, scheme) => StyleSheet.create({
  top: { flexDirection: 'row', justifyContent: 'flex-end' },
  round: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center', ...cardShadow(scheme) },
  badge: { position: 'absolute', top: -2, right: -2, height: 20, minWidth: 20, paddingHorizontal: 5, borderRadius: 10, backgroundColor: colors.accent, borderWidth: 2, borderColor: colors.ground, alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: '#FFFFFF', fontSize: 10, fontWeight: '700' },
  who: { gap: 4, paddingHorizontal: 4, paddingBottom: 4 },
  meta: { color: colors.muted, fontSize: 13 },
  name: { fontSize: 34, lineHeight: 38, fontWeight: '500', letterSpacing: -1 },
  center: { borderRadius: radius.l, backgroundColor: colors.tileSky, padding: space.l, gap: 4 },
  centerLabel: { color: colors.tileInk, fontSize: 12, fontWeight: '600', opacity: 0.7 },
  centerName: { color: colors.tileInk, fontSize: 18, fontWeight: '600' },
  section: { marginTop: 4 },
  list: { borderRadius: radius.l, backgroundColor: colors.surface, paddingHorizontal: space.l, paddingVertical: 4, ...cardShadow(scheme) },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: 60, paddingVertical: 8 },
  rowLine: { borderTopWidth: 1, borderTopColor: colors.line },
  rowTitle: { fontSize: 15, fontWeight: '600' },
  rowNote: { color: colors.muted, fontSize: 12 },
  documents: { flexDirection: 'row', flexWrap: 'wrap', columnGap: space.l, rowGap: 6, paddingHorizontal: 4, paddingTop: 4 },
  document: { color: colors.muted, fontSize: 12, textDecorationLine: 'underline' },
  version: { color: colors.faint, fontSize: 12, paddingHorizontal: 4 },
  access: { flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: 44 },
  tick: { width: 24, height: 24, borderRadius: 8, backgroundColor: colors.pill, alignItems: 'center', justifyContent: 'center' },
  accessText: { fontSize: 15, fontWeight: '600', flex: 1 }
}));
