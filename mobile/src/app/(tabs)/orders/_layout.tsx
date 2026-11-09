import { Stack } from 'expo-router';
import { useStackOptions } from '@/ui/stack';

export const unstable_settings = { initialRouteName: 'index' };

export default function OrdersStack() {
  const options = useStackOptions();
  return (
    <Stack screenOptions={options}>
      <Stack.Screen name="index" options={{ title: 'Заказы' }}/>
      <Stack.Screen name="[id]" options={{ title: 'Заказ', headerShown: false }}/>
      <Stack.Screen name="intake/[id]" options={{ title: 'Приёмка', headerShown: false }}/>
      <Stack.Screen name="estimate/[id]" options={{ title: 'Смета', headerShown: false }}/>
      <Stack.Screen name="handover/[id]" options={{ title: 'Выдача' }}/>
      <Stack.Screen name="document/[id]" options={{ title: 'Документ' }}/>
    </Stack>
  );
}
