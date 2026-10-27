import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { LEGAL_VERSION } from '@df/legal';
import type { AuthProvider, LoginMembership, LoginRequest, LoginStatus } from '@df/types';
import { ApiError, createApi } from '@/lib/api';
import { LegalChecks, type LegalState } from '@/features/legal-checks';
import { useSession } from '@/lib/session';
import { colors, radius, space } from '@/lib/theme';
import { Body, Button, Card, Field, Label, Notice, Screen, Title } from '@/ui';

const statusText: Record<LoginStatus['status'], string> = {
  PENDING: 'Откройте бота и нажмите «Старт» или отправьте ему код.',
  AWAITING_CONFIRMATION: 'Подтвердите вход кнопкой «Это я, войти» в боте.',
  CONFIRMED: 'Вход подтверждён. Открываем рабочее место…',
  DENIED: 'Вход отклонён в мессенджере.',
  CONSUMED: 'Этот вход уже использован.',
  EXPIRED: 'Время на подтверждение истекло.'
};

export default function LoginScreen() {
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
      .then((result) => { setProviders(result.items); setDemo(result.demo); setEmailEnabled(result.email === true); })
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
          if (login.purpose === 'signup') setConfirmed(true);
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
      if (login.purpose === 'signup') setConfirmed(true);
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
  const reset = () => { setLogin(null); setStatus(null); setError(''); setConfirmed(false); };

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

  const finished = status === 'DENIED' || status === 'EXPIRED' || status === 'CONSUMED';
  const byEmail = login?.provider === 'email';
  const providerTitle = byEmail ? 'Email' : login ? providers?.find((item) => item.provider === login.provider)?.title ?? login.provider : '';

  return (
    <Screen contentStyle={{ paddingTop: 64 }}>
      {/* A long press on the title points the app at another server: for tests and a center's own machine. */}
      <Pressable onLongPress={() => router.push('/server')} delayLongPress={1500} accessible={false} testID="login-title">
        <Title>{mode === 'signup' ? 'Новый центр' : 'Вход в DetailFlow'}</Title>
      </Pressable>
      <Body muted>{mode === 'signup'
        ? `Подтвердите себя ${emailEnabled ? 'в мессенджере или по email' : 'в мессенджере'}, затем назовите центр. Вы станете его владельцем и сами пригласите команду.`
        : `Войдите через ${emailEnabled ? 'мессенджер или email' : 'мессенджер'}, к которому вас привязал владелец центра, или по коду доступа.`}</Body>
      {error ? <Notice>{error}</Notice> : null}

      {!login && <>
        {providers === null ? <Body muted>Загружаем способы входа…</Body> : null}
        {providers?.map((provider) => (
          <Button key={provider.provider} title={`${mode === 'signup' ? 'Продолжить' : 'Войти'} через ${provider.title}`} busy={busy} onPress={() => start(provider)} testID={`login-${provider.provider}`}/>
        ))}
        {emailEnabled && <Card>
          <Field label="Email" value={email} onChangeText={setEmail} placeholder="name@mail.ru" keyboardType="email-address" autoCapitalize="none"
            autoCorrect={false} autoComplete="email" returnKeyType="send" onSubmitEditing={startEmail} testID="login-email"/>
          <Button title={mode === 'signup' ? 'Продолжить с email' : 'Получить код на почту'} tone="secondary" busy={busy}
            disabled={!/^\S+@\S+\.\S+$/.test(email.trim())} onPress={startEmail} testID="login-email-submit"/>
        </Card>}
      </>}

      {login && (
        <Card>
          <Label>{providerTitle}</Label>
          {!byEmail && <Text style={styles.code} accessibilityLabel={`Код ${login.shortCode.split('').join(' ')}`} testID="login-code">{login.shortCode}</Text>}
          {byEmail && !confirmed && !finished && status !== 'CONFIRMED' && <View style={{ gap: space.m }}>
            <Body muted>Код отправлен на {login.email}. Письмо приходит за минуту — если его нет, загляните в «Спам».</Body>
            <Field label="Код из письма" value={emailCode} onChangeText={(value) => setEmailCode(value.replace(/\D/g, ''))} placeholder="000000"
              keyboardType="number-pad" maxLength={6} autoComplete="one-time-code" textContentType="oneTimeCode" returnKeyType="go" onSubmitEditing={confirmEmail} testID="login-email-code"/>
            <Button title="Подтвердить" busy={busy} disabled={emailCode.length !== 6} onPress={confirmEmail} testID="login-email-confirm"/>
          </View>}
          <Body muted>{byEmail && !confirmed && status !== 'CONFIRMED' ? '' : confirmed ? 'Подтверждено. Осталось назвать центр.'
            : status === 'AWAITING_CONFIRMATION' && login.purpose === 'signup' ? 'Подтвердите кнопкой «Это я, продолжить» в боте.'
            : status ? statusText[status] : ''}</Body>
          {confirmed && <View style={{ gap: space.m }}>
            <Field label="Название центра" value={centerName} onChangeText={setCenterName} maxLength={120} placeholder="Например, Детейлинг Север" testID="center-name"/>
            <Field label="Ваше имя" value={ownerName} onChangeText={setOwnerName} maxLength={80} autoCapitalize="words" placeholder="Имя Фамилия" testID="owner-name"/>
            <LegalChecks value={legal} onChange={setLegal}/>
            <Button title="Создать центр" busy={busy} disabled={centerName.trim().length < 2 || ownerName.trim().length < 2 || !legal.terms || !legal.consent} onPress={createCenter} testID="create-center"/>
          </View>}
          {login.deepLink && !finished && !confirmed && <Button title={`Открыть ${providerTitle}`} tone="secondary" onPress={() => Linking.openURL(login.deepLink!)}/>}
          {memberships.length > 1 && <View style={{ gap: space.s }}>
            <Label>Выберите центр</Label>
            {memberships.map((membership) => (
              <Pressable key={membership.tenant.id} accessibilityRole="button" onPress={() => openSession(login, membership.tenant.id)}
                android_ripple={{ color: 'rgba(255,255,255,.08)' }} style={styles.tenant}>
                <Text style={styles.tenantName}>{membership.tenant.name}</Text>
                <Text style={styles.tenantRole}>{membership.member.displayName}</Text>
              </Pressable>
            ))}
          </View>}
          {finished && <Button title="Начать заново" onPress={reset}/>}
          {!finished && <Button title="Отмена" tone="quiet" onPress={reset}/>}
        </Card>
      )}

      {!login && <Button title={mode === 'signup' ? 'У меня уже есть центр — войти' : 'Создать свой центр'} tone="quiet"
        onPress={() => { setMode(mode === 'signup' ? 'login' : 'signup'); setError(''); }} testID="toggle-signup"/>}

      {!login && mode === 'login' && <Card style={{ marginTop: space.s }}>
        <Field label="Код доступа сотрудника" value={code} onChangeText={setCode} placeholder="df_…" autoCapitalize="none" autoCorrect={false}
          secureTextEntry returnKeyType="go" onSubmitEditing={signInWithCode} error={codeError} testID="access-code"/>
        <Button title="Войти по коду" tone="secondary" busy={busy} onPress={signInWithCode} testID="access-code-submit"/>
      </Card>}

      {!login && mode === 'login' && demo && <Button title="Демо-режим" tone="quiet" onPress={() => signIn('demo-session-token')} testID="login-demo"/>}
    </Screen>
  );
}

const styles = StyleSheet.create({
  code: { color: colors.text, fontSize: 40, fontWeight: '800', letterSpacing: 6, textAlign: 'center', marginVertical: space.s, fontVariant: ['tabular-nums'] },
  tenant: { backgroundColor: colors.surfaceRaised, borderRadius: radius.m, padding: space.m, overflow: 'hidden' },
  tenantName: { color: colors.text, fontSize: 16, fontWeight: '700' },
  tenantRole: { color: colors.muted, fontSize: 14, marginTop: 2 }
});
