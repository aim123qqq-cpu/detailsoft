import { useEffect } from 'react';
import { Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { SessionProvider, useSession } from '@/lib/session';
import { colors, navigationTheme } from '@/lib/theme';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  return (
    <ThemeProvider value={navigationTheme}>
      <SessionProvider>
        <RootNavigator/>
      </SessionProvider>
      <StatusBar style="light"/>
    </ThemeProvider>
  );
}

/** Without a server: its address. Signed out: sign-in. Signed in: the tabs. */
function RootNavigator() {
  const { state } = useSession();
  useEffect(() => { if (state.phase !== 'loading') void SplashScreen.hideAsync(); }, [state.phase]);
  if (state.phase === 'loading') return null;

  return (
    <Stack screenOptions={{ headerStyle: { backgroundColor: colors.ground }, headerTintColor: colors.text, headerShadowVisible: false, contentStyle: { backgroundColor: colors.ground } }}>
      <Stack.Protected guard={state.phase === 'signed-in'}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }}/>
      </Stack.Protected>
      <Stack.Protected guard={state.phase === 'signed-out'}>
        <Stack.Screen name="login" options={{ headerShown: false }}/>
      </Stack.Protected>
      <Stack.Protected guard={state.phase === 'offline'}>
        <Stack.Screen name="offline" options={{ headerShown: false }}/>
      </Stack.Protected>
      <Stack.Screen name="server" options={{ title: 'Сервер центра', headerShown: state.phase !== 'no-server' }}/>
    </Stack>
  );
}
