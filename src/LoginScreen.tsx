import { useEffect, useRef, useState } from 'react';
import { ApiRequestError, api, authSession, demoAuthEnabled } from './api';
import { iosBrowserTab } from './platform';
import { LEGAL_VERSION } from './legal';
import { LegalChecks, type LegalState } from './LegalGate';
import type { AuthProvider, LoginMembership, LoginRequest, LoginStatus, SignInProvider } from './types';

const EMAIL_SHAPE = /^\S+@\S+\.\S+$/;

const closedText: Partial<Record<LoginStatus['status'], string>> = {
  CONFIRMED: 'Вход подтверждён. Открываем рабочее место…',
  DENIED: 'Вход отклонён в мессенджере.',
  CONSUMED: 'Этот вход уже использован.',
  EXPIRED: 'Время на подтверждение истекло.'
};

/** Telegram is the main way in, whatever order the server lists them in. */
const telegramFirst = (items: AuthProvider[]) => [...items].sort((left, right) => Number(right.provider === 'telegram') - Number(left.provider === 'telegram'));

export function LoginScreen({ onSignedIn, onCancel }: { onSignedIn: () => void; onCancel?: () => void }) {
  const [providers, setProviders] = useState<AuthProvider[] | null>(null);
  const [login, setLogin] = useState<LoginRequest | null>(null);
  const [status, setStatus] = useState<LoginStatus['status'] | null>(null);
  const [memberships, setMemberships] = useState<LoginMembership[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // "signup": a person without a center creates one and becomes its owner.
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  // Pressed «Войти», but no center knows the account: the sign-in went on as creating a center.
  const [unlinked, setUnlinked] = useState(false);
  const [centerName, setCenterName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [legal, setLegal] = useState<LegalState>({ terms: false, consent: false });
  // Sign-in by email: a 6-digit code comes by letter and is typed here (no bot to poll).
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const opening = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    api.getAuthProviders(controller.signal)
      .then((result) => { setProviders(telegramFirst(result.items)); setEmailEnabled(result.email === true); })
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
    if (!login || login.provider === 'email') return;
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
          // A sign-up goes on to the center's name; a sign-in opens the workplace. A sign-in by an account
          // no center knows comes back as a sign-up: the person may create their own center.
          if (next.purpose === 'signup') { becomeSignup(login); return; }
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

  const startEmail = async () => {
    setBusy(true); setError(''); setMemberships([]); setEmailCode('');
    try {
      setLogin(await api.createEmailLogin(email.trim(), mode));
      setStatus('AWAITING_CONFIRMATION');
    } catch (requestError) { setError((requestError as Error).message); }
    finally { setBusy(false); }
  };

  // The code from the letter confirms the request; then it goes on like a confirmation in a bot.
  const confirmEmail = async () => {
    if (!login) return;
    setBusy(true); setError('');
    try {
      const next = await api.confirmEmailLogin(login.id, login.pollSecret, emailCode);
      setStatus(next.status);
      if (next.purpose === 'signup') becomeSignup(login);
      else {
        if (next.memberships.length > 1) setMemberships(next.memberships);
        else void openSession(login);
      }
    } catch (requestError) {
      setError((requestError as Error).message);
      if (requestError instanceof ApiRequestError && requestError.code === 'login_closed') setStatus('DENIED');
    } finally { setBusy(false); }
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

  function becomeSignup(started: LoginRequest) {
    if (started.purpose !== 'signup') setUnlinked(true);
    setMode('signup');
  }

  const signup = mode === 'signup';
  const byEmail = login?.provider === 'email';
  const providerTitle = login ? providers?.find((item) => item.provider === login.provider)?.title ?? login.provider : '';
  const finished = status === 'DENIED' || status === 'EXPIRED' || status === 'CONSUMED';
  const waiting = status === 'PENDING' || status === 'AWAITING_CONFIRMATION';
  const naming = signup && status === 'CONFIRMED';
  const choosing = memberships.length > 1;
  const reset = () => { setLogin(null); setStatus(null); setError(''); setMemberships([]); if (unlinked) { setUnlinked(false); setMode('login'); } };
  // With no messenger set up the address is the only way in: no need to ask for it twice.
  const emailShown = emailEnabled && (emailOpen || providers?.length === 0);

  const confirmIntro = byEmail ? `Код отправлен на ${login?.email}. Письмо приходит за минуту — если его нет, загляните в «Спам».`
    : finished ? 'Начните вход заново, чтобы получить новый код.'
    : status === 'AWAITING_CONFIRMATION' ? `Откройте сообщение бота в ${providerTitle} и сверьте код.`
    : login?.deepLink ? `Откройте бота в ${providerTitle} и нажмите «Старт».` : `Отправьте этот код боту в ${providerTitle}.`;

  return (
    <section className="auth-screen" data-testid="login-screen">
      <div className="auth-brand"><span aria-hidden="true"><CarMark/></span><b>DetailFlow</b></div>

      {!login && <>
        <div className="auth-main">
          <h1>{signup ? 'Создать центр' : 'Войти в центр'}</h1>
          <p className="auth-intro">{signup
            ? `Подтвердите аккаунт через ${emailEnabled ? 'мессенджер или почту' : 'мессенджер'}. Затем назовите центр.`
            : 'Выберите удобный способ входа.'}</p>
          {/* The ways in take their place at once, so the title does not jump when they arrive. */}
          <div className={`auth-actions ${providers === null ? 'loading' : ''}`}>
            {providers === null && <div className="login-loading"><span className="spinner"/> Проверяем способы входа</div>}
            {providers?.map((provider, index) => (
              <button key={provider.provider} className={`auth-action ${index === 0 ? 'primary' : 'secondary'}`} data-testid={`login-${provider.provider}`} disabled={busy} onClick={() => start(provider)}>
                <span>Продолжить с {provider.title}</span><i aria-hidden="true">↗</i>
              </button>
            ))}
            {providers?.length === 0 && !emailEnabled && <div className="login-note" role="note">
              <strong>Вход через мессенджер ещё не настроен</strong>
              <span>Администратору сервера нужно указать токен бота в файле .env и перезапустить DetailFlow.</span>
            </div>}
          </div>
          {emailEnabled && !emailShown && <button className="auth-text-action" data-testid="login-email-open" onClick={() => setEmailOpen(true)}>{signup ? 'Продолжить по почте' : 'Войти по почте'}</button>}
          {emailShown && <form className="auth-form" onSubmit={(event) => { event.preventDefault(); if (EMAIL_SHAPE.test(email.trim())) void startEmail(); }}>
            <label className="auth-field">Почта<input type="email" data-testid="login-email" value={email} autoComplete="email" placeholder="name@mail.ru" onChange={(event) => setEmail(event.target.value)}/></label>
            <button className="auth-action secondary" data-testid="login-email-submit" disabled={busy || !EMAIL_SHAPE.test(email.trim())}><span>{signup ? 'Продолжить с почтой' : 'Получить код на почту'}</span><i aria-hidden="true">→</i></button>
          </form>}
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <footer className="auth-foot">
          <p>{signup ? 'Уже есть центр?' : 'Впервые в DetailFlow?'} <button data-testid="toggle-signup" onClick={() => { setMode(signup ? 'login' : 'signup'); setError(''); }}>{signup ? 'Войти' : 'Создать центр'}</button></p>
          <small>{signup ? 'Если вас пригласили в команду, используйте вход.' : 'Сотруднику понадобится приглашение владельца.'}</small>
          {iosBrowserTab() && <small data-testid="ios-install"><b>Как приложение на iPhone:</b> нажмите «Поделиться» в Safari и выберите «На экран „Домой“». DetailFlow откроется на весь экран и будет работать без сети.</small>}
          {onCancel && demoAuthEnabled && <button className="auth-text-action" data-testid="login-cancel" onClick={onCancel}>Продолжить в демо-режиме</button>}
        </footer>
      </>}

      {login && !naming && <>
        <div className="auth-main" data-testid="login-progress">
          <button className="auth-back" onClick={reset}><span aria-hidden="true">←</span>Назад</button>
          <h1>{choosing ? 'Выберите центр' : byEmail ? 'Введите код из письма' : signup ? 'Подтвердите аккаунт' : 'Подтвердите вход'}</h1>
          {!choosing && <p className="auth-intro">{confirmIntro}</p>}
          {!byEmail && !choosing && <div className="auth-code-block">
            <span>Код этого входа</span>
            <strong data-testid="login-code" data-code={login.shortCode} role="img" aria-label={`Код ${login.shortCode.split('').join(' ')}`}>{login.shortCode}</strong>
          </div>}
          {byEmail && waiting && <form className="auth-form" onSubmit={(event) => { event.preventDefault(); if (emailCode.length === 6) void confirmEmail(); }}>
            <label className="auth-field">Код из письма<input data-testid="login-email-code" value={emailCode} inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="000000"
              onChange={(event) => setEmailCode(event.target.value.replace(/\D/g, ''))}/></label>
            <button className="auth-action primary" data-testid="login-email-confirm" disabled={busy || emailCode.length !== 6}><span>Подтвердить</span><i aria-hidden="true">→</i></button>
          </form>}
          {/* Announced only when the state changes: a screen reader must not read the timer out every second. */}
          {!choosing && <div className={`auth-status ${status ?? ''}`} data-testid="login-status" aria-live={waiting ? 'off' : 'polite'}>
            <i aria-hidden="true"/>
            {waiting ? <span>{byEmail ? 'Код действует' : 'Ожидаем подтверждения'} · <Countdown expiresAt={login.expiresAt}/></span> : <span>{status ? closedText[status] : ''}</span>}
          </div>}
          {login.deepLink && waiting && <div className="auth-actions"><a className="auth-action primary" href={login.deepLink} target="_blank" rel="noopener noreferrer" data-testid="open-bot"><span>Открыть {providerTitle}</span><i aria-hidden="true">↗</i></a></div>}
          {!byEmail && waiting && <p className="auth-hint">Подтверждайте вход, только если код совпадает.</p>}
          {choosing && <div className="auth-tenants" data-testid="login-tenants">
            {memberships.map((membership) => <button key={membership.tenant.id} onClick={() => openSession(login, membership.tenant.id)}><b>{membership.tenant.name}</b><small>{membership.member.displayName}</small></button>)}
          </div>}
          {error && <p className="form-error" role="alert">{error}</p>}
          {finished && <div className="auth-actions"><button className="auth-action primary" onClick={reset}><span>Начать заново</span><i aria-hidden="true">→</i></button></div>}
        </div>
        <footer className="auth-foot plain"><button className="auth-text-action" onClick={reset}>Выбрать другой способ</button></footer>
      </>}

      {login && naming && <>
        <div className="auth-main" data-testid="login-signup">
          <h1>Название центра</h1>
          <p className="auth-intro">Как ваша команда называет центр?</p>
          {unlinked && <p className="auth-hint" data-testid="login-unlinked">Этот аккаунт ещё не привязан к центру. Создайте свой — или, если вы сотрудник, попросите владельца прислать приглашение из «Профиль → Команда».</p>}
          <div className="auth-form">
            <label className="auth-field">Название<input data-testid="center-name" value={centerName} maxLength={120} autoComplete="organization" placeholder="Название детейлинг-центра" onChange={(event) => setCenterName(event.target.value)}/></label>
            <label className="auth-field">Ваше имя<input data-testid="owner-name" value={ownerName} maxLength={80} autoComplete="name" placeholder="Имя Фамилия" onChange={(event) => setOwnerName(event.target.value)}/></label>
            <LegalChecks value={legal} onChange={setLegal}/>
            <button className="auth-action primary" data-testid="create-center" disabled={busy || centerName.trim().length < 2 || ownerName.trim().length < 2 || !legal.terms || !legal.consent} onClick={createCenter}><span>{busy ? 'Создаём…' : 'Создать центр'}</span><i aria-hidden="true">→</i></button>
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <footer className="auth-foot"><button className="auth-text-action" onClick={reset}>Вернуться к выбору способа</button></footer>
      </>}
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
  return <span aria-label={`Код действует ещё ${Math.floor(left / 60)} мин ${left % 60} с`}>{String(Math.floor(left / 60)).padStart(2, '0')}:{String(left % 60).padStart(2, '0')}</span>;
}

export function ProviderIcon({ provider }: { provider: SignInProvider }) {
  if (provider === 'email') return <span className="provider-icon email" aria-hidden="true">@</span>;
  return provider === 'telegram'
    ? <span className="provider-icon telegram" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M20.7 4.3 3.6 10.9c-1.2.5-1.2 1.1-.2 1.4l4.4 1.4 1.7 5.2c.2.6.1.8.7.8.5 0 .7-.2 1-.5l2.1-2 4.4 3.2c.8.4 1.4.2 1.6-.8l2.9-13.6c.3-1.2-.4-1.7-1.5-1.3Zm-3 3.3-8.2 7.4-.3 3.3-1.4-4.6 9.4-6.4c.4-.3.8-.1.5.3Z"/></svg></span>
    : <span className="provider-icon max" aria-hidden="true">M</span>;
}

function CarMark() {
  return <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M4 15v-4l2-5h12l2 5v4"/><path d="M4 13h16M7 13v2m10-2v2M6 18h1m10 0h1"/></svg>;
}
