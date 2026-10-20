import { Stack } from 'expo-router';
import { colors } from '@/lib/theme';

export default function OrdersStack() {
  return (
    <Stack screenOptions={{ headerStyle: { backgroundColor: colors.ground }, headerTintColor: colors.text, headerShadowVisible: false, contentStyle: { backgroundColor: colors.ground } }}>
      <Stack.Screen name="index" options={{ title: 'Заказы' }}/>
      <Stack.Screen name="[id]" options={{ title: 'Заказ' }}/>
    </Stack>
  );
}
