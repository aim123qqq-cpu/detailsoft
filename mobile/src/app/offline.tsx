import { useState } from 'react';
import { useSession } from '@/lib/session';
import { Body, Button, Notice, Screen, Title } from '@/ui';

/** Signed in, but the server could not be reached when the app started. */
export default function OfflineScreen() {
  const { state, reload, signOut } = useSession();
  const [retrying, setRetrying] = useState(false);
  const message = state.phase === 'offline' ? state.message : '';

  return (
    <Screen contentStyle={{ paddingTop: 72 }}>
      <Title>Нет связи с сервером</Title>
      <Notice>{message}</Notice>
      <Body muted>Проверьте интернет и повторите.</Body>
      <Button title="Повторить" busy={retrying} onPress={async () => { setRetrying(true); await reload(); setRetrying(false); }} testID="offline-retry"/>
      <Button title="Выйти" tone="quiet" onPress={signOut}/>
    </Screen>
  );
}
