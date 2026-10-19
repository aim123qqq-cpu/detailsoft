import { useMemo, useState } from 'react';
import { BODY_TYPES, QUICK_NOTES, carLayout, type BodyType, type LayoutElement } from '../shared/carLayouts';
import type { IntakeFinding, PhotoAsset } from '../types';
import { CarDiagram, findingMarks } from './CarDiagram';

const SEVERITIES: Array<{ value: IntakeFinding['severity']; label: string }> = [
  { value: 'LOW', label: 'Лёгкое' },
  { value: 'MEDIUM', label: 'Среднее' },
  { value: 'HIGH', label: 'Сильное' }
];
const severityLabel = (value: IntakeFinding['severity']) => SEVERITIES.find((item) => item.value === value)!.label;
const GROUP_LABELS: Record<LayoutElement['group'], string> = {
  body: 'Кузов', glass: 'Остекление', wheel: 'Колесо и диск', mirror: 'Зеркало', interior: 'Салон', other: 'Прочее'
};

/**
 * Intake inspection: body type, the numbered diagram, interior and other items, and the findings.
 * A finding's zone is the element name, so the act shows it with the same number.
 */
export function InspectionPanel({ bodyType, onBodyType, findings, onFindings, photos, photoUploading, onPhoto }: {
  bodyType: BodyType;
  onBodyType: (value: BodyType) => void;
  findings: IntakeFinding[];
  onFindings: (findings: IntakeFinding[]) => void;
  photos: PhotoAsset[];
  photoUploading: boolean;
  onPhoto: (file: File, elementName: string) => void;
}) {
  const layout = useMemo(() => carLayout(bodyType), [bodyType]);
  const ordered = useMemo(() => [...layout.elements].sort((a, b) => a.number - b.number), [layout]);
  const marks = useMemo(() => findingMarks(findings), [findings]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [severity, setSeverity] = useState<IntakeFinding['severity']>('MEDIUM');
  const [note, setNote] = useState('');
  const selected = ordered.find((element) => element.id === selectedId) ?? null;
  const numberOf = (zone: string) => ordered.find((element) => element.name === zone)?.number ?? null;
  const extras = ordered.filter((element) => !element.d);

  const select = (element: LayoutElement) => {
    setSelectedId(element.id);
    setNote('');
    setSeverity('MEDIUM');
  };
  const addFinding = () => {
    if (!selected || !note.trim()) return;
    onFindings([...findings, { zone: selected.name, severity, note: note.trim() }]);
    setNote('');
  };
  const changeBodyType = (value: BodyType) => {
    onBodyType(value);
    // Elements with the same name keep their findings; others (e.g. a sliding door) no longer exist.
    if (selected && !carLayout(value).elements.some((element) => element.name === selected.name)) setSelectedId(null);
  };
  const elementPhotos = selected ? photos.filter((photo) => photo.phase === 'intake' && photo.zone === selected.name) : [];
  const sortedFindings = [...findings].map((finding, index) => ({ finding, index }))
    .sort((left, right) => (numberOf(left.finding.zone) ?? 999) - (numberOf(right.finding.zone) ?? 999));

  return (
    <div className="inspection-panel" data-testid="inspection-panel">
      <div className="body-type-picker" role="radiogroup" aria-label="Тип кузова">
        <span>Тип кузова</span>
        <div>{BODY_TYPES.map((item) => <button key={item.code} type="button" role="radio" aria-checked={bodyType === item.code} data-testid={`body-type-${item.code}`}
          className={bodyType === item.code ? 'selected' : ''} onClick={() => changeBodyType(item.code)}>{item.label}</button>)}</div>
      </div>

      <div className="diagram-stage">
        <CarDiagram layout={layout} marks={marks} selected={selectedId} onSelect={select}/>
        <div className="diagram-legend"><span>Нажмите на элемент, чтобы добавить замечание</span><i className="legend low">лёгкое</i><i className="legend medium">среднее</i><i className="legend high">сильное</i></div>
      </div>

      <div className="extra-elements">
        {(['interior', 'other'] as const).map((group) => <div key={group}><span>{GROUP_LABELS[group]}</span><div>
          {extras.filter((element) => element.group === group).map((element) => {
            const mark = marks.get(element.name);
            return <button key={element.id} type="button" data-testid={`element-${element.id}`} aria-pressed={selectedId === element.id}
              className={`${selectedId === element.id ? 'selected' : ''} ${mark ? `marked severity-${mark.severity.toLowerCase()}` : ''}`} onClick={() => select(element)}>
              <b>{element.number}</b>{element.name}{mark && <em>{mark.count}</em>}
            </button>;
          })}
        </div></div>)}
      </div>

      {selected && <section className="element-editor" data-testid="element-editor" aria-label={`Замечание: ${selected.name}`}>
        <header><b>{selected.number}</b><div><strong>{selected.name}</strong><small>{GROUP_LABELS[selected.group]}</small></div>
          <button type="button" aria-label="Закрыть" onClick={() => setSelectedId(null)}>×</button></header>
        <div className="quick-notes">{QUICK_NOTES[selected.group].map((value) => <button key={value} type="button" className={note === value ? 'selected' : ''} onClick={() => setNote(value)}>{value}</button>)}</div>
        <div className="severity-chips" role="radiogroup" aria-label="Тяжесть">{SEVERITIES.map((item) => <button key={item.value} type="button" role="radio" aria-checked={severity === item.value}
          className={`${severity === item.value ? 'selected' : ''} severity-${item.value.toLowerCase()}`} onClick={() => setSeverity(item.value)}>{item.label}</button>)}</div>
        <label className="compact-note">Комментарий<input data-testid="finding-note" value={note} maxLength={300} placeholder="Например, скол 3 мм у кромки" onChange={(event) => setNote(event.target.value)}/></label>
        <div className="element-actions">
          <label className="photo-add-button" aria-label={`Фото: ${selected.name}`}>{photoUploading ? '…' : '＋ Фото'}<input data-testid="defect-photo-input" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" disabled={photoUploading}
            onChange={(event) => { const file = event.target.files?.[0]; if (file) onPhoto(file, selected.name); event.target.value = ''; }}/></label>
          {elementPhotos.slice(-3).map((photo) => <img key={photo.id} src={photo.dataUrl} alt={`Фото: ${photo.zone}`}/>)}
          <button type="button" className="primary-button" data-testid="add-finding" disabled={!note.trim()} onClick={addFinding}>Добавить замечание</button>
        </div>
      </section>}

      <section className="findings-list" data-testid="findings-list">
        <div className="detected-title"><span>Обнаружено при осмотре</span><b>{findings.length}</b></div>
        {!findings.length && <p className="findings-empty">Замечаний нет. Если на автомобиле есть повреждения, отметьте их на схеме.</p>}
        {sortedFindings.map(({ finding, index }) => <div key={`${finding.zone}-${index}`} className={`finding-row severity-${finding.severity.toLowerCase()}`} data-testid="finding-row">
          <b>{numberOf(finding.zone) ?? '•'}</b>
          <button type="button" className="finding-text" onClick={() => { const element = ordered.find((item) => item.name === finding.zone); if (element) select(element); }}>
            <strong>{finding.zone}</strong><small>{finding.note}</small>
          </button>
          <em>{severityLabel(finding.severity)}</em>
          <button type="button" className="finding-remove" aria-label={`Удалить замечание: ${finding.zone}`} onClick={() => onFindings(findings.filter((_, position) => position !== index))}>×</button>
        </div>)}
      </section>
    </div>
  );
}
