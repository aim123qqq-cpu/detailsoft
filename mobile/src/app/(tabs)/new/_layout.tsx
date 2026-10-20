import { Stack } from 'expo-router';
import { colors } from '@/lib/theme';

export default function NewStack() {
  return <Stack screenOptions={{ title: 'Новая запись', headerStyle: { backgroundColor: colors.ground }, headerTintColor: colors.text, headerShadowVisible: false }}/>;
}
