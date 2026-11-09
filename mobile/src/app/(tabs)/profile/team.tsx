import { useCallback } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSession } from '@/lib/session';
import { cardShadow, makeStyles, radius, space, useTheme } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Button, Heading, Loading, Notice, Screen } from '@/ui';
import { FlowHeader } from '@/ui/brand';
import { Icon } from '@/ui/icons';
import { Text } from '@/ui/text';

const people = (count: number) => `${count} ${count % 10 === 1 && count % 100 !== 11 ? 'сотрудник' : [2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100) ? 'сотрудника' : 'сотрудников'}`;

/** The team (who works here, with which roles) and the roles with their permissions, on one page. */
export default function TeamScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { api } = useSession();
  const { data, error, reload, refresh } = useResource(useCallback(async (signal: AbortSignal) => {
    const [team, roles] = await Promise.all([api.team(signal), api.roles(signal)]);
    return { members: team.items, roles: roles.items };
  }, [api]));
  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));

  if (!data && !error) return <Loading label="Загружаем команду…"/>;
  if (!data) return <Screen><Notice>{error}</Notice><Button title="Повторить" tone="secondary" onPress={reload}/></Screen>;
  const roleName = (key: string) => data.roles.find((role) => role.key === key)?.name ?? key;
  const roles = data.roles.filter((role) => !role.archived).concat(data.roles.filter((role) => role.archived));
  const owner = data.roles.find((role) => role.locked);

  return (
    <Screen contentStyle={{ paddingTop: insets.top + 18, gap: 14 }}>
      <FlowHeader title="Команда и роли" note={people(data.members.length)}/>
      <View style={styles.actions}>
        <Pressable accessibilityRole="button" accessibilityLabel="Новый сотрудник" onPress={() => router.push({ pathname: '/profile/member/[id]', params: { id: 'new' } })} style={[styles.action, styles.actionMain]}>
          <Icon name="plus" size={16} strokeWidth={2.4} color={colors.pillInk}/><Text style={[styles.actionText, { color: colors.pillInk }]}>Сотрудник</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Новая роль" onPress={() => router.push({ pathname: '/profile/role/[key]', params: { key: 'new' } })} style={styles.action}>
          <Icon name="plus" size={16} strokeWidth={2.4}/><Text style={styles.actionText}>Роль</Text>
        </Pressable>
      </View>

      <View style={styles.sectionHead}><Heading>Сотрудники</Heading><Text style={styles.meta}>{data.members.length}</Text></View>
      <View style={styles.list}>
        {data.members.map((member, index) => (
          <Pressable key={member.id} accessibilityRole="button" accessibilityLabel={member.displayName} onPress={() => router.push({ pathname: '/profile/member/[id]', params: { id: member.id } })}
            style={[styles.row, index > 0 && styles.line]}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[styles.title, member.status === 'blocked' && styles.off]}>{member.displayName}</Text>
              <Text style={styles.small} numberOfLines={1}>{member.roles.map(roleName).join(' · ')}</Text>
            </View>
            <Text style={[styles.status, { color: member.status === 'active' ? colors.ok : colors.muted }]}>{member.status === 'active' ? 'активен' : 'заблокирован'}</Text>
            <Icon name="chevronRight" size={18}/>
          </Pressable>
        ))}
      </View>

      <Heading style={{ marginTop: 4 }}>Роли и права</Heading>
      <View style={styles.list}>
        {roles.map((role, index) => (
          <Pressable key={role.key} accessibilityRole="button" accessibilityLabel={role.name} disabled={role.locked}
            onPress={() => router.push({ pathname: '/profile/role/[key]', params: { key: role.key } })} style={[styles.row, index > 0 && styles.line]}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[styles.title, role.archived && styles.off]}>{role.name}</Text>
              <Text style={styles.small}>{[role.archived ? 'архив' : role.system ? 'системная' : 'своя', role.locked ? 'полный доступ' : role.memberCount ? people(role.memberCount) : 'ни у кого нет'].join(' · ')}</Text>
            </View>
            {!role.locked ? <Icon name="chevronRight" size={18}/> : null}
          </Pressable>
        ))}
      </View>
      {owner ? <Text style={styles.hint}>{owner.name}: все права и управление командой. Не меняется.</Text> : null}
    </Screen>
  );
}

const useStyles = makeStyles((colors, scheme) => StyleSheet.create({
  actions: { flexDirection: 'row', gap: 8 },
  action: { height: 44, paddingHorizontal: 16, borderRadius: 22, backgroundColor: colors.surface, flexDirection: 'row', alignItems: 'center', gap: 6, ...cardShadow(scheme) },
  actionMain: { backgroundColor: colors.pill },
  actionText: { fontSize: 14, fontWeight: '700' },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 4 },
  meta: { color: colors.muted, fontSize: 13 },
  list: { borderRadius: radius.l, backgroundColor: colors.surface, paddingHorizontal: space.l, paddingVertical: 4, ...cardShadow(scheme) },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: 60, paddingVertical: 8 },
  line: { borderTopWidth: 1, borderTopColor: colors.line },
  title: { fontSize: 15, fontWeight: '600' },
  off: { color: colors.muted },
  small: { color: colors.muted, fontSize: 12 },
  status: { fontSize: 12, fontWeight: '600' },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 17, paddingHorizontal: 4 }
}));
