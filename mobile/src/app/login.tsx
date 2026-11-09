import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Image, Linking, Pressable, StyleSheet, View, type TextInputProps } from 'react-native';
import { Text, TextInput } from '@/ui/text';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { LEGAL_VERSION, legalLinks } from '@df/legal';
import type { AuthProvider, LoginMembership, LoginRequest, LoginStatus } from '@df/types';
import { ApiError, createApi } from '@/lib/api';
import { LegalChecks, type LegalState } from '@/features/legal-checks';
import { useSession } from '@/lib/session';
import { makeStyles, useTheme } from '@/lib/theme';
import { Notice, Screen } from '@/ui';

const closedText: Partial<Record<LoginStatus['status'], string>> = {
  CONFIRMED: 'Вход подтверждён. Открываем рабочее место…',
  DENIED: 'Вход отклонён в мессенджере.',
  CONSUMED: 'Этот вход уже использован.',
  EXPIRED: 'Время на подтверждение истекло.'
};

/** Telegram is the main way in, whatever order the server lists them in. */
const telegramFirst = (items: AuthProvider[]) => [...items].sort((left, right) => Number(right.provider === 'telegram') - Number(left.provider === 'telegram'));

/** A wide action of these screens: the main one is filled, the others outlined. */
function Action({ title, mark = '→', tone = 'primary', busy, disabled, onPress, testID }: { title: string; mark?: string; tone?: 'primary' | 'secondary'; busy?: boolean; disabled?: boolean; onPress: () => void; testID?: string }) {
  const styles = useStyles();
  const primary = tone === 'primary';
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: Boolean(disabled || busy), busy: Boolean(busy) }} disabled={disabled || busy} onPress={onPress} testID={testID}
      android_ripple={{ color: primary ? 'rgba(20,23,25,.14)' : 'rgba(255,255,255,.08)' }}
      style={({ pressed }) => [styles.action, primary ? styles.actionPrimary : styles.actionSecondary, (disabled || busy) && styles.off, pressed && styles.pressed]}>
      <Text style={[styles.actionText, primary && styles.actionTextPrimary]}>{title}</Text>
      {busy ? <ActivityIndicator size="small" color={primary ? '#141719' : '#e8e9e7'}/> : <Text style={[styles.actionMark, primary && styles.actionMarkPrimary]} importantForAccessibility="no">{mark}</Text>}
    </Pressable>
  );
}

function TextAction({ title, onPress, testID }: { title: string; onPress: () => void; testID?: string }) {
  const styles = useStyles();
  return <Pressable accessibilityRole="button" hitSlop={6} onPress={onPress} testID={testID} style={styles.textAction}><Text style={styles.textActionText}>{title}</Text></Pressable>;
}

function AuthField({ label, error, ...props }: TextInputProps & { label: string; error?: string }) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <View>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput placeholderTextColor="#6f797b" selectionColor={colors.primary} cursorColor={colors.primary} style={[styles.field, error ? styles.fieldError : null]} {...props}/>
      {error ? <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text> : null}
    </View>
  );
}

function Countdown({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // Every 2 s: Android's UI reader waits for a second of quiet on screen, and a timer ticking each second never gives it.
    const timer = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(timer);
  }, []);
  const left = Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000));
  return <>{String(Math.floor(left / 60)).padStart(2, '0')}:{String(left % 60).padStart(2, '0')}</>;
}

export default function LoginScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { api, server, signIn } = useSession();
  // "signup": a person without a center creates one and becomes its owner.
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [confirmed, setConfirmed] = useState(false);
  const [centerName, setCenterName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [legal, setLegal] = useState<LegalState>({ terms: false, consent: false });
  const [providers, setProviders] = useState<AuthProvider[] | null>(null);
  const [demo, setDemo] = useState(false);
  // Sign-in by email: a 6-digit code comes by letter and is typed here (no bot to poll).
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [login, setLogin] = useState<LoginRequest | null>(null);
  const [status, setStatus] = useState<LoginStatus['status'] | null>(null);
  const [memberships, setMemberships] = useState<LoginMembership[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [codeOpen, setCodeOpen] = useState(false);
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
  // With no messenger set up the address is the only way in: no need to ask for it twice.
  const emailShown = emailEnabled && (emailOpen || providers?.length === 0);
  const confirmIntro = byEmail ? `Код отправлен на ${login?.email}. Письмо приходит за минуту — если его нет, загляните в «Спам».`
    : finished ? 'Начните вход заново, чтобы получить новый код.'
    : status === 'AWAITING_CONFIRMATION' ? `Откройте сообщение бота в ${providerTitle} и сверьте код.`
    : login?.deepLink ? `Откройте бота в ${providerTitle} и нажмите «Старт».` : `Отправьте этот код боту в ${providerTitle}.`;
  const openLegal = (path: string) => void WebBrowser.openBrowserAsync(`${server}${path}`, { toolbarColor: colors.ground, controlsColor: colors.primary });

  return (
    <Screen contentStyle={styles.screen}>
      <View style={styles.brand}>
        <Image source={require('../../assets/images/splash-icon.png')} style={styles.logo} resizeMode="contain" accessible={false}/>
        <Text style={styles.brandName}>DetailFlow</Text>
      </View>

      {!login && <>
        <View style={styles.main}>
          {/* A long press on the title points the app at another server: for tests and a center's own machine. */}
          <Pressable onLongPress={() => router.push('/server')} delayLongPress={1500} accessible={false} testID="login-title">
            <Text style={styles.title} accessibilityRole="header">{signup ? 'Создать центр' : 'Войти в центр'}</Text>
          </Pressable>
          <Text style={styles.intro}>{signup
            ? `Подтвердите аккаунт через ${emailEnabled ? 'мессенджер или почту' : 'мессенджер'}. Затем назовите центр.`
            : 'Выберите удобный способ входа.'}</Text>
          {error ? <View style={styles.notice}><Notice>{error}</Notice></View> : null}
          {/* The ways in take their place at once, so the title does not jump when they arrive. */}
          <View style={[styles.actions, providers === null && styles.actionsLoading]}>
            {providers === null ? <Text style={styles.intro}>Загружаем способы входа…</Text> : null}
            {providers?.map((provider, index) => (
              <Action key={provider.provider} title={`Продолжить с ${provider.title}`} mark="↗" tone={index === 0 ? 'primary' : 'secondary'} busy={busy} onPress={() => start(provider)} testID={`login-${provider.provider}`}/>
            ))}
          </View>
          {emailEnabled && !emailShown && <TextAction title={signup ? 'Продолжить по почте' : 'Войти по почте'} onPress={() => setEmailOpen(true)} testID="login-email-open"/>}
          {emailShown && <View style={styles.form}>
            <AuthField label="Почта" value={email} onChangeText={setEmail} placeholder="name@mail.ru" keyboardType="email-address" autoCapitalize="none"
              autoCorrect={false} autoComplete="email" returnKeyType="send" onSubmitEditing={startEmail} testID="login-email"/>
            <Action title={signup ? 'Продолжить с почтой' : 'Получить код на почту'} tone="secondary" busy={busy} disabled={!/^\S+@\S+\.\S+$/.test(email.trim())} onPress={startEmail} testID="login-email-submit"/>
          </View>}
          {/* The way in for an employee with a code from the owner, and for store reviewers. */}
          {!signup && !codeOpen && <TextAction title="Войти по коду доступа" onPress={() => setCodeOpen(true)} testID="access-code-open"/>}
          {!signup && codeOpen && <View style={styles.form}>
            <AuthField label="Код доступа сотрудника" value={code} onChangeText={setCode} placeholder="df_…" autoCapitalize="none" autoCorrect={false}
              secureTextEntry returnKeyType="go" onSubmitEditing={signInWithCode} error={codeError} testID="access-code"/>
            <Action title="Войти по коду" tone="secondary" busy={busy} onPress={signInWithCode} testID="access-code-submit"/>
          </View>}
          {!signup && demo && <TextAction title="Демо-режим" onPress={() => signIn('demo-session-token')} testID="login-demo"/>}
        </View>
        <View style={styles.foot}>
          <View style={styles.footLine}>
            <Text style={styles.footText}>{signup ? 'Уже есть центр?' : 'Впервые в DetailFlow?'}</Text>
            <Pressable accessibilityRole="button" hitSlop={10} onPress={() => { setMode(signup ? 'login' : 'signup'); setError(''); }} testID="toggle-signup">
              <Text style={styles.footLink}>{signup ? 'Войти' : 'Создать центр'}</Text>
            </Pressable>
          </View>
          <Text style={styles.footNote}>{signup ? 'Если вас пригласили в команду, используйте вход.' : 'Сотруднику понадобится приглашение владельца.'}</Text>
        </View>
      </>}

      {login && !confirmed && <>
        <View style={styles.main}>
          <Pressable accessibilityRole="button" hitSlop={8} onPress={reset} style={styles.back}>
            <Text style={styles.backArrow} importantForAccessibility="no">←</Text>
            <Text style={styles.backText}>Назад</Text>
          </Pressable>
          <Text style={styles.title} accessibilityRole="header">{choosing ? 'Выберите центр' : byEmail ? 'Введите код из письма' : signup || login.purpose === 'signup' ? 'Подтвердите аккаунт' : 'Подтвердите вход'}</Text>
          {!choosing && <Text style={styles.intro}>{confirmIntro}</Text>}
          {error ? <View style={styles.notice}><Notice>{error}</Notice></View> : null}
          {!byEmail && !choosing && <View style={styles.codeBlock}>
            <Text style={styles.caption}>Код этого входа</Text>
            <Text style={styles.code} accessibilityLabel={`Код ${login.shortCode.split('').join(' ')}`} testID="login-code">{login.shortCode}</Text>
          </View>}
          {byEmail && waiting && <View style={styles.form}>
            <AuthField label="Код из письма" value={emailCode} onChangeText={(value) => setEmailCode(value.replace(/\D/g, ''))} placeholder="000000"
              keyboardType="number-pad" maxLength={6} autoComplete="one-time-code" textContentType="oneTimeCode" returnKeyType="go" onSubmitEditing={confirmEmail} testID="login-email-code"/>
            <Action title="Подтвердить" busy={busy} disabled={emailCode.length !== 6} onPress={confirmEmail} testID="login-email-confirm"/>
          </View>}
          {/* Announced only when the state changes: a screen reader must not read the timer out every second. */}
          {!choosing && <View style={styles.status} accessibilityLiveRegion={waiting ? 'none' : 'polite'}>
            <View style={[styles.dot, status === 'CONFIRMED' && styles.dotOk, finished && styles.dotBad]}/>
            <Text style={[styles.statusText, finished && styles.statusBad]}>{waiting ? <>{byEmail ? 'Код действует' : 'Ожидаем подтверждения'} · <Countdown expiresAt={login.expiresAt}/></> : status ? closedText[status] : ''}</Text>
          </View>}
          {login.deepLink && waiting && <View style={styles.actions}><Action title={`Открыть ${providerTitle}`} mark="↗" onPress={() => Linking.openURL(login.deepLink!)}/></View>}
          {!byEmail && waiting && <Text style={styles.hint}>Подтверждайте вход, только если код совпадает.</Text>}
          {choosing && <View style={styles.actions}>
            {memberships.map((membership) => (
              <Pressable key={membership.tenant.id} accessibilityRole="button" onPress={() => openSession(login, membership.tenant.id)}
                android_ripple={{ color: 'rgba(255,255,255,.08)' }} style={styles.tenant}>
                <Text style={styles.tenantName}>{membership.tenant.name}</Text>
                <Text style={styles.tenantRole}>{membership.member.displayName}</Text>
              </Pressable>
            ))}
          </View>}
          {finished && <View style={styles.actions}><Action title="Начать заново" onPress={reset}/></View>}
        </View>
        <View style={styles.footPlain}><TextAction title="Выбрать другой способ" onPress={reset}/></View>
      </>}

      {login && confirmed && <>
        <View style={styles.main}>
          <Text style={styles.title} accessibilityRole="header">Название центра</Text>
          <Text style={styles.intro}>Как ваша команда называет центр?</Text>
          {login.purpose !== 'signup' && <Text style={styles.hint}>Этот аккаунт ещё не привязан к центру. Создайте свой — или, если вы сотрудник, попросите владельца прислать приглашение из «Профиль → Команда».</Text>}
          {error ? <View style={styles.notice}><Notice>{error}</Notice></View> : null}
          <View style={styles.form}>
            <AuthField label="Название" value={centerName} onChangeText={setCenterName} maxLength={120} placeholder="Название детейлинг-центра" testID="center-name"/>
            <AuthField label="Ваше имя" value={ownerName} onChangeText={setOwnerName} maxLength={80} autoCapitalize="words" placeholder="Имя Фамилия" testID="owner-name"/>
            <LegalChecks value={legal} onChange={setLegal}/>
            <Action title="Создать центр" busy={busy} disabled={centerName.trim().length < 2 || ownerName.trim().length < 2 || !legal.terms || !legal.consent} onPress={createCenter} testID="create-center"/>
          </View>
        </View>
        <View style={styles.foot}><TextAction title="Вернуться к выбору способа" onPress={reset}/></View>
      </>}

      {/* Before anyone signs in: how their data is handled (AppGallery and Google Play ask for it on this screen). */}
      <Text style={styles.legal}>
        <Text style={styles.legalLink} onPress={() => openLegal(legalLinks.privacy)}>Политика обработки персональных данных</Text>
        {' · '}
        <Text style={styles.legalLink} onPress={() => openLegal(legalLinks.terms)}>Пользовательское соглашение</Text>
      </Text>
    </Screen>
  );
}

const useStyles = makeStyles((colors) => StyleSheet.create({
  screen: { flexGrow: 1, gap: 0, backgroundColor: '#0b0e10', paddingHorizontal: 28, paddingTop: 52, paddingBottom: 24 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  logo: { width: 28, height: 28 },
  brandName: { color: '#f1f1ed', fontSize: 17, fontWeight: '700', letterSpacing: -0.4 },
  main: { marginTop: 'auto', paddingTop: 40, paddingBottom: 56 },
  title: { color: '#f1f1ed', fontSize: 31, lineHeight: 36, fontWeight: '700', letterSpacing: -1.2, marginBottom: 13 },
  intro: { color: '#a0a7a9', fontSize: 16, lineHeight: 24 },
  notice: { marginTop: 16 },
  actions: { gap: 11, marginTop: 36 },
  actionsLoading: { minHeight: 179 },
  action: { minHeight: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 18, borderRadius: 10, borderWidth: 1, overflow: 'hidden' },
  actionPrimary: { backgroundColor: '#eeeae2', borderColor: '#eeeae2' },
  actionSecondary: { backgroundColor: 'transparent', borderColor: '#4a5052' },
  actionText: { flexShrink: 1, color: '#e8e9e7', fontSize: 16, fontWeight: '700', letterSpacing: -0.2 },
  actionTextPrimary: { color: '#141719' },
  actionMark: { color: '#646b6b', fontSize: 15 },
  actionMarkPrimary: { color: '#4f5555' },
  off: { opacity: 0.45 },
  pressed: { opacity: 0.88 },
  textAction: { minHeight: 44, justifyContent: 'center', marginTop: 8, alignSelf: 'flex-start' },
  textActionText: { color: '#bfc5c4', fontSize: 15 },
  form: { gap: 18, marginTop: 24 },
  fieldLabel: { color: '#c4c9c8', fontSize: 14, marginBottom: 10 },
  field: { minHeight: 58, borderRadius: 10, borderWidth: 1, borderColor: '#4a5052', paddingHorizontal: 17, color: '#f1f1ed', fontSize: 16 },
  fieldError: { borderColor: colors.danger },
  error: { color: '#ff9b9b', fontSize: 14, marginTop: 6 },
  back: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, marginBottom: 32, alignSelf: 'flex-start' },
  backArrow: { color: '#aeb5b5', fontSize: 23, lineHeight: 26 },
  backText: { color: '#aeb5b5', fontSize: 15 },
  codeBlock: { marginTop: 40 },
  caption: { color: '#8e989a', fontSize: 13 },
  code: { color: '#f4f2ec', fontFamily: 'monospace', fontSize: 39, letterSpacing: 3, marginTop: 7 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 15 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.primary },
  dotOk: { backgroundColor: colors.ok },
  dotBad: { backgroundColor: colors.danger },
  statusText: { flexShrink: 1, color: '#a0a7a9', fontSize: 14, fontVariant: ['tabular-nums'] },
  statusBad: { color: '#ffb3ae' },
  hint: { color: '#869092', fontSize: 13, lineHeight: 19, marginTop: 16 },
  tenant: { minHeight: 58, justifyContent: 'center', borderRadius: 10, borderWidth: 1, borderColor: '#4a5052', paddingHorizontal: 18, paddingVertical: 9, overflow: 'hidden' },
  tenantName: { color: '#f1f1ed', fontSize: 16, fontWeight: '700' },
  tenantRole: { color: '#a0a7a9', fontSize: 13, marginTop: 2 },
  foot: { marginTop: 'auto', paddingTop: 22, borderTopWidth: 1, borderTopColor: '#32383a' },
  footPlain: { marginTop: 'auto' },
  footLine: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8 },
  footText: { color: '#a0a7a9', fontSize: 14, lineHeight: 21 },
  footLink: { color: '#f1f1ed', fontSize: 14, lineHeight: 21, fontWeight: '700' },
  footNote: { color: '#80898b', fontSize: 13, lineHeight: 19, marginTop: 10 },
  legal: { color: '#80898b', fontSize: 12, lineHeight: 18, marginTop: 18 },
  legalLink: { color: '#80898b', textDecorationLine: 'underline' }
}));
