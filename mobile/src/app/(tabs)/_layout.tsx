import { View } from 'react-native';
import { usePathname } from 'expo-router';
import { TabList, TabSlot, TabTrigger, Tabs } from 'expo-router/ui';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LegalGate } from '@/features/legal-checks';
import { NotificationsProvider, useUnread } from '@/features/notifications';
import { useSignedIn } from '@/lib/session';
import { useTheme } from '@/lib/theme';
import { TabBar, TabBarSpace, tabBarHeight } from '@/ui/tab-bar';

// The same places for every role (an unavailable section says so). Statistics opens from the home screen.
export const unstable_settings = { initialRouteName: 'home' };

// The floating navigation shows on the sections' own screens; a card or a step-by-step flow has its own bottom actions.
const WITH_BAR = new Set(['/', '/home', '/bookings', '/new', '/new/done', '/orders', '/profile', '/profile/team', '/analytics']);

export default function TabsLayout() {
  const session = useSignedIn();
  // A person who has not accepted this edition of the agreement and the consent sees them before any data.
  if (session.actor.legalAccepted === false) return <LegalGate centerName={session.tenant.name}/>;
  return <NotificationsProvider><SectionTabs/></NotificationsProvider>;
}

function SectionTabs() {
  // Unread notifications show on the profile, where the feed is.
  const { unread } = useUnread();
  const { colors } = useTheme();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const withBar = WITH_BAR.has(pathname);
  return (
    <Tabs style={{ flex: 1, backgroundColor: colors.ground }}>
      <TabBarSpace value={withBar ? tabBarHeight(insets.bottom) : 0}>
        <View style={{ flex: 1 }}><TabSlot/></View>
      </TabBarSpace>
      {withBar ? <TabBar badges={{ profile: unread }}/> : null}
      <TabList style={{ display: 'none' }}>
        <TabTrigger name="home" href="/home"/>
        <TabTrigger name="bookings" href="/bookings"/>
        <TabTrigger name="new" href="/new"/>
        <TabTrigger name="orders" href="/orders"/>
        <TabTrigger name="profile" href="/profile"/>
        <TabTrigger name="analytics" href="/analytics"/>
      </TabList>
    </Tabs>
  );
}
