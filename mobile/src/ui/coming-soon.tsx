import * as WebBrowser from 'expo-web-browser';
import { useSession } from '@/lib/session';
import { colors } from '@/lib/theme';
import { Body, Button, Card, Screen, Title } from './index';

/** A section the native app does not have yet: says so plainly and opens it in the web version. */
export function ComingSoon({ title, text }: { title: string; text: string }) {
  const { server } = useSession();
  return (
    <Screen>
      <Card>
        <Title>{title}</Title>
        <Body muted>{text}</Body>
        <Body muted>В нативном приложении раздел появится в одной из следующих версий. Пока он работает в веб-версии.</Body>
        {server ? <Button title="Открыть в веб-версии" tone="secondary" onPress={() => WebBrowser.openBrowserAsync(server, { toolbarColor: colors.ground, controlsColor: colors.primary })}/> : null}
      </Card>
    </Screen>
  );
}
