import { Stack } from 'expo-router';
import { colors } from '@/lib/theme';

export default function BookingsStack() {
  return <Stack screenOptions={{ title: 'Записи', headerStyle: { backgroundColor: colors.ground }, headerTintColor: colors.text, headerShadowVisible: false }}/>;
}
