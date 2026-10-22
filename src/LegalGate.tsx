import { useState } from 'react';
import { api } from './api';
import { LEGAL_VERSION, legalLinks } from './legal';

export type LegalState = { terms: boolean; consent: boolean };

/**
 * The user agreement and the consent to the processing of personal data: two separate ticks, because
 * since 1 September 2025 the consent is a document of its own (152-FZ art. 9). Nothing is pre-ticked.
 */
export function LegalChecks({ value, onChange }: { value: LegalState; onChange: (next: LegalState) => void }) {
  return (
    <div className="legal-checks">
      <label>
        <input type="checkbox" data-testid="accept-terms" checked={value.terms} onChange={(event) => onChange({ ...value, terms: event.target.checked })}/>
        <span>Принимаю <a href={legalLinks.terms} target="_blank" rel="noopener">Пользовательское соглашение</a></span>
      </label>
      <label>
        <input type="checkbox" data-testid="accept-consent" checked={value.consent} onChange={(event) => onChange({ ...value, consent: event.target.checked })}/>
        <span>Даю <a href={legalLinks.consent} target="_blank" rel="noopener">согласие на обработку персональных данных</a></span>
      </label>
      <small>Как мы обращаемся с данными — в <a href={legalLinks.privacy} target="_blank" rel="noopener">Политике обработки персональных данных</a>.</small>
    </div>
  );
}

/** Shown once per edition to a signed-in person who has not accepted the documents yet. */
export function LegalGate({ centerName, onAccepted, onSignOut }: { centerName: string; onAccepted: () => void; onSignOut: () => void }) {
  const [value, setValue] = useState<LegalState>({ terms: false, consent: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const accept = async () => {
    setBusy(true); setError('');
    try { await api.acceptLegal(LEGAL_VERSION); onAccepted(); }
    catch (requestError) { setError((requestError as Error).message); setBusy(false); }
  };
  return (
    <section className="screen legal-gate" data-testid="legal-gate">
      <h1>Перед началом работы</h1>
      <p>Вы входите в «{centerName}». Чтобы пользоваться DetailFlow, примите соглашение и дайте согласие на обработку ваших персональных данных: имени, аккаунта мессенджера и действий в заказах.</p>
      <LegalChecks value={value} onChange={setValue}/>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <button className="primary-button" data-testid="accept-legal" disabled={busy || !value.terms || !value.consent} onClick={accept}>{busy ? 'Сохраняем…' : 'Продолжить'}</button>
      <button className="login-secondary" onClick={onSignOut}>Выйти</button>
    </section>
  );
}
