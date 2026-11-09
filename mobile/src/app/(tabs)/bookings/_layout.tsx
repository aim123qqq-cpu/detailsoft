import { Stack } from 'expo-router';
import { useStackOptions } from '@/ui/stack';

export const unstable_settings = { initialRouteName: 'index' };

export default function BookingsStack() {
  const options = useStackOptions();
  return (
    <Stack screenOptions={options}>
      <Stack.Screen name="index" options={{ title: 'Записи' }}/>
      <Stack.Screen name="[id]" options={{ title: 'Запись' }}/>
    </Stack>
  );
}
