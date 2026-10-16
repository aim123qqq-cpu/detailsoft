import { createContext, useContext } from 'react';
import type { SessionContext } from './types';

/** The signed-in employee, loaded once by App; null while loading. Screens use it only to shape the UI — the server enforces access. */
export const SessionInfo = createContext<SessionContext | null>(null);

export const useSessionInfo = () => useContext(SessionInfo);

export function NoAccess({ section }: { section: string }) {
  return <section className="screen" data-testid="no-access">
    <div className="workspace-state no-access-state">
      <strong>{section} недоступен для вашей роли</strong>
      <span>Если он нужен вам в работе, попросите владельца центра добавить роль в разделе «Профиль → Команда».</span>
    </div>
  </section>;
}
