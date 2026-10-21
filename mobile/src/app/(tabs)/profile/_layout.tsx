import { Stack } from 'expo-router';
import { colors } from '@/lib/theme';

export const unstable_settings = { initialRouteName: 'index' };

/** The profile, and the center's management for those who may: catalog, team and roles, schedule. */
export default function ProfileStack() {
  return (
    <Stack screenOptions={{ headerStyle: { backgroundColor: colors.ground }, headerTintColor: colors.text, headerShadowVisible: false, contentStyle: { backgroundColor: colors.ground } }}>
      <Stack.Screen name="index" options={{ title: 'Профиль' }}/>
      <Stack.Screen name="catalog" options={{ title: 'Каталог услуг' }}/>
      <Stack.Screen name="service/[id]" options={{ title: 'Услуга' }}/>
      <Stack.Screen name="team" options={{ title: 'Команда и роли' }}/>
      <Stack.Screen name="member/[id]" options={{ title: 'Сотрудник' }}/>
      <Stack.Screen name="role/[key]" options={{ title: 'Роль' }}/>
      <Stack.Screen name="settings" options={{ title: 'График центра' }}/>
    </Stack>
  );
}
