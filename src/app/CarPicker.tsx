import { useEffect, useRef, useState } from 'react';
import { carMakes, carModels } from '../shared/carCatalog.ts';
import { Icon } from './AppChrome';

/** A list to choose from with a search on top, over the whole screen: the phone keyboard leaves it room. */
function ChoiceSheet({ title, items, query, setQuery, onChoose, onClose, onNotListed }: {
  title: string; items: string[]; query: string; setQuery: (value: string) => void;
  onChoose: (value: string) => void; onClose: () => void; onNotListed: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  return <div className="car-sheet" role="dialog" aria-label={title} data-testid="car-sheet">
    <div className="car-sheet-head"><strong>{title}</strong><button type="button" onClick={onClose}>Закрыть</button></div>
    <div className="search-input filled"><Icon name="search"/><input ref={input} data-testid="car-search" value={query} autoComplete="off" autoCorrect="off" placeholder="Поиск" onChange={(event) => setQuery(event.target.value)}/></div>
    <div className="car-sheet-list">
      {items.map((item) => <button type="button" key={item} data-testid="car-option" onClick={() => onChoose(item)}>{item}</button>)}
      {!items.length && <p>В справочнике такого нет</p>}
      <button type="button" className="car-not-listed" data-testid="car-not-listed" onClick={onNotListed}>Нет в списке — ввести вручную</button>
    </div>
  </div>;
}

/** Make, then model, as on car sites. A car that is not listed goes to the manual form with what was typed. */
export function CarPicker({ make, model, onChange, onNotListed }: {
  make: string; model: string;
  onChange: (make: string, model: string) => void;
  onNotListed: (make: string, model: string) => void;
}) {
  const [open, setOpen] = useState<'make' | 'model' | null>(null);
  const [query, setQuery] = useState('');
  const show = (sheet: 'make' | 'model') => { setQuery(''); setOpen(sheet); };
  const close = () => setOpen(null);
  return <div className="form-row car-picker">
    <div className="form-group"><label>Марка</label><button type="button" className={`car-select${make ? ' filled' : ''}`} data-testid="car-make" onClick={() => show('make')}>{make || 'Выбрать'}</button></div>
    <div className="form-group"><label>Модель</label><button type="button" className={`car-select${model ? ' filled' : ''}`} data-testid="car-model" disabled={!make} onClick={() => show('model')}>{model || 'Выбрать'}</button></div>
    {open === 'make' && <ChoiceSheet title="Марка" items={carMakes(query)} query={query} setQuery={setQuery}
      onChoose={(value) => { onChange(value, ''); show('model'); }} onClose={close}
      onNotListed={() => { close(); onNotListed(query.trim(), ''); }}/>}
    {open === 'model' && <ChoiceSheet title={make} items={carModels(make, query)} query={query} setQuery={setQuery}
      onChoose={(value) => { onChange(make, value); close(); }} onClose={close}
      onNotListed={() => { close(); onNotListed(make, query.trim()); }}/>}
  </div>;
}
