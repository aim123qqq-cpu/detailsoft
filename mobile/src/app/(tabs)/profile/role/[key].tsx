import { useCallback, useState } from 'react';
import * as Haptics from 'expo-haptics';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import type { CenterRole, Permission } from '@df/types';
import { PickList } from '@/features/pick-list';
import { useSession } from '@/lib/session';
import { useResource } from '@/lib/use-resource';
import { Body, Button, Field, Label, Loading, Notice, Screen } from '@/ui';

/** A role: its name (own roles only) and the permissions it gives. `new` creates one. */
export default function RoleScreen() {
  const { key } = useLocalSearchParams<{ key: string }>();
  const { api } = useSession();
  const { data, error, reload } = useResource(useCallback((signal: AbortSignal) => api.roles(signal), [api]));
  if (!data && !error) return <Loading label="Загружаем роли…"/>;
  if (!data) return <Screen><Notice>{error}</Notice><Button title="Повторить" tone="secondary" onPress={reload}/></Screen>;
  const role = key === 'new' ? null : data.items.find((item) => item.key === key) ?? null;
  if (role?.locked) return <Screen><Body muted>Роль владельца даёт полный доступ и не меняется.</Body></Screen>;
  return <RoleForm key={key} role={role} permissions={data.permissions}/>;
}

function RoleForm({ role, permissions }: { role: CenterRole | null; permissions: Permission[] }) {
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

  return (
    <Screen>
      <Stack.Screen options={{ title: role ? role.name : 'Новая роль' }}/>
      {role?.system ? <Body muted>Системная роль: название не меняется, права — можно.</Body>
        : <Field label="Название роли" value={name} onChangeText={setName} maxLength={40} placeholder="Например, Старший мастер"/>}
      <Label>Что может эта роль</Label>
      <PickList options={permissions.map((permission) => ({ key: permission.key, title: permission.title, note: permission.note }))} selected={picked} onToggle={toggle}/>
      {role && role.memberCount > 0 ? <Notice tone="info">Изменения сразу действуют для всех сотрудников с этой ролью ({role.memberCount}).</Notice> : null}
      {error ? <Notice>{error}</Notice> : null}
      <Button title={role ? 'Сохранить роль' : 'Создать роль'} busy={busy === 'save'} disabled={busy !== null || name.trim().length < 2 || !picked.length} onPress={() => void save()}/>
      {role && !role.system ? <Button title={role.archived ? 'Вернуть из архива' : 'В архив'} tone="quiet" busy={busy === 'archive'} disabled={busy !== null}
        onPress={() => void run('archive', () => api.setRoleArchived(role.key, !role.archived))}/> : null}
    </Screen>
  );
}
