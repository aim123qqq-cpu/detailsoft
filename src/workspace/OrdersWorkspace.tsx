import { useEffect, useRef, useState } from 'react';
import { useSessionInfo } from '../session';
import { api } from '../api';
import { OrderDocumentsPanel } from '../OrderDocuments';
import { ShareOrderButton } from '../ShareOrderButton';
import { productFeatures } from '../features';
import type { OrderListItem, OrderTarget, WorkOrder } from '../types';
import { money, useWorkspaceItems, LoadingState, ErrorState, orderTarget } from './shared';

const orderStatuses: Record<WorkOrder['status'], { label: string; group: 'active' | 'ready' | 'closed' }> = {
  INTAKE: { label: 'Приёмка', group: 'active' },
  ESTIMATE_DRAFT: { label: 'Смета', group: 'active' },
  APPROVED: { label: 'Согласован', group: 'active' },
  IN_PROGRESS: { label: 'В работе', group: 'active' },
  QC: { label: 'Контроль качества', group: 'active' },
  READY: { label: 'Готов к выдаче', group: 'ready' },
  CLOSED: { label: 'Закрыт', group: 'closed' }
};

type OrderFilter = 'mine' | 'all' | 'active' | 'ready' | 'closed';

export function OrdersWorkspace({ onOpenCustomer, onOpenOrder, refreshToken }: {
  onOpenCustomer: (customerId: string) => void;
  onOpenOrder: (target: OrderTarget) => void;
  refreshToken: number;
}) {
  const session = useSessionInfo();
  const { items, loading, error, retry } = useWorkspaceItems(api.listOrders);
  const [filter, setFilter] = useState<OrderFilter>('all');
  const [selected, setSelected] = useState<OrderListItem | null>(null);
  const isMaster = Boolean(session?.capabilities.acceptAssignments);
  // An order executor without front-desk rights starts on their own queue.
  const defaultApplied = useRef(false);
  useEffect(() => {
    if (!session || defaultApplied.current) return;
    defaultApplied.current = true;
    if (isMaster && !session.capabilities.manageBookings) setFilter('mine');
  }, [session, isMaster]);
  const isMine = (item: OrderListItem) => session?.actor.memberId
    ? item.masterMemberId === session.actor.memberId
    : item.masterName === session?.actor.displayName;
  const filtered = filter === 'all' ? items : filter === 'mine' ? items.filter(isMine) : items.filter((item) => orderStatuses[item.status].group === filter);
  const filters: Array<{ id: OrderFilter; label: string }> = [
    ...(isMaster ? [{ id: 'mine' as const, label: `Мои ${items.filter(isMine).length}` }] : []),
    { id: 'all', label: 'Все' }, { id: 'active', label: 'В работе' }, { id: 'ready', label: 'К выдаче' }, { id: 'closed', label: 'Закрытые' }
  ];

  useEffect(() => {
    if (selected) window.scrollTo({ top: 0, behavior: 'auto' });
  }, [selected?.id]);

  useEffect(() => {
    if (refreshToken) retry();
  }, [refreshToken]);

  if (selected) return <OrderDetails item={selected} onBack={() => { setSelected(null); retry(); }} onOpenCustomer={onOpenCustomer} onOpenOrder={onOpenOrder} refreshToken={refreshToken}/>;

  return (
    <section className="screen workspace-screen" data-testid="orders-workspace">
      <div className="workspace-hero orders-hero"><span>Рабочая очередь</span><div><strong>{items.filter((item) => orderStatuses[item.status].group === 'active').length}</strong><small>в работе</small><strong>{items.filter((item) => item.status === 'READY').length}</strong><small>к выдаче</small></div></div>
      <div className="workspace-toolbar"><div><h2>Заказы</h2><p>Текущий этап и ответственный</p></div></div>
      <div className="workspace-filters" aria-label="Фильтр заказов">{filters.map((item) => <button key={item.id} className={filter === item.id ? 'selected' : ''} onClick={() => setFilter(item.id)}>{item.label}</button>)}</div>
      {loading ? <LoadingState/> : error ? <ErrorState message={error} onRetry={retry}/> : filtered.length === 0 ? (
        <div className="workspace-state">{filter === 'mine'
          ? <><strong>Вам пока не назначено заказов</strong><span>Они появятся здесь, когда администратор назначит вас мастером</span></>
          : <><strong>В этой группе пусто</strong><span>Заказы появятся после начала приёмки</span></>}</div>
      ) : <div className="workspace-list orders-list">{filtered.map((item) => <OrderCard key={item.id} item={item} onOpen={() => setSelected(item)}/>)}</div>}
    </section>
  );
}

function OrderCard({ item, onOpen }: { item: OrderListItem; onOpen: () => void }) {
  const status = orderStatuses[item.status];
  return (
    <button className="workspace-card order-card" data-testid={`order-card-${item.id}`} onClick={onOpen}>
      <div className="workspace-card-body">
        <div className="workspace-card-top"><span className={`status-pill ${status.group}`}>{status.label}</span><span>#{item.id.replace('order_', '').slice(0, 6)}</span></div>
        <h3>{item.customer.name}</h3>
        <p>{item.vehicle.make} {item.vehicle.model} {item.vehicle.generation}</p>
        <div className="workspace-card-meta"><span className="plate">{item.vehicle.plate}</span><span>{item.masterName ?? 'Мастер не назначен'}</span></div>
        <div className="order-summary"><span>Смета</span><strong>{item.totalAmountMinor === null ? 'Не составлена' : money.format(item.totalAmountMinor / 100)}</strong></div>
      </div>
    </button>
  );
}

const orderStages = productFeatures.qualityControl
  ? ['Приёмка', 'Смета', 'Работы', 'QC', 'Выдача']
  : ['Приёмка', 'Смета', 'Работы', 'Выдача'];

function orderStageIndex(status: WorkOrder['status']) {
  if (status === 'INTAKE') return 0;
  if (status === 'ESTIMATE_DRAFT' || status === 'APPROVED') return 1;
  if (status === 'IN_PROGRESS') return 2;
  if (status === 'QC') return productFeatures.qualityControl ? 3 : 2;
  if (status === 'READY') return productFeatures.qualityControl ? 4 : 3;
  return orderStages.length;
}

function OrderDetails({ item, onBack, onOpenCustomer, onOpenOrder, refreshToken }: {
  item: OrderListItem;
  onBack: () => void;
  onOpenCustomer: (customerId: string) => void;
  onOpenOrder: (target: OrderTarget) => void;
  refreshToken: number;
}) {
  const session = useSessionInfo();
  const canOpenCustomer = !session || session.capabilities.manageCustomers;
  const [order, setOrder] = useState<WorkOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    api.getOrder(item.id, controller.signal)
      .then(setOrder)
      .catch((requestError: Error) => { if (requestError.name !== 'AbortError') setError(requestError.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [item.id, revision, refreshToken]);

  const status = orderStatuses[order?.status ?? item.status];
  const currentEstimate = order?.estimateVersions.find((estimate) => estimate.id === order.currentEstimateVersionId) ?? null;
  const doneOperations = order?.work?.operations.filter((operation) => operation.status === 'DONE').length ?? 0;
  const totalOperations = order?.work?.operations.length ?? 0;
  const lastQc = order?.qualityControl.at(-1) ?? null;

  return (
    <section className="screen order-details-screen" data-testid="order-details">
      <button className="details-back" onClick={onBack}>← Все заказы</button>
      {loading && !order ? <LoadingState/> : error && !order ? <ErrorState message={error} onRetry={() => setRevision((value) => value + 1)}/> : order && <>
        <div className="order-details-hero">
          <div><span className={`status-pill ${status.group}`}>{status.label}</span><small>#{item.id.replace('order_', '').slice(0, 8)}</small></div>
          <h2>{order.status === 'CLOSED' ? 'Заказ закрыт' : status.label}</h2>
          <p>{item.customer.name} · {item.customer.phoneDisplay}</p>
          <div className="details-vehicle"><span className="plate">{item.vehicle.plate}</span><strong>{item.vehicle.make} {item.vehicle.model} {item.vehicle.generation}</strong><small>{item.vehicle.color}</small></div>
          {canOpenCustomer && <button className="details-customer-link" data-testid="order-open-customer" onClick={() => onOpenCustomer(item.customer.id)}>Карточка клиента ›</button>}
        </div>
        {order.bookingId && <button className="primary-button order-open-workspace" data-testid="open-order-workspace" onClick={() => onOpenOrder(orderTarget(order.bookingId!, order.id, item))}>
          {order.status === 'CLOSED' ? 'Открыть выдачу и документы →' : 'Продолжить работу с заказом →'}
        </button>}

        <div className="order-timeline" aria-label="Этапы заказа" style={{ gridTemplateColumns: `repeat(${orderStages.length}, 1fr)` }}>
          {orderStages.map((stage, index) => <div key={stage} className={index < orderStageIndex(order.status) ? 'done' : index === orderStageIndex(order.status) ? 'current' : ''}><i>{index < orderStageIndex(order.status) || order.status === 'CLOSED' ? '✓' : index + 1}</i><span>{stage}</span></div>)}
        </div>

        <div className="details-grid order-details-grid">
          <div><span>Смета</span><strong>{currentEstimate ? money.format(currentEstimate.totalAmountMinor / 100) : 'Не составлена'}</strong></div>
          <div><span>Мастер</span><strong>{order.assignment?.masterName ?? 'Не назначен'}</strong></div>
          <div><span>Операции</span><strong>{totalOperations ? `${doneOperations} из ${totalOperations}` : 'Нет операций'}</strong></div>
          <div><span>События</span><strong>{order.auditTrail.length} в журнале</strong></div>
        </div>

        <ShareOrderButton order={order} vehicle={item.vehicle}/>
        <OrderDocumentsPanel order={order} defaultSigner={item.customer.name} onChanged={() => setRevision((value) => value + 1)}/>

        {currentEstimate && <section className="order-detail-section">
          <div className="detail-section-heading"><span>Смета v{currentEstimate.version}</span><strong>{currentEstimate.lines.length} позиции</strong></div>
          <div className="detail-rows">{currentEstimate.lines.map((line) => <div key={line.id}><span>{line.name}</span><strong>{money.format(line.amountMinor / 100)}</strong></div>)}</div>
        </section>}

        {order.work && <section className="order-detail-section">
          <div className="detail-section-heading"><span>Работы</span><strong>{doneOperations}/{totalOperations}</strong></div>
          <div className="detail-rows operation-history">{order.work.operations.map((operation) => <div key={operation.id}><i className={operation.status.toLowerCase()}>{operation.status === 'DONE' ? '✓' : '·'}</i><span>{operation.name}</span><strong>{operation.status === 'DONE' ? 'Готово' : operation.status === 'BLOCKED' ? 'Проблема' : 'Ожидает'}</strong></div>)}</div>
        </section>}

        {lastQc && <section className="order-detail-section qc-history">
          <div className="detail-section-heading"><span>Контроль качества</span><strong>{lastQc.decision === 'PASSED' ? 'Пройден' : 'Доработка'}</strong></div>
          <p>{lastQc.responsible} · {lastQc.note}</p>
        </section>}

        {order.handover && <div className="handover-proof"><strong>Автомобиль выдан</strong><br/>✓ {order.handover.responsible} · {order.handover.note}</div>}
      </>}
    </section>
  );
}
