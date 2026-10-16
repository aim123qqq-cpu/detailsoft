import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { OperationLibrary } from './OperationLibrary';
import type { ManagedCatalog, ManagedCatalogItem } from './types';

type Operation = ManagedCatalog['operationLibrary'][number];
type PriceRow = { operationId?: string; name: string; amount: string; duration: string };
const money = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 });

function itemPrice(item: ManagedCatalogItem, tenantClass: string) {
  if (item.type === 'package') return item.prices?.find((price) => price.tenantClass === tenantClass) ?? null;
  const prices = item.operations.map((operation) => operation.prices?.find((price) => price.tenantClass === tenantClass)).filter(Boolean);
  if (prices.length !== item.operations.length) return null;
  return { tenantClass, amountMinor: prices.reduce((sum, price) => sum + (price?.amountMinor ?? 0), 0), durationMinutes: prices.reduce((sum, price) => sum + (price?.durationMinutes ?? 0), 0) };
}

export function CatalogScreen({ onBack }: { onBack: () => void }) {
  const [catalog, setCatalog] = useState<ManagedCatalog | null>(null);
  const [tenantClass, setTenantClass] = useState('');
  const [kind, setKind] = useState<'service' | 'package' | 'operations'>('service');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<ManagedCatalogItem | null>(null);
  const [creating, setCreating] = useState<'service' | 'package' | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    api.getManagedCatalog(controller.signal).then((result) => {
      setCatalog(result); setTenantClass((current) => current || result.vehicleClasses[0] || '');
    }).catch((requestError: Error) => { if (requestError.name !== 'AbortError') setError(requestError.message); });
    return () => controller.abort();
  }, [revision]);

  const items = useMemo(() => catalog?.items.filter((item) => item.type === kind && (showArchived || item.active)) ?? [], [catalog, kind, showArchived]);
  const updateItem = (updated: ManagedCatalogItem) => setCatalog((current) => current ? { ...current, items: current.items.some((item) => item.id === updated.id) ? current.items.map((item) => item.id === updated.id ? updated : item) : [...current.items, updated] } : current);

  if (creating && catalog) return <CatalogCreate type={creating} catalog={catalog} onCancel={() => setCreating(null)} onOperationCreated={(operation) => setCatalog((current) => current ? { ...current, operationLibrary: [...current.operationLibrary, operation].sort((a, b) => a.name.localeCompare(b.name, 'ru')) } : current)} onCreated={(item) => { updateItem(item); setCreating(null); setKind(item.type); window.scrollTo({ top: 0, behavior: 'auto' }); }}/>;
  if (editing && catalog) return <CatalogEditor key={`${editing.id}-${tenantClass}`} item={editing} operationLibrary={catalog.operationLibrary} tenantClass={tenantClass} onCancel={() => setEditing(null)} onSaved={(updated) => { updateItem(updated); setEditing(null); window.scrollTo({ top: 0, behavior: 'auto' }); }}/>;

  return <section className="screen catalog-manager" data-testid="catalog-manager">
    <button className="details-back" onClick={onBack}>← Профиль</button>
    <div className="catalog-manager-hero"><span>Каталог центра</span><h2>Услуги и цены</h2><p>Создавайте услуги из переиспользуемых операций. Старые записи и сметы сохраняют свои суммы.</p></div>
    {error && <div className="workspace-state error-state"><strong>Не удалось загрузить каталог</strong><span>{error}</span><button onClick={() => setRevision((value) => value + 1)}>Повторить</button></div>}
    {!catalog && !error && <div className="workspace-state"><span className="spinner"/> Загружаем каталог</div>}
    {catalog && <>
      {kind !== 'operations' && <div className="catalog-class-picker" aria-label="Класс автомобиля"><span>Цены для класса</span><div>{catalog.vehicleClasses.map((value) => <button key={value} className={tenantClass === value ? 'selected' : ''} onClick={() => setTenantClass(value)}>{value}</button>)}</div></div>}
      <div className="catalog-toolbar"><div className="workspace-section-tabs catalog-kind-tabs" role="tablist" aria-label="Тип позиции"><button role="tab" aria-selected={kind === 'service'} className={kind === 'service' ? 'selected' : ''} onClick={() => setKind('service')}>Услуги</button><button role="tab" aria-selected={kind === 'package'} className={kind === 'package' ? 'selected' : ''} onClick={() => setKind('package')}>Пакеты</button><button role="tab" data-testid="catalog-operations-tab" aria-selected={kind === 'operations'} className={kind === 'operations' ? 'selected' : ''} onClick={() => setKind('operations')}>Операции</button></div>{kind !== 'operations' && <button className="catalog-create-button" data-testid="create-catalog-item" onClick={() => setCreating(kind as 'service' | 'package')}>+ Создать</button>}</div>
      {kind === 'operations' ? <OperationLibrary onChanged={() => setRevision((value) => value + 1)}/> : <>
      <label className="catalog-archive-toggle"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)}/><span>Показывать архивные</span></label>
      <div className="catalog-managed-list">{items.map((item) => { const price = itemPrice(item, tenantClass); return <article key={item.id} className={`catalog-managed-card ${item.active ? '' : 'archived'}`} data-testid={`catalog-card-${item.id}`}><div><span>{item.category}</span><i>{item.active ? 'Активна' : 'Архив'}</i></div><h3>{item.name}</h3><p>{item.description}</p><div className="catalog-managed-summary"><span><small>{item.operations.length} {item.type === 'service' ? 'операции' : 'в пакете'}</small><strong>{price ? money.format(price.amountMinor / 100) : 'Нет цены'}</strong></span><span><small>Длительность</small><strong>{price ? `${price.durationMinutes} мин` : '—'}</strong></span></div><button onClick={() => setEditing(item)}>Редактировать</button></article>; })}</div>
      {items.length === 0 && <div className="workspace-state"><strong>Позиции не найдены</strong><span>Создайте первую позицию или включите архивные</span></div>}
      </>}
    </>}
  </section>;
}

function OperationPicker({ operations, selected, onToggle }: { operations: Operation[]; selected: string[]; onToggle: (operation: Operation) => void }) {
  return <fieldset className="operation-picker"><legend>Состав операций</legend><p>Операции переиспользуются между услугами и пакетами — повторная оплата исключается автоматически.</p><div>{operations.filter((item) => item.active).map((operation) => <button type="button" key={operation.id} className={selected.includes(operation.id) ? 'selected' : ''} aria-pressed={selected.includes(operation.id)} onClick={() => onToggle(operation)}><i>{selected.includes(operation.id) ? '✓' : '+'}</i><span>{operation.name}</span></button>)}</div></fieldset>;
}

function CatalogCreate({ type, catalog, onCancel, onCreated, onOperationCreated }: { type: 'service' | 'package'; catalog: ManagedCatalog; onCancel: () => void; onCreated: (item: ManagedCatalogItem) => void; onOperationCreated: (operation: Operation) => void }) {
  const [name, setName] = useState(''); const [category, setCategory] = useState(type === 'service' ? 'Детейлинг' : 'Комплексы'); const [description, setDescription] = useState('');
  const [pricingMode, setPricingMode] = useState<ManagedCatalogItem['pricingMode']>('fixed'); const [selected, setSelected] = useState<string[]>([]); const [rows, setRows] = useState<PriceRow[]>([]);
  const [packageAmount, setPackageAmount] = useState(''); const [packageDuration, setPackageDuration] = useState('60'); const [operationName, setOperationName] = useState('');
  const [savingOperation, setSavingOperation] = useState(false); const [saving, setSaving] = useState(false); const [error, setError] = useState('');
  const toggle = (operation: Operation) => { if (selected.includes(operation.id)) { setSelected((current) => current.filter((id) => id !== operation.id)); setRows((current) => current.filter((row) => row.operationId !== operation.id)); } else { setSelected((current) => [...current, operation.id]); setRows((current) => [...current, { operationId: operation.id, name: operation.name, amount: '', duration: '30' }]); } };
  const createOperation = async () => { setSavingOperation(true); setError(''); try { const operation = await api.createCatalogOperation(operationName); onOperationCreated(operation); toggle(operation); setOperationName(''); } catch (requestError) { setError((requestError as Error).message); } finally { setSavingOperation(false); } };
  const validRows = rows.every((row) => Number(row.amount) >= 0 && row.amount !== '' && Number.isInteger(Number(row.duration)) && Number(row.duration) > 0);
  const valid = name.trim().length >= 2 && category.trim().length >= 2 && selected.length > 0 && (type === 'service' ? validRows : Number(packageAmount) >= 0 && packageAmount !== '' && Number(packageDuration) > 0);
  const save = async () => { setSaving(true); setError(''); try { const item = await api.createManagedCatalogItem(type, { name, category, description, ...(type === 'service' ? { pricingMode, operationPrices: rows.map((row) => ({ operationId: row.operationId!, amountMinor: Math.round(Number(row.amount) * 100), durationMinutes: Number(row.duration) })) } : { operationIds: selected, amountMinor: Math.round(Number(packageAmount) * 100), durationMinutes: Number(packageDuration) }) }); onCreated(item); } catch (requestError) { setError((requestError as Error).message); } finally { setSaving(false); } };
  return <section className="screen catalog-editor catalog-create" data-testid="catalog-create"><button className="details-back" onClick={onCancel}>← Каталог</button><div className="catalog-editor-title"><span>Новая {type === 'service' ? 'услуга' : 'пакет'}</span><h2>{type === 'service' ? 'Соберите услугу' : 'Соберите пакет'}</h2><p>Стартовые цены применятся ко всем классам — затем их можно скорректировать отдельно.</p></div><div className="catalog-editor-form"><label>Название<input data-testid="new-catalog-name" value={name} onChange={(event) => setName(event.target.value)} placeholder={type === 'service' ? 'Например, уход за крышей' : 'Например, быстрый комплекс'}/></label><label>Категория<input value={category} onChange={(event) => setCategory(event.target.value)}/></label><label>Описание<textarea value={description} onChange={(event) => setDescription(event.target.value)}/></label>{type === 'service' && <label>Отображение цены<select value={pricingMode} onChange={(event) => setPricingMode(event.target.value as ManagedCatalogItem['pricingMode'])}><option value="fixed">Точная цена</option><option value="from">Цена от</option><option value="inspection">После осмотра</option></select></label>}</div><OperationPicker operations={catalog.operationLibrary} selected={selected} onToggle={toggle}/><div className="operation-create-inline"><label>Нет нужной операции?<input data-testid="new-operation-name" value={operationName} onChange={(event) => setOperationName(event.target.value)} placeholder="Название новой операции"/></label><button data-testid="create-operation" disabled={operationName.trim().length < 2 || savingOperation} onClick={createOperation}>{savingOperation ? '…' : 'Добавить'}</button></div>{type === 'service' ? <PriceEditor rows={rows} tenantClass="Все классы" onRows={setRows}/> : <div className="catalog-price-editor"><div><span>Стартовая цена пакета</span><strong>Все классы</strong></div><div className="catalog-price-row"><strong>Пакет целиком</strong><label>Цена, ₽<input type="number" min="0" value={packageAmount} onChange={(event) => setPackageAmount(event.target.value)}/></label><label>Минуты<input type="number" min="1" value={packageDuration} onChange={(event) => setPackageDuration(event.target.value)}/></label></div></div>}{error && <p className="form-error">{error}</p>}<button className="primary-button catalog-save" data-testid="save-new-catalog-item" disabled={!valid || saving} onClick={save}>{saving ? 'Создаём…' : `Создать ${type === 'service' ? 'услугу' : 'пакет'}`}</button></section>;
}

function PriceEditor({ rows, tenantClass, onRows }: { rows: PriceRow[]; tenantClass: string; onRows: (rows: PriceRow[]) => void }) {
  return <div className="catalog-price-editor"><div><span>Операции и цены</span><strong>{tenantClass}</strong></div>{rows.map((row, index) => <div className="catalog-price-row" key={row.operationId ?? 'package'}><strong>{row.name}</strong><label>Цена, ₽<input aria-label={`${row.name} цена`} type="number" min="0" step="50" value={row.amount} onChange={(event) => onRows(rows.map((value, rowIndex) => rowIndex === index ? { ...value, amount: event.target.value } : value))}/></label><label>Минуты<input aria-label={`${row.name} длительность`} type="number" min="1" max="1440" value={row.duration} onChange={(event) => onRows(rows.map((value, rowIndex) => rowIndex === index ? { ...value, duration: event.target.value } : value))}/></label></div>)}{!rows.length && <p className="catalog-price-empty">Выберите хотя бы одну операцию</p>}</div>;
}

function CatalogEditor({ item, operationLibrary, tenantClass, onCancel, onSaved }: { item: ManagedCatalogItem; operationLibrary: Operation[]; tenantClass: string; onCancel: () => void; onSaved: (item: ManagedCatalogItem) => void }) {
  const [name, setName] = useState(item.name); const [category, setCategory] = useState(item.category); const [description, setDescription] = useState(item.description); const [pricingMode, setPricingMode] = useState(item.pricingMode); const [active, setActive] = useState(item.active); const [selected, setSelected] = useState(item.operations.map((operation) => operation.id));
  const initialRows = item.type === 'service' ? item.operations.map((operation) => ({ operationId: operation.id, name: operation.name, price: operation.prices?.find((price) => price.tenantClass === tenantClass) })) : [{ operationId: undefined, name: 'Пакет целиком', price: item.prices?.find((price) => price.tenantClass === tenantClass) }];
  const [rows, setRows] = useState<PriceRow[]>(() => initialRows.map((row) => ({ operationId: row.operationId, name: row.name, amount: String((row.price?.amountMinor ?? 0) / 100), duration: String(row.price?.durationMinutes ?? 30) }))); const [saving, setSaving] = useState(false); const [error, setError] = useState(''); const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'auto' }); titleRef.current?.focus(); }, []);
  const toggle = (operation: Operation) => { if (selected.includes(operation.id)) { setSelected((current) => current.filter((id) => id !== operation.id)); if (item.type === 'service') setRows((current) => current.filter((row) => row.operationId !== operation.id)); } else { setSelected((current) => [...current, operation.id]); if (item.type === 'service') setRows((current) => [...current, { operationId: operation.id, name: operation.name, amount: '0', duration: '30' }]); } };
  const save = async () => { setSaving(true); setError(''); try { onSaved(await api.updateManagedCatalogItem(item, { name, category, description, pricingMode, active, operationIds: selected, prices: rows.map((row) => ({ ...(row.operationId ? { operationId: row.operationId } : {}), tenantClass, amountMinor: Math.round(Number(row.amount) * 100), durationMinutes: Number(row.duration) })) })); } catch (requestError) { setError((requestError as Error).message); } finally { setSaving(false); } };
  const valid = name.trim().length >= 2 && category.trim().length >= 2 && selected.length > 0 && rows.every((row) => Number(row.amount) >= 0 && Number.isInteger(Number(row.duration)) && Number(row.duration) > 0);
  return <section className="screen catalog-editor" data-testid="catalog-editor"><button className="details-back" onClick={onCancel}>← Каталог</button><div className="catalog-editor-title"><span>{item.type === 'service' ? 'Услуга' : 'Пакет'} · {tenantClass}</span><h2 ref={titleRef} tabIndex={-1}>{item.name}</h2><p>Меняются только будущие расчёты.</p></div><div className="catalog-editor-form"><label>Название<input value={name} onChange={(event) => setName(event.target.value)}/></label><label>Категория<input value={category} onChange={(event) => setCategory(event.target.value)}/></label><label>Описание<textarea value={description} onChange={(event) => setDescription(event.target.value)}/></label>{item.type === 'service' && <label>Отображение цены<select value={pricingMode} onChange={(event) => setPricingMode(event.target.value as ManagedCatalogItem['pricingMode'])}><option value="fixed">Точная цена</option><option value="from">Цена от</option><option value="inspection">После осмотра</option></select></label>}<label className="catalog-active-toggle"><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)}/><span><strong>Доступно для записи</strong><small>{active ? 'Клиенты могут выбрать позицию' : 'Позиция останется только в истории'}</small></span></label></div><OperationPicker operations={operationLibrary} selected={selected} onToggle={toggle}/><PriceEditor rows={rows} tenantClass={tenantClass} onRows={setRows}/>{error && <p className="form-error">{error}</p>}<button className="primary-button catalog-save" data-testid="save-catalog-item" disabled={!valid || saving} onClick={save}>{saving ? 'Сохраняем…' : 'Сохранить изменения'}</button></section>;
}
