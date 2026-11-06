// Runs inside the page: draws what is on screen as an SVG of real layers (shapes and text, not a picture),
// which Figma opens as editable objects. Elements with something visible become groups, as in the screen's structure.
window.__domToSvg = function domToSvg(width, height, idPrefix) {
  const measure = document.createElement('canvas').getContext('2d');
  let clipCount = 0;
  const defs = [];
  const n = (value) => Number(value.toFixed(2));
  const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /** A CSS colour as SVG attributes; nothing for a transparent one. */
  function paint(color, attribute) {
    const match = /rgba?\(([^)]+)\)/.exec(color);
    if (!match) return '';
    const [r, g, b, a = '1'] = match[1].split(/[ ,/]+/).map((part) => part.trim());
    if (Number(a) === 0) return '';
    const hex = `#${[r, g, b].map((part) => Number(part).toString(16).padStart(2, '0')).join('')}`;
    return `${attribute}="${hex}"${Number(a) < 1 ? ` ${attribute}-opacity="${n(Number(a))}"` : ''}`;
  }

  const familyOf = (style) => /mono/i.test(style.fontFamily) ? 'Roboto Mono' : 'Roboto';

  function transformed(text, style) {
    if (style.textTransform === 'uppercase') return text.toUpperCase();
    if (style.textTransform === 'lowercase') return text.toLowerCase();
    return text;
  }

  function textLayer(text, x, baseline, style, color = style.color) {
    const fill = paint(color, 'fill');
    if (!fill) return '';
    const spacing = parseFloat(style.letterSpacing);
    return `<text x="${n(x)}" y="${n(baseline)}" font-family="${familyOf(style)}" font-size="${parseFloat(style.fontSize)}" font-weight="${style.fontWeight}" ${fill}${spacing ? ` letter-spacing="${n(spacing)}"` : ''} xml:space="preserve">${esc(text)}</text>`;
  }

  function ascentOf(style) {
    measure.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    return measure.measureText('Hg').fontBoundingBoxAscent;
  }

  /** One text layer per line: wrapping is taken from where the browser really broke the lines. */
  function textNodeLayers(node, style) {
    const raw = node.nodeValue;
    if (!raw.trim()) return '';
    const range = document.createRange();
    const lines = [];
    for (let index = 0; index < raw.length; index += 1) {
      range.setStart(node, index);
      range.setEnd(node, index + 1);
      const rect = range.getClientRects()[0];
      if (!rect || (!rect.width && !raw[index].trim())) continue;
      const line = lines.at(-1);
      if (line && Math.abs(line.top - rect.top) < rect.height / 2) { line.text += raw[index]; line.right = rect.right; }
      else lines.push({ top: rect.top, height: rect.height, left: rect.left, right: rect.right, text: raw[index] });
    }
    const ascent = ascentOf(style);
    const decoration = style.textDecorationLine;
    return lines.map((line) => {
      const leading = line.text.length - line.text.trimStart().length;
      const trimmed = line.text.trim();
      if (!trimmed) return '';
      const x = leading ? line.left + measureWidth(line.text.slice(0, leading), style) : line.left;
      const baseline = line.top + ascent;
      let mark = '';
      const fontSize = parseFloat(style.fontSize);
      if (decoration.includes('underline')) mark += `<rect x="${n(x)}" y="${n(baseline + fontSize * 0.1)}" width="${n(line.right - x)}" height="1" ${paint(style.color, 'fill')}/>`;
      if (decoration.includes('line-through')) mark += `<rect x="${n(x)}" y="${n(baseline - fontSize * 0.3)}" width="${n(line.right - x)}" height="1" ${paint(style.color, 'fill')}/>`;
      return textLayer(transformed(trimmed, style), x, baseline, style) + mark;
    }).join('');
  }

  function measureWidth(text, style) {
    measure.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    return measure.measureText(text).width;
  }

  function fieldLayers(el, style, rect) {
    const value = el.value || el.placeholder;
    if (!value) return '';
    const color = el.value ? style.color : getComputedStyle(el, '::placeholder').color;
    const left = rect.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
    const right = rect.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
    const ascent = ascentOf(style);
    measure.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const metrics = measure.measureText('Hg');
    const lineHeight = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
    const top = el.tagName === 'TEXTAREA'
      ? rect.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop)
      : rect.top + (rect.height - lineHeight) / 2;
    if (el.tagName === 'TEXTAREA') {
      // A long comment wraps as in the field; each line is its own layer, like other text.
      const lines = [];
      for (const word of value.split(/s+/)) {
        const line = lines.at(-1);
        if (line !== undefined && measure.measureText(`${line} ${word}`).width <= right - left) lines[lines.length - 1] = `${line} ${word}`;
        else lines.push(word);
      }
      const step = parseFloat(style.lineHeight) || lineHeight;
      return lines.map((line, index) => textLayer(line, left, top + ascent + index * step, style, color)).join('');
    }
    const x = style.textAlign === 'center' ? (left + right - measure.measureText(value).width) / 2 : left;
    return textLayer(value, x, top + ascent, style, color);
  }

  /** A rectangle with these corners: a rect when they are all equal, otherwise a path. */
  function shape(x, y, w, h, radii, attributes) {
    const limit = Math.min(w, h) / 2;
    const [tl, tr, br, bl] = radii.map((radius) => Math.min(radius, limit));
    if (tl === tr && tr === br && br === bl) return `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}"${tl ? ` rx="${n(tl)}"` : ''} ${attributes}/>`;
    const d = `M${n(x + tl)} ${n(y)}H${n(x + w - tr)}A${n(tr)} ${n(tr)} 0 0 1 ${n(x + w)} ${n(y + tr)}V${n(y + h - br)}A${n(br)} ${n(br)} 0 0 1 ${n(x + w - br)} ${n(y + h)}H${n(x + bl)}A${n(bl)} ${n(bl)} 0 0 1 ${n(x)} ${n(y + h - bl)}V${n(y + tl)}A${n(tl)} ${n(tl)} 0 0 1 ${n(x + tl)} ${n(y)}Z`;
    return `<path d="${d}" ${attributes}/>`;
  }

  function boxLayers(style, rect) {
    const radii = ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'].map((name) => parseFloat(style[name]) || 0);
    const sides = ['Top', 'Right', 'Bottom', 'Left'].map((side) => ({
      side, width: style[`border${side}Style`] === 'none' ? 0 : parseFloat(style[`border${side}Width`]) || 0, color: style[`border${side}Color`]
    }));
    const drawn = sides.filter((item) => item.width && paint(item.color, 'stroke'));
    const fill = paint(style.backgroundColor, 'fill');
    const whole = drawn.length === 4 && drawn.every((item) => item.width === drawn[0].width && item.color === drawn[0].color);
    if (whole) {
      const inset = drawn[0].width / 2;
      return shape(rect.left + inset, rect.top + inset, rect.width - drawn[0].width, rect.height - drawn[0].width, radii.map((radius) => Math.max(0, radius - inset)),
        `${fill || 'fill="none"'} ${paint(drawn[0].color, 'stroke')} stroke-width="${drawn[0].width}"`);
    }
    let out = fill ? shape(rect.left, rect.top, rect.width, rect.height, radii, fill) : '';
    for (const { side, width, color } of drawn) {
      const line = { Top: [rect.left, rect.top, rect.width, width], Bottom: [rect.left, rect.bottom - width, rect.width, width], Left: [rect.left, rect.top, width, rect.height], Right: [rect.right - width, rect.top, width, rect.height] }[side];
      out += `<rect x="${n(line[0])}" y="${n(line[1])}" width="${n(line[2])}" height="${n(line[3])}" ${paint(color, 'fill')}/>`;
    }
    return out;
  }

  /** An icon or the car diagram: its own shapes, moved and scaled into place. */
  function svgLayers(el, rect) {
    const box = el.viewBox?.baseVal;
    const hasBox = box && box.width && box.height;
    const scaleX = hasBox ? rect.width / box.width : 1;
    const scaleY = hasBox ? rect.height / box.height : 1;
    const scale = Math.min(scaleX, scaleY);
    const shiftX = rect.left + (hasBox ? (rect.width - box.width * scale) / 2 - box.x * scale : 0);
    const shiftY = rect.top + (hasBox ? (rect.height - box.height * scale) / 2 - box.y * scale : 0);
    const serializer = new XMLSerializer();
    const inner = [...el.childNodes].map((child) => serializer.serializeToString(child)).join('').replace(/ xmlns="[^"]+"/g, '');
    return `<g transform="translate(${n(shiftX)} ${n(shiftY)}) scale(${n(scale)})">${inner}</g>`;
  }

  /** A picture. React Native draws it as the background of the element next to it, tinted by a filter; the file itself is in a see-through img. */
  function imageLayer(el, rect, painted = el) {
    if (!el.complete || !el.naturalWidth) return '';
    let href = el.currentSrc || el.src;
    const tint = /url\("?#([^")]+)"?\)/.exec(getComputedStyle(painted).filter ?? '');
    const flood = tint && document.getElementById(tint[1])?.querySelector('feFlood')?.getAttribute('flood-color');
    if (!href.startsWith('data:') || flood) {
      const canvas = document.createElement('canvas');
      canvas.width = el.naturalWidth; canvas.height = el.naturalHeight;
      const context = canvas.getContext('2d');
      context.drawImage(el, 0, 0);
      if (flood) { context.globalCompositeOperation = 'source-in'; context.fillStyle = flood; context.fillRect(0, 0, canvas.width, canvas.height); }
      href = canvas.toDataURL('image/png');
    }
    return `<image x="${n(rect.left)}" y="${n(rect.top)}" width="${n(rect.width)}" height="${n(rect.height)}" href="${href}" preserveAspectRatio="xMidYMid slice"/>`;
  }

  const nameOf = (el, parts) => {
    const label = el.getAttribute('aria-label') || el.dataset?.testid;
    return label && parts ? label.slice(0, 60) : '';
  };

  function walk(el) {
    const style = getComputedStyle(el);
    if (el.tagName === 'IMG' && Number(style.opacity) === 0) {
      const painted = [...el.parentElement.children].find((other) => other !== el && getComputedStyle(other).backgroundImage !== 'none');
      return painted ? imageLayer(el, el.parentElement.getBoundingClientRect(), painted) : '';
    }
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return '';
    // Screens under the current one in the navigation stack.
    if (el.getAttribute('aria-hidden') === 'true' && el.getBoundingClientRect().width > width * 0.8) return '';
    const rect = el.getBoundingClientRect();
    if (rect.right < 0 || rect.left > width || rect.bottom < 0 || rect.top > height) {
      if (style.position === 'fixed' || !el.children.length) return '';
    }
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript') return '';
    if (tag === 'svg') return svgLayers(el, rect);
    let parts = rect.width && rect.height ? boxLayers(style, rect) : '';
    if (tag === 'img') parts += imageLayer(el, rect);
    else if (tag === 'input' || tag === 'textarea') {
      if (el.type !== 'file' && el.type !== 'hidden') parts += fieldLayers(el, style, rect);
    } else {
      for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) parts += textNodeLayers(child, style);
        else if (child.nodeType === Node.ELEMENT_NODE) parts += walk(child);
      }
    }
    if (!parts) return '';
    let clip = '';
    const overflowing = (style.overflowX !== 'visible' && el.scrollWidth > el.clientWidth + 1) || (style.overflowY !== 'visible' && el.scrollHeight > el.clientHeight + 1);
    if (overflowing) {
      clipCount += 1;
      const id = `${idPrefix}c${clipCount}`;
      defs.push(`<clipPath id="${id}"><rect x="${n(rect.left)}" y="${n(rect.top)}" width="${n(rect.width)}" height="${n(rect.height)}"/></clipPath>`);
      clip = ` clip-path="url(#${id})"`;
    }
    const opacity = Number(style.opacity) < 1 ? ` opacity="${n(Number(style.opacity))}"` : '';
    const name = nameOf(el, parts);
    const several = (parts.match(/<(rect|path|text|g|image)\b/g) ?? []).length > 1;
    return clip || opacity || (name && several) || several
      ? `<g${name ? ` id="${esc(`${idPrefix}${name}`)}"` : ''}${clip}${opacity}>${parts}</g>`
      : parts;
  }

  const background = paint(getComputedStyle(document.body).backgroundColor, 'fill') || 'fill="#0b1016"';
  const body = walk(document.body);
  return { background, defs: defs.join(''), body };
};
