import { useEffect, useRef, useState } from 'react';
import { api, authSession, demoAuthEnabled } from './api';
import { LoginScreen } from './LoginScreen';
import { visitsLabel } from './format';
import { NoAccess, SessionInfo } from './session';
import { ScheduleStep, ServicesStep } from './BookingFlow';
import { OrderFlow } from './OrderFlow';
import { FirstSteps, type SetupTarget } from './FirstSteps';
import { SyncBanner } from './SyncBanner';
import { pruneCache, syncState } from './offline/sync';
import { BookingsWorkspace } from './workspace/BookingsWorkspace';
import { OrdersWorkspace } from './workspace/OrdersWorkspace';
import { AnalyticsScreen } from './AnalyticsScreen';
import { ProfileScreen } from './ProfileScreen';
import { VehicleProfileScreen } from './VehicleProfileScreen';
import { CustomerProfileScreen } from './CustomerProfileScreen';
import type { Booking, BookingQuote, Customer, Lead, OrderTarget, QuoteSelection, SessionContext, Vehicle } from './types';
import { type Workspace, Icon, VehicleCard, Header, BottomNav } from './app/AppChrome';
import { AddVehicle } from './app/AddVehicle';
import { OrderWorkspaceLoader } from './app/OrderWorkspaceLoader';

type ProfileOverlay = { kind: 'customer' | 'vehicle'; id: string } | ({ kind: 'order' } & OrderTarget);

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

/** A search handed over in the link (the landing page opens `/?phone=…` or `/?plate=…`); read once, then dropped from the URL. */
function initialSearch(): { mode: 'phone' | 'plate'; query: string } {
  const params = new URLSearchParams(window.location.search);
  const phone = params.get('phone');
  const plate = params.get('plate');
  if (phone === null && plate === null) return { mode: 'phone', query: '' };
  params.delete('phone');
  params.delete('plate');
  window.history.replaceState(null, '', `${window.location.pathname}${params.size ? `?${params}` : ''}${window.location.hash}`);
  return plate !== null
    ? { mode: 'plate', query: plate.slice(0, 12).toLocaleUpperCase('ru-RU') }
    : { mode: 'phone', query: formatPhoneInput(phone!.slice(0, 20)) };
}

export function App() {
  const [handedSearch] = useState(initialSearch);
  const [workspace, setWorkspace] = useState<Workspace>('new');
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [mode, setMode] = useState<'phone' | 'plate'>(handedSearch.mode);
  const [channel, setChannel] = useState('Telegram');
  const [query, setQuery] = useState(handedSearch.query);
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
  const createCustomerCard = useRef<HTMLDivElement>(null);
  const [newCustomerName, setNewCustomerName] = useState('');
  const [profileVehicleId, setProfileVehicleId] = useState<string | null>(null);
  const [overlays, setOverlays] = useState<ProfileOverlay[]>([]);
  const overlay = overlays.at(-1) ?? null;
  // 'checking' until the server says whether sign-in is required; a stored session skips the check.
  const [authGate, setAuthGate] = useState<'checking' | 'login' | 'app'>(() => authSession.token() || authSession.demoChosen() ? 'app' : 'checking');
  const [demoAllowed, setDemoAllowed] = useState(demoAuthEnabled);
  const [session, setSession] = useState<SessionContext | null>(null);
  // The profile opens on its main page, or straight on a section (from the first steps); n remounts it.
  const [profileTarget, setProfileTarget] = useState<{ open?: 'catalog' | 'team' | 'settings'; n: number }>({ n: 0 });

  // Roles shape the UI: a master starts on Orders, intake on Bookings. The server still checks every request.
  useEffect(() => {
    if (authGate !== 'app') return;
    const controller = new AbortController();
    api.getSession(controller.signal).then((loaded) => {
      setSession(loaded);
      if (!loaded.capabilities.manageBookings) setWorkspace((current) => current === 'new' ? (loaded.capabilities.manageIntake ? 'bookings' : 'orders') : current);
    }).catch(() => { /* a 401 is handled globally; other errors keep the default layout */ });
    return () => controller.abort();
  }, [authGate]);

  // Front-desk staff keep what booking needs offline (schedule, prices, busy time, customers).
  const canBook = Boolean(session?.capabilities.manageBookings);
  const canAssign = Boolean(session?.capabilities.assignMasters);
  useEffect(() => {
    // The masters list lets an admin assign work without the server.
    if (canAssign) api.listMasters().catch(() => {});
  }, [canAssign]);
  useEffect(() => {
    if (!canBook) return;
    void api.refreshBookingPack(true);
    const timer = setInterval(() => { void api.refreshBookingPack(); }, 10 * 60_000);
    return () => clearInterval(timer);
  }, [canBook]);

  // The phone's copy is cleaned up while the server is reachable: on start and every 6 hours.
  const signedIn = Boolean(session);
  useEffect(() => {
    if (!signedIn) return;
    const clean = () => { if (syncState().reachable) void pruneCache(); };
    clean();
    const timer = setInterval(clean, 6 * 60 * 60_000);
    return () => clearInterval(timer);
  }, [signedIn]);

  // Offline changes reached the server: reload lists and the booking pack.
  useEffect(() => {
    const synced = () => {
      setWorkspaceRefresh((value) => value + 1);
      if (canBook) void api.refreshBookingPack(true);
    };
    window.addEventListener('detailflow:synced', synced);
    return () => window.removeEventListener('detailflow:synced', synced);
  }, [canBook]);

  useEffect(() => {
    const requireSignIn = () => setAuthGate('login');
    window.addEventListener('detailflow:unauthorized', requireSignIn);
    return () => window.removeEventListener('detailflow:unauthorized', requireSignIn);
  }, []);

  useEffect(() => {
    if (authGate !== 'checking') return;
    const controller = new AbortController();
    api.getAuthProviders(controller.signal)
      .then((result) => {
        const allowed = result.demo && demoAuthEnabled;
        setDemoAllowed(allowed);
        // A configured bot means real accounts exist: open with the sign-in screen, demo stays optional.
        setAuthGate(result.items.length > 0 || !allowed ? 'login' : 'app');
      })
      .catch((requestError: Error) => { if (requestError.name !== 'AbortError') setAuthGate(demoAuthEnabled ? 'app' : 'login'); });
    return () => controller.abort();
  }, [authGate]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [step, workspace, overlays.length]);

  const openCustomerProfile = (customerId: string) => setOverlays((stack) => [...stack, { kind: 'customer', id: customerId }]);
  const openVehicleOverlay = (vehicleId: string) => setOverlays((stack) => [...stack, { kind: 'vehicle', id: vehicleId }]);
  const openOrderWorkspace = (target: OrderTarget) => {
    setOrderHeader('Рабочий заказ');
    setOverlays((stack) => [...stack, { kind: 'order', ...target }]);
  };
  // Lists under an overlay are refreshed on return: intake, work or handover may have changed them.
  const [workspaceRefresh, setWorkspaceRefresh] = useState(0);
  const closeOverlay = () => {
    setOverlays((stack) => stack.slice(0, -1));
    setWorkspaceRefresh((value) => value + 1);
  };

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
    // A booking started from a customer card jumps straight to step 3 with a preselected customer.
    if (workspace !== 'new' || step !== 1) return;
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
          // Archived matches are shown too, so a returning customer is reactivated instead of duplicated.
          const result = await api.searchCustomers(query, controller.signal, true);
          setCustomers(result.items);
          if (result.items.length === 1 && !result.items[0].archived) setSelectedCustomer(result.items[0]);
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

  // On a phone the keyboard covers the lower half of the screen, and "not found" appears below the search:
  // a full number moves on to the name (the phone scrolls to it), a partial one only brings the card into view.
  useEffect(() => {
    if (!showCreateCustomer) return;
    const card = createCustomerCard.current;
    card?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (query.replace(/\D/g, '').length >= 11) card?.querySelector('input')?.focus({ preventScroll: true });
    // Only when the card appears: typing more digits must not pull the focus away.
  }, [showCreateCustomer]);

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
    setProfileVehicleId(null);
    setOverlays([]);
  };

  const startLeadBooking = (lead: Lead) => {
    setOverlays([]);
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

  const openSetupStep = (target: SetupTarget) => {
    if (target === 'booking') return document.getElementById('search-input')?.focus();
    setProfileTarget((current) => ({ open: target, n: current.n + 1 }));
    setWorkspace('profile');
  };

  const selectWorkspace = (nextWorkspace: Workspace) => {
    setOverlays([]);
    if (nextWorkspace === 'profile') setProfileTarget((current) => ({ n: current.n + 1 }));
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

  const startBookingFor = (customer: Customer, vehicle: Vehicle) => {
    startNewBooking();
    chooseVehicle(vehicle, customer);
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

  const newBookingAllowed = !session || session.capabilities.manageBookings;
  const bookingsAllowed = !session || session.capabilities.manageBookings || session.capabilities.manageIntake;
  const analyticsAllowed = !session || session.capabilities.viewAnalytics;

  if (authGate === 'checking') return (
    <div className="app-shell login-shell"><main id="main-content"><div className="workspace-state" data-testid="auth-checking"><span className="spinner"/> Проверяем вход</div></main></div>
  );

  if (authGate === 'login') return (
    <div className="app-shell login-shell">
      <main id="main-content" tabIndex={-1}>
        <LoginScreen
          onSignedIn={() => window.location.reload()}
          onCancel={demoAllowed && !authSession.token() ? () => { authSession.chooseDemo(); setAuthGate('app'); } : undefined}
        />
      </main>
    </div>
  );

  return (
    <SessionInfo.Provider value={session}>
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Перейти к содержимому</a>
      {/* The connection banner sits above the header in one sticky block: it pushes content, never covers it. */}
      <div className="app-top">
        <SyncBanner online={online}/>
        <Header step={step} workspace={workspace} orderTitle={orderHeader} overlayTitle={overlay ? overlay.kind === 'customer' ? 'Карточка клиента' : overlay.kind === 'vehicle' ? 'Карточка автомобиля' : orderHeader : undefined}
          overlayEyebrow={overlay?.kind === 'order' ? 'Рабочий заказ' : undefined} onBack={() => overlay ? closeOverlay() : workspace !== 'new' ? startNewBooking() : profileVehicleId ? setProfileVehicleId(null) : step === 1 ? setQuery('') : setStep(step === 5 ? 4 : step === 4 ? 3 : 1)}/>
      </div>
      <main id="main-content" tabIndex={-1}>
        {overlay?.kind === 'customer' && <CustomerProfileScreen
          key={overlay.id}
          customerId={overlay.id}
          backLabel="Назад"
          onBack={closeOverlay}
          onOpenVehicle={openVehicleOverlay}
          onOpenCustomer={openCustomerProfile}
          onBook={startBookingFor}
        />}
        {overlay?.kind === 'vehicle' && <VehicleProfileScreen key={overlay.id} vehicleId={overlay.id} backLabel="Назад" onBack={closeOverlay} onOpenCustomer={openCustomerProfile}/>}
        {overlay?.kind === 'order' && <OrderWorkspaceLoader key={`${overlay.id}-${overlay.orderId ?? 'new'}`} target={overlay} onPhaseChange={setOrderHeader} onBack={closeOverlay}/>}
        {/* Workspaces stay mounted under a profile so lists and opened details keep their state. */}
        <div className="workspace-layer" hidden={Boolean(overlay)}>
        {workspace === 'bookings' && (bookingsAllowed
          ? <BookingsWorkspace onNew={startNewBooking} onLeadConvert={startLeadBooking} onOpenCustomer={openCustomerProfile} onOpenOrder={openOrderWorkspace} refreshToken={workspaceRefresh}/>
          : <NoAccess section="Раздел «Записи»"/>)}
        {workspace === 'orders' && <OrdersWorkspace onOpenCustomer={openCustomerProfile} onOpenOrder={openOrderWorkspace} refreshToken={workspaceRefresh}/>}
        {workspace === 'analytics' && (analyticsAllowed ? <AnalyticsScreen/> : <NoAccess section="Раздел «Статистика»"/>)}
        {workspace === 'new' && !newBookingAllowed && <NoAccess section="Раздел «Новая запись»"/>}
        {workspace === 'profile' && <ProfileScreen key={profileTarget.n} open={profileTarget.open} onSignIn={() => setAuthGate('login')}/>}
        {workspace === 'new' && newBookingAllowed && step === 1 && profileVehicleId && <VehicleProfileScreen vehicleId={profileVehicleId} onBack={() => setProfileVehicleId(null)} onOpenCustomer={openCustomerProfile}/>}
        {workspace === 'new' && newBookingAllowed && step === 1 && !profileVehicleId && (
          <section className="screen" aria-label="Поиск клиента и автомобиля">
            {activeLead && <div className="lead-conversion-banner"><span>Обращение · {leadChannelLabels[activeLead.channel]}</span><strong>{activeLead.contactName}</strong><small>Выберите клиента и автомобиль — обращение закроется после создания записи.</small></div>}
            {session?.capabilities.manageSettings && !activeLead && <FirstSteps onOpen={openSetupStep}/>}
            <div className="context-line"><span className="live-dot"/> {session?.tenant.name ?? 'DetailFlow'} <span>·</span> Сегодня, {new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</div>
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

            {mode === 'phone' && customers.map((customer) => customer.archived ? (
              <div className="customer-result archived" key={customer.id} data-testid="customer-result-archived">
                <div className="customer-head">
                  <span className="avatar">{customer.name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase()}</span>
                  <span><strong>{customer.name}</strong><small>{customer.phoneDisplay} · клиент в архиве</small></span>
                  <span className="match-badge archived">архив</span>
                </div>
                <p className="archived-result-note">Не создавайте дубль: откройте карточку и верните клиента из архива.</p>
                <button className="vehicle-profile-link" data-testid={`open-customer-profile-${customer.id}`} onClick={() => openCustomerProfile(customer.id)}><Icon name="user" size={17}/> Открыть карточку клиента</button>
              </div>
            ) : (
              <div className="customer-result" key={customer.id} data-testid="customer-result">
                <div className="customer-head">
                  <span className="avatar">АМ</span>
                  <span><strong>{customer.name}</strong><small>{customer.phoneDisplay} · {customer.visitCount ? visitsLabel(customer.visitCount) : 'новый клиент'}</small></span>
                  <span className="match-badge"><Icon name="check" size={13}/> найден</span>
                </div>
                <div className="result-title"><span>Автомобили клиента</span><small>{customer.vehicles.length}</small></div>
                <div className="vehicle-list">
                  {customer.vehicles.map((vehicle) => <VehicleCard key={vehicle.id} vehicle={vehicle} onSelect={() => chooseVehicle(vehicle, customer)}/>) }
                </div>
                <button className="add-row" onClick={() => { setSelectedCustomer(customer); setStep(2); }}><span><Icon name="plus"/></span> Добавить автомобиль</button>
                <button className="vehicle-profile-link" data-testid={`open-customer-profile-${customer.id}`} onClick={() => openCustomerProfile(customer.id)}><Icon name="user" size={17}/> Карточка клиента</button>
              </div>
            ))}

            {mode === 'phone' && showCreateCustomer && (
              <div className="empty-state" ref={createCustomerCard} data-testid="create-customer">
                <span className="empty-icon"><Icon name="user"/></span>
                <strong>Клиент не найден</strong>
                <p>Номер сохранён — добавьте имя, чтобы продолжить.</p>
                <input aria-label="Имя клиента" value={newCustomerName} onChange={(event) => setNewCustomerName(event.target.value)} placeholder="Имя клиента"/>
                <button className="primary-button" disabled={newCustomerName.trim().length < 2 || loading} onClick={createCustomer}>Создать клиента</button>
              </div>
            )}

            {mode === 'plate' && plateVehicles.map((vehicle) => (
              <div className="customer-result" key={vehicle.id}>
                {vehicle.customer && <button className="found-owner" data-testid={`open-owner-profile-${vehicle.id}`} onClick={() => openCustomerProfile(vehicle.customer!.id)} aria-label={`Карточка клиента ${vehicle.customer.name}`}><Icon name="user"/> {vehicle.customer.name} <span>{vehicle.customer.phoneDisplay} ›</span></button>}
                <VehicleCard vehicle={vehicle} onSelect={() => chooseVehicle(vehicle, vehicle.customer)}/>
                <button className="vehicle-profile-link" data-testid={`open-vehicle-profile-${vehicle.id}`} onClick={() => setProfileVehicleId(vehicle.id)}><Icon name="clipboard" size={17}/> История и владелец</button>
              </div>
            ))}
          </section>
        )}

        {workspace === 'new' && newBookingAllowed && step === 2 && selectedCustomer && <AddVehicle customer={selectedCustomer} onCancel={() => setStep(1)} onCreated={(vehicle) => chooseVehicle(vehicle, selectedCustomer)}/>}

        {workspace === 'new' && newBookingAllowed && step === 3 && selectedVehicle && (
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
        {workspace === 'new' && newBookingAllowed && step === 4 && selectedVehicle && selectedCustomer && bookingQuote && (
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
        {workspace === 'new' && newBookingAllowed && step === 5 && activeBooking && selectedVehicle && selectedCustomer && (
          <OrderFlow booking={activeBooking} customer={selectedCustomer} vehicle={selectedVehicle} onPhaseChange={setOrderHeader}/>
        )}
        </div>
      </main>
      <BottomNav active={workspace} onSelect={selectWorkspace}/>
    </div>
    </SessionInfo.Provider>
  );
}
