import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSession } from '@/lib/session';
import { makeStyles } from '@/lib/theme';
import { Button } from '@/ui';
import { FlowPage, MarkTile, TextLink } from '@/ui/brand';
import { Text } from '@/ui/text';

/** Signed in, but the server could not be reached when the app started. */
export default function OfflineScreen() {
  const styles = useStyles();
  const { state, reload, signOut } = useSession();
  const [retrying, setRetrying] = useState(false);
  const message = state.phase === 'offline' ? state.message : '';

  return (
    <FlowPage>
      <Text style={styles.brand}>DetailFlow</Text>
      <View style={styles.middle}>
        <MarkTile size={96} faded/>
        <Text style={styles.h1} accessibilityRole="header">Нет связи с сервером</Text>
        <Text style={styles.lead} accessibilityLiveRegion="polite">{message || 'Проверьте интернет и повторите.'}</Text>
        {message ? <Text style={styles.lead}>Проверьте интернет и повторите.</Text> : null}
      </View>
      <Button title="Повторить" busy={retrying} onPress={async () => { setRetrying(true); await reload(); setRetrying(false); }} testID="offline-retry"/>
      <TextLink title="Выйти" tone="muted" onPress={signOut}/>
    </FlowPage>
  );
}

const useStyles = makeStyles((colors) => StyleSheet.create({
  brand: { fontSize: 16, fontWeight: '700', marginTop: 6 },
  middle: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingVertical: 40 },
  h1: { fontSize: 28, lineHeight: 34, fontWeight: '500', letterSpacing: -0.8, textAlign: 'center', marginTop: 8 },
  lead: { fontSize: 15, lineHeight: 21, color: colors.muted, textAlign: 'center' }
}));
