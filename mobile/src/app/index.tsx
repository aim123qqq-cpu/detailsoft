import { Redirect } from 'expo-router';
import { useSession } from '@/lib/session';

/** The app opens at "/": send it where the session stands. */
export default function Index() {
  const { state } = useSession();
  if (state.phase === 'signed-out') return <Redirect href="/login"/>;
  if (state.phase === 'offline') return <Redirect href="/offline"/>;
  return <Redirect href="/orders"/>;
}
