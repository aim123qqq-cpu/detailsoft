import { useState } from 'react';
import { router } from 'expo-router';
import { useSession } from '@/lib/session';
import { Body, Button, Notice, Screen, Title } from '@/ui';

/** Signed in, but the server cannot be reached. Working offline arrives in a later version. */
export default function OfflineScreen() {
  const { state, reload, signOut } = useSession();
  const [retrying, setRetrying] = useState(false);
  const message = state.phase === 'offline' ? state.message : '';

  return (
    <Screen contentStyle={{ paddingTop: 72 }}>
      <Title>Нет связи с сервером</Title>
      <Notice>{message}</Notice>
      <Body muted>Работа без сети появится в нативной версии на следующих этапах. Пока проверьте Wi-Fi центра или интернет и повторите.</Body>
      <Button title="Повторить" busy={retrying} onPress={async () => { setRetrying(true); await reload(); setRetrying(false); }} testID="offline-retry"/>
      <Button title="Сменить сервер" tone="secondary" onPress={() => router.push('/server')}/>
      <Button title="Выйти" tone="quiet" onPress={signOut}/>
    </Screen>
  );
}
