import { Stack } from 'expo-router';
import { colors } from '@/lib/theme';

export default function ProfileStack() {
  return <Stack screenOptions={{ title: 'Профиль', headerStyle: { backgroundColor: colors.ground }, headerTintColor: colors.text, headerShadowVisible: false }}/>;
}
