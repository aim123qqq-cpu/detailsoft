import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { ScheduleStep, ServicesStep } from './BookingFlow';
import { OrderFlow } from './OrderFlow';
import { BookingsWorkspace, OrdersWorkspace } from './WorkspaceScreens';
import { AnalyticsScreen } from './AnalyticsScreen';
import { ProfileScreen } from './ProfileScreen';
import type { Booking, BookingQuote, CatalogVariant, Customer, Lead, QuoteSelection, Vehicle } from './types';

type Workspace = 'bookings' | 'new' | 'orders' | 'analytics' | 'profile';

type IconName = 'arrow' | 'search' | 'phone' | 'car' | 'user' | 'calendar' | 'clipboard' | 'plus' | 'check' | 'spark' | 'chart';

function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
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

const bodyLabels: Record<string, string> = { sedan: 'седан', hatchback: 'хэтчбек', suv: 'кроссовер' };
const channels = ['Telegram', 'VK', 'Instagram', 'Звонок', 'На месте'];
const leadChannelLabels: Record<Lead['channel'], string> = {
  telegram: 'Telegram', vk: 'VK', instagram: 'Instagram', call: 'Звонок', in_person: 'На месте'
};

function formatPhoneInput(value: string) {
  const digits = value.replace(/\D/g, '').replace(/^8/, '7').slice(0, 11);
  if (!digits) return '';
  const normalized = digits.startsWith('7') ? digits : `7${digits}`;
  const parts = [normalized.slice(1, 4), normalized.slice(4, 7), normalized.slice(7, 9), normalized.slice(9, 11)];
  let result = '+7';
  if (parts[0]) result += ` ${parts[0]}`;
  if (parts[1]) result += ` ${parts[1]}`;
  if (parts[2]) result += `-${parts[2]}`;
  if (parts[3]) result += `-${parts[3]}`;
  return result;
}

function VehicleCard({ vehicle, onSelect }: { vehicle: Vehicle; onSelect: () => void }) {
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

function Header({ step, workspace, onBack, orderTitle }: { step: number; workspace: Workspace; onBack: () => void; orderTitle?: string }) {
  const workspaceTitle = workspace === 'bookings' ? 'Записи' : workspace === 'analytics' ? 'Статистика' : workspace === 'profile' ? 'Профиль' : 'Заказы';
  return (
    <header className="app-header">
      <button className="icon-button" onClick={onBack} aria-label="Назад"><Icon name="arrow"/></button>
      <div>
        <span className="eyebrow">{workspace === 'bookings' ? 'Расписание' : workspace === 'orders' ? 'Производство' : workspace === 'analytics' ? 'Управление' : workspace === 'profile' ? 'Аккаунт' : step === 5 ? 'Рабочий заказ' : 'Новая запись'}</span>
        <h1>{workspace !== 'new' ? workspaceTitle : step === 1 ? 'Клиент и автомобиль' : step === 2 ? 'Добавить автомобиль' : step === 3 ? 'Услуги' : step === 4 ? 'Дата и время' : orderTitle ?? 'Рабочий заказ'}</h1>
      </div>
      <span aria-hidden="true"/>
      {workspace === 'new' && <div className="progress" aria-label={step === 5 ? 'Рабочий заказ' : `Шаг ${step} из 4`}>
        {[1, 2, 3, 4].map((item) => <span key={item} className={item <= step ? 'active' : ''}/>) }
      </div>}
    </header>
  );
}

function BottomNav({ active, onSelect }: { active: Workspace; onSelect: (workspace: Workspace) => void }) {
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

export function App() {
  const [workspace, setWorkspace] = useState<Workspace>('new');
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [mode, setMode] = useState<'phone' | 'plate'>('phone');
  const [channel, setChannel] = useState('Telegram');
  const [query, setQuery] = useState('');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [plateVehicles, setPlateVehicles] = useState<Array<Vehicle & { customer: Customer | null }>>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [selectedVehicle, setSelectedVehicle] = useState<Vehicle | null>(null);
  const [serviceSelections, setServiceSelections] = useState<QuoteSelection[]>([]);
  const [bookingQuote, setBookingQuote] = useState<BookingQuote | null>(null);
  const [activeBooking, setActiveBooking] = useState<Booking | null>(null);
  const [activeLead, setActiveLead] = useState<Lead | null>(null);
  const [orderHeader, setOrderHeader] = useState('Приёмка автомобиля');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [online, setOnline] = useState(() => navigator.onLine);
  const [searchRetryKey, setSearchRetryKey] = useState(0);
  const [showCreateCustomer, setShowCreateCustomer] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState('');

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [step, workspace]);

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    if (workspace !== 'new') return;
    setCustomers([]);
    setPlateVehicles([]);
    setSelectedCustomer(null);
    setShowCreateCustomer(false);
    if (query.replace(/\D/g, '').length < (mode === 'phone' ? 4 : 2)) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError('');
      try {
        if (mode === 'phone') {
          const result = await api.searchCustomers(query, controller.signal);
          setCustomers(result.items);
          if (result.items.length === 1) setSelectedCustomer(result.items[0]);
          setShowCreateCustomer(result.items.length === 0);
        } else {
          const result = await api.searchVehicles(query, controller.signal);
          setPlateVehicles(result.items);
        }
      } catch (requestError) {
        if ((requestError as Error).name !== 'AbortError') setError((requestError as Error).message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 320);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, mode, workspace, searchRetryKey]);

  const startNewBooking = () => {
    setWorkspace('new');
    setStep(1);
    setMode('phone');
    setQuery('');
    setCustomers([]);
    setPlateVehicles([]);
    setSelectedCustomer(null);
    setSelectedVehicle(null);
    setServiceSelections([]);
    setBookingQuote(null);
    setActiveBooking(null);
    setActiveLead(null);
    setOrderHeader('Приёмка автомобиля');
    setError('');
    setSearchRetryKey(0);
    setShowCreateCustomer(false);
    setNewCustomerName('');
  };

  const startLeadBooking = (lead: Lead) => {
    setWorkspace('new');
    setStep(1);
    setMode('phone');
    setChannel(leadChannelLabels[lead.channel]);
    setQuery(formatPhoneInput(lead.phoneDisplay));
    setCustomers([]);
    setPlateVehicles([]);
    setSelectedCustomer(null);
    setSelectedVehicle(null);
    setServiceSelections([]);
    setBookingQuote(null);
    setActiveBooking(null);
    setActiveLead(lead);
    setNewCustomerName(lead.contactName);
    setError('');
  };

  const selectWorkspace = (nextWorkspace: Workspace) => {
    if (nextWorkspace === 'new') startNewBooking();
    else setWorkspace(nextWorkspace);
  };

  const chooseVehicle = (vehicle: Vehicle, customer?: Customer | null) => {
    if (customer) setSelectedCustomer(customer);
    setSelectedVehicle(vehicle);
    setServiceSelections([]);
    setBookingQuote(null);
    setStep(3);
  };

  const createCustomer = async () => {
    setLoading(true);
    setError('');
    try {
      const customer = await api.createCustomer({ name: newCustomerName, phone: query });
      setSelectedCustomer(customer);
      setCustomers([customer]);
      setShowCreateCustomer(false);
      setStep(2);
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Перейти к содержимому</a>
      {!online && <div className="connectivity-banner" data-testid="offline-banner" role="status" aria-live="polite"><strong>Нет подключения</strong><span>Можно продолжить ввод — данные формы не пропадут</span></div>}
      <Header step={step} workspace={workspace} orderTitle={orderHeader} onBack={() => workspace !== 'new' ? startNewBooking() : step === 1 ? setQuery('') : setStep(step === 5 ? 4 : step === 4 ? 3 : 1)}/>
      <main id="main-content" tabIndex={-1}>
        {workspace === 'bookings' && <BookingsWorkspace onNew={startNewBooking} onLeadConvert={startLeadBooking}/>}
        {workspace === 'orders' && <OrdersWorkspace/>}
        {workspace === 'analytics' && <AnalyticsScreen/>}
        {workspace === 'profile' && <ProfileScreen/>}
        {workspace === 'new' && step === 1 && (
          <section className="screen" aria-label="Поиск клиента и автомобиля">
            {activeLead && <div className="lead-conversion-banner"><span>Обращение · {leadChannelLabels[activeLead.channel]}</span><strong>{activeLead.contactName}</strong><small>Выберите клиента и автомобиль — обращение закроется после создания записи.</small></div>}
            <div className="context-line"><span className="live-dot"/> DetailFlow Studio <span>·</span> Сегодня, 14:30</div>
            <div className="section-block compact">
              <label className="section-label">Канал обращения</label>
              <div className="chips" role="group" aria-label="Канал обращения">
                {channels.map((item) => <button key={item} aria-pressed={channel === item} className={channel === item ? 'selected' : ''} onClick={() => setChannel(item)}>{channel === item && <Icon name="check" size={14}/>} {item}</button>)}
              </div>
            </div>
            <div className="search-panel">
              <div className="search-tabs">
                <button aria-pressed={mode === 'phone'} className={mode === 'phone' ? 'active' : ''} onClick={() => { setMode('phone'); setQuery(''); }}><Icon name="phone" size={17}/> По телефону</button>
                <button aria-pressed={mode === 'plate'} className={mode === 'plate' ? 'active' : ''} onClick={() => { setMode('plate'); setQuery(''); }}><Icon name="car" size={18}/> По госномеру</button>
              </div>
              <label htmlFor="search-input">{mode === 'phone' ? 'Телефон клиента' : 'Госномер автомобиля'}</label>
              <div className={`search-input ${error ? 'invalid' : ''}`}>
                <Icon name="search"/>
                <input
                  id="search-input"
                  data-testid="main-search"
                  value={query}
                  inputMode={mode === 'phone' ? 'tel' : 'text'}
                  autoComplete="off"
                  placeholder={mode === 'phone' ? '+7 999 000-00-00' : 'А123АА 55'}
                  onChange={(event) => setQuery(mode === 'phone' ? formatPhoneInput(event.target.value) : event.target.value.toLocaleUpperCase('ru-RU'))}
                />
                {loading && <span className="spinner" aria-label="Поиск"/>}
              </div>
              <div className="field-feedback" data-testid="search-feedback">
                <p aria-live="polite" className={error ? 'field-hint error' : 'field-hint'}>{error || (mode === 'phone' ? 'Начните вводить номер — найдём клиента и его автомобили' : 'Поиск работает только внутри текущего центра')}</p>
                {error && <button data-testid="search-retry" disabled={loading || !online} onClick={() => setSearchRetryKey((key) => key + 1)}>Повторить</button>}
              </div>
            </div>

            {mode === 'phone' && customers.map((customer) => (
              <div className="customer-result" key={customer.id} data-testid="customer-result">
                <div className="customer-head">
                  <span className="avatar">АМ</span>
                  <span><strong>{customer.name}</strong><small>{customer.phoneDisplay} · {customer.visitCount} визитов</small></span>
                  <span className="match-badge"><Icon name="check" size={13}/> найден</span>
                </div>
                <div className="result-title"><span>Автомобили клиента</span><small>{customer.vehicles.length}</small></div>
                <div className="vehicle-list">
                  {customer.vehicles.map((vehicle) => <VehicleCard key={vehicle.id} vehicle={vehicle} onSelect={() => chooseVehicle(vehicle, customer)}/>) }
                </div>
                <button className="add-row" onClick={() => { setSelectedCustomer(customer); setStep(2); }}><span><Icon name="plus"/></span> Добавить автомобиль</button>
              </div>
            ))}

            {mode === 'phone' && showCreateCustomer && (
              <div className="empty-state">
                <span className="empty-icon"><Icon name="user"/></span>
                <strong>Клиент не найден</strong>
                <p>Номер сохранён — добавьте имя, чтобы продолжить.</p>
                <input aria-label="Имя клиента" value={newCustomerName} onChange={(event) => setNewCustomerName(event.target.value)} placeholder="Имя клиента"/>
                <button className="primary-button" disabled={newCustomerName.trim().length < 2 || loading} onClick={createCustomer}>Создать клиента</button>
              </div>
            )}

            {mode === 'plate' && plateVehicles.map((vehicle) => (
              <div className="customer-result" key={vehicle.id}>
                {vehicle.customer && <div className="found-owner"><Icon name="user"/> {vehicle.customer.name} <span>{vehicle.customer.phoneDisplay}</span></div>}
                <VehicleCard vehicle={vehicle} onSelect={() => chooseVehicle(vehicle, vehicle.customer)}/>
              </div>
            ))}
          </section>
        )}

        {workspace === 'new' && step === 2 && selectedCustomer && <AddVehicle customer={selectedCustomer} onCancel={() => setStep(1)} onCreated={(vehicle) => chooseVehicle(vehicle, selectedCustomer)}/>}

        {workspace === 'new' && step === 3 && selectedVehicle && (
          <ServicesStep
            vehicle={selectedVehicle}
            initialSelections={serviceSelections}
            onBack={() => setStep(1)}
            onContinue={(selections, quote) => {
              setServiceSelections(selections);
              setBookingQuote(quote);
              setStep(4);
            }}
          />
        )}
        {workspace === 'new' && step === 4 && selectedVehicle && selectedCustomer && bookingQuote && (
          <ScheduleStep
            customer={selectedCustomer}
            vehicle={selectedVehicle}
            channel={channel}
            selections={serviceSelections}
            quote={bookingQuote}
            leadId={activeLead?.id}
            onBack={() => setStep(3)}
            onStartIntake={(booking) => { setActiveBooking(booking); setStep(5); }}
          />
        )}
        {workspace === 'new' && step === 5 && activeBooking && selectedVehicle && selectedCustomer && (
          <OrderFlow booking={activeBooking} customer={selectedCustomer} vehicle={selectedVehicle} onPhaseChange={setOrderHeader}/>
        )}
      </main>
      <BottomNav active={workspace} onSelect={selectWorkspace}/>
    </div>
  );
}

function AddVehicle({ customer, onCancel, onCreated }: { customer: Customer; onCancel: () => void; onCreated: (vehicle: Vehicle) => void }) {
  const [modelQuery, setModelQuery] = useState('Mazda 3 BL');
  const [variants, setVariants] = useState<CatalogVariant[]>([]);
  const [variant, setVariant] = useState<CatalogVariant | null>(null);
  const [plate, setPlate] = useState('');
  const [color, setColor] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      if (modelQuery.trim().length < 2) return setVariants([]);
      try {
        const result = await api.searchCatalog(modelQuery, controller.signal);
        setVariants(result.items);
        if (result.items.length === 1) setVariant(result.items[0]);
      } catch (requestError) {
        if ((requestError as Error).name !== 'AbortError') setError((requestError as Error).message);
      }
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [modelQuery]);

  const chosenSummary = useMemo(() => variant ? `${variant.make} ${variant.model} ${variant.generation} · ${bodyLabels[variant.bodyType] ?? variant.bodyType}` : '', [variant]);
  const submit = async () => {
    if (!variant) return;
    setLoading(true);
    setError('');
    try {
      const result = await api.createVehicle({ customerId: customer.id, catalogVariantId: variant.id, plateDisplay: plate, color });
      onCreated(result.vehicle);
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="screen add-vehicle-screen" data-testid="add-vehicle-screen">
      <div className="customer-strip"><span className="avatar small">АМ</span><span><small>Владелец</small><strong>{customer.name}</strong></span><button onClick={onCancel}>Сменить</button></div>
      <div className="form-group">
        <label htmlFor="model-search">Марка, модель или поколение</label>
        <div className="search-input filled"><Icon name="search"/><input id="model-search" value={modelQuery} onChange={(event) => { setModelQuery(event.target.value); setVariant(null); }}/></div>
        {variants.length > 1 && <p className="choice-note"><Icon name="spark" size={16}/> Найдено несколько кузовов — выберите подходящий</p>}
        <div className="variant-grid">
          {variants.map((item) => <button key={item.id} aria-pressed={variant?.id === item.id} className={variant?.id === item.id ? 'selected' : ''} onClick={() => setVariant(item)}>
            <span className="variant-icon"><Icon name="car" size={26}/></span>
            <strong>{bodyLabels[item.bodyType] ?? item.bodyType}</strong>
            <small>{item.yearFrom}–{item.yearTo}</small>
            {variant?.id === item.id && <span className="variant-check"><Icon name="check" size={14}/></span>}
          </button>)}
        </div>
      </div>
      <div className="form-row">
        <div className="form-group"><label htmlFor="plate">Госномер</label><input id="plate" data-testid="plate-input" value={plate} onChange={(event) => setPlate(event.target.value.toLocaleUpperCase('ru-RU'))} placeholder="А123АА 55"/></div>
        <div className="form-group"><label htmlFor="color">Цвет</label><input id="color" data-testid="color-input" value={color} onChange={(event) => setColor(event.target.value)} placeholder="Например, графит"/></div>
      </div>
      {chosenSummary && <div className="auto-summary"><Icon name="check"/><span><small>Определено по справочнику</small><strong>{chosenSummary}</strong></span></div>}
      {error && <p className="form-error">{error}</p>}
      <button className="primary-button sticky-cta" data-testid="save-vehicle" onClick={submit} disabled={!variant || plate.trim().length < 3 || color.trim().length < 2 || loading}>
        {loading ? <span className="spinner light"/> : <>Сохранить и выбрать <span>→</span></>}
      </button>
    </section>
  );
}
