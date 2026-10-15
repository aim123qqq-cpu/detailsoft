import { useEffect, useState } from 'react';
import { api } from './api';
import type { TeamMember, TeamRole } from './types';

const roleOptions: Array<{ value: TeamRole; label: string; note: string }> = [
  { value: 'owner', label: 'Владелец', note: 'Команда, настройки и аналитика' },
  { value: 'admin', label: 'Администратор', note: 'Клиенты, записи и заказы' },
  { value: 'intake', label: 'Приёмщик', note: 'Осмотр и черновик сметы' },
  { value: 'master', label: 'Мастер', note: 'Назначенные работы' }
];

const roleLabel = (role: TeamRole) => roleOptions.find((item) => item.value === role)?.label ?? role;

export function TeamScreen({ onBack }: { onBack: () => void }) {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [mode, setMode] = useState<'list' | 'create' | 'edit'>('list');
  const [selectedId, setSelectedId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [roles, setRoles] = useState<TeamRole[]>(['intake']);
  const [accessToken, setAccessToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = async (signal?: AbortSignal) => {
    try {
      const result = await api.listTeam(signal);
      setMembers(result.items);
    } catch (requestError) {
      if ((requestError as Error).name !== 'AbortError') setError((requestError as Error).message);
    } finally { setLoading(false); }
  };

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, []);

  const toggleRole = (role: TeamRole) => {
    setError('');
    setRoles((current) => current.includes(role) ? current.filter((item) => item !== role) : [...current, role]);
  };

  const openCreate = () => {
    setMode('create'); setDisplayName(''); setRoles(['intake']); setAccessToken(''); setError('');
  };

  const openEdit = (member: TeamMember) => {
    setSelectedId(member.id); setDisplayName(member.displayName); setRoles(member.roles); setMode('edit'); setError('');
  };

  const create = async () => {
    setSaving(true); setError('');
    try {
      const result = await api.createTeamMember({ displayName, roles });
      setMembers((current) => [...current, result.member].sort((left, right) => left.displayName.localeCompare(right.displayName, 'ru')));
      setAccessToken(result.accessToken);
    } catch (requestError) { setError((requestError as Error).message); }
    finally { setSaving(false); }
  };

  const update = async (input: { roles?: TeamRole[]; status?: TeamMember['status'] }) => {
    setSaving(true); setError('');
    try {
      const result = await api.updateTeamMember(selectedId, input);
      setMembers((current) => current.map((member) => member.id === result.id ? result : member));
      setRoles(result.roles);
      if (input.status) setMode('list');
    } catch (requestError) { setError((requestError as Error).message); }
    finally { setSaving(false); }
  };

  const selected = members.find((member) => member.id === selectedId);
  const activeCount = members.filter((member) => member.status === 'active').length;

  return <section className="screen team-screen" data-testid="team-screen">
    <button className="details-back" onClick={mode === 'list' ? onBack : () => { setMode('list'); setAccessToken(''); setError(''); }}>← {mode === 'list' ? 'Профиль' : 'Команда'}</button>
    <div className="team-hero">
      <span>Сотрудники центра</span>
      <h2>{mode === 'list' ? 'Команда и роли' : mode === 'create' ? 'Новый сотрудник' : displayName}</h2>
      <p>{mode === 'list' ? 'Доступы действуют только внутри текущего центра.' : 'Один сотрудник может совмещать несколько ролей.'}</p>
    </div>

    {mode === 'list' && <>
      <div className="team-summary"><div><strong>{activeCount}</strong><span>активных</span></div><div><strong>{members.filter((member) => member.roles.includes('owner') && member.status === 'active').length}</strong><span>владельцев</span></div><button data-testid="add-team-member" onClick={openCreate}>+ Добавить</button></div>
      {loading && <div className="workspace-state"><span className="spinner"/> Загружаем команду</div>}
      {!loading && error && !members.length && <div className="workspace-state error-state"><strong>Не удалось загрузить команду</strong><span>{error}</span><button onClick={() => { setLoading(true); setError(''); load(); }}>Повторить</button></div>}
      <div className="team-list">{members.map((member) => <article key={member.id} className={`team-card ${member.status}`} data-testid={`team-member-${member.id}`}>
        <span className="team-avatar">{member.displayName.split(' ').slice(0, 2).map((part) => part[0]).join('')}</span>
        <div><h3>{member.displayName}</h3><p>{member.roles.map(roleLabel).join(' · ')}</p><small>{member.status === 'active' ? '● Доступ активен' : '○ Доступ заблокирован'}</small></div>
        <button aria-label={`Настроить ${member.displayName}`} onClick={() => openEdit(member)}>›</button>
      </article>)}</div>
    </>}

    {mode === 'create' && <div className="team-form">
      {!accessToken && <>
        <label>Имя сотрудника<input aria-label="Имя сотрудника" value={displayName} maxLength={80} placeholder="Например, Мария Орлова" onChange={(event) => setDisplayName(event.target.value)}/></label>
        <RolePicker roles={roles} onToggle={toggleRole}/>
        {error && <p className="form-error">{error}</p>}
        <button className="primary-button" data-testid="create-team-member" disabled={saving || displayName.trim().length < 2 || !roles.length} onClick={create}>{saving ? 'Добавляем…' : 'Добавить сотрудника'}</button>
      </>}
      {accessToken && <div className="access-token-card" role="status" data-testid="team-access-token">
        <span>Сотрудник добавлен</span><h3>Передайте код лично</h3><code>{accessToken}</code>
        <p>Код показывается только сейчас и используется для входа в локальную версию.</p>
        <button className="primary-button" onClick={() => { setMode('list'); setAccessToken(''); }}>Готово</button>
      </div>}
    </div>}

    {mode === 'edit' && selected && <div className="team-form">
      <div className="member-status-line"><span>Статус доступа</span><strong className={selected.status}>{selected.status === 'active' ? 'Активен' : 'Заблокирован'}</strong></div>
      <RolePicker roles={roles} onToggle={toggleRole}/>
      {error && <p className="form-error">{error}</p>}
      <button className="primary-button" data-testid="save-team-member" disabled={saving || !roles.length} onClick={() => update({ roles })}>{saving ? 'Сохраняем…' : 'Сохранить роли'}</button>
      <button className={`team-status-action ${selected.status}`} disabled={saving} onClick={() => update({ status: selected.status === 'active' ? 'blocked' : 'active' })}>{selected.status === 'active' ? 'Заблокировать доступ' : 'Восстановить доступ'}</button>
    </div>}
  </section>;
}

function RolePicker({ roles, onToggle }: { roles: TeamRole[]; onToggle: (role: TeamRole) => void }) {
  return <fieldset className="team-role-picker"><legend>Роли и доступы</legend>{roleOptions.map((role) => <button type="button" key={role.value} aria-pressed={roles.includes(role.value)} className={roles.includes(role.value) ? 'selected' : ''} onClick={() => onToggle(role.value)}><i>{roles.includes(role.value) ? '✓' : '+'}</i><span><strong>{role.label}</strong><small>{role.note}</small></span></button>)}</fieldset>;
}
