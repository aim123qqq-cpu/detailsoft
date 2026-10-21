import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Stack, router, useFocusEffect } from 'expo-router';
import { Segmented } from '@/features/booking-ui';
import { useSession } from '@/lib/session';
import { colors, radius, space } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Body, Button, Loading, Notice, Pill, Screen } from '@/ui';

const PROVIDERS = { telegram: 'Telegram', max: 'MAX' } as const;
const people = (count: number) => count % 10 === 1 && count % 100 !== 11 ? 'сотрудник' : [2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100) ? 'сотрудника' : 'сотрудников';

/** The team (who works here, with which roles) and the roles with their permissions. */
export default function TeamScreen() {
  const { api } = useSession();
  const [tab, setTab] = useState<'members' | 'roles'>('members');
  const { data, error, reload, refresh } = useResource(useCallback(async (signal: AbortSignal) => {
    const [team, roles] = await Promise.all([api.team(signal), api.roles(signal)]);
    return { members: team.items, roles: roles.items, permissions: roles.permissions };
  }, [api]));
  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));

  if (!data && !error) return <Loading label="Загружаем команду…"/>;
  if (!data) return <Screen><Notice>{error}</Notice><Button title="Повторить" tone="secondary" onPress={reload}/></Screen>;
  const roleName = (key: string) => data.roles.find((role) => role.key === key)?.name ?? key;
  const titleOf = (key: string) => data.permissions.find((permission) => permission.key === key)?.title ?? key;

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Команда и роли', headerRight: () => (
        <Pressable accessibilityRole="button" hitSlop={10} onPress={() => tab === 'members'
          ? router.push({ pathname: '/profile/member/[id]', params: { id: 'new' } })
          : router.push({ pathname: '/profile/role/[key]', params: { key: 'new' } })}>
          <Text style={styles.headerAction}>{tab === 'members' ? '＋ Сотрудник' : '＋ Роль'}</Text>
        </Pressable>
      ) }}/>
      <Segmented value={tab} onChange={setTab} options={[{ value: 'members', label: 'Сотрудники' }, { value: 'roles', label: 'Роли и права' }]}/>
      {tab === 'members' ? <>
        <Body muted>{data.members.filter((member) => member.status === 'active').length} с доступом · доступы действуют только в этом центре.</Body>
        {data.members.map((member) => (
          <Pressable key={member.id} accessibilityRole="button" accessibilityLabel={member.displayName} onPress={() => router.push({ pathname: '/profile/member/[id]', params: { id: member.id } })}
            android_ripple={{ color: 'rgba(255,255,255,.06)' }} style={[styles.row, member.status === 'blocked' && styles.blocked]}>
            <View style={styles.avatar}><Text style={styles.avatarText}>{member.displayName.split(' ').slice(0, 2).map((part) => part[0]).join('')}</Text></View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.name}>{member.displayName}</Text>
              <Text style={styles.meta}>{member.roles.map(roleName).join(' · ')}</Text>
              <Text style={styles.meta}>{member.status === 'active' ? 'Доступ активен' : 'Доступ заблокирован'}{member.messengerLinks?.length ? ` · ${member.messengerLinks.map((link) => PROVIDERS[link.provider]).join(', ')}` : ''}</Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        ))}
      </> : <>
        {data.roles.filter((role) => !role.archived).concat(data.roles.filter((role) => role.archived)).map((role) => (
          <Pressable key={role.key} accessibilityRole="button" accessibilityLabel={role.name} disabled={role.locked}
            onPress={() => router.push({ pathname: '/profile/role/[key]', params: { key: role.key } })}
            android_ripple={{ color: 'rgba(255,255,255,.06)' }} style={[styles.row, role.archived && styles.blocked]}>
            <View style={{ flex: 1, gap: 4 }}>
              <View style={styles.roleHead}><Text style={styles.name}>{role.name}</Text><Pill label={role.archived ? 'архив' : role.locked ? 'полный доступ' : role.system ? 'системная' : 'своя'} tone={role.locked ? 'accent' : 'neutral'}/></View>
              <Text style={styles.meta}>{role.locked ? 'Все права и управление командой. Не меняется.' : role.permissions.map(titleOf).join(' · ')}</Text>
              <Text style={styles.meta}>{role.memberCount ? `${role.memberCount} ${people(role.memberCount)}` : 'Ни у кого нет'}</Text>
            </View>
            {!role.locked ? <Text style={styles.chevron}>›</Text> : null}
          </Pressable>
        ))}
      </>}
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerAction: { color: colors.primary, fontSize: 16, fontWeight: '800' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.m, backgroundColor: colors.surface, borderRadius: radius.l, padding: space.l, overflow: 'hidden' },
  blocked: { opacity: 0.55 },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.surfaceRaised, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: colors.text, fontSize: 15, fontWeight: '800' },
  name: { color: colors.text, fontSize: 16, fontWeight: '700' },
  meta: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  chevron: { color: colors.muted, fontSize: 24 },
  roleHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.s }
});
