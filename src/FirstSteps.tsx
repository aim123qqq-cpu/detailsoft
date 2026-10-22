import { useEffect, useState } from 'react';
import { api } from './api';

export type SetupTarget = 'catalog' | 'team' | 'settings' | 'booking';
type Setup = { services: number; members: number; bookings: number };

/**
 * A new center's owner sees what to do before the first customer: services, the team, a booking.
 * Done steps are ticked; once all are done the card is gone. Offline it simply does not show.
 */
export function FirstSteps({ onOpen, refreshToken }: { onOpen: (target: SetupTarget) => void; refreshToken?: unknown }) {
  const [setup, setSetup] = useState<Setup | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api.getCenterSetup(controller.signal).then(setSetup).catch(() => setSetup(null));
    return () => controller.abort();
  }, [refreshToken]);

  if (!setup) return null;
  const steps: { target: SetupTarget; title: string; text: string; done: boolean }[] = [
    { target: 'catalog', title: 'Добавьте услуги', text: 'Название, время и цена — без них не записать клиента.', done: setup.services > 0 },
    { target: 'team', title: 'Пригласите команду', text: 'Администраторы и мастера войдут по своему коду или через Telegram.', done: setup.members > 1 },
    { target: 'booking', title: 'Запишите первого клиента', text: 'Телефон, автомобиль, услуги и время — начните ниже.', done: setup.bookings > 0 }
  ];
  if (steps.every((step) => step.done)) return null;

  return (
    <section className="first-steps" data-testid="first-steps" aria-labelledby="first-steps-title">
      <h2 id="first-steps-title">Первые шаги</h2>
      <p>Часы работы центра — в <button className="first-steps-link" onClick={() => onOpen('settings')}>«Графике центра»</button>.</p>
      <ol>
        {steps.map((step, index) => (
          <li key={step.target} className={step.done ? 'done' : ''}>
            <button onClick={() => onOpen(step.target)} data-testid={`first-step-${step.target}`}>
              <i aria-hidden="true">{step.done ? '✓' : index + 1}</i>
              <span><b>{step.title}</b>{step.done ? <small>Готово</small> : <small>{step.text}</small>}</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
