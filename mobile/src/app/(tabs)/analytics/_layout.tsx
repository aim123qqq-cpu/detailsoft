import { Stack } from 'expo-router';
import { useStackOptions } from '@/ui/stack';

export default function AnalyticsStack() {
  const options = useStackOptions();
  return <Stack screenOptions={{ ...options, title: 'Статистика', headerShown: false }}/>;
}
