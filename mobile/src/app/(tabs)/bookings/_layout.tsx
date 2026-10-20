import { Stack } from 'expo-router';
import { colors } from '@/lib/theme';

export const unstable_settings = { initialRouteName: 'index' };

export default function BookingsStack() {
  return (
    <Stack screenOptions={{ headerStyle: { backgroundColor: colors.ground }, headerTintColor: colors.text, headerShadowVisible: false, contentStyle: { backgroundColor: colors.ground } }}>
      <Stack.Screen name="index" options={{ title: 'Записи' }}/>
      <Stack.Screen name="[id]" options={{ title: 'Запись' }}/>
    </Stack>
  );
}
