import { useEffect, useState } from 'react';
import { api, authSession } from './api';
import { CatalogScreen } from './CatalogScreen';
import { CenterSettingsScreen } from './CenterSettingsScreen';
import { wipeOfflineData } from './offline/store';
import { ProviderIcon } from './LoginScreen';
import { TeamScreen } from './TeamScreen';
import type { SessionContext } from './types';

const roleLabels: Record<string, string> = {
  admin: 'Администратор',
  intake: 'Приёмщик',
  master: 'Мастер',
  qc: 'Контроль качества',
  owner: 'Владелец'
};

const capabilityLabels: Array<[keyof SessionContext['capabilities'], string]> = [
  ['manageCustomers', 'Клиенты и автомобили'],
  ['manageBookings', 'Записи'],
  ['manageIntake', 'Приёмка и черновики смет'],
  ['approveEstimates', 'Согласование смет'],
  ['assignMasters', 'Назначение мастеров'],
  ['performWork', 'Выполнение работ'],
  ['acceptAssignments', 'Исполнитель заказов'],
  ['closeOrders', 'Выдача автомобилей'],
  ['manageCatalog', 'Каталог и цены'],
  ['manageSettings', 'Настройки центра'],
  ['manageTeam', 'Команда и роли'],
  ['viewAnalytics', 'Статистика']
];

function timezoneLabel(timezone: string) {
  return timezone === 'Europe/Moscow' ? 'Москва · UTC+3' : timezone;
}

/** How this person is signed in, in words: the messenger by name when the server knows it. */
function signedInWith(actor: SessionContext['actor']) {
  if (actor.authMethod === 'demo') return 'Демо-доступ';
  if (actor.authMethod === 'access_token') return 'Вы вошли по коду доступа';
  return actor.authProvider === 'max' ? 'Вы вошли через MAX' : actor.authProvider === 'telegram' ? 'Вы вошли через Telegram'
    : actor.authProvider === 'email' ? 'Вы вошли по email' : 'Вы вошли через мессенджер';
}

export function ProfileScreen({ onSignIn, open }: { onSignIn: () => void; open?: 'catalog' | 'team' | 'settings' }) {
  const [signingOut, setSigningOut] = useState(false);
  const [session, setSession] = useState<SessionContext | null>(null);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [showCatalog, setShowCatalog] = useState(open === 'catalog');
  const [showSettings, setShowSettings] = useState(open === 'settings');
  const [showTeam, setShowTeam] = useState(open === 'team');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    api.getSession(controller.signal)
      .then(setSession)
      .catch((requestError: Error) => {
        if (requestError.name !== 'AbortError') setError(requestError.message);
      });
    return () => controller.abort();
  }, [reloadKey]);

  if (!session && !error) return (
    <section className="screen profile-screen profile-state" data-testid="profile-screen" aria-busy="true">
      <span className="spinner" aria-hidden="true"/><strong>Загружаем профиль…</strong>
    </section>
  );

  if (!session) return (
    <section className="screen profile-screen profile-state" data-testid="profile-screen" role="alert">
      <strong>Не удалось открыть профиль</strong><p>{error}</p>
      <button className="secondary-button" onClick={() => setReloadKey((key) => key + 1)}>Повторить</button>
    </section>
  );

  const roleNames = session.actor.roleNames?.length ? session.actor.roleNames : session.actor.roles.map((role) => roleLabels[role] ?? role);
  const grantedCapabilities = capabilityLabels.filter(([capability]) => session.capabilities[capability]);

  if (showCatalog) return <CatalogScreen onBack={() => setShowCatalog(false)}/>;
  if (showSettings) return <CenterSettingsScreen onBack={() => setShowSettings(false)}/>;
  if (showTeam) return <TeamScreen onBack={() => setShowTeam(false)}/>;

  return (
    <section className="screen profile-screen" data-testid="profile-screen">
      <div className="profile-hero">
        <span className="profile-avatar">{session.actor.displayName.slice(0, 1).toLocaleUpperCase('ru-RU')}</span>
        <div><small>Текущий пользователь</small><h2>{session.actor.displayName}</h2><p>{roleNames.join(' · ')}</p></div>
        <i aria-label="Сессия активна"/>
      </div>

      <section className="profile-center-card">
        <span>Рабочий центр</span>
        <h3>{session.tenant.name}</h3>
        <p>Все записи, заказы и статистика показываются только для этого центра.</p>
        <div><span>Статус</span><strong><i/> Активен</strong></div>
      </section>

      <section className="profile-access" aria-label="Роли и доступы">
        <div className="profile-section-heading"><span>Доступы</span><strong>{roleNames.length} {roleNames.length === 1 ? 'роль' : 'роли'}</strong></div>
        <div className="profile-role-list">{roleNames.map((role) => <span key={role}>{role}</span>)}</div>
        <div className="profile-capability-list">
          {grantedCapabilities.map(([capability, label]) => <div key={capability}><i>✓</i><span>{label}</span></div>)}
          {!session.features.qualityControl && <div className="muted"><i>—</i><span>Контроль качества временно отключён</span></div>}
        </div>
        <p>Права вычисляются сервером для текущей сессии и центра.</p>
      </section>

      <section className="profile-settings" aria-label="Параметры центра">
        <h3>Параметры</h3>
        <div><span><i>◷</i><b>Часовой пояс</b></span><strong>{timezoneLabel(session.tenant.timezone)}</strong></div>
        <div><span><i>₽</i><b>Валюта смет</b></span><strong>{session.preferences.currency === 'RUB' ? 'Российский рубль' : session.preferences.currency}</strong></div>
        <div><span><i>RU</i><b>Язык интерфейса</b></span><strong>{session.preferences.locale === 'ru-RU' ? 'Русский' : session.preferences.locale}</strong></div>
      </section>

      {session.capabilities.manageCatalog && <button className="profile-catalog-entry" data-testid="catalog-entry" onClick={() => setShowCatalog(true)}>
        <span><i>₽</i><b>Каталог услуг</b><small>Цены, длительность и доступность</small></span><strong>Открыть →</strong>
      </button>}
      {session.capabilities.manageSettings && <button className="profile-catalog-entry profile-settings-entry" data-testid="center-settings-entry" onClick={() => setShowSettings(true)}>
        <span><i>◷</i><b>График и загрузка</b><small>Рабочие дни, часы и вместимость</small></span><strong>Открыть →</strong>
      </button>}
      {session.capabilities.manageTeam && <button className="profile-catalog-entry profile-team-entry" data-testid="team-entry" onClick={() => setShowTeam(true)}>
        <span><i>👥</i><b>Команда</b><small>Сотрудники, роли и блокировка доступа</small></span><strong>Открыть →</strong>
      </button>}

      <section className="account-card" data-testid="profile-signin" aria-label="Аккаунт">
        <div className="account-head">
          {session.actor.authProvider ? <ProviderIcon provider={session.actor.authProvider}/> : <span className="provider-icon code" aria-hidden="true">{session.actor.authMethod === 'demo' ? 'Д' : '#'}</span>}
          <div>
            <span>Аккаунт</span>
            <strong>{signedInWith(session.actor)}</strong>
          </div>
        </div>
        {session.actor.authMethod === 'demo'
          ? <button className="account-primary" data-testid="sign-in-messenger" onClick={onSignIn}>Войти через мессенджер</button>
          : <div className="account-actions">
              <button className="account-primary" data-testid="sign-out" disabled={signingOut} onClick={async () => {
                setSigningOut(true);
                // A messenger session is revoked on the server; an access code is only forgotten here.
                if (session.actor.authMethod === 'messenger') { try { await api.logout(); } catch { /* the session is dropped locally anyway */ } }
                authSession.clear();
                window.location.reload();
              }}>{signingOut ? 'Выходим…' : 'Выйти'}</button>
              {session.actor.memberId && !confirmDelete && <button className="account-delete" data-testid="delete-account" onClick={() => { setDeleteError(''); setConfirmDelete(true); }}>Удалить аккаунт</button>}
            </div>}
        {session.actor.memberId && confirmDelete && <div className="profile-delete-confirm" data-testid="profile-account" role="alertdialog" aria-labelledby="delete-account-title" aria-describedby="delete-account-text">
          <h3 id="delete-account-title">Удалить аккаунт в «{session.tenant.name}»?</h3>
          <div id="delete-account-text">
            <p>Удалим ваше имя, привязку к Telegram или MAX, коды доступа и все входы. Войти в этот центр снова будет нельзя.</p>
            <p>Заказы, акты и история работ останутся у центра: это его рабочие документы. На этом устройстве удалится сохранённая копия данных.</p>
          </div>
          {deleteError && <p className="inline-error" role="alert">{deleteError}</p>}
          <div className="profile-delete-actions">
            <button className="secondary-button" disabled={deleting} onClick={() => setConfirmDelete(false)}>Отмена</button>
            <button className="danger-button" data-testid="confirm-delete-account" disabled={deleting} onClick={async () => {
              setDeleting(true); setDeleteError('');
              try {
                await api.deleteAccount();
                await wipeOfflineData();
                authSession.clear();
                window.location.reload();
              } catch (requestError) {
                setDeleteError((requestError as Error).message);
                setDeleting(false);
              }
            }}>{deleting ? 'Удаляем…' : 'Удалить навсегда'}</button>
          </div>
        </div>}
      </section>

      <p className="profile-version"><a href="/privacy/" target="_blank" rel="noopener" data-testid="privacy-link">Политика обработки данных</a> · <a href="/terms/" target="_blank" rel="noopener">Соглашение</a> · <a href="/consent/" target="_blank" rel="noopener">Согласие</a> · <a href="/licenses/" target="_blank" rel="noopener">Лицензии</a></p>
    </section>
  );
}
