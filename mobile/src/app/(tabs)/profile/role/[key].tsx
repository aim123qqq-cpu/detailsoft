import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { CenterRole, Permission } from '@df/types';
import { useSession } from '@/lib/session';
import { cardShadow, makeStyles, radius, space } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Body, Button, Field, Heading, Loading, Notice, Screen } from '@/ui';
import { FlowHeader } from '@/ui/brand';
import { DOCK_SPACE, Dock } from '@/ui/sheet';
import { Text } from '@/ui/text';
import { Toggle } from '@/ui/toggle';

/** A role: its name (own roles only) and the permissions it gives. `new` creates one. */
export default function RoleScreen() {
  const { key } = useLocalSearchParams<{ key: string }>();
  const { api } = useSession();
  const insets = useSafeAreaInsets();
  const { data, error, reload } = useResource(useCallback((signal: AbortSignal) => api.roles(signal), [api]));
  if (!data && !error) return <Loading label="Загружаем роли…"/>;
  const role = key === 'new' ? null : data?.items.find((item) => item.key === key) ?? null;
  if (!data || role?.locked) return (
    <Screen contentStyle={{ paddingTop: insets.top + 18, gap: 14 }}>
      <FlowHeader title="Роль"/>
      {data ? <Body muted>Роль владельца даёт полный доступ и не меняется.</Body> : <><Notice>{error}</Notice><Button title="Повторить" tone="secondary" onPress={reload}/></>}
    </Screen>
  );
  return <RoleForm key={key} role={role} permissions={data.permissions}/>;
}

function RoleForm({ role, permissions }: { role: CenterRole | null; permissions: Permission[] }) {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const { api } = useSession();
  const [name, setName] = useState(role?.name ?? '');
  const [picked, setPicked] = useState(role?.permissions ?? []);
  const [busy, setBusy] = useState<'save' | 'archive' | null>(null);
  const [error, setError] = useState('');
  const toggle = (key: string) => setPicked((list) => list.includes(key) ? list.filter((item) => item !== key) : [...list, key]);

  const run = async (kind: 'save' | 'archive', action: () => Promise<unknown>) => {
    setBusy(kind); setError('');
    try { await action(); void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); router.back(); }
    catch (failure) { setError((failure as Error).message); setBusy(null); }
  };
  const save = () => run('save', () => role
    ? api.updateRole(role.key, role.system ? { permissions: picked } : { name: name.trim(), permissions: picked })
    : api.createRole({ name: name.trim(), permissions: picked }));
  const missing = [name.trim().length < 2 && 'название', !picked.length && 'хотя бы одно право'].filter(Boolean).join(' и ');

  return (
    <View style={styles.root}>
      <Screen contentStyle={{ paddingTop: insets.top + 18, gap: 14, paddingBottom: DOCK_SPACE + 50 + insets.bottom }}>
        <FlowHeader title={role ? 'Роль' : 'Новая роль'} note={role ? (role.archived ? 'в архиве' : role.system ? 'системная' : 'своя') : undefined}/>
        {role?.system ? <View style={{ gap: 4, paddingHorizontal: 4 }}>
          <Text style={styles.name}>{role.name}</Text>
          <Text style={styles.small}>Системная роль: название не меняется, права — можно.</Text>
        </View> : <Field label="Название роли" required value={name} onChangeText={setName} maxLength={40} placeholder="Например, Старший мастер"/>}

        <View style={styles.sectionHead}><Heading>Что может эта роль</Heading><Text style={styles.meta}>{picked.length} из {permissions.length}</Text></View>
        <View style={styles.list}>
          {permissions.map((permission, index) => {
            const on = picked.includes(permission.key);
            return (
              <Pressable key={permission.key} accessibilityRole="switch" accessibilityState={{ checked: on }} accessibilityLabel={permission.title}
                onPress={() => toggle(permission.key)} style={[styles.row, index > 0 && styles.line]}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.title}>{permission.title}</Text>
                  {permission.note ? <Text style={styles.small}>{permission.note}</Text> : null}
                </View>
                <Toggle value={on} onValueChange={() => toggle(permission.key)}/>
              </Pressable>
            );
          })}
        </View>
        {error ? <Notice>{error}</Notice> : null}
        {role && !role.system ? (
          <Pressable accessibilityRole="button" disabled={busy !== null} onPress={() => void run('archive', () => api.setRoleArchived(role.key, !role.archived))} style={styles.archive} hitSlop={6}>
            <Text style={styles.archiveText}>{busy === 'archive' ? 'Сохраняем…' : role.archived ? 'Вернуть из архива' : 'В архив'}</Text>
          </Pressable>
        ) : null}
      </Screen>
      <Dock>
        <View style={{ flex: 1, gap: 10 }}>
          {missing ? <Text style={styles.warning}>Осталось указать: {missing}</Text>
            : role ? <Text style={styles.small}>Изменения сразу действуют для всех сотрудников с этой ролью ({role.memberCount})</Text> : null}
          <Button title={role ? 'Сохранить роль' : 'Создать роль'} busy={busy === 'save'} disabled={busy !== null || Boolean(missing)} onPress={() => void save()}/>
        </View>
      </Dock>
    </View>
  );
}

const useStyles = makeStyles((colors, scheme) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ground },
  name: { fontSize: 30, lineHeight: 36, fontWeight: '500', letterSpacing: -0.8 },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 4 },
  meta: { color: colors.muted, fontSize: 13 },
  list: { borderRadius: radius.l, backgroundColor: colors.surface, paddingHorizontal: space.l, paddingVertical: 4, ...cardShadow(scheme) },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: 56, paddingVertical: 8 },
  line: { borderTopWidth: 1, borderTopColor: colors.line },
  title: { fontSize: 15, fontWeight: '600' },
  small: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  archive: { alignSelf: 'center', padding: 8 },
  archiveText: { fontSize: 14, fontWeight: '700' },
  warning: { color: colors.warnText, fontSize: 12, fontWeight: '600' }
}));
