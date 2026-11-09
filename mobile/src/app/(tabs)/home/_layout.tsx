import { Stack } from 'expo-router';
import { useStackOptions } from '@/ui/stack';

export const unstable_settings = { initialRouteName: 'index' };

export default function HomeStack() {
  const options = useStackOptions();
  return (
    <Stack screenOptions={options}>
      <Stack.Screen name="index" options={{ headerShown: false, title: 'Главная' }}/>
    </Stack>
  );
}
