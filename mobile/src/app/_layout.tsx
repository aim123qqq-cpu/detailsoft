import { useEffect } from 'react';
import { Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useSyncLoop } from '@/features/sync-banner';
import { BookingDraftProvider } from '@/lib/booking-draft';
import { SessionProvider, useSession } from '@/lib/session';
import { colors, navigationTheme } from '@/lib/theme';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  return (
    <ThemeProvider value={navigationTheme}>
      <SessionProvider>
        <BookingDraftProvider>
          <RootNavigator/>
        </BookingDraftProvider>
      </SessionProvider>
      <StatusBar style="light"/>
    </ThemeProvider>
  );
}

/** Without a server: its address. Signed out: sign-in. Signed in: the tabs. */
function RootNavigator() {
  const { state } = useSession();
  useSyncLoop();
  useEffect(() => { if (state.phase !== 'loading') void SplashScreen.hideAsync(); }, [state.phase]);
  if (state.phase === 'loading') return null;

  return (
    <Stack screenOptions={{ headerStyle: { backgroundColor: colors.ground }, headerTintColor: colors.text, headerShadowVisible: false, contentStyle: { backgroundColor: colors.ground } }}>
      <Stack.Protected guard={state.phase === 'signed-in'}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }}/>
        <Stack.Screen name="customer/[id]" options={{ title: 'Клиент' }}/>
      </Stack.Protected>
      <Stack.Protected guard={state.phase === 'signed-out'}>
        <Stack.Screen name="login" options={{ headerShown: false }}/>
      </Stack.Protected>
      <Stack.Protected guard={state.phase === 'offline'}>
        <Stack.Screen name="offline" options={{ headerShown: false }}/>
      </Stack.Protected>
      <Stack.Screen name="server" options={{ title: 'Сервер' }}/>
      <Stack.Screen name="index" options={{ headerShown: false }}/>
    </Stack>
  );
}
