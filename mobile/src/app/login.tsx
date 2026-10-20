import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { AuthProvider, LoginMembership, LoginRequest, LoginStatus } from '@df/types';
import { ApiError, createApi } from '@/lib/api';
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
  const [providers, setProviders] = useState<AuthProvider[] | null>(null);
  const [demo, setDemo] = useState(false);
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
      .then((result) => { setProviders(result.items); setDemo(result.demo); })
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
    if (!login) return;
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
          if (next.memberships.length > 1) setMemberships(next.memberships);
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
      const created = await api.createLoginRequest(provider.provider);
      setLogin(created);
      setStatus('PENDING');
      if (created.deepLink) void Linking.openURL(created.deepLink).catch(() => {});
    } catch (requestError) { setError((requestError as Error).message); }
    finally { setBusy(false); }
  };

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
  const providerTitle = login ? providers?.find((item) => item.provider === login.provider)?.title ?? login.provider : '';

  return (
    <Screen contentStyle={{ paddingTop: 64 }}>
      <Title>Вход в DetailFlow</Title>
      <Body muted>Войдите через мессенджер, к которому вас привязал владелец центра, или по коду доступа.</Body>
      {error ? <Notice>{error}</Notice> : null}

      {!login && <>
        {providers === null ? <Body muted>Загружаем способы входа…</Body> : null}
        {providers?.map((provider) => (
          <Button key={provider.provider} title={`Войти через ${provider.title}`} busy={busy} onPress={() => start(provider)} testID={`login-${provider.provider}`}/>
        ))}
      </>}

      {login && (
        <Card>
          <Label>{providerTitle}</Label>
          <Text style={styles.code} accessibilityLabel={`Код ${login.shortCode.split('').join(' ')}`} testID="login-code">{login.shortCode}</Text>
          <Body muted>{status ? statusText[status] : ''}</Body>
          {login.deepLink && !finished && <Button title={`Открыть ${providerTitle}`} tone="secondary" onPress={() => Linking.openURL(login.deepLink!)}/>}
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
          {finished && <Button title="Начать заново" onPress={() => { setLogin(null); setStatus(null); setError(''); }}/>}
          {!finished && <Button title="Отмена" tone="quiet" onPress={() => { setLogin(null); setStatus(null); }}/>}
        </Card>
      )}

      {!login && <Card style={{ marginTop: space.s }}>
        <Field label="Код доступа сотрудника" value={code} onChangeText={setCode} placeholder="df_…" autoCapitalize="none" autoCorrect={false}
          secureTextEntry returnKeyType="go" onSubmitEditing={signInWithCode} error={codeError} testID="access-code"/>
        <Button title="Войти по коду" tone="secondary" busy={busy} onPress={signInWithCode} testID="access-code-submit"/>
      </Card>}

      {!login && demo && <Button title="Демо-режим" tone="quiet" onPress={() => signIn('demo-session-token')} testID="login-demo"/>}

      <Pressable accessibilityRole="button" onPress={() => router.push('/server')} style={styles.server} hitSlop={8}>
        <Text style={styles.serverText}>Сервер: {server} · <Text style={{ color: colors.primary }}>Сменить</Text></Text>
      </Pressable>
    </Screen>
  );
}

const styles = StyleSheet.create({
  code: { color: colors.text, fontSize: 40, fontWeight: '800', letterSpacing: 6, textAlign: 'center', marginVertical: space.s, fontVariant: ['tabular-nums'] },
  tenant: { backgroundColor: colors.surfaceRaised, borderRadius: radius.m, padding: space.m, overflow: 'hidden' },
  tenantName: { color: colors.text, fontSize: 16, fontWeight: '700' },
  tenantRole: { color: colors.muted, fontSize: 14, marginTop: 2 },
  server: { marginTop: space.xl, alignItems: 'center', padding: space.s },
  serverText: { color: colors.muted, fontSize: 14 }
});
