import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { DEFAULT_SERVER, normalizeServerUrl, probeServer } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Body, Button, Field, Screen, Title } from '@/ui';

/** First launch (and "Сменить сервер"): the address of the center's DetailFlow server. */
export default function ServerScreen() {
  const { server, setServer, state } = useSession();
  // A new install offers the public server; a center with its own machine types its address instead.
  const [address, setAddress] = useState(server ?? DEFAULT_SERVER);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);

  const connect = async () => {
    const url = normalizeServerUrl(address);
    if (!url) return setError('Введите адрес сервера');
    setChecking(true); setError('');
    const ok = await probeServer(url);
    setChecking(false);
    if (!ok) return setError('По этому адресу сервер DetailFlow не отвечает. Проверьте адрес и интернет; для сервера в сети центра телефон должен быть в той же сети.');
    await setServer(url);
    router.replace('/login');
  };

  return (
    <Screen contentStyle={{ paddingTop: state.phase === 'no-server' ? 72 : 16 }}>
      {state.phase === 'no-server' && <Title>DetailFlow</Title>}
      <Body muted>Обычно это {DEFAULT_SERVER} — оставьте как есть и нажмите «Подключиться». Если у вашего центра свой сервер, введите его адрес: его знает владелец (например, 192.168.1.60:4173 в сети центра).</Body>
      <View style={{ height: 8 }}/>
      <Field label="Адрес сервера" value={address} onChangeText={setAddress} placeholder={DEFAULT_SERVER} autoCapitalize="none" autoCorrect={false}
        keyboardType="url" returnKeyType="go" onSubmitEditing={connect} error={error} testID="server-address"/>
      <Button title="Подключиться" busy={checking} onPress={connect} testID="server-connect"/>
    </Screen>
  );
}
