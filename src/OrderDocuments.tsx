import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api';
import { CarDiagram, findingMarks } from './intake/CarDiagram';
import { BODY_TYPES, carLayout, normalizeBodyType } from './shared/carLayouts';
import { contractorLine } from './shared/orderDocuments';
import type { OrderDocument, OrderDocumentContent, OrderDocumentType, WorkOrder } from './types';

const documentTitles: Record<OrderDocumentType, string> = {
  intake_act: 'Акт приёмки',
  handover_act: 'Акт выдачи (заказ-наряд)'
};
const severityLabels = { LOW: 'лёгкое', MEDIUM: 'среднее', HIGH: 'серьёзное' } as const;
const priorityLabels = { OPTIONAL: 'по желанию', RECOMMENDED: 'рекомендуется', URGENT: 'срочно' } as const;
const methodLabels: Record<string, string> = { in_person: 'лично', phone: 'по телефону', messenger: 'в мессенджере' };
const dateTime = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const money = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 });

function formatDate(value: string | null | undefined) {
  return value ? dateTime.format(new Date(value)) : '—';
}

export function DocumentPaper({ content, number, pendingNumber, signerName, signatureDataUrl, signedAt, actorName }: {
  content: OrderDocumentContent;
  number?: string;
  /** Issued offline: the server numbers it once the queue is sent. */
  pendingNumber?: boolean;
  signerName?: string | null;
  signatureDataUrl?: string | null;
  signedAt?: string | null;
  actorName?: string | null;
}) {
  const vehicle = `${content.vehicle.make} ${content.vehicle.model}${content.vehicle.generation ? ` ${content.vehicle.generation}` : ''}`;
  return (
    <article className="document-paper" data-testid="document-paper">
      <header>
        <span>{content.center.name}</span>
        {contractorLine(content.center) && <small className="document-contractor">Исполнитель: {contractorLine(content.center)}</small>}
        <h2>{content.title}</h2>
        <p>{number ? `№ ${number}` : pendingNumber ? 'Сохранён на телефоне · номер присвоится при отправке' : 'Предпросмотр · номер присвоится при сохранении'} · заказ #{content.order.number}</p>
      </header>
      <dl className="document-parties">
        <div><dt>Клиент</dt><dd>{content.customer.name}</dd></div>
        <div><dt>Телефон</dt><dd>{content.customer.phoneDisplay}</dd></div>
        <div><dt>Автомобиль</dt><dd>{vehicle}</dd></div>
        <div><dt>Госномер</dt><dd>{content.vehicle.plate}</dd></div>
        <div><dt>Цвет</dt><dd>{content.vehicle.color}</dd></div>
        <div><dt>Заказ открыт</dt><dd>{formatDate(content.order.createdAt)}</dd></div>
      </dl>

      {content.intake && <>
        <h3>Состояние при приёмке</h3>
        <p>{content.intake.conditionSummary}</p>
        <h3>Зафиксированные повреждения</h3>
        {content.intake.bodyType && <figure className="document-diagram">
          <CarDiagram layout={carLayout(normalizeBodyType(content.intake.bodyType))} marks={findingMarks(content.intake.findings)}/>
          <figcaption>Схема осмотра · {BODY_TYPES.find((item) => item.code === content.intake?.bodyType)?.label ?? 'кузов'}. Номера в списке соответствуют элементам на схеме.</figcaption>
        </figure>}
        {content.intake.findings.length ? <ol className="document-list">{content.intake.findings.map((finding, index) => (
          <li key={index}>{finding.element ? <span className="document-element">{finding.element}</span> : null}<b>{finding.zone}</b> · {severityLabels[finding.severity]} — {finding.note}</li>
        ))}</ol> : <p>Повреждений не выявлено.</p>}
        {content.intake.recommendations.length > 0 && <>
          <h3>Рекомендации</h3>
          <ol className="document-list">{content.intake.recommendations.map((item, index) => (
            <li key={index}><b>{item.title}</b> ({priorityLabels[item.priority]}) — {item.reason}</li>
          ))}</ol>
        </>}
        <p className="document-meta">Осмотр: {formatDate(content.intake.completedAt)} · фото при приёмке: {content.intake.photoCount}</p>
      </>}

      {content.works && <>
        <h3>Выполненные работы</h3>
        <table className="document-table">
          <thead><tr><th>Работа</th><th>Сумма</th></tr></thead>
          <tbody>{content.works.map((work, index) => <tr key={index}><td>{work.name}{work.status !== 'DONE' ? ' (не выполнено)' : ''}</td><td>{money.format(work.amountMinor / 100)}</td></tr>)}</tbody>
          {content.estimate && <tfoot><tr><td>Итого по согласованной смете v{content.estimate.version}</td><td>{money.format(content.estimate.totalAmountMinor / 100)}</td></tr></tfoot>}
        </table>
        {content.estimate?.approvedAt && <p className="document-meta">Смета согласована {formatDate(content.estimate.approvedAt)}{content.estimate.approvalMethod ? ` ${methodLabels[content.estimate.approvalMethod] ?? ''}` : ''}{content.estimate.approvedBy ? ` · ответственный: ${content.estimate.approvedBy}` : ''}</p>}
        {content.handover && <p className="document-meta">Выдача: {formatDate(content.handover.handedOverAt)} · выдал: {content.handover.responsible} · {content.handover.note}</p>}
        {content.photos && <p className="document-meta">Фото до работ: {content.photos.intake} · после работ: {content.photos.result}</p>}
      </>}

      {content.warranty && <p className="document-meta">Гарантия: {content.warranty}</p>}
      <p className="document-statement">{content.statement}</p>

      <footer className="document-signatures">
        <div>
          <span>Клиент</span>
          {signatureDataUrl ? <img src={signatureDataUrl} alt={`Подпись: ${signerName}`}/> : <i className="signature-line"/>}
          <small>{signerName ? `${signerName}${signedAt ? ` · ${formatDate(signedAt)}` : ''}` : 'подпись / ФИО'}</small>
        </div>
        <div>
          <span>Сотрудник центра</span>
          <i className="signature-line"/>
          <small>{actorName ?? 'подпись / ФИО'}</small>
        </div>
      </footer>
    </article>
  );
}

function SignaturePad({ onChange }: { onChange: (dataUrl: string | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [hasInk, setHasInk] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(canvas.clientWidth * ratio);
    canvas.height = Math.round(canvas.clientHeight * ratio);
    const context = canvas.getContext('2d');
    if (!context) return;
    context.scale(ratio, ratio);
    context.lineWidth = 2.4;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.strokeStyle = '#111518';
  }, []);

  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const start = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const context = event.currentTarget.getContext('2d');
    if (!context) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = true;
    const { x, y } = point(event);
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(x + 0.1, y + 0.1);
    context.stroke();
  };
  const move = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const context = event.currentTarget.getContext('2d');
    if (!context) return;
    const { x, y } = point(event);
    context.lineTo(x, y);
    context.stroke();
  };
  const end = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    drawing.current = false;
    setHasInk(true);
    onChange(event.currentTarget.toDataURL('image/png'));
  };
  const clear = () => {
    const canvas = canvasRef.current;
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    setHasInk(false);
    onChange(null);
  };

  return (
    <div className="signature-pad">
      <canvas
        ref={canvasRef}
        data-testid="signature-pad"
        role="img"
        aria-label="Поле для подписи клиента пальцем или стилусом"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      />
      <div><span>{hasInk ? 'Подпись поставлена' : 'Подпишите пальцем в рамке'}</span><button type="button" onClick={clear} disabled={!hasInk}>Очистить</button></div>
    </div>
  );
}

function DocumentOverlay({ title, onClose, children, actions }: { title: string; onClose: () => void; children: React.ReactNode; actions?: React.ReactNode }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    headingRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Rendered into <body> so a transformed ancestor (screen enter animation) cannot shrink the fixed overlay.
  return createPortal(
    <div className="document-overlay" role="dialog" aria-modal="true" aria-labelledby="document-overlay-title">
      <div className="document-toolbar">
        <button type="button" onClick={onClose} data-testid="close-document">← Закрыть</button>
        <h2 id="document-overlay-title" ref={headingRef} tabIndex={-1}>{title}</h2>
        {actions}
      </div>
      {children}
    </div>,
    document.body
  );
}

function DocumentSigner({ orderId, type, defaultSigner, onCancel, onIssued }: {
  orderId: string;
  type: OrderDocumentType;
  defaultSigner: string;
  onCancel: () => void;
  onIssued: (document: OrderDocument) => void;
}) {
  const [content, setContent] = useState<OrderDocumentContent | null>(null);
  const [signerName, setSignerName] = useState(defaultSigner);
  const [signature, setSignature] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    api.previewOrderDocument(orderId, type, controller.signal)
      .then((result) => setContent(result.content))
      .catch((requestError: Error) => { if (requestError.name !== 'AbortError') setError(requestError.message); });
    return () => controller.abort();
  }, [orderId, type]);

  const issue = async (signed: boolean) => {
    setBusy(true); setError('');
    try {
      onIssued(await api.issueOrderDocument(orderId, signed && signature
        ? { type, signerName: signerName.trim(), signatureDataUrl: signature }
        : { type }));
    } catch (requestError) { setError((requestError as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <DocumentOverlay title={documentTitles[type]} onClose={onCancel}>
      <div className="document-signer" data-testid="document-signer">
        {!content ? <div className="workspace-state">{error || <><span className="spinner"/> Готовим документ</>}</div> : <>
          <DocumentPaper content={content}/>
          <section className="document-sign-panel">
            <h3>Подпись клиента</h3>
            <p>Покажите документ клиенту. Подпись необязательна: можно сформировать акт без неё и подписать на бумаге.</p>
            <label htmlFor="signer-name">ФИО подписанта</label>
            <input id="signer-name" data-testid="signer-name" value={signerName} maxLength={120} autoComplete="off" onChange={(event) => setSignerName(event.target.value)}/>
            <SignaturePad onChange={setSignature}/>
            {error && <p className="form-error" role="alert">{error}</p>}
            <div className="document-sign-actions">
              <button type="button" data-testid="issue-unsigned" disabled={busy} onClick={() => issue(false)}>Без подписи</button>
              <button type="button" data-testid="sign-document" disabled={busy || !signature || signerName.trim().length < 2} onClick={() => issue(true)}>{busy ? 'Сохраняем…' : 'Подписать и сохранить'}</button>
            </div>
          </section>
        </>}
      </div>
    </DocumentOverlay>
  );
}

function DocumentViewer({ orderId, documentId, onClose }: { orderId: string; documentId: string; onClose: () => void }) {
  const [document, setDocument] = useState<OrderDocument | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    api.getOrderDocument(orderId, documentId, controller.signal)
      .then(setDocument)
      .catch((requestError: Error) => { if (requestError.name !== 'AbortError') setError(requestError.message); });
    return () => controller.abort();
  }, [orderId, documentId]);
  return (
    <DocumentOverlay
      title={document ? `${documentTitles[document.type]} ${numberLabel(document)}` : 'Документ'}
      onClose={onClose}
      actions={document && <button type="button" className="primary" data-testid="print-document" onClick={() => window.print()}>Печать / PDF</button>}
    >
      <div className="document-viewer" data-testid="document-viewer">
        {!document ? <div className="workspace-state">{error || <><span className="spinner"/> Загружаем документ</>}</div> : <>
          {document.outdated && <div className="customer-note duplicate-note document-outdated"><strong>Акт устарел</strong><span>После его подписания приёмку осмотрели повторно. Документ сохранён без изменений; оформите новый акт.</span></div>}
          <DocumentPaper content={document.content} number={document.id.startsWith('doc_local_') ? undefined : document.number} pendingNumber={document.id.startsWith('doc_local_')} signerName={document.signerName} signatureDataUrl={document.signatureDataUrl} signedAt={document.signedAt} actorName={document.actorName}/>
        </>}
      </div>
    </DocumentOverlay>
  );
}

/** An act issued offline gets its number from the server when it is sent. */
const numberLabel = (document: { id: string; number: string }) => document.id.startsWith('doc_local_') ? 'номер присвоится при отправке' : `№ ${document.number}`;

export function OrderDocumentsPanel({ order, types = ['intake_act', 'handover_act'], defaultSigner, onChanged }: {
  order: WorkOrder;
  types?: OrderDocumentType[];
  defaultSigner: string;
  onChanged: () => void;
}) {
  const [signing, setSigning] = useState<OrderDocumentType | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const available = types.filter((type) => type === 'intake_act' ? Boolean(order.intake) : order.status === 'CLOSED');
  if (!available.length) return null;

  return (
    <section className="order-documents" data-testid="documents-panel" aria-label="Документы заказа">
      <div className="detail-section-heading"><span>Документы</span><strong>подпись необязательна</strong></div>
      {available.map((type) => {
        const documents = order.documents.filter((item) => item.type === type);
        const latest = documents.find((item) => item.current) ?? null;
        const older = documents.filter((item) => item !== latest);
        return <div className="order-document-row" key={type} data-testid={`document-row-${type}`}>
          <div>
            <strong>{documentTitles[type]}</strong>
            <small className={latest?.outdated ? 'warn' : ''}>{latest
              ? `${numberLabel(latest)} · ${latest.signed ? `подписан: ${latest.signerName}` : 'без подписи'}${latest.outdated ? ' · устарел после повторного осмотра' : ''}`
              : 'Ещё не оформлен'}</small>
          </div>
          <div className="order-document-actions">
            {latest && <button type="button" data-testid={`open-${type}`} onClick={() => setViewing(latest.id)}>Открыть</button>}
            <button type="button" className="primary" data-testid={`issue-${type}`} onClick={() => setSigning(type)}>{latest ? 'Оформить заново' : 'Оформить'}</button>
          </div>
          {older.length > 0 && <details className="order-document-history">
            <summary>Ранее выпущенные · {older.length}</summary>
            {older.map((item) => <button type="button" key={item.id} onClick={() => setViewing(item.id)}>{numberLabel(item)} · {item.signed ? `подписан: ${item.signerName}` : 'без подписи'}{item.outdated ? ' · устарел' : ''}</button>)}
          </details>}
        </div>;
      })}
      {signing && <DocumentSigner
        orderId={order.id}
        type={signing}
        defaultSigner={defaultSigner}
        onCancel={() => setSigning(null)}
        onIssued={(document) => { setSigning(null); onChanged(); setViewing(document.id); }}
      />}
      {viewing && <DocumentViewer orderId={order.id} documentId={viewing} onClose={() => setViewing(null)}/>}
    </section>
  );
}
