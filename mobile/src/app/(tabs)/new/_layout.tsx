import { Stack } from 'expo-router';
import { colors } from '@/lib/theme';

export const unstable_settings = { initialRouteName: 'index' };

/** New booking, step by step: client and vehicle, services, time, done. */
export default function NewStack() {
  return (
    <Stack screenOptions={{ headerStyle: { backgroundColor: colors.ground }, headerTintColor: colors.text, headerShadowVisible: false, contentStyle: { backgroundColor: colors.ground } }}>
      <Stack.Screen name="index" options={{ title: 'Новая запись' }}/>
      <Stack.Screen name="vehicle" options={{ title: 'Новый автомобиль' }}/>
      <Stack.Screen name="services" options={{ title: 'Услуги' }}/>
      <Stack.Screen name="schedule" options={{ title: 'Время' }}/>
      <Stack.Screen name="done" options={{ title: 'Запись создана', headerBackVisible: false, gestureEnabled: false }}/>
    </Stack>
  );
}
