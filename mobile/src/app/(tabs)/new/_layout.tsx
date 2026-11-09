import { Stack } from 'expo-router';
import { useStackOptions } from '@/ui/stack';

export const unstable_settings = { initialRouteName: 'index' };

/** New booking, step by step: client and vehicle, services, time, done. */
export default function NewStack() {
  const options = useStackOptions();
  return (
    <Stack screenOptions={{ ...options, headerShown: false }}>
      <Stack.Screen name="index" options={{ title: 'Новая запись' }}/>
      <Stack.Screen name="vehicle" options={{ title: 'Новый автомобиль' }}/>
      <Stack.Screen name="services" options={{ title: 'Услуги' }}/>
      <Stack.Screen name="schedule" options={{ title: 'Время' }}/>
      <Stack.Screen name="done" options={{ title: 'Запись создана', headerBackVisible: false, gestureEnabled: false }}/>
    </Stack>
  );
}
