/**
 * Top-view inspection layouts per body type, shared by the intake screen and the intake act (server
 * and app): every element has its own number, and the act lists findings with the same numbers.
 * Coordinates are in a 200-unit-wide view box, front of the car at the top.
 */

export type BodyType = 'sedan' | 'hatchback' | 'wagon' | 'suv' | 'coupe' | 'van' | 'pickup';
export type ElementGroup = 'body' | 'glass' | 'wheel' | 'mirror' | 'interior' | 'other';

export const BODY_TYPES: Array<{ code: BodyType; label: string }> = [
  { code: 'sedan', label: 'Седан' },
  { code: 'hatchback', label: 'Хэтчбек' },
  { code: 'wagon', label: 'Универсал' },
  { code: 'suv', label: 'Кроссовер' },
  { code: 'coupe', label: 'Купе' },
  { code: 'van', label: 'Минивэн' },
  { code: 'pickup', label: 'Пикап' }
];

export type LayoutElement = {
  id: string;
  number: number;
  name: string;
  group: ElementGroup;
  /** SVG path in the view box; absent for interior and other items (listed, not drawn). */
  d?: string;
  /** Where the number badge sits. */
  label?: { x: number; y: number };
};

/** `elements` are in drawing order (panels that sit under others first); `details` are visual-only lines. */
export type CarLayout = { bodyType: BodyType; width: number; height: number; outline: string; details: string; elements: LayoutElement[] };

type Shape = {
  width: number;
  /** How far the rounded nose and tail reach along the car. */
  nose: number;
  tail: number;
  /** Lengths front to back: bumper, hood, windshield, roof, rear glass, trunk/tailgate (or bed), rear bumper. */
  bumper: number; hood: number; windshield: number; roof: number; rearGlass: number; trunk: number; rearBumper: number;
  doors: 'four' | 'two' | 'sliding';
  rear: 'trunk' | 'tailgate' | 'bed';
};

const SHAPES: Record<BodyType, Shape> = {
  sedan:     { width: 132, nose: 46, tail: 34, bumper: 16, hood: 84, windshield: 40, roof: 92, rearGlass: 32, trunk: 50, rearBumper: 14, doors: 'four', rear: 'trunk' },
  hatchback: { width: 130, nose: 44, tail: 26, bumper: 16, hood: 76, windshield: 40, roof: 96, rearGlass: 30, trunk: 22, rearBumper: 14, doors: 'four', rear: 'tailgate' },
  wagon:     { width: 134, nose: 46, tail: 22, bumper: 16, hood: 82, windshield: 40, roof: 140, rearGlass: 18, trunk: 20, rearBumper: 14, doors: 'four', rear: 'tailgate' },
  suv:       { width: 146, nose: 34, tail: 20, bumper: 18, hood: 86, windshield: 36, roof: 132, rearGlass: 20, trunk: 22, rearBumper: 16, doors: 'four', rear: 'tailgate' },
  coupe:     { width: 132, nose: 50, tail: 38, bumper: 16, hood: 96, windshield: 44, roof: 70, rearGlass: 38, trunk: 46, rearBumper: 14, doors: 'two', rear: 'trunk' },
  van:       { width: 146, nose: 40, tail: 16, bumper: 16, hood: 52, windshield: 44, roof: 196, rearGlass: 14, trunk: 18, rearBumper: 14, doors: 'sliding', rear: 'tailgate' },
  pickup:    { width: 146, nose: 32, tail: 12, bumper: 18, hood: 90, windshield: 36, roof: 70, rearGlass: 10, trunk: 112, rearBumper: 14, doors: 'four', rear: 'bed' }
};

const TOP = 22;
const r = (value: number) => Math.round(value * 10) / 10;
const rect = (x1: number, y1: number, x2: number, y2: number) => `M${r(x1)} ${r(y1)}H${r(x2)}V${r(y2)}H${r(x1)}Z`;
const center = (x1: number, y1: number, x2: number, y2: number) => ({ x: r((x1 + x2) / 2), y: r((y1 + y2) / 2) });

export function normalizeBodyType(value: string | null | undefined): BodyType {
  return value && value in SHAPES ? value as BodyType : 'sedan';
}

export function carLayout(input: string | null | undefined): CarLayout {
  const bodyType = normalizeBodyType(input);
  const s = SHAPES[bodyType];
  const left = 100 - s.width / 2;
  const right = 100 + s.width / 2;
  const side = s.width * 0.17;
  const xL = left + side;
  const xR = right - side;
  const inset = 5;
  // Stations along the car, front to back.
  const yBF = TOP + s.bumper;
  const yH = yBF + s.hood;
  const yWS = yH + s.windshield;
  const yRoof = yWS + s.roof;
  const yRG = yRoof + s.rearGlass;
  const yBR = yRG + s.trunk;
  const yEnd = yBR + s.rearBumper;
  const W = s.width;

  // Rounded nose and tail; the sides swell slightly between the axles.
  const outline = [
    `M${left} ${TOP + s.nose}`,
    `C${left} ${r(TOP + s.nose * 0.32)} ${r(left + W * 0.2)} ${TOP} 100 ${TOP}`,
    `C${r(right - W * 0.2)} ${TOP} ${right} ${r(TOP + s.nose * 0.32)} ${right} ${TOP + s.nose}`,
    `C${right + 1.5} ${TOP + s.nose + 40} ${right + 1.5} ${yEnd - s.tail - 40} ${right} ${yEnd - s.tail}`,
    `C${right} ${r(yEnd - s.tail * 0.3)} ${r(right - W * 0.16)} ${yEnd} 100 ${yEnd}`,
    `C${r(left + W * 0.16)} ${yEnd} ${left} ${r(yEnd - s.tail * 0.3)} ${left} ${yEnd - s.tail}`,
    `C${left - 1.5} ${yEnd - s.tail - 40} ${left - 1.5} ${TOP + s.nose + 40} ${left} ${TOP + s.nose}`,
    'Z'
  ].join(' ');

  // Doors start at the A-pillar and end near the C-pillar.
  const doorStart = yH + 6;
  const doorEnd = s.rear === 'bed' ? yRG : s.doors === 'two' ? yRoof - 4 : yRoof + 6;
  const sideSplits: Array<{ key: string; name: string; from: number; to: number }> = [];
  if (s.doors === 'four') {
    const middle = doorStart + (doorEnd - doorStart) * 0.52;
    sideSplits.push({ key: 'front-door', name: 'передняя дверь', from: doorStart, to: middle }, { key: 'rear-door', name: 'задняя дверь', from: middle, to: doorEnd });
  } else if (s.doors === 'two') {
    sideSplits.push({ key: 'front-door', name: 'дверь', from: doorStart, to: doorEnd });
  } else {
    const frontDoor = doorStart + 60;
    sideSplits.push({ key: 'front-door', name: 'передняя дверь', from: doorStart, to: frontDoor }, { key: 'sliding-door', name: 'сдвижная дверь', from: frontDoor, to: frontDoor + 96 });
  }
  const quarterFrom = sideSplits[sideSplits.length - 1].to;
  const wrapF = TOP + s.nose * 0.78;
  const wrapR = yEnd - s.tail * 0.78;

  // Numbering order (what the employee and the act see).
  const elements: Array<Omit<LayoutElement, 'number'>> = [];
  const add = (id: string, name: string, group: ElementGroup, d?: string, label?: { x: number; y: number }) => elements.push({ id, name, group, d, label });

  add('front-bumper', 'Передний бампер', 'body',
    `M${left - 3} ${TOP - 3}H${right + 3}V${r(wrapF)}C${right - 4} ${r(wrapF)} ${r(right - side)} ${yBF} 100 ${yBF}C${r(left + side)} ${yBF} ${left + 4} ${r(wrapF)} ${left - 3} ${r(wrapF)}Z`,
    { x: 100, y: r(TOP + s.bumper * 0.5) });
  add('hood', 'Капот', 'body', rect(xL, TOP, xR, yH + 6), center(xL, yBF, xR, yH));
  add('windshield', 'Лобовое стекло', 'glass',
    `M${r(xL)} ${yH + 5}Q100 ${yH - 7} ${r(xR)} ${yH + 5}L${r(xR - inset)} ${yWS}Q100 ${yWS - 5} ${r(xL + inset)} ${yWS}Z`, center(xL, yH, xR, yWS));
  add('roof', 'Крыша', 'body',
    `M${r(xL + inset)} ${yWS}Q100 ${yWS - 5} ${r(xR - inset)} ${yWS}V${yRoof}Q100 ${yRoof + 4} ${r(xL + inset)} ${yRoof}Z`, center(xL, yWS, xR, yRoof));
  add('rear-glass', s.rear === 'bed' ? 'Заднее стекло кабины' : 'Заднее стекло', 'glass',
    `M${r(xL + inset)} ${yRoof}Q100 ${yRoof + 4} ${r(xR - inset)} ${yRoof}L${r(xR)} ${yRG - 3}Q100 ${yRG + 5} ${r(xL)} ${yRG - 3}Z`, center(xL, yRoof, xR, yRG));
  if (s.rear === 'bed') {
    const tailgate = yBR - 12;
    add('bed', 'Кузов (платформа)', 'body', rect(xL, yRG + 4, xR, tailgate), center(xL, yRG, xR, tailgate));
    add('tailgate', 'Задний борт', 'body', rect(xL, tailgate, xR, yEnd), { x: 100, y: r((tailgate + yBR) / 2) });
  } else {
    add('trunk', s.rear === 'trunk' ? 'Крышка багажника' : 'Дверь багажника', 'body', rect(xL, yRG - 4, xR, yEnd), center(xL, yRG, xR, yBR));
  }
  add('rear-bumper', 'Задний бампер', 'body',
    `M${left - 3} ${yEnd + 3}H${right + 3}V${r(wrapR)}C${right - 4} ${r(wrapR)} ${r(right - side)} ${yBR} 100 ${yBR}C${r(left + side)} ${yBR} ${left + 4} ${r(wrapR)} ${left - 3} ${r(wrapR)}Z`,
    { x: 100, y: r(yEnd - s.rearBumper * 0.5) });

  for (const [sideKey, x1, x2] of [['left', left - 3, xL], ['right', xR, right + 3]] as const) {
    const neuter = sideKey === 'left' ? 'Левое' : 'Правое';
    const feminine = sideKey === 'left' ? 'Левая' : 'Правая';
    const masculine = sideKey === 'left' ? 'Левый' : 'Правый';
    add(`${sideKey}-front-fender`, `${neuter} переднее крыло`, 'body', rect(x1, TOP, x2, doorStart), center(x1, wrapF, x2, doorStart));
    for (const split of sideSplits) add(`${sideKey}-${split.key}`, `${feminine} ${split.name}`, 'body', rect(x1, split.from, x2, split.to), center(x1, split.from, x2, split.to));
    if (s.rear === 'bed') add(`${sideKey}-bed-side`, `${masculine} борт кузова`, 'body', rect(x1, quarterFrom, x2, yEnd), center(x1, quarterFrom, x2, wrapR));
    else add(`${sideKey}-rear-fender`, `${neuter} заднее крыло`, 'body', rect(x1, quarterFrom, x2, yEnd), center(x1, quarterFrom, x2, wrapR));
  }

  const mirrorY = yH + 10;
  add('left-mirror', 'Левое зеркало', 'mirror', `M${left - 1} ${mirrorY - 4}H${left - 11}Q${left - 16} ${mirrorY + 1} ${left - 11} ${mirrorY + 6}H${left - 1}Z`, { x: left - 21, y: mirrorY + 1 });
  add('right-mirror', 'Правое зеркало', 'mirror', `M${right + 1} ${mirrorY - 4}H${right + 11}Q${right + 16} ${mirrorY + 1} ${right + 11} ${mirrorY + 6}H${right + 1}Z`, { x: right + 21, y: mirrorY + 1 });

  const frontAxle = r(yBF + s.hood * 0.5);
  const rearAxle = r(yBR - (s.rear === 'bed' ? 30 : 26));
  const wheel = (x: number, y: number) => `M${r(x - 4)} ${r(y - 17)}h8a3 3 0 0 1 3 3v28a3 3 0 0 1-3 3h-8a3 3 0 0 1-3-3v-28a3 3 0 0 1 3-3Z`;
  add('wheel-front-left', 'Переднее левое колесо', 'wheel', wheel(left - 3, frontAxle), { x: left - 21, y: frontAxle });
  add('wheel-front-right', 'Переднее правое колесо', 'wheel', wheel(right + 3, frontAxle), { x: right + 21, y: frontAxle });
  add('wheel-rear-left', 'Заднее левое колесо', 'wheel', wheel(left - 3, rearAxle), { x: left - 21, y: rearAxle });
  add('wheel-rear-right', 'Заднее правое колесо', 'wheel', wheel(right + 3, rearAxle), { x: right + 21, y: rearAxle });

  const interior: Array<[string, string]> = [['front-seats', 'Передние сиденья'], ['rear-seats', s.doors === 'two' ? 'Задние сиденья' : 'Задний диван'],
    ['dashboard', 'Приборная панель'], ['headliner', 'Потолок'], ['floor', 'Пол и коврики']];
  for (const [id, name] of interior) add(id, name, 'interior');
  if (s.rear !== 'bed') add('cargo', 'Багажное отделение', 'interior');
  add('kit', 'Комплектность', 'other');
  add('keys', 'Ключи и документы', 'other');

  // Hood creases and door handles: purely visual.
  const handles = sideSplits.map((split) => `M${r(left + 3)} ${r(split.to - 12)}h5M${r(right - 8)} ${r(split.to - 12)}h5`).join('');
  const details = `M${r(xL + side * 0.6)} ${r(yBF + 12)}Q100 ${r(yBF + 6)} ${r(xR - side * 0.6)} ${r(yBF + 12)}`
    + `M${r(100 - W * 0.12)} ${r(yBF + 18)}L${r(100 - W * 0.09)} ${r(yH - 8)}M${r(100 + W * 0.12)} ${r(yBF + 18)}L${r(100 + W * 0.09)} ${r(yH - 8)}`
    + handles;

  const numbered = elements.map((element, index) => ({ ...element, number: index + 1 }));
  // Panels that run under others (hood under the bumper, trunk under the rear one) are drawn first.
  const under = ['hood', 'trunk', 'bed', 'tailgate'];
  const drawn = [...numbered].sort((a, b) => Number(!under.includes(a.id)) - Number(!under.includes(b.id)) || a.number - b.number);
  return { bodyType, width: 200, height: r(yEnd + TOP), outline, details, elements: drawn };
}

/** The element a finding refers to (findings store the element name as their zone). */
export function findLayoutElement(bodyType: string | null | undefined, name: string) {
  return carLayout(bodyType).elements.find((element) => element.name === name) ?? null;
}

/** Quick notes offered for an element group. */
export const QUICK_NOTES: Record<ElementGroup, string[]> = {
  body: ['Скол ЛКП', 'Царапина', 'Вмятина', 'Потёртость', 'Битум и смола', 'Сильное загрязнение'],
  glass: ['Скол', 'Трещина', 'Царапины', 'Плёнка повреждена'],
  wheel: ['Бордюрная царапина', 'Скол на диске', 'Коррозия', 'Нет колпачка или секретки'],
  mirror: ['Скол корпуса', 'Трещина зеркального элемента', 'Не складывается'],
  interior: ['Пятно', 'Износ обивки', 'Шерсть животных', 'Прожог', 'Посторонний запах'],
  other: ['Отсутствует', 'Повреждено', 'Требует уточнения']
};
