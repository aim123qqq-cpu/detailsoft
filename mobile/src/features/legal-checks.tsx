import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { LEGAL_VERSION, legalLinks } from '@df/legal';
import { useSession } from '@/lib/session';
import { colors, radius, space } from '@/lib/theme';
import { Body, Button, Notice, Screen, Title } from '@/ui';

export type LegalState = { terms: boolean; consent: boolean };

/**
 * The user agreement and the consent to the processing of personal data: two separate ticks, because
 * since 1 September 2025 the consent is a document of its own (152-FZ art. 9). Nothing is pre-ticked.
 */
export function LegalChecks({ value, onChange }: { value: LegalState; onChange: (next: LegalState) => void }) {
  const { server } = useSession();
  const open = (path: string) => WebBrowser.openBrowserAsync(`${server}${path}`, { toolbarColor: colors.ground, controlsColor: colors.primary });
  const row = (key: keyof LegalState, before: string, link: string, path: string, testID: string) => (
    <View style={styles.row}>
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: value[key] }} accessibilityLabel={`${before} ${link}`} hitSlop={8}
        onPress={() => onChange({ ...value, [key]: !value[key] })} style={[styles.box, value[key] && styles.boxOn]} testID={testID}>
        {value[key] ? <Text style={styles.tick}>✓</Text> : null}
      </Pressable>
      <Text style={styles.text}>{before} <Text style={styles.link} onPress={() => void open(path)}>{link}</Text></Text>
    </View>
  );
  return (
    <View style={styles.checks}>
      {row('terms', 'Принимаю', 'Пользовательское соглашение', legalLinks.terms, 'accept-terms')}
      {row('consent', 'Даю', 'согласие на обработку персональных данных', legalLinks.consent, 'accept-consent')}
      <Text style={styles.note}>Как мы обращаемся с данными — в <Text style={styles.link} onPress={() => void open(legalLinks.privacy)}>Политике обработки персональных данных</Text>.</Text>
    </View>
  );
}

/** Shown once per edition to a signed-in person who has not accepted the documents yet. */
export function LegalGate({ centerName }: { centerName: string }) {
  const { api, reload, signOut } = useSession();
  const [value, setValue] = useState<LegalState>({ terms: false, consent: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const accept = async () => {
    setBusy(true); setError('');
    try { await api.acceptLegal(LEGAL_VERSION); await reload(); }
    catch (failure) { setError((failure as Error).message); setBusy(false); }
  };
  return (
    <Screen contentStyle={{ paddingTop: 72 }}>
      <Title>Перед началом работы</Title>
      <Body muted>Вы входите в «{centerName}». Чтобы пользоваться DetailFlow, примите соглашение и дайте согласие на обработку ваших персональных данных: имени, аккаунта мессенджера и действий в заказах.</Body>
      <LegalChecks value={value} onChange={setValue}/>
      {error ? <Notice>{error}</Notice> : null}
      <Button title="Продолжить" busy={busy} disabled={!value.terms || !value.consent} onPress={() => void accept()} testID="accept-legal"/>
      <Button title="Выйти" tone="quiet" onPress={() => void signOut()}/>
    </Screen>
  );
}

const styles = StyleSheet.create({
  checks: { gap: space.m },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.m },
  box: { width: 26, height: 26, borderRadius: radius.s, borderWidth: 2, borderColor: colors.muted, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  boxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  tick: { color: colors.primaryInk, fontSize: 16, fontWeight: '900' },
  text: { flex: 1, color: colors.text, fontSize: 15, lineHeight: 22 },
  link: { color: colors.primary, textDecorationLine: 'underline' },
  note: { color: colors.muted, fontSize: 13, lineHeight: 19 }
});
