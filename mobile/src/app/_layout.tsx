import { useEffect } from 'react';
import { Platform } from 'react-native';
import { Stack, ThemeProvider } from 'expo-router';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useSyncLoop } from '@/features/sync-banner';
import { BookingDraftProvider } from '@/lib/booking-draft';
import { SessionProvider, useSession } from '@/lib/session';
import { AppThemeProvider, font, navigationTheme, useTheme } from '@/lib/theme';

SplashScreen.preventAutoHideAsync();

// On a phone the faces are built into the app (expo-font in app.json); a browser loads them.
const WEB_FONTS = Platform.OS === 'web' ? [{ fontFamily: font, fontDefinitions: [
  { path: require('../../assets/fonts/Manrope_300Light.ttf'), weight: 300 },
  { path: require('../../assets/fonts/Manrope_400Regular.ttf'), weight: 400 },
  { path: require('../../assets/fonts/Manrope_500Medium.ttf'), weight: 500 },
  { path: require('../../assets/fonts/Manrope_600SemiBold.ttf'), weight: 600 },
  { path: require('../../assets/fonts/Manrope_700Bold.ttf'), weight: 700 },
  { path: require('../../assets/fonts/Manrope_800ExtraBold.ttf'), weight: 800 }
] }] : [];

export default function RootLayout() {
  return (
    <AppThemeProvider>
      <Themed/>
    </AppThemeProvider>
  );
}

function Themed() {
  const { scheme } = useTheme();
  return (
    <ThemeProvider value={navigationTheme(scheme)}>
      <SessionProvider>
        <BookingDraftProvider>
          <RootNavigator/>
        </BookingDraftProvider>
      </SessionProvider>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'}/>
    </ThemeProvider>
  );
}

/** Without a server: its address. Signed out: sign-in. Signed in: the tabs. */
function RootNavigator() {
  const { state } = useSession();
  const { colors } = useTheme();
  const [fontsReady] = useFonts(WEB_FONTS as never);
  useSyncLoop();
  const ready = state.phase !== 'loading' && (fontsReady || Platform.OS !== 'web');
  useEffect(() => { if (ready) void SplashScreen.hideAsync(); }, [ready]);
  if (!ready) return null;

  return (
    <Stack screenOptions={{
      headerStyle: { backgroundColor: colors.ground }, headerTintColor: colors.ink, headerShadowVisible: false,
      headerTitleStyle: { fontFamily: font, fontWeight: '600' }, contentStyle: { backgroundColor: colors.ground }
    }}>
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
