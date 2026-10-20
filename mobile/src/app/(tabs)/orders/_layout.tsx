import { Stack } from 'expo-router';
import { colors } from '@/lib/theme';

export const unstable_settings = { initialRouteName: 'index' };

export default function OrdersStack() {
  return (
    <Stack screenOptions={{ headerStyle: { backgroundColor: colors.ground }, headerTintColor: colors.text, headerShadowVisible: false, contentStyle: { backgroundColor: colors.ground } }}>
      <Stack.Screen name="index" options={{ title: 'Заказы' }}/>
      <Stack.Screen name="[id]" options={{ title: 'Заказ' }}/>
      <Stack.Screen name="intake/[id]" options={{ title: 'Приёмка' }}/>
    </Stack>
  );
}
