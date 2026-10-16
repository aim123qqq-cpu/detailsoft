import { useEffect, useState } from 'react';
import { api } from './api';
import { pluralRu } from './format';
import type { CenterRole, Permission } from './types';

type Editing = { role: CenterRole | null };

/** "Команда → Роли": the owner creates roles and ticks their permissions. */
export function RolesPanel({ onChanged }: { onChanged: () => void }) {
  const [roles, setRoles] = useState<CenterRole[]>([]);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Editing | null>(null);

  const load = async (signal?: AbortSignal) => {
    try {
      const result = await api.listRoles({ includeArchived: true }, signal);
      setRoles(result.items); setPermissions(result.permissions); setError('');
    } catch (requestError) {
      if ((requestError as Error).name !== 'AbortError') setError((requestError as Error).message);
    } finally { setLoading(false); }
  };
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, []);

  const saved = (role: CenterRole) => {
    setRoles((current) => current.some((item) => item.key === role.key) ? current.map((item) => item.key === role.key ? role : item) : [...current, role]);
    setEditing(null);
    onChanged();
  };

  if (editing) return <RoleEditor role={editing.role} permissions={permissions} onCancel={() => setEditing(null)} onSaved={saved}/>;

  const titleOf = (key: string) => permissions.find((permission) => permission.key === key)?.title ?? key;
  const active = roles.filter((role) => !role.archived);
  const archived = roles.filter((role) => role.archived);
  const card = (role: CenterRole) => <article key={role.key} className={`role-card ${role.archived ? 'archived' : ''}`} data-testid={`role-card-${role.key}`}>
    <div className="role-card-head">
      <h3>{role.name}</h3>
      <i>{role.archived ? 'Архив' : role.locked ? 'Полный доступ' : role.system ? 'Системная' : 'Своя'}</i>
    </div>
    <p>{role.locked ? 'Все права и управление командой. Не меняется.' : role.permissions.map(titleOf).join(' · ')}</p>
    <div className="role-card-foot">
      <small>{role.memberCount ? `${role.memberCount} ${pluralRu(role.memberCount, 'сотрудник', 'сотрудника', 'сотрудников')}` : 'Ни у кого нет'}</small>
      {!role.locked && <button data-testid={`edit-role-${role.key}`} onClick={() => setEditing({ role })}>Настроить</button>}
    </div>
  </article>;

  return <div className="roles-panel" data-testid="roles-panel">
    <div className="team-summary roles-summary"><div><strong>{active.length}</strong><span>{pluralRu(active.length, 'роль', 'роли', 'ролей')} в центре</span></div><div><strong>{permissions.length}</strong><span>прав на выбор</span></div><button data-testid="create-role" onClick={() => setEditing({ role: null })}>+ Роль</button></div>
    {loading && <div className="workspace-state"><span className="spinner"/> Загружаем роли</div>}
    {error && <div className="workspace-state error-state"><strong>Не удалось загрузить роли</strong><span>{error}</span><button onClick={() => { setLoading(true); load(); }}>Повторить</button></div>}
    <div className="team-list">{active.map(card)}</div>
    {archived.length > 0 && <details className="roles-archive"><summary>Архив · {archived.length}</summary><div className="team-list">{archived.map(card)}</div></details>}
  </div>;
}

function RoleEditor({ role, permissions, onCancel, onSaved }: { role: CenterRole | null; permissions: Permission[]; onCancel: () => void; onSaved: (role: CenterRole) => void }) {
  const [name, setName] = useState(role?.name ?? '');
  const [selected, setSelected] = useState<string[]>(role?.permissions ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const toggle = (key: string) => setSelected((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  const valid = name.trim().length >= 2 && selected.length > 0;

  const run = async (action: () => Promise<CenterRole>) => {
    setSaving(true); setError('');
    try { onSaved(await action()); } catch (requestError) { setError((requestError as Error).message); } finally { setSaving(false); }
  };
  const save = () => run(() => role
    ? api.updateRole(role.key, role.system ? { permissions: selected } : { name: name.trim(), permissions: selected })
    : api.createRole({ name: name.trim(), permissions: selected }));

  return <div className="team-form role-editor" data-testid="role-editor">
    <button className="details-back" onClick={onCancel}>← Роли</button>
    {role?.system
      ? <div className="member-status-line"><span>Системная роль</span><strong className="active">{role.name}</strong></div>
      : <label>Название роли<input aria-label="Название роли" data-testid="role-name" value={name} maxLength={40} placeholder="Например, Старший мастер" onChange={(event) => setName(event.target.value)}/></label>}
    <fieldset className="team-role-picker" data-testid="role-permissions"><legend>Что может эта роль</legend>
      {permissions.map((permission) => <button type="button" key={permission.key} data-testid={`permission-${permission.key}`} aria-pressed={selected.includes(permission.key)} className={selected.includes(permission.key) ? 'selected' : ''} onClick={() => toggle(permission.key)}>
        <i>{selected.includes(permission.key) ? '✓' : '+'}</i><span><strong>{permission.title}</strong><small>{permission.note}</small></span>
      </button>)}
    </fieldset>
    {role && role.memberCount > 0 && <p className="role-editor-note">Изменения сразу действуют для {role.memberCount} {pluralRu(role.memberCount, 'сотрудника', 'сотрудников', 'сотрудников')} с этой ролью.</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <button className="primary-button" data-testid="save-role" disabled={saving || !valid} onClick={save}>{saving ? 'Сохраняем…' : role ? 'Сохранить роль' : 'Создать роль'}</button>
    {role && !role.system && <button className="team-status-action active" data-testid="archive-role" disabled={saving}
      onClick={() => run(() => api.setRoleArchived(role.key, !role.archived))}>{role.archived ? 'Вернуть из архива' : 'В архив'}</button>}
  </div>;
}
