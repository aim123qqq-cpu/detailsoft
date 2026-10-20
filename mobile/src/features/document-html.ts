import { BODY_TYPES, carLayout, normalizeBodyType } from '@df/shared/carLayouts';
import type { OrderDocument } from '@df/types';
import { money } from '@/lib/format';
import { PALETTES, findingMarks } from './car-diagram';
import { METHOD_WORDS, PRIORITY_WORDS, SEVERITY_WORDS, documentDate } from './document-paper';

const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

/** The inspection diagram as SVG markup in the act's light colours (the same drawing as on screen). */
function diagramSvg(bodyType: string, findings: { zone: string; severity: 'LOW' | 'MEDIUM' | 'HIGH' }[]) {
  const layout = carLayout(normalizeBodyType(bodyType));
  const marks = findingMarks(findings);
  const tone = PALETTES.paper;
  const drawn = layout.elements.filter((element) => element.d);
  const fill = (element: (typeof drawn)[number]) => {
    const mark = marks.get(element.name);
    if (mark) return tone.marks[mark.severity];
    return element.group === 'glass' ? '#c9d3da' : element.group === 'wheel' ? tone.wheel : element.group === 'mirror' ? tone.mirror : element.id === 'bed' ? tone.bed : '#f1efea';
  };
  const part = (element: (typeof drawn)[number]) => `<path d="${element.d}" fill="${fill(element)}" stroke="${tone.stroke}" stroke-width="0.8"/>`;
  const outside = drawn.filter((element) => element.group === 'wheel' || element.group === 'mirror').map(part).join('');
  const panels = drawn.filter((element) => element.group === 'body' || element.group === 'glass').map(part).join('');
  const badges = drawn.map((element) => {
    const mark = marks.get(element.name);
    const { x, y } = element.label!;
    return `<circle cx="${x}" cy="${y}" r="7" fill="${mark ? { LOW: '#8f7220', MEDIUM: '#b9561d', HIGH: '#b8302a' }[mark.severity] : 'rgba(14,19,24,.88)'}"/>`
      + `<text x="${x}" y="${y + 2.7}" fill="#fff" font-size="7.5" font-weight="800" text-anchor="middle" font-family="sans-serif">${element.number}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${layout.width} ${layout.height}" width="220"><defs><clipPath id="c"><path d="${layout.outline}"/></clipPath></defs>`
    + `${outside}<path d="${layout.outline}" fill="${tone.shell}"/><g clip-path="url(#c)">${panels}</g>`
    + `<path d="${layout.details}" fill="none" stroke="${tone.details}" stroke-width="0.7" clip-path="url(#c)"/>`
    + `<path d="${layout.outline}" fill="none" stroke="${tone.outline}" stroke-width="1.1"/>${badges}</svg>`;
}

/** A printable HTML page of an issued act, for a PDF to share with the customer. */
export function documentHtml(document: OrderDocument) {
  const content = document.content;
  const vehicle = [content.vehicle.make, content.vehicle.model, content.vehicle.generation].filter(Boolean).join(' ');
  const intake = content.intake;
  const parts: string[] = [];
  parts.push(`<p class="muted">${escape(content.center.name)}</p><h1>${escape(content.title)}</h1><p class="muted">№ ${escape(document.number)} · заказ #${escape(content.order.number)}</p>`);
  parts.push(`<table class="parties"><tr><td>Клиент<br><b>${escape(content.customer.name)}</b></td><td>Телефон<br><b>${escape(content.customer.phoneDisplay)}</b></td></tr>`
    + `<tr><td>Автомобиль<br><b>${escape(vehicle)}</b></td><td>Госномер<br><b>${escape(content.vehicle.plate)}</b></td></tr>`
    + `<tr><td>Цвет<br><b>${escape(content.vehicle.color)}</b></td><td>Заказ открыт<br><b>${escape(documentDate(content.order.createdAt))}</b></td></tr></table>`);
  if (intake) {
    parts.push(`<h2>Состояние при приёмке</h2><p>${escape(intake.conditionSummary)}</p><h2>Зафиксированные повреждения</h2>`);
    if (intake.bodyType) parts.push(`<div class="diagram">${diagramSvg(intake.bodyType, intake.findings)}<p class="muted">Схема осмотра · ${escape(BODY_TYPES.find((item) => item.code === intake.bodyType)?.label ?? 'кузов')}. Номера в списке соответствуют элементам на схеме.</p></div>`);
    parts.push(intake.findings.length
      ? `<ol class="plain">${intake.findings.map((finding) => `<li>${finding.element ? `${finding.element}. ` : '• '}<b>${escape(finding.zone)}</b> · ${SEVERITY_WORDS[finding.severity]} — ${escape(finding.note)}</li>`).join('')}</ol>`
      : '<p>Повреждений не выявлено.</p>');
    if (intake.recommendations.length) parts.push(`<h2>Рекомендации</h2><ol>${intake.recommendations.map((item) => `<li><b>${escape(item.title)}</b> (${PRIORITY_WORDS[item.priority]}) — ${escape(item.reason)}</li>`).join('')}</ol>`);
    parts.push(`<p class="muted">Осмотр: ${escape(documentDate(intake.completedAt))} · фото при приёмке: ${intake.photoCount}</p>`);
  }
  if (content.works) {
    parts.push(`<h2>Выполненные работы</h2><table class="works">${content.works.map((work) => `<tr><td>${escape(work.name)}${work.status !== 'DONE' ? ' (не выполнено)' : ''}</td><td class="sum">${escape(money(work.amountMinor))}</td></tr>`).join('')}`
      + (content.estimate ? `<tr class="total"><td>Итого по согласованной смете v${content.estimate.version}</td><td class="sum">${escape(money(content.estimate.totalAmountMinor))}</td></tr>` : '') + '</table>');
    if (content.estimate?.approvedAt) parts.push(`<p class="muted">Смета согласована ${escape(documentDate(content.estimate.approvedAt))} ${escape(METHOD_WORDS[content.estimate.approvalMethod ?? ''] ?? '')}${content.estimate.approvedBy ? ` · ответственный: ${escape(content.estimate.approvedBy)}` : ''}</p>`);
    if (content.handover) parts.push(`<p class="muted">Выдача: ${escape(documentDate(content.handover.handedOverAt))} · выдал: ${escape(content.handover.responsible)} · ${escape(content.handover.note)}</p>`);
  }
  parts.push(`<p class="statement">${escape(content.statement)}</p>`);
  parts.push(`<table class="signatures"><tr><td>Клиент<div class="sign">${document.signatureDataUrl ? `<img src="${document.signatureDataUrl}">` : ''}</div>${escape(document.signerName ? `${document.signerName}${document.signedAt ? ` · ${documentDate(document.signedAt)}` : ''}` : 'подпись / ФИО')}</td>`
    + `<td>Сотрудник центра<div class="sign"></div>${escape(document.actorName ?? 'подпись / ФИО')}</td></tr></table>`);
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>
    body { font-family: -apple-system, Roboto, sans-serif; color: #16191c; font-size: 13px; line-height: 1.45; margin: 28px; }
    h1 { font-size: 20px; margin: 2px 0; } h2 { font-size: 14px; margin: 16px 0 4px; }
    .muted { color: #5c6368; font-size: 11.5px; margin: 2px 0; }
    table { width: 100%; border-collapse: collapse; } .parties td { width: 50%; padding: 4px 0; color: #5c6368; font-size: 11.5px; vertical-align: top; }
    .parties b { color: #16191c; font-size: 13px; } .parties { border-top: 1px solid #d9d6cf; border-bottom: 1px solid #d9d6cf; margin: 10px 0; }
    .works td { padding: 3px 0; border-bottom: 1px solid #ece9e3; } .sum { text-align: right; white-space: nowrap; } .total td { font-weight: 700; border-bottom: 0; }
    .diagram { text-align: center; margin: 8px 0; } ol.plain { list-style: none; padding: 0; } li { margin: 2px 0; }
    .statement { font-style: italic; margin-top: 18px; } .signatures td { width: 50%; padding-right: 20px; color: #5c6368; font-size: 11.5px; vertical-align: top; }
    .sign { height: 64px; border-bottom: 1px solid #16191c; margin: 6px 0 4px; } .sign img { height: 62px; }
  </style></head><body>${parts.join('')}</body></html>`;
}
