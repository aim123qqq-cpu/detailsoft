import { Stack } from 'expo-router';
import { colors } from '@/lib/theme';

export default function AnalyticsStack() {
  return <Stack screenOptions={{ title: 'Статистика', headerStyle: { backgroundColor: colors.ground }, headerTintColor: colors.text, headerShadowVisible: false }}/>;
}
