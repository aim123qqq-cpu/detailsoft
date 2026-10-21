import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { DEFAULT_SERVER, normalizeServerUrl, probeServer } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Body, Button, Field, Screen } from '@/ui';

/** Another server than the public one: reached by a long press on the sign-in title (tests, a center's own machine). */
export default function ServerScreen() {
  const { server, setServer } = useSession();
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
    <Screen>
      <Body muted>Обычно менять не нужно: приложение работает с {DEFAULT_SERVER}. Другой адрес — только для своего сервера центра (например, 192.168.1.60:4173).</Body>
      <View style={{ height: 8 }}/>
      <Field label="Адрес сервера" value={address} onChangeText={setAddress} placeholder={DEFAULT_SERVER} autoCapitalize="none" autoCorrect={false}
        keyboardType="url" returnKeyType="go" onSubmitEditing={connect} error={error} testID="server-address"/>
      <Button title="Подключиться" busy={checking} onPress={connect} testID="server-connect"/>
    </Screen>
  );
}
