import { useEffect, useMemo, useState } from 'react';
import { ApiRequestError, api } from './api';
import { pluralRu } from './format';
import type { CatalogOperation, CatalogUsageItem } from './types';

type Filter = 'active' | 'archived' | 'all';

function usageText(operation: CatalogOperation) {
  const { services, packages } = operation.usage;
  if (!services.length && !packages.length) return 'Не используется';
  return [
    services.length ? `${services.length} ${pluralRu(services.length, 'услуга', 'услуги', 'услуг')}` : '',
    packages.length ? `${packages.length} ${pluralRu(packages.length, 'пакет', 'пакета', 'пакетов')}` : ''
  ].filter(Boolean).join(' · ');
}

const usageNames = (items: CatalogUsageItem[]) => items.map((item) => `${item.name}${item.active ? '' : ' (архив)'}`).join(', ');

/** Tenant operation library: search, rename and archive with protection for operations in active items. */
export function OperationLibrary({ onChanged }: { onChanged: () => void }) {
  const [items, setItems] = useState<CatalogOperation[] | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('active');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    api.listCatalogOperations(controller.signal)
      .then((result) => setItems(result.items))
      .catch((requestError: Error) => { if (requestError.name !== 'AbortError') setError(requestError.message); });
    return () => controller.abort();
  }, [revision]);

  const visible = useMemo(() => {
    const terms = query.trim().toLocaleLowerCase('ru-RU').split(/\s+/).filter(Boolean);
    return (items ?? []).filter((operation) => (filter === 'all' || (filter === 'active') === operation.active) &&
      terms.every((term) => operation.name.toLocaleLowerCase('ru-RU').includes(term)));
  }, [items, query, filter]);

  const replace = (updated: CatalogOperation) => setItems((current) => current?.map((item) => item.id === updated.id ? updated : item) ?? current);

  const run = async (action: () => Promise<void>, success: string) => {
    setBusy(true); setError(''); setNotice('');
    try { await action(); setNotice(success); onChanged(); }
    catch (requestError) {
      const apiError = requestError instanceof ApiRequestError ? requestError : null;
      setError(apiError?.code === 'operation_in_use'
        ? `${apiError.message}. Используется в: ${usageNames([...(apiError.details.services as CatalogUsageItem[] ?? []), ...(apiError.details.packages as CatalogUsageItem[] ?? [])])}`
        : (requestError as Error).message);
    } finally { setBusy(false); }
  };

  const saveName = (operation: CatalogOperation) => run(async () => {
    replace(await api.updateCatalogOperation(operation.id, { name }));
    setEditingId(null);
  }, 'Название обновлено. Готовые записи и сметы сохранили прежнее название.');

  const setActive = (operation: CatalogOperation, active: boolean) => run(async () => {
    replace(await api.updateCatalogOperation(operation.id, { active }));
    setEditingId(null);
  }, active ? 'Операция восстановлена и снова доступна в составе услуг.' : 'Операция перенесена в архив.');

  const create = () => run(async () => {
    await api.createCatalogOperation(newName.trim());
    setNewName('');
    setRevision((value) => value + 1);
  }, 'Операция добавлена в библиотеку.');

  const counts = { active: items?.filter((item) => item.active).length ?? 0, archived: items?.filter((item) => !item.active).length ?? 0 };

  return <section className="operation-library" data-testid="operation-library" aria-label="Библиотека операций">
    <p className="operation-library-intro">Операции — кирпичики услуг и пакетов. Переименование применяется к новым расчётам; записи и сметы хранят своё название. Операцию из активной услуги или пакета нельзя убрать в архив.</p>
    <div className="operation-library-tools">
      <label htmlFor="operation-search" className="visually-hidden">Поиск операции</label>
      <input id="operation-search" data-testid="operation-search" type="search" value={query} placeholder="Найти операцию" onChange={(event) => setQuery(event.target.value)}/>
      <div className="workspace-filters operation-filters" role="group" aria-label="Статус операций">
        {([['active', `Активные ${counts.active}`], ['archived', `Архив ${counts.archived}`], ['all', 'Все']] as const).map(([value, label]) =>
          <button key={value} className={filter === value ? 'selected' : ''} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}
      </div>
    </div>

    {notice && <div className="vehicle-success" role="status">✓ {notice}</div>}
    {error && <p className="form-error" role="alert" data-testid="operation-error">{error}</p>}
    {!items && !error && <div className="workspace-state"><span className="spinner"/> Загружаем операции</div>}

    <ul className="operation-list">
      {visible.map((operation) => {
        const editing = editingId === operation.id;
        const locked = operation.active && operation.usage.activeCount > 0;
        return <li key={operation.id} className={`operation-row ${operation.active ? '' : 'archived'} ${editing ? 'editing' : ''}`} data-testid={`operation-row-${operation.id}`}>
          <div className="operation-row-main">
            <span><strong>{operation.name}</strong><small data-testid="operation-usage">{usageText(operation)}{operation.active ? '' : ' · в архиве'}</small></span>
            {!editing && <button data-testid={`operation-edit-${operation.id}`} onClick={() => { setEditingId(operation.id); setName(operation.name); setError(''); setNotice(''); }}>Изменить</button>}
          </div>
          {editing && <div className="operation-editor">
            <label htmlFor={`operation-name-${operation.id}`}>Название</label>
            <input id={`operation-name-${operation.id}`} data-testid="operation-name-input" value={name} maxLength={120} onChange={(event) => setName(event.target.value)}/>
            {(operation.usage.services.length > 0 || operation.usage.packages.length > 0) && <p className="operation-used-in">Входит в: {usageNames([...operation.usage.services, ...operation.usage.packages])}</p>}
            <div className="operation-editor-actions">
              <button onClick={() => setEditingId(null)}>Отмена</button>
              <button className="primary" data-testid="save-operation" disabled={busy || name.trim().length < 2 || name.trim() === operation.name} onClick={() => saveName(operation)}>Сохранить</button>
            </div>
            {operation.active
              ? <button className="operation-archive" data-testid="archive-operation" disabled={busy || locked} onClick={() => setActive(operation, false)}>
                  {locked ? 'В архив нельзя: операция в активных услугах или пакетах' : 'Перенести в архив'}
                </button>
              : <button className="operation-restore" data-testid="restore-operation" disabled={busy} onClick={() => setActive(operation, true)}>Восстановить</button>}
          </div>}
        </li>;
      })}
    </ul>
    {items && !visible.length && <div className="workspace-state"><strong>Ничего не найдено</strong><span>Измените запрос или фильтр</span></div>}

    <div className="operation-create">
      <label htmlFor="new-operation-name">Новая операция</label>
      <div>
        <input id="new-operation-name" data-testid="new-operation-name" value={newName} maxLength={120} placeholder="Например, Озонирование салона" onChange={(event) => setNewName(event.target.value)}/>
        <button data-testid="create-operation" disabled={busy || newName.trim().length < 2} onClick={create}>Добавить</button>
      </div>
    </div>
  </section>;
}
