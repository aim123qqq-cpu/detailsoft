import type { Vehicle } from '../types';
import { bodyLabels } from './AddVehicle';

export type Workspace = 'bookings' | 'new' | 'orders' | 'analytics' | 'profile';

export type IconName = 'arrow' | 'search' | 'phone' | 'car' | 'user' | 'calendar' | 'clipboard' | 'plus' | 'check' | 'spark' | 'chart';

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    arrow: <><path d="M15 18l-6-6 6-6"/><path d="M9 12h10"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    phone: <path d="M8.5 3.5 6 4.5c-.8.3-1.2 1.1-1 1.9 1.3 5.9 5.7 10.3 11.6 11.6.8.2 1.6-.2 1.9-1l1-2.5-4-2-1.2 1.8c-2.3-.9-3.7-2.3-4.6-4.6l1.8-1.2-2-4Z"/>,
    car: <><path d="M4 15v-4l2-5h12l2 5v4"/><path d="M4 13h16M7 13v2m10-2v2M6 18h1m10 0h1"/></>,
    user: <><circle cx="12" cy="8" r="3"/><path d="M5.5 20c.7-4 3-6 6.5-6s5.8 2 6.5 6"/></>,
    calendar: <><rect x="4" y="5" width="16" height="15" rx="3"/><path d="M8 3v4m8-4v4M4 10h16"/></>,
    clipboard: <><path d="M9 5h6l1 2h3v14H5V7h3l1-2Z"/><path d="M9 12h6m-6 4h4"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    check: <path d="m5 12 4 4L19 6"/>,
    spark: <><path d="m12 3 1.2 4.3L17 9l-3.8 1.7L12 15l-1.2-4.3L7 9l3.8-1.7L12 3Z"/><path d="m18 15 .7 2.3L21 18l-2.3.7L18 21l-.7-2.3L15 18l2.3-.7L18 15Z"/></>,
    chart: <><path d="M5 19V9m7 10V5m7 14v-7"/><path d="M3 19h18"/></>
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

export function VehicleCard({ vehicle, onSelect }: { vehicle: Vehicle; onSelect: () => void }) {
  return (
    <button className="vehicle-card" onClick={onSelect} data-testid={`vehicle-${vehicle.id}`}>
      <span className="vehicle-mark"><Icon name="car" size={22}/></span>
      <span className="vehicle-copy">
        <strong>{vehicle.make} {vehicle.model} {vehicle.generation}</strong>
        <span>{bodyLabels[vehicle.bodyType ?? ''] ?? vehicle.bodyType} · {vehicle.color}</span>
      </span>
      <span className="plate">{vehicle.plate}</span>
      <span className="card-arrow">›</span>
    </button>
  );
}

export function Header({ step, workspace, onBack, orderTitle, overlayTitle, overlayEyebrow }: { step: number; workspace: Workspace; onBack: () => void; orderTitle?: string; overlayTitle?: string; overlayEyebrow?: string }) {
  const workspaceTitle = workspace === 'bookings' ? 'Записи' : workspace === 'analytics' ? 'Статистика' : workspace === 'profile' ? 'Профиль' : 'Заказы';
  return (
    <header className="app-header">
      <button className="icon-button" onClick={onBack} aria-label="Назад"><Icon name="arrow"/></button>
      <div>
        <span className="eyebrow">{overlayTitle ? overlayEyebrow ?? 'Клиенты и автомобили' : workspace === 'bookings' ? 'Расписание' : workspace === 'orders' ? 'Производство' : workspace === 'analytics' ? 'Управление' : workspace === 'profile' ? 'Аккаунт' : step === 5 ? 'Рабочий заказ' : 'Новая запись'}</span>
        <h1>{overlayTitle ?? (workspace !== 'new' ? workspaceTitle : step === 1 ? 'Клиент и автомобиль' : step === 2 ? 'Добавить автомобиль' : step === 3 ? 'Услуги' : step === 4 ? 'Дата и время' : orderTitle ?? 'Рабочий заказ')}</h1>
      </div>
      <span aria-hidden="true"/>
      {workspace === 'new' && !overlayTitle && <div className="progress" aria-label={step === 5 ? 'Рабочий заказ' : `Шаг ${step} из 4`}>
        {[1, 2, 3, 4].map((item) => <span key={item} className={item <= step ? 'active' : ''}/>) }
      </div>}
    </header>
  );
}

export function BottomNav({ active, onSelect }: { active: Workspace; onSelect: (workspace: Workspace) => void }) {
  return (
    <nav className="bottom-nav" aria-label="Основная навигация">
      <button data-testid="analytics-nav" className={active === 'analytics' ? 'active' : ''} aria-current={active === 'analytics' ? 'page' : undefined} onClick={() => onSelect('analytics')}><Icon name="chart"/><span>Статистика</span></button>
      <button data-testid="bookings-nav" className={active === 'bookings' ? 'active' : ''} aria-current={active === 'bookings' ? 'page' : undefined} onClick={() => onSelect('bookings')}><Icon name="calendar"/><span>Записи</span></button>
      <button data-testid="new-booking-nav" className={`new-nav ${active === 'new' ? 'active' : ''}`} aria-label="Новая запись" aria-current={active === 'new' ? 'page' : undefined} onClick={() => onSelect('new')}><span className="nav-action"><Icon name="plus" size={24}/></span></button>
      <button data-testid="orders-nav" className={active === 'orders' ? 'active' : ''} aria-current={active === 'orders' ? 'page' : undefined} onClick={() => onSelect('orders')}><Icon name="clipboard"/><span>Заказы</span></button>
      <button data-testid="profile-nav" className={active === 'profile' ? 'active' : ''} aria-current={active === 'profile' ? 'page' : undefined} onClick={() => onSelect('profile')}><Icon name="user"/><span>Профиль</span></button>
    </nav>
  );
}
