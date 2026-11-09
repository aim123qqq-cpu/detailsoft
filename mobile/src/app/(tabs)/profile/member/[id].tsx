import { useCallback, useState, type ReactNode } from 'react';
import { Alert, Pressable, Share, StyleSheet, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AuthProvider, CenterRole, Permission, TeamMember } from '@df/types';
import { useSession } from '@/lib/session';
import { cardShadow, makeStyles, radius, space, useTheme } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Body, Button, Chip, Field, Heading, Loading, Notice, Screen } from '@/ui';
import { FlowHeader } from '@/ui/brand';
import { Text } from '@/ui/text';

const PROVIDERS = { telegram: 'Telegram', max: 'MAX', email: 'Email' } as const;
const EMAIL = /^\S+@\S+\.\S+$/;
type Invite = { provider: AuthProvider['provider']; code: string; deepLink: string | null; botName: string | null; expiresAt: string };

/** A member of the team: roles, sign-in through a messenger, blocking. `new` adds one and shows the access code once. */
export default function MemberScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api } = useSession();
  const { data, error, reload } = useResource(useCallback(async (signal: AbortSignal) => {
    const [team, roles, providers] = await Promise.all([api.team(signal), api.roles(signal), api.authProviders(signal).catch(() => ({ items: [] as AuthProvider[], email: false }))]);
    return { member: team.items.find((item) => item.id === id) ?? null, roles: roles.items, permissions: roles.permissions, providers: providers.items, emailSignIn: providers.email === true };
  }, [api, id]));
  if (!data && !error) return <Loading label="Загружаем…"/>;
  if (!data) return <Page title="Сотрудник"><Notice>{error}</Notice><Button title="Повторить" tone="secondary" onPress={reload}/></Page>;
  if (id === 'new') return <NewMember roles={data.roles} permissions={data.permissions}/>;
  if (!data.member) return <Page title="Сотрудник"><Body muted>Сотрудник не найден.</Body></Page>;
  return <EditMember key={data.member.updatedAt} member={data.member} roles={data.roles} permissions={data.permissions} providers={data.providers} emailSignIn={data.emailSignIn} onChanged={reload}/>;
}

function Page({ title, note, back = true, children }: { title: string; note?: string; back?: boolean; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <Screen contentStyle={{ paddingTop: insets.top + 18, gap: 14 }}>
      {back ? <FlowHeader title={title} note={note}/> : null}
      {children}
    </Screen>
  );
}

/** The roles to pick from as chips, and what the picked ones allow, in one line. */
function RolePicker({ roles, permissions, picked, onToggle, keep = [] }: { roles: CenterRole[]; permissions: Permission[]; picked: string[]; onToggle: (key: string) => void; keep?: string[] }) {
  const styles = useStyles();
  const chosen = roles.filter((role) => picked.includes(role.key));
  const allowed = [...new Set(chosen.flatMap((role) => role.permissions))].map((key) => permissions.find((permission) => permission.key === key)?.title ?? key);
  const summary = chosen.some((role) => role.locked) ? 'Полный доступ и управление командой'
    : allowed.length ? allowed.slice(0, 3).join(', ') + (allowed.length > 3 ? ` и ещё ${allowed.length - 3}` : '') : 'Выберите хотя бы одну роль';
  return (
    <>
      <View style={styles.chips}>
        {roles.filter((role) => !role.archived || keep.includes(role.key)).map((role) => <Chip key={role.key} label={role.name} selected={picked.includes(role.key)} onPress={() => onToggle(role.key)}/>)}
      </View>
      <Text style={styles.small}>{summary}</Text>
    </>
  );
}

function NewMember({ roles, permissions }: { roles: CenterRole[]; permissions: Permission[] }) {
  const styles = useStyles();
  const { api } = useSession();
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>(['intake']);
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const toggle = (key: string) => setPicked((list) => list.includes(key) ? list.filter((item) => item !== key) : [...list, key]);

  const create = async () => {
    setSaving(true); setError('');
    try { setToken((await api.createMember({ displayName: name.trim(), roles: picked })).accessToken); void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); }
    catch (failure) { setError((failure as Error).message); }
    finally { setSaving(false); }
  };

  if (token) return (
    <Page title="Сотрудник добавлен" back={false}>
      <View style={styles.who}>
        <Text style={styles.meta}>Сотрудник добавлен</Text>
        <Text style={styles.name}>{name.trim()}</Text>
      </View>
      <View style={styles.codeCard}>
        <Text style={styles.codeLabel}>Код доступа</Text>
        <Text style={styles.token} selectable>{token}</Text>
        <Text style={styles.codeNote}>Код показывается только сейчас. Передайте его лично: с ним сотрудник входит в приложение. Потом можно пригласить его в Telegram или MAX.</Text>
      </View>
      <Button title="Поделиться кодом" tone="secondary" onPress={() => void Share.share({ message: token })}/>
      <Button title="Готово" onPress={() => router.back()}/>
    </Page>
  );

  return (
    <Page title="Новый сотрудник">
      <Field label="Имя сотрудника" required value={name} onChangeText={setName} maxLength={80} placeholder="Например, Мария Орлова" autoCapitalize="words"/>
      <Heading style={{ marginTop: 4 }}>Роли и доступы</Heading>
      <View style={styles.card}><RolePicker roles={roles} permissions={permissions} picked={picked} onToggle={toggle}/></View>
      {error ? <Notice>{error}</Notice> : null}
      <Button title="Добавить сотрудника" busy={saving} disabled={name.trim().length < 2 || !picked.length} onPress={() => void create()}/>
    </Page>
  );
}

function EditMember({ member, roles, permissions, providers, emailSignIn, onChanged }: { member: TeamMember; roles: CenterRole[]; permissions: Permission[]; providers: AuthProvider[]; emailSignIn: boolean; onChanged: () => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { api } = useSession();
  const [picked, setPicked] = useState(member.roles);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [email, setEmail] = useState('');
  const toggle = (key: string) => { setSaved(false); setPicked((list) => list.includes(key) ? list.filter((item) => item !== key) : [...list, key]); };
  const active = member.status === 'active';
  const [first, ...rest] = member.displayName.trim().split(/\s+/);
  const rolesChanged = picked.length !== member.roles.length || picked.some((key) => !member.roles.includes(key));

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key); setError('');
    try { await action(); return true; }
    catch (failure) { setError((failure as Error).message); return false; }
    finally { setBusy(null); }
  };
  const saveRoles = async () => { if (await run('roles', () => api.updateMember(member.id, { roles: picked }))) { setSaved(true); onChanged(); } };
  const toggleStatus = () => Alert.alert(
    active ? `Заблокировать ${member.displayName}?` : `Вернуть доступ ${member.displayName}?`,
    active ? 'Сотрудник сразу перестанет входить в центр. История работ сохранится.' : 'Сотрудник снова сможет входить.',
    [{ text: 'Отмена', style: 'cancel' }, { text: active ? 'Заблокировать' : 'Вернуть доступ', style: active ? 'destructive' : 'default',
      onPress: async () => { if (await run('status', () => api.updateMember(member.id, { status: active ? 'blocked' : 'active' }))) onChanged(); } }]
  );
  const createInvite = (provider: AuthProvider['provider']) => run(`invite-${provider}`, async () => setInvite(await api.messengerInvite(member.id, provider)));
  // The address the member signs in with: a code goes there at each sign-in.
  const saveEmail = () => run('email', async () => { await api.setMemberEmail(member.id, email.trim()); setEmail(''); onChanged(); });
  const unlink = (linkId: string) => run(`unlink-${linkId}`, async () => { await api.removeMessengerLink(member.id, linkId); onChanged(); });
  const inviteText = invite ? [`Вход в DetailFlow через ${PROVIDERS[invite.provider]}.`, invite.deepLink ? `Откройте ссылку: ${invite.deepLink}` : null,
    `Или отправьте боту${invite.botName ? ` @${invite.botName}` : ''} код: ${invite.code}`].filter(Boolean).join('\n') : '';
  const statusText = active ? 'Доступ активен' : 'Доступ заблокирован';

  return (
    <Page title="Сотрудник" note={statusText}>
      <View style={styles.who}>
        <Text style={styles.name} accessibilityRole="header" accessibilityLabel={member.displayName}>{first}{rest.length ? `\n${rest.join(' ')}` : ''}</Text>
        <Text style={[styles.meta, { color: active ? colors.ok : colors.muted }]}>{statusText}</Text>
      </View>

      <Heading style={{ marginTop: 4 }}>Роли и доступы</Heading>
      <View style={styles.card}>
        <RolePicker roles={roles} permissions={permissions} picked={picked} onToggle={toggle} keep={member.roles}/>
        {saved && !rolesChanged ? <Text style={[styles.small, { color: colors.ok }]}>Роли сохранены</Text> : null}
        <Button title="Сохранить роли" busy={busy === 'roles'} disabled={!picked.length || !rolesChanged || busy !== null} onPress={() => void saveRoles()}/>
      </View>

      <Heading style={{ marginTop: 4 }}>{emailSignIn ? 'Вход через мессенджер или email' : 'Вход через мессенджер'}</Heading>
      <View style={styles.card}>
        {member.messengerLinks?.length ? member.messengerLinks.map((link) => (
          <View key={link.id} style={styles.link}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.title}>{PROVIDERS[link.provider]}</Text>
              <Text style={styles.small}>{link.externalName ? `${link.externalName} · привязан` : 'привязан'}</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel={`Отвязать ${PROVIDERS[link.provider]}`} disabled={busy !== null} onPress={() => void unlink(link.id)} hitSlop={8}>
              <Text style={styles.textAction}>{busy === `unlink-${link.id}` ? 'Отвязываем…' : 'Отвязать'}</Text>
            </Pressable>
          </View>
        )) : <Text style={styles.small}>Мессенджер не привязан. Отправьте сотруднику приглашение{emailSignIn ? ' или укажите его email' : ''}.</Text>}
        {active && emailSignIn ? <>
          <View style={styles.divider}/>
          <Field label={member.messengerLinks?.some((link) => link.provider === 'email') ? 'Сменить email для входа' : 'Email для входа'} value={email} onChangeText={setEmail}
            placeholder="name@mail.ru" keyboardType="email-address" autoCapitalize="none" autoCorrect={false} testID="member-email" style={styles.softInput}/>
          <Text style={styles.small}>Сотрудник введёт этот адрес на экране входа и получит код в письме.</Text>
          <Button title="Сохранить email" tone="secondary" busy={busy === 'email'} disabled={!EMAIL.test(email.trim()) || busy !== null} onPress={() => void saveEmail()}/>
        </> : null}
        {active ? <>
          <View style={styles.divider}/>
          {(['telegram', 'max'] as const).map((provider) => {
            const configured = providers.some((item) => item.provider === provider);
            return <Button key={provider} title={`Пригласить в ${PROVIDERS[provider]}${configured ? '' : ' · бот не настроен'}`} tone="secondary"
              busy={busy === `invite-${provider}`} disabled={!configured || busy !== null} onPress={() => void createInvite(provider)}/>;
          })}
        </> : null}
        {invite ? <View style={styles.invite}>
          <Text style={styles.small}>Приглашение одноразовое, действует до {new Date(invite.expiresAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.</Text>
          <Text style={styles.inviteCode} selectable>{invite.code}</Text>
          <Button title="Отправить сотруднику" onPress={() => void Share.share({ message: inviteText })}/>
        </View> : null}
      </View>

      {error ? <Notice>{error}</Notice> : null}
      <Pressable accessibilityRole="button" disabled={busy !== null} onPress={toggleStatus} style={styles.statusButton} hitSlop={6}>
        <Text style={[styles.textAction, { color: active ? colors.danger : colors.ink }]}>{busy === 'status' ? 'Сохраняем…' : active ? 'Заблокировать доступ' : 'Вернуть доступ'}</Text>
      </Pressable>
    </Page>
  );
}

const useStyles = makeStyles((colors, scheme) => StyleSheet.create({
  who: { gap: 4, paddingHorizontal: 4 },
  name: { fontSize: 34, lineHeight: 38, fontWeight: '500', letterSpacing: -1 },
  meta: { color: colors.muted, fontSize: 13 },
  card: { borderRadius: radius.l, backgroundColor: colors.surface, padding: space.l, gap: 12, ...cardShadow(scheme) },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  small: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  title: { fontSize: 15, fontWeight: '600' },
  link: { flexDirection: 'row', alignItems: 'center', gap: space.m },
  textAction: { fontSize: 14, fontWeight: '700' },
  divider: { height: 1, backgroundColor: colors.line },
  softInput: { backgroundColor: colors.soft, boxShadow: 'none' },
  invite: { gap: space.s, backgroundColor: colors.soft, borderRadius: radius.m, padding: space.m },
  inviteCode: { fontSize: 22, fontWeight: '600', letterSpacing: 2 },
  statusButton: { alignSelf: 'center', padding: 8 },
  codeCard: { borderRadius: radius.l, backgroundColor: colors.darkCard, padding: 18, gap: 8, ...cardShadow(scheme) },
  codeLabel: { color: colors.darkCardInk, fontSize: 13, opacity: 0.65 },
  token: { color: colors.darkCardInk, fontSize: 20, fontWeight: '600', fontFamily: 'monospace' },
  codeNote: { color: colors.darkCardInk, fontSize: 13, lineHeight: 18, opacity: 0.65 }
}));
