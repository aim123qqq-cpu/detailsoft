import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { normalizeServerUrl, probeServer } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Body, Button, Field, Screen, Title } from '@/ui';

/** First launch (and "Сменить сервер"): the address of the center's DetailFlow server. */
export default function ServerScreen() {
  const { server, setServer, state } = useSession();
  const [address, setAddress] = useState(server ?? '');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);

  const connect = async () => {
    const url = normalizeServerUrl(address);
    if (!url) return setError('Введите адрес сервера');
    setChecking(true); setError('');
    const ok = await probeServer(url);
    setChecking(false);
    if (!ok) return setError('По этому адресу сервер DetailFlow не отвечает. Проверьте адрес и что телефон в той же сети.');
    await setServer(url);
    router.replace('/login');
  };

  return (
    <Screen contentStyle={{ paddingTop: state.phase === 'no-server' ? 72 : 16 }}>
      {state.phase === 'no-server' && <Title>DetailFlow</Title>}
      <Body muted>Адрес сервера вашего центра. Его знает владелец или администратор: например, 192.168.1.60:4173 в сети центра или адрес в интернете.</Body>
      <View style={{ height: 8 }}/>
      <Field label="Адрес сервера" value={address} onChangeText={setAddress} placeholder="192.168.1.60:4173" autoCapitalize="none" autoCorrect={false}
        keyboardType="url" returnKeyType="go" onSubmitEditing={connect} error={error} testID="server-address"/>
      <Button title="Подключиться" busy={checking} onPress={connect} testID="server-connect"/>
    </Screen>
  );
}
