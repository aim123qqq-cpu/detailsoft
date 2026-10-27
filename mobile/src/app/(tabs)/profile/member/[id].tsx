import { useCallback, useState } from 'react';
import { Alert, Share, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import type { AuthProvider, CenterRole, Permission, TeamMember } from '@df/types';
import { PickList } from '@/features/pick-list';
import { useSession } from '@/lib/session';
import { colors, radius, space } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Body, Button, Card, Field, Label, Loading, Notice, Screen } from '@/ui';

const PROVIDERS = { telegram: 'Telegram', max: 'MAX', email: 'Email' } as const;
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
  if (!data) return <Screen><Notice>{error}</Notice><Button title="Повторить" tone="secondary" onPress={reload}/></Screen>;
  if (id === 'new') return <NewMember roles={data.roles} permissions={data.permissions}/>;
  if (!data.member) return <Screen><Body muted>Сотрудник не найден.</Body></Screen>;
  return <EditMember key={data.member.updatedAt} member={data.member} roles={data.roles} permissions={data.permissions} providers={data.providers} emailSignIn={data.emailSignIn} onChanged={reload}/>;
}

function roleOptions(roles: CenterRole[], permissions: Permission[], keep: string[] = []) {
  const titleOf = (key: string) => permissions.find((permission) => permission.key === key)?.title ?? key;
  return roles.filter((role) => !role.archived || keep.includes(role.key)).map((role) => ({
    key: role.key, title: role.name,
    note: role.locked ? 'Полный доступ и команда' : role.permissions.map(titleOf).slice(0, 3).join(', ') + (role.permissions.length > 3 ? ` и ещё ${role.permissions.length - 3}` : '')
  }));
}

function NewMember({ roles, permissions }: { roles: CenterRole[]; permissions: Permission[] }) {
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
    <Screen>
      <Stack.Screen options={{ title: 'Сотрудник добавлен', headerBackVisible: false }}/>
      <Card>
        <Label>Код доступа для {name.trim()}</Label>
        <Text style={styles.token} selectable>{token}</Text>
        <Body muted>Код показывается только сейчас. Передайте его лично: с ним сотрудник входит в приложение. Потом можно пригласить его в Telegram или MAX.</Body>
      </Card>
      <Button title="Поделиться кодом" tone="secondary" onPress={() => void Share.share({ message: token })}/>
      <Button title="Готово" onPress={() => router.back()}/>
    </Screen>
  );

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Новый сотрудник' }}/>
      <Field label="Имя сотрудника" value={name} onChangeText={setName} maxLength={80} placeholder="Например, Мария Орлова" autoCapitalize="words"/>
      <Label>Роли и доступы</Label>
      <PickList options={roleOptions(roles, permissions)} selected={picked} onToggle={toggle}/>
      {error ? <Notice>{error}</Notice> : null}
      <Button title="Добавить сотрудника" busy={saving} disabled={name.trim().length < 2 || !picked.length} onPress={() => void create()}/>
    </Screen>
  );
}

function EditMember({ member, roles, permissions, providers, emailSignIn, onChanged }: { member: TeamMember; roles: CenterRole[]; permissions: Permission[]; providers: AuthProvider[]; emailSignIn: boolean; onChanged: () => void }) {
  const { api } = useSession();
  const [picked, setPicked] = useState(member.roles);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [email, setEmail] = useState('');
  const toggle = (key: string) => { setSaved(false); setPicked((list) => list.includes(key) ? list.filter((item) => item !== key) : [...list, key]); };

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key); setError('');
    try { await action(); return true; }
    catch (failure) { setError((failure as Error).message); return false; }
    finally { setBusy(null); }
  };
  const saveRoles = async () => { if (await run('roles', () => api.updateMember(member.id, { roles: picked }))) { setSaved(true); onChanged(); } };
  const toggleStatus = () => Alert.alert(
    member.status === 'active' ? `Заблокировать ${member.displayName}?` : `Вернуть доступ ${member.displayName}?`,
    member.status === 'active' ? 'Сотрудник сразу перестанет входить в центр. История работ сохранится.' : 'Сотрудник снова сможет входить.',
    [{ text: 'Отмена', style: 'cancel' }, { text: member.status === 'active' ? 'Заблокировать' : 'Вернуть доступ', style: member.status === 'active' ? 'destructive' : 'default',
      onPress: async () => { if (await run('status', () => api.updateMember(member.id, { status: member.status === 'active' ? 'blocked' : 'active' }))) onChanged(); } }]
  );
  const createInvite = (provider: AuthProvider['provider']) => run(`invite-${provider}`, async () => setInvite(await api.messengerInvite(member.id, provider)));
  // The address the member signs in with: a code goes there at each sign-in.
  const saveEmail = () => run('email', async () => { await api.setMemberEmail(member.id, email.trim()); setEmail(''); onChanged(); });
  const unlink = (linkId: string) => run(`unlink-${linkId}`, async () => { await api.removeMessengerLink(member.id, linkId); onChanged(); });
  const inviteText = invite ? [`Вход в DetailFlow через ${PROVIDERS[invite.provider]}.`, invite.deepLink ? `Откройте ссылку: ${invite.deepLink}` : null,
    `Или отправьте боту${invite.botName ? ` @${invite.botName}` : ''} код: ${invite.code}`].filter(Boolean).join('\n') : '';

  return (
    <Screen>
      <Stack.Screen options={{ title: member.displayName }}/>
      <Body muted>{member.status === 'active' ? 'Доступ активен.' : 'Доступ заблокирован.'} Один сотрудник может совмещать несколько ролей.</Body>
      <Label>Роли и доступы</Label>
      <PickList options={roleOptions(roles, permissions, member.roles)} selected={picked} onToggle={toggle}/>
      {saved ? <Notice tone="info">Роли сохранены.</Notice> : null}
      <Button title="Сохранить роли" busy={busy === 'roles'} disabled={!picked.length || busy !== null} onPress={() => void saveRoles()}/>

      <Card>
        <Label>{emailSignIn ? 'Вход через мессенджер или email' : 'Вход через мессенджер'}</Label>
        {member.messengerLinks?.length ? member.messengerLinks.map((link) => (
          <View key={link.id} style={styles.link}>
            <Text style={styles.linkText}>{PROVIDERS[link.provider]}{link.externalName ? ` · ${link.externalName}` : ''}</Text>
            <Button title="Отвязать" tone="quiet" busy={busy === `unlink-${link.id}`} onPress={() => void unlink(link.id)} style={styles.unlink}/>
          </View>
        )) : <Body muted>Мессенджер не привязан. Отправьте сотруднику приглашение{emailSignIn ? ' или укажите его email' : ''}.</Body>}
        {member.status === 'active' && emailSignIn ? <View style={styles.invite}>
          <Field label={member.messengerLinks?.some((link) => link.provider === 'email') ? 'Сменить email для входа' : 'Email для входа'} value={email} onChangeText={setEmail}
            placeholder="name@mail.ru" keyboardType="email-address" autoCapitalize="none" autoCorrect={false} testID="member-email"/>
          <Button title="Сохранить email" tone="secondary" busy={busy === 'email'} disabled={!/^S+@S+.S+$/.test(email.trim()) || busy !== null} onPress={() => void saveEmail()}/>
          <Body muted>Сотрудник введёт этот адрес на экране входа и получит код в письме.</Body>
        </View> : null}
        {member.status === 'active' ? (['telegram', 'max'] as const).map((provider) => {
          const configured = providers.some((item) => item.provider === provider);
          return <Button key={provider} title={`Пригласить в ${PROVIDERS[provider]}${configured ? '' : ' · бот не настроен'}`} tone="secondary"
            busy={busy === `invite-${provider}`} disabled={!configured || busy !== null} onPress={() => void createInvite(provider)}/>;
        }) : null}
        {invite ? <View style={styles.invite}>
          <Text style={styles.linkText}>Приглашение готово — одноразовое, действует до {new Date(invite.expiresAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.</Text>
          <Text style={styles.code} selectable>{invite.code}</Text>
          <Button title="Отправить сотруднику" onPress={() => void Share.share({ message: inviteText })}/>
        </View> : null}
      </Card>

      {error ? <Notice>{error}</Notice> : null}
      <Button title={member.status === 'active' ? 'Заблокировать доступ' : 'Вернуть доступ'} tone={member.status === 'active' ? 'dangerQuiet' : 'secondary'}
        busy={busy === 'status'} onPress={toggleStatus}/>
    </Screen>
  );
}

const styles = StyleSheet.create({
  token: { color: colors.primary, fontSize: 18, fontWeight: '800', fontFamily: 'monospace', paddingVertical: space.s },
  link: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.m },
  linkText: { color: colors.text, fontSize: 15, flexShrink: 1 },
  unlink: { minHeight: 40 },
  invite: { gap: space.s, backgroundColor: colors.surfaceRaised, borderRadius: radius.m, padding: space.m },
  code: { color: colors.primary, fontSize: 20, fontWeight: '800', letterSpacing: 2 }
});
