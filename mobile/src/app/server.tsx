import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { DEFAULT_SERVER, normalizeServerUrl, probeServer } from '@/lib/api';
import { useSession } from '@/lib/session';
import { makeStyles, radius } from '@/lib/theme';
import { Button, Field } from '@/ui';
import { FlowHeader, FlowPage } from '@/ui/brand';
import { Text } from '@/ui/text';

/** Another server than the public one: reached by a long press on the sign-in title (tests, a center's own machine). */
export default function ServerScreen() {
  const styles = useStyles();
  const { server, setServer } = useSession();
  const [address, setAddress] = useState(server ?? DEFAULT_SERVER);
  const [failed, setFailed] = useState(false);
  const [empty, setEmpty] = useState(false);
  const [checking, setChecking] = useState(false);

  const connect = async () => {
    const url = normalizeServerUrl(address);
    setFailed(false);
    if (!url) return setEmpty(true);
    setEmpty(false); setChecking(true);
    const ok = await probeServer(url);
    setChecking(false);
    if (!ok) return setFailed(true);
    await setServer(url);
    router.replace('/login');
  };

  return (
    <FlowPage>
      <FlowHeader title="Сервер" note="для своей установки"/>
      <View style={{ height: 12 }}/>
      <Text style={styles.h1} accessibilityRole="header">Адрес сервера</Text>
      <Text style={styles.lead}>Обычно менять не нужно: приложение работает с {DEFAULT_SERVER}. Другой адрес — только для своего сервера центра, например 192.168.1.60:4173.</Text>
      <Field label="Адрес сервера" required value={address} onChangeText={setAddress} placeholder={DEFAULT_SERVER} autoCapitalize="none" autoCorrect={false}
        keyboardType="url" returnKeyType="go" onSubmitEditing={connect} error={empty ? 'Введите адрес сервера' : undefined} testID="server-address"/>
      {failed ? <View style={styles.problem} accessibilityLiveRegion="polite">
        <Text style={styles.problemTitle}>Сервер не отвечает</Text>
        <Text style={styles.problemText}>Проверьте адрес и интернет. Для сервера в сети центра телефон должен быть в той же сети.</Text>
      </View> : null}
      <View style={{ flexGrow: 1, minHeight: 24 }}/>
      <Button title="Подключиться" busy={checking} onPress={connect} testID="server-connect"/>
    </FlowPage>
  );
}

const useStyles = makeStyles((colors) => StyleSheet.create({
  h1: { fontSize: 30, lineHeight: 34, fontWeight: '500', letterSpacing: -0.9, paddingHorizontal: 4 },
  lead: { fontSize: 14, lineHeight: 20, color: colors.muted, paddingHorizontal: 4 },
  problem: { borderRadius: radius.m, backgroundColor: colors.soft, paddingVertical: 14, paddingHorizontal: 16, gap: 4 },
  problemTitle: { fontSize: 14, fontWeight: '700', color: colors.sevHiText },
  problemText: { fontSize: 13, lineHeight: 19, color: colors.muted }
}));
