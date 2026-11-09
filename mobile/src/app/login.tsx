import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { LEGAL_VERSION, legalLinks } from '@df/legal';
import type { AuthProvider, LoginMembership, LoginRequest, LoginStatus } from '@df/types';
import { ApiError, createApi } from '@/lib/api';
import { LegalChecks, type LegalState } from '@/features/legal-checks';
import { useSession } from '@/lib/session';
import { cardShadow, makeStyles, radius, space, useTheme } from '@/lib/theme';
import { Button, Field, Notice } from '@/ui';
import { FlowHeader, FlowPage, MarkTile, TextLink } from '@/ui/brand';
import { Icon } from '@/ui/icons';
import { Text } from '@/ui/text';

const closedText: Partial<Record<LoginStatus['status'], string>> = {
  CONFIRMED: 'Вход подтверждён. Открываем рабочее место…',
  DENIED: 'Вход отклонён в мессенджере',
  CONSUMED: 'Этот вход уже использован',
  EXPIRED: 'Время на подтверждение истекло'
};

/** Telegram is the main way in, whatever order the server lists them in. */
const telegramFirst = (items: AuthProvider[]) => [...items].sort((left, right) => Number(right.provider === 'telegram') - Number(left.provider === 'telegram'));

function Countdown({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // Every 2 s: Android's UI reader waits for a second of quiet on screen, and a timer ticking each second never gives it.
    const timer = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(timer);
  }, []);
  const left = Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000));
  return <>{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</>;
}

export default function LoginScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { api, server, signIn } = useSession();
  // "signup": a person without a center creates one and becomes its owner.
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  // Which way in is open before a request exists: the list, the email address, the access code.
  const [way, setWay] = useState<'choose' | 'email' | 'code'>('choose');
  const [confirmed, setConfirmed] = useState(false);
  const [centerName, setCenterName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [legal, setLegal] = useState<LegalState>({ terms: false, consent: false });
  const [providers, setProviders] = useState<AuthProvider[] | null>(null);
  const [demo, setDemo] = useState(false);
  // Sign-in by email: a 6-digit code comes by letter and is typed here (no bot to poll).
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [email, setEmail] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [login, setLogin] = useState<LoginRequest | null>(null);
  const [status, setStatus] = useState<LoginStatus['status'] | null>(null);
  const [memberships, setMemberships] = useState<LoginMembership[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState('');
  const opening = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    api.authProviders(controller.signal)
      .then((result) => { setProviders(telegramFirst(result.items)); setDemo(result.demo); setEmailEnabled(result.email === true); })
      .catch((requestError: Error) => { if (requestError.name !== 'AbortError') { setProviders([]); setError(requestError.message); } });
    return () => controller.abort();
  }, [api]);

  const openSession = useCallback(async (current: LoginRequest, tenantId?: string) => {
    if (opening.current) return;
    opening.current = true;
    try {
      const session = await api.openSession(current, tenantId);
      await signIn(session.token);
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.code === 'choose_tenant') {
        setMemberships((requestError.details.memberships as LoginMembership[] | undefined) ?? []);
      } else setError((requestError as Error).message);
    } finally { opening.current = false; }
  }, [api, signIn]);

  // Polls for the whole life of the login request; coming back from the messenger checks at once.
  useEffect(() => {
    if (!login || login.provider === 'email') return;
    const controller = new AbortController();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      clearTimeout(timer);
      if (stopped) return;
      try {
        const next = await api.loginStatus(login, controller.signal);
        if (stopped) return;
        setStatus(next.status);
        if (next.status === 'CONFIRMED') {
          stopped = true;
          // A sign-in by an account no center knows comes back as a sign-up: the person may create their own center.
          if (next.purpose === 'signup') setConfirmed(true);
          else if (next.memberships.length > 1) setMemberships(next.memberships);
          else void openSession(login);
          return;
        }
        if (['DENIED', 'CONSUMED', 'EXPIRED'].includes(next.status)) { stopped = true; return; }
      } catch (requestError) {
        if ((requestError as Error).name === 'AbortError') return;
        setError((requestError as Error).message);
      }
      timer = setTimeout(tick, 1500);
    };
    const subscription = AppState.addEventListener('change', (next) => { if (next === 'active') void tick(); });
    timer = setTimeout(tick, 1500);
    return () => { stopped = true; controller.abort(); clearTimeout(timer); subscription.remove(); };
  }, [login, api, openSession]);

  const start = async (provider: AuthProvider) => {
    setBusy(true); setError(''); setMemberships([]);
    try {
      const created = await api.createLoginRequest(provider.provider, mode);
      setLogin(created);
      setStatus('PENDING');
      if (created.deepLink) void Linking.openURL(created.deepLink).catch(() => {});
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
      const next = await api.confirmEmailLogin(login, emailCode);
      setStatus(next.status);
      if (next.purpose === 'signup') setConfirmed(true);
      else if (next.memberships.length > 1) setMemberships(next.memberships);
      else void openSession(login);
    } catch (requestError) {
      setError((requestError as Error).message);
      if (requestError instanceof ApiError && requestError.code === 'login_closed') setStatus('DENIED');
    } finally { setBusy(false); }
  };

  const createCenter = async () => {
    if (!login) return;
    setBusy(true); setError('');
    try {
      const session = await api.createCenter(login, { centerName: centerName.trim(), ownerName: ownerName.trim(), acceptedLegal: LEGAL_VERSION });
      await signIn(session.token);
    } catch (requestError) { setError((requestError as Error).message); }
    finally { setBusy(false); }
  };
  const reset = () => { setLogin(null); setStatus(null); setError(''); setConfirmed(false); setMemberships([]); };
  const backToWays = () => { reset(); setWay('choose'); setCodeError(''); };

  const signInWithCode = async () => {
    const value = code.trim();
    if (!value) return setCodeError('Введите код доступа');
    setBusy(true); setCodeError('');
    try {
      await createApi(server ?? '', value, () => {}).session();
      await signIn(value);
    } catch (requestError) {
      setCodeError(requestError instanceof ApiError && requestError.status === 401 ? 'Код не подошёл. Попросите новый у владельца центра.' : (requestError as Error).message);
    } finally { setBusy(false); }
  };

  const signup = mode === 'signup';
  const finished = status === 'DENIED' || status === 'EXPIRED' || status === 'CONSUMED';
  const waiting = status === 'PENDING' || status === 'AWAITING_CONFIRMATION';
  const choosing = memberships.length > 1;
  const byEmail = login?.provider === 'email';
  const providerTitle = login ? providers?.find((item) => item.provider === login.provider)?.title ?? login.provider : '';
  const openLegal = (path: string) => void WebBrowser.openBrowserAsync(`${server}${path}`, { toolbarColor: colors.ground, controlsColor: colors.accent });
  const legalLine = (
    // Before anyone signs in: how their data is handled (AppGallery and Google Play ask for it on this screen).
    <Text style={styles.legal}>
      <Text style={styles.legalLink} onPress={() => openLegal(legalLinks.privacy)}>Политика обработки персональных данных</Text>
      {' · '}
      <Text style={styles.legalLink} onPress={() => openLegal(legalLinks.terms)}>Пользовательское соглашение</Text>
    </Text>
  );

  // A new center: its name, the owner's name, the agreement.
  if (login && confirmed) return (
    <FlowPage>
      <FlowHeader title="Новый центр" note="последний шаг" onBack={backToWays}/>
      <View style={styles.gap}/>
      <Text style={styles.h1} accessibilityRole="header">Название центра</Text>
      <Text style={styles.lead}>Как ваша команда называет центр?</Text>
      {login.purpose !== 'signup' && <Text style={styles.lead}>Этот аккаунт ещё не привязан к центру. Создайте свой — или, если вы сотрудник, попросите владельца прислать приглашение из «Профиль → Команда».</Text>}
      {error ? <Notice>{error}</Notice> : null}
      <Field label="Название" required value={centerName} onChangeText={setCenterName} maxLength={120} placeholder="Название детейлинг-центра" testID="center-name"/>
      <Field label="Ваше имя" required value={ownerName} onChangeText={setOwnerName} maxLength={80} autoCapitalize="words" placeholder="Имя Фамилия" testID="owner-name"/>
      <LegalChecks value={legal} onChange={setLegal}/>
      <View style={styles.fill}/>
      <Button title="Создать центр" busy={busy} disabled={centerName.trim().length < 2 || ownerName.trim().length < 2 || !legal.terms || !legal.consent} onPress={createCenter} testID="create-center"/>
      <TextLink title="Вернуться к выбору способа" tone="muted" onPress={backToWays}/>
    </FlowPage>
  );

  // Several centers know this account: which one to open.
  if (login && choosing) return (
    <FlowPage>
      <FlowHeader title="Выберите центр" note={`через ${providerTitle}`} onBack={backToWays}/>
      <View style={styles.gap}/>
      <Text style={styles.h1} accessibilityRole="header">В какой центр{'\n'}войти?</Text>
      {error ? <Notice>{error}</Notice> : null}
      {memberships.map((membership) => (
        <Pressable key={membership.tenant.id} accessibilityRole="button" onPress={() => openSession(login, membership.tenant.id)}
          android_ripple={{ color: 'rgba(127,127,127,.12)' }} style={styles.tenant}>
          <View style={{ flex: 1 }}>
            <Text style={styles.tenantName}>{membership.tenant.name}</Text>
            <Text style={styles.tenantRole}>{membership.member.displayName}</Text>
          </View>
          <Icon name="chevronRight" size={18} color={colors.muted}/>
        </Pressable>
      ))}
    </FlowPage>
  );

  // The code from the letter.
  if (login && byEmail) return (
    <FlowPage>
      <FlowHeader title={signup || login.purpose === 'signup' ? 'Подтвердите почту' : 'Вход по почте'} note={login.email ?? undefined} onBack={backToWays}/>
      <View style={styles.gap}/>
      <Text style={styles.h1} accessibilityRole="header">Введите код{'\n'}из письма</Text>
      <Text style={styles.lead}>Код отправлен на {login.email}. Письмо приходит за минуту — если его нет, загляните в «Спам».</Text>
      {error ? <Notice>{error}</Notice> : null}
      {waiting ? <Field label="Код из письма" required value={emailCode} onChangeText={(value) => setEmailCode(value.replace(/\D/g, ''))} placeholder="000000"
        keyboardType="number-pad" maxLength={6} autoComplete="one-time-code" textContentType="oneTimeCode" returnKeyType="go" onSubmitEditing={confirmEmail}
        style={styles.codeInput} testID="login-email-code"/> : null}
      <Waiting waiting={waiting} finished={finished} status={status} expiresAt={login.expiresAt} label="Код действует ещё"/>
      <View style={styles.fill}/>
      {waiting ? <Button title="Подтвердить" busy={busy} disabled={emailCode.length !== 6} onPress={confirmEmail} testID="login-email-confirm"/>
        : finished ? <Button title="Начать заново" onPress={backToWays}/> : null}
      <TextLink title="Выбрать другой способ" tone="muted" onPress={backToWays}/>
    </FlowPage>
  );

  // The code of a messenger sign-in: compare it with the bot's.
  if (login) return (
    <FlowPage>
      <FlowHeader title={signup || login.purpose === 'signup' ? 'Подтвердите аккаунт' : 'Подтвердите вход'} note={`через ${providerTitle}`} onBack={backToWays}/>
      <View style={styles.gap}/>
      <Text style={styles.caption}>Код этого входа</Text>
      <View style={styles.codeRow} accessible accessibilityLabel={`Код ${login.shortCode.split('').join(' ')}`} testID="login-code">
        {login.shortCode.split('').map((digit, index) => <View key={index} style={styles.codeTile}><Text style={styles.codeDigit}>{digit}</Text></View>)}
      </View>
      <Text style={styles.body}>{finished ? 'Начните вход заново, чтобы получить новый код.'
        : status === 'AWAITING_CONFIRMATION' ? `Откройте сообщение бота в ${providerTitle} и сверьте код. Подтверждайте вход, только если код совпадает.`
        : login.deepLink ? `Откройте бота в ${providerTitle} и нажмите «Старт». Подтверждайте вход, только если код совпадает.`
        : `Отправьте этот код боту в ${providerTitle}. Подтверждайте вход, только если код совпадает.`}</Text>
      {error ? <Notice>{error}</Notice> : null}
      <Waiting waiting={waiting} finished={finished} status={status} expiresAt={login.expiresAt} label="Ожидаем подтверждения · код действует ещё"/>
      <View style={styles.fill}/>
      {login.deepLink && waiting ? <Button title={`Открыть ${providerTitle}`} onPress={() => Linking.openURL(login.deepLink!)}/> : null}
      {finished ? <Button title="Начать заново" onPress={backToWays}/> : null}
      <View style={styles.links}>
        {!finished ? <TextLink title="Начать заново" onPress={backToWays}/> : null}
        <TextLink title="Выбрать другой способ" tone="muted" onPress={backToWays}/>
      </View>
    </FlowPage>
  );

  // An employee's access code from the owner (and the way in for store reviewers).
  if (way === 'code') return (
    <FlowPage>
      <FlowHeader title="Вход сотрудника" note="по коду доступа" onBack={backToWays}/>
      <View style={styles.gap}/>
      <Text style={styles.h1} accessibilityRole="header">Введите код{'\n'}доступа</Text>
      <Text style={styles.lead}>Код выдаёт владелец центра при добавлении сотрудника.</Text>
      <Field label="Код доступа сотрудника" required value={code} onChangeText={setCode} placeholder="df_…" autoCapitalize="none" autoCorrect={false}
        secureTextEntry returnKeyType="go" onSubmitEditing={signInWithCode} error={codeError} testID="access-code"/>
      <View style={styles.fill}/>
      <Button title="Войти по коду" busy={busy} disabled={!code.trim()} onPress={signInWithCode} testID="access-code-submit"/>
      <TextLink title="Назад" tone="muted" onPress={backToWays}/>
    </FlowPage>
  );

  // The email address the code goes to.
  if (way === 'email') return (
    <FlowPage>
      <FlowHeader title={signup ? 'Новый центр' : 'Вход'} note="по почте" onBack={backToWays}/>
      <View style={styles.gap}/>
      <Text style={styles.h1} accessibilityRole="header">Ваша почта</Text>
      <Text style={styles.lead}>Пришлём на неё код из 6 цифр.</Text>
      {error ? <Notice>{error}</Notice> : null}
      <Field label="Почта" required value={email} onChangeText={setEmail} placeholder="name@mail.ru" keyboardType="email-address" autoCapitalize="none"
        autoCorrect={false} autoComplete="email" returnKeyType="send" onSubmitEditing={startEmail} testID="login-email"/>
      <View style={styles.fill}/>
      <Button title="Получить код на почту" busy={busy} disabled={!/^\S+@\S+\.\S+$/.test(email.trim())} onPress={startEmail} testID="login-email-submit"/>
      <TextLink title="Назад" tone="muted" onPress={backToWays}/>
    </FlowPage>
  );

  // With no messenger set up the address is the only way in.
  const emailOnly = emailEnabled && providers?.length === 0;
  return (
    <FlowPage>
      <View style={styles.hero}>
        <MarkTile/>
        {/* A long press on the name points the app at another server: for tests and a center's own machine. */}
        <Pressable onLongPress={() => router.push('/server')} delayLongPress={1500} accessible={false} testID="login-title">
          <Text style={styles.brand} accessibilityRole="header">DetailFlow</Text>
        </Pressable>
        <Text style={styles.tagline}>{signup ? 'Создание детейлинг-центра' : 'Рабочее место детейлинг-центра'}</Text>
      </View>
      <View style={styles.fill}/>
      <Text style={styles.choose}>{signup ? `Подтвердите аккаунт через ${emailEnabled ? 'мессенджер или почту' : 'мессенджер'}, затем назовите центр` : 'Выберите удобный способ входа'}</Text>
      {error ? <Notice>{error}</Notice> : null}
      <View style={[styles.ways, providers === null && styles.waysLoading]}>
        {providers === null ? <Text style={styles.choose}>Загружаем способы входа…</Text> : null}
        {providers?.map((provider, index) => (
          <Button key={provider.provider} title={`Продолжить с ${provider.title}`} tone={index === 0 ? 'primary' : 'raised'} busy={busy} style={styles.wayButton}
            onPress={() => start(provider)} testID={`login-${provider.provider}`}/>
        ))}
        {emailEnabled ? <Button title="Продолжить по почте" tone={emailOnly ? 'primary' : 'raised'} style={styles.wayButton} onPress={() => { setError(''); setWay('email'); }} testID="login-email-open"/> : null}
      </View>
      {!signup ? <View style={styles.links}>
        <TextLink title="Войти по коду доступа" onPress={() => { setError(''); setWay('code'); }} testID="access-code-open"/>
        {demo ? <TextLink title="Демо-режим" tone="muted" onPress={() => signIn('demo-session-token')} testID="login-demo"/> : null}
      </View> : null}
      <View style={styles.newcomer}>
        <Text style={styles.choose}>{signup ? 'Уже есть центр?' : 'Впервые в DetailFlow?'}</Text>
        <Pressable accessibilityRole="button" hitSlop={10} onPress={() => { setMode(signup ? 'login' : 'signup'); setError(''); }} testID="toggle-signup">
          <Text style={styles.accentLink}>{signup ? 'Войти' : 'Создать центр'}</Text>
        </Pressable>
      </View>
      {legalLine}
    </FlowPage>
  );
}

/** «Ожидаем подтверждения» with the time left, or how the request ended. Announced only when the state changes. */
function Waiting({ waiting, finished, status, expiresAt, label }: { waiting: boolean; finished: boolean; status: LoginStatus['status'] | null; expiresAt: string; label: string }) {
  const styles = useStyles();
  const { colors } = useTheme();
  if (!waiting && !status) return null;
  const tone = finished ? colors.sevHi : status === 'CONFIRMED' ? colors.ok : colors.accent;
  return (
    <View style={styles.waiting} accessibilityLiveRegion={waiting ? 'none' : 'polite'}>
      <View style={[styles.halo, { backgroundColor: finished ? colors.carTintHi : colors.tilePeach }]}><View style={[styles.pulse, { backgroundColor: tone }]}/></View>
      <Text style={[styles.waitingText, finished && { color: colors.sevHiText }]}>
        {waiting ? <>{label} <Countdown expiresAt={expiresAt}/></> : status ? closedText[status] : ''}
      </Text>
    </View>
  );
}

const useStyles = makeStyles((colors, scheme) => StyleSheet.create({
  gap: { height: 12 },
  fill: { flexGrow: 1, minHeight: 24 },
  hero: { alignItems: 'center', gap: 18, marginTop: 96 },
  brand: { fontSize: 34, lineHeight: 40, fontWeight: '600', letterSpacing: -1.2, textAlign: 'center' },
  tagline: { fontSize: 15, color: colors.muted, textAlign: 'center', marginTop: -12 },
  choose: { fontSize: 14, color: colors.muted, textAlign: 'center' },
  ways: { gap: space.m },
  waysLoading: { minHeight: 192, justifyContent: 'center' },
  wayButton: { minHeight: 56 },
  links: { flexDirection: 'row', justifyContent: 'center', gap: 12, flexWrap: 'wrap' },
  newcomer: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  accentLink: { fontSize: 14, fontWeight: '700', color: colors.accent },
  h1: { fontSize: 30, lineHeight: 34, fontWeight: '500', letterSpacing: -0.9, paddingHorizontal: 4 },
  lead: { fontSize: 14, lineHeight: 20, color: colors.muted, paddingHorizontal: 4 },
  body: { fontSize: 15, lineHeight: 21, paddingHorizontal: 4 },
  caption: { fontSize: 13, color: colors.muted, paddingHorizontal: 4 },
  codeRow: { flexDirection: 'row', gap: space.s },
  codeTile: { flex: 1, height: 76, borderRadius: 22, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center', ...cardShadow(scheme) },
  codeDigit: { fontSize: 36, fontWeight: '500', fontVariant: ['tabular-nums'] },
  codeInput: { fontSize: 28, letterSpacing: 8, fontWeight: '500', height: 64 },
  waiting: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, paddingHorizontal: space.l, borderRadius: radius.m, backgroundColor: colors.soft },
  halo: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  pulse: { width: 10, height: 10, borderRadius: 5 },
  waitingText: { flex: 1, fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  tenant: { flexDirection: 'row', alignItems: 'center', minHeight: 64, borderRadius: radius.m, backgroundColor: colors.surface, paddingHorizontal: 18, paddingVertical: 12, overflow: 'hidden', ...cardShadow(scheme) },
  tenantName: { fontSize: 16, fontWeight: '600' },
  tenantRole: { color: colors.muted, fontSize: 13, marginTop: 2 },
  legal: { color: colors.muted, fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: 4 },
  legalLink: { color: colors.muted, textDecorationLine: 'underline' }
}));
