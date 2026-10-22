import { useEffect, useRef, useState } from 'react';
import { ApiRequestError, api, authSession, demoAuthEnabled } from './api';
import { iosBrowserTab } from './platform';
import { LEGAL_VERSION } from './legal';
import { LegalChecks, type LegalState } from './LegalGate';
import type { AuthProvider, LoginMembership, LoginRequest, LoginStatus } from './types';

const statusText: Record<LoginStatus['status'], string> = {
  PENDING: 'Откройте бота и нажмите «Старт» или отправьте ему код.',
  AWAITING_CONFIRMATION: 'Подтвердите вход кнопкой «Это я, войти» в боте.',
  CONFIRMED: 'Вход подтверждён. Открываем рабочее место…',
  DENIED: 'Вход отклонён в мессенджере.',
  CONSUMED: 'Этот вход уже использован.',
  EXPIRED: 'Время на подтверждение истекло.'
};

export function LoginScreen({ onSignedIn, onCancel }: { onSignedIn: () => void; onCancel?: () => void }) {
  const [providers, setProviders] = useState<AuthProvider[] | null>(null);
  const [login, setLogin] = useState<LoginRequest | null>(null);
  const [status, setStatus] = useState<LoginStatus['status'] | null>(null);
  const [memberships, setMemberships] = useState<LoginMembership[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // "signup": a person without a center creates one and becomes its owner.
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [centerName, setCenterName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [legal, setLegal] = useState<LegalState>({ terms: false, consent: false });
  const opening = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    api.getAuthProviders(controller.signal)
      .then((result) => setProviders(result.items))
      .catch((requestError: Error) => { if (requestError.name !== 'AbortError') { setProviders([]); setError(requestError.message); } });
    return () => controller.abort();
  }, []);

  const openSession = async (current: LoginRequest, tenantId?: string) => {
    if (opening.current) return;
    opening.current = true;
    try {
      const session = await api.openSession(current.id, current.pollSecret, tenantId);
      authSession.save(session.token);
      onSignedIn();
    } catch (requestError) {
      if (requestError instanceof ApiRequestError && requestError.code === 'choose_tenant') {
        setMemberships((requestError.details.memberships as LoginMembership[] | undefined) ?? []);
      } else setError((requestError as Error).message);
    } finally { opening.current = false; }
  };

  // Polls on a timer for the whole life of the login request. Polling must not depend on the
  // status changing: repeated PENDING/AWAITING answers are the normal case while the user is in the bot.
  useEffect(() => {
    if (!login) return;
    const controller = new AbortController();
    let stopped = false;
    let timer = 0;
    const tick = async () => {
      window.clearTimeout(timer);
      if (stopped) return;
      try {
        const next = await api.getLoginStatus(login.id, login.pollSecret, controller.signal);
        if (stopped) return;
        setStatus(next.status);
        if (next.status === 'CONFIRMED') {
          stopped = true;
          // A sign-up goes on to the center's name; a sign-in opens the workplace.
          if (login.purpose === 'signup') return;
          if (next.memberships.length > 1) setMemberships(next.memberships);
          else void openSession(login);
          return;
        }
        if (['DENIED', 'CONSUMED', 'EXPIRED'].includes(next.status)) { stopped = true; return; }
      } catch (requestError) {
        if ((requestError as Error).name === 'AbortError') return;
        setError((requestError as Error).message);
      }
      timer = window.setTimeout(tick, 1500);
    };
    // Coming back from Telegram/MAX to this tab checks immediately instead of waiting for the timer.
    const onVisible = () => { if (document.visibilityState === 'visible') void tick(); };
    document.addEventListener('visibilitychange', onVisible);
    timer = window.setTimeout(tick, 1500);
    return () => {
      stopped = true;
      controller.abort();
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [login]);

  const start = async (provider: AuthProvider) => {
    setBusy(true); setError(''); setMemberships([]);
    try {
      const created = await api.createLoginRequest(provider.provider, mode);
      setLogin(created);
      setStatus('PENDING');
    } catch (requestError) { setError((requestError as Error).message); }
    finally { setBusy(false); }
  };

  const createCenter = async () => {
    if (!login) return;
    setBusy(true); setError('');
    try {
      const session = await api.createCenter(login.id, login.pollSecret, { centerName: centerName.trim(), ownerName: ownerName.trim(), acceptedLegal: LEGAL_VERSION });
      authSession.save(session.token);
      onSignedIn();
    } catch (requestError) { setError((requestError as Error).message); }
    finally { setBusy(false); }
  };

  const signup = mode === 'signup';
  const providerTitle = login ? providers?.find((item) => item.provider === login.provider)?.title ?? login.provider : '';
  const finished = status === 'DENIED' || status === 'EXPIRED' || status === 'CONSUMED';
  const reset = () => { setLogin(null); setStatus(null); setError(''); setMemberships([]); };
  const step = status === 'CONFIRMED' ? 3 : status === 'AWAITING_CONFIRMATION' ? 2 : 1;

  return (
    <section className="screen login-screen" data-testid="login-screen">
      <div className="login-brand">
        <span className="login-logo" aria-hidden="true"><CarMark/></span>
        <span><b>DetailFlow</b><small>CRM детейлинг-центра</small></span>
      </div>

      <div className={`login-layout ${login ? 'in-progress' : ''}`}>
        <div className="login-intro">
          <span className="login-kicker">{signup ? 'Новый центр' : 'Рабочее место'}</span>
          <h1>{signup ? 'Создайте свой центр' : 'Вход для сотрудников'}</h1>
          <p>{signup
            ? 'Подтвердите себя в мессенджере и назовите центр. Вы станете его владельцем и сами пригласите команду.'
            : 'Без паролей и SMS. Подтвердите вход одной кнопкой в мессенджере, к которому вас привязал владелец центра.'}</p>
        </div>
        <div className="login-preview">
          <BotPreview
            code={login?.shortCode ?? 'K7M2PQ'}
            provider={login?.provider ?? providers?.[0]?.provider ?? 'telegram'}
            botName={login?.botName ?? providers?.[0]?.botName ?? null}
          />
        </div>

        <div className="login-card">
          {!login && <>
            <h2>Выберите мессенджер</h2>
            <div className="login-providers">
              {providers === null && <div className="login-loading"><span className="spinner"/> Проверяем доступные способы входа</div>}
              {providers?.map((provider) => (
                <button key={provider.provider} className={`login-provider ${provider.provider}`} data-testid={`login-${provider.provider}`} disabled={busy} onClick={() => start(provider)}>
                  <ProviderIcon provider={provider.provider}/>
                  <span><b>{signup ? 'Продолжить' : 'Войти'} через {provider.title}</b><small>{provider.botName ? `@${provider.botName}` : 'бот центра'}</small></span>
                  <i className="login-provider-arrow" aria-hidden="true">→</i>
                </button>
              ))}
              {providers?.length === 0 && <div className="login-note" role="note">
                <strong>Вход через мессенджер ещё не настроен</strong>
                <span>Администратору сервера нужно указать токен бота в файле .env и перезапустить DetailFlow.</span>
              </div>}
            </div>
            <ol className="login-how" aria-label="Как проходит вход">
              <li><b>1</b><span>Откройте бота по кнопке или отправьте ему код с экрана</span></li>
              <li><b>2</b><span>Сверьте код и нажмите «{signup ? 'Это я, продолжить' : 'Это я, войти'}»</span></li>
              <li><b>3</b><span>{signup ? 'Вернитесь сюда и назовите центр' : 'Вернитесь сюда — рабочее место откроется само'}</span></li>
            </ol>
          </>}

          {login && <div className="login-progress" data-testid="login-progress" aria-live="polite">
            <div className="login-progress-head">
              <ProviderIcon provider={login.provider}/>
              <span><b>{signup ? 'Подтверждение' : 'Вход'} через {providerTitle}</b><small>{login.botName ? `@${login.botName}` : 'бот центра'}</small></span>
              {!finished && status !== 'CONFIRMED' && <Countdown expiresAt={login.expiresAt}/>}
            </div>
            <span className="login-code-label">Код для бота</span>
            <div className="login-code" data-testid="login-code" data-code={login.shortCode} role="img" aria-label={`Код ${login.shortCode.split('').join(' ')}`}>
              {login.shortCode.split('').map((char, index) => <span key={index}>{char}</span>)}
            </div>
            {login.deepLink && !finished && status !== 'CONFIRMED' && <a className="primary-button login-open-bot" href={login.deepLink} target="_blank" rel="noopener noreferrer" data-testid="open-bot">Открыть {login.botName ? `@${login.botName}` : `бота ${providerTitle}`}</a>}
            <ol className={`login-steps ${finished ? 'failed' : ''}`} aria-label="Ход входа">
              {['Бот открыт', 'Подтверждение', signup ? 'Название центра' : 'Вход выполнен'].map((label, index) => {
                const position = index + 1;
                const state = finished ? (position < step ? 'done' : position === step ? 'failed' : '') : position < step || status === 'CONFIRMED' ? 'done' : position === step ? 'current' : '';
                return <li key={label} className={state}><i>{state === 'done' ? '✓' : state === 'failed' ? '!' : position}</i><span>{label}</span></li>;
              })}
            </ol>
            <div className={`login-status ${status ?? ''}`} data-testid="login-status">{signup && status === 'CONFIRMED' ? 'Подтверждено. Осталось назвать центр.'
              : signup && status === 'AWAITING_CONFIRMATION' ? 'Подтвердите кнопкой «Это я, продолжить» в боте.' : status ? statusText[status] : ''}</div>
            {signup && status === 'CONFIRMED' && <div className="login-signup" data-testid="login-signup">
              <label>Название центра<input data-testid="center-name" value={centerName} maxLength={120} placeholder="Например, Детейлинг Север" onChange={(event) => setCenterName(event.target.value)}/></label>
              <label>Ваше имя<input data-testid="owner-name" value={ownerName} maxLength={80} placeholder="Имя Фамилия" onChange={(event) => setOwnerName(event.target.value)}/></label>
              <LegalChecks value={legal} onChange={setLegal}/>
              <button className="primary-button" data-testid="create-center" disabled={busy || centerName.trim().length < 2 || ownerName.trim().length < 2 || !legal.terms || !legal.consent} onClick={createCenter}>{busy ? 'Создаём…' : 'Создать центр'}</button>
            </div>}
            {memberships.length > 1 && <div className="login-tenants" data-testid="login-tenants">
              <strong>Выберите центр</strong>
              {memberships.map((membership) => <button key={membership.tenant.id} onClick={() => openSession(login, membership.tenant.id)}><b>{membership.tenant.name}</b><small>{membership.member.displayName}</small></button>)}
            </div>}
            <p className="login-hint">Бот покажет тот же код. Подтверждайте, только если коды совпадают и вы входите сами.</p>
            {(finished || status === 'PENDING' || status === 'AWAITING_CONFIRMATION') && <button className={finished ? 'primary-button login-retry' : 'login-secondary'} onClick={reset}>{finished ? 'Начать заново' : 'Выбрать другой мессенджер'}</button>}
          </div>}

          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
      </div>

      <footer className="login-footer">
        {!login && <button className="login-secondary" data-testid="toggle-signup" onClick={() => { setMode(signup ? 'login' : 'signup'); setError(''); }}>
          {signup ? 'У меня уже есть центр — войти' : 'Создать свой центр'}
        </button>}
        {!signup && <p><b>Нет доступа?</b> Попросите владельца центра прислать приглашение из раздела «Профиль → Команда» или создайте свой центр.</p>}
        {iosBrowserTab() && <p className="login-install" data-testid="ios-install"><b>Как приложение на iPhone:</b> нажмите «Поделиться» в Safari и выберите «На экран „Домой“». DetailFlow откроется на весь экран и будет работать без сети.</p>}
        {onCancel && demoAuthEnabled && <button className="login-demo" data-testid="login-cancel" onClick={onCancel}>Продолжить в демо-режиме</button>}
      </footer>
    </section>
  );
}

function Countdown({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const left = Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000));
  return <span className={`login-countdown ${left < 60 ? 'soon' : ''}`} aria-label={`Код действует ещё ${Math.floor(left / 60)} мин ${left % 60} с`}>
    {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
  </span>;
}

export function ProviderIcon({ provider }: { provider: AuthProvider['provider'] }) {
  return provider === 'telegram'
    ? <span className="provider-icon telegram" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M20.7 4.3 3.6 10.9c-1.2.5-1.2 1.1-.2 1.4l4.4 1.4 1.7 5.2c.2.6.1.8.7.8.5 0 .7-.2 1-.5l2.1-2 4.4 3.2c.8.4 1.4.2 1.6-.8l2.9-13.6c.3-1.2-.4-1.7-1.5-1.3Zm-3 3.3-8.2 7.4-.3 3.3-1.4-4.6 9.4-6.4c.4-.3.8-.1.5.3Z"/></svg></span>
    : <span className="provider-icon max" aria-hidden="true">M</span>;
}

function CarMark() {
  return <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M4 15v-4l2-5h12l2 5v4"/><path d="M4 13h16M7 13v2m10-2v2M6 18h1m10 0h1"/></svg>;
}

/** A static preview of the bot message, so the employee knows what to expect before opening the messenger. */
function BotPreview({ code, provider, botName }: { code: string; provider: AuthProvider['provider']; botName: string | null }) {
  return <figure className={`bot-preview ${provider}`} aria-label="Так выглядит сообщение бота">
    <div className="bot-preview-head"><ProviderIcon provider={provider}/><span><b>{botName ? `@${botName}` : 'Бот центра'}</b><small>бот DetailFlow</small></span></div>
    <div className="bot-preview-bubble">
      <b>Вход в DetailFlow</b>
      <span>Код на экране входа: <code>{code}</code></span>
      <small>Подтверждайте, только если код совпадает.</small>
    </div>
    <div className="bot-preview-buttons"><span>Это я, войти</span><span>Отклонить</span></div>
    <figcaption>Так будет выглядеть сообщение бота</figcaption>
  </figure>;
}
