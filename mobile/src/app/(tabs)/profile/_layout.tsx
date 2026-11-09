import { Stack } from 'expo-router';
import { useStackOptions } from '@/ui/stack';

export const unstable_settings = { initialRouteName: 'index' };

/** The profile, and the center's management for those who may: catalog, team and roles, schedule. */
export default function ProfileStack() {
  const options = useStackOptions();
  return (
    <Stack screenOptions={options}>
      <Stack.Screen name="index" options={{ title: 'Профиль', headerShown: false }}/>
      <Stack.Screen name="catalog" options={{ title: 'Каталог услуг', headerShown: false }}/>
      <Stack.Screen name="service/[id]" options={{ title: 'Услуга', headerShown: false }}/>
      <Stack.Screen name="team" options={{ title: 'Команда и роли', headerShown: false }}/>
      <Stack.Screen name="member/[id]" options={{ title: 'Сотрудник', headerShown: false }}/>
      <Stack.Screen name="role/[key]" options={{ title: 'Роль', headerShown: false }}/>
      <Stack.Screen name="settings" options={{ title: 'График центра', headerShown: false }}/>
      <Stack.Screen name="notifications" options={{ title: 'Уведомления', headerShown: false }}/>
    </Stack>
  );
}
