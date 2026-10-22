import { NativeTabs } from 'expo-router/native-tabs';
import { LegalGate } from '@/features/legal-checks';
import { useSignedIn } from '@/lib/session';
import { colors } from '@/lib/theme';

// The same five places for every role, as in the web app (an unavailable section says so).
export const unstable_settings = { initialRouteName: 'orders' };

export default function TabsLayout() {
  const session = useSignedIn();
  // A person who has not accepted this edition of the agreement and the consent sees them before any data.
  if (session.actor.legalAccepted === false) return <LegalGate centerName={session.tenant.name}/>;
  return (
    <NativeTabs backgroundColor={colors.ground} tintColor={colors.primary} iconColor={{ default: colors.muted, selected: colors.primary }}
      labelStyle={{ default: { color: colors.muted }, selected: { color: colors.primary } }} indicatorColor="rgba(255,121,57,.16)" labelVisibilityMode="labeled">
      <NativeTabs.Trigger name="analytics">
        <NativeTabs.Trigger.Icon sf="chart.bar" md="bar_chart"/>
        <NativeTabs.Trigger.Label>Статистика</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="bookings">
        <NativeTabs.Trigger.Icon sf="calendar" md="calendar_month"/>
        <NativeTabs.Trigger.Label>Записи</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="new">
        <NativeTabs.Trigger.Icon sf="plus.circle.fill" md="add_circle"/>
        <NativeTabs.Trigger.Label>Новая</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="orders">
        <NativeTabs.Trigger.Icon sf="doc.text" md="assignment"/>
        <NativeTabs.Trigger.Label>Заказы</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="profile">
        <NativeTabs.Trigger.Icon sf="person.crop.circle" md="account_circle"/>
        <NativeTabs.Trigger.Label>Профиль</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
