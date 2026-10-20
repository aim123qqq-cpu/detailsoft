import { Stack } from 'expo-router';
import { colors } from '@/lib/theme';

export const unstable_settings = { initialRouteName: 'index' };

export default function OrdersStack() {
  return (
    <Stack screenOptions={{ headerStyle: { backgroundColor: colors.ground }, headerTintColor: colors.text, headerShadowVisible: false, contentStyle: { backgroundColor: colors.ground } }}>
      <Stack.Screen name="index" options={{ title: 'Заказы' }}/>
      <Stack.Screen name="[id]" options={{ title: 'Заказ' }}/>
      <Stack.Screen name="intake/[id]" options={{ title: 'Приёмка' }}/>
      <Stack.Screen name="estimate/[id]" options={{ title: 'Смета' }}/>
      <Stack.Screen name="handover/[id]" options={{ title: 'Выдача' }}/>
      <Stack.Screen name="document/[id]" options={{ title: 'Документ' }}/>
    </Stack>
  );
}
