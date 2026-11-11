/*
 * Chart image and one-page PDF report sharing in the browser: compose the
 * current transfer chart with a footer, or a full report page, then hand the
 * file to the share sheet when files can be shared, otherwise download it.
 */

function shareFileSupported(file) {
  return !!(navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share);
}

export async function shareOrDownload(blob, filename, title) {
  let file = null;
  try {
    if (typeof File !== 'undefined') file = new File([blob], filename, { type: blob.type });
  } catch (err) {
    file = null;
  }

  if (file) {
    try {
      if (shareFileSupported(file)) {
        await navigator.share({ files: [file], title });
        return 'shared';
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return 'cancelled';
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return 'downloaded';
}

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function roundedRect(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

/** The visible transfer chart, padded on the app's dark background with a footer. */
export function composeChartCanvas(chartCanvas, footer) {
  const sourceWidth = chartCanvas.width;
  const sourceHeight = chartCanvas.height;
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) return null;

  const cssWidth = Math.max(1, chartCanvas.getBoundingClientRect().width || 660);
  const scale = Math.max(1, sourceWidth / cssWidth);
  const margin = Math.round(18 * scale);
  const footerHeight = Math.round(32 * scale);
  const canvas = document.createElement('canvas');
  canvas.width = sourceWidth + margin * 2;
  canvas.height = sourceHeight + margin + footerHeight;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#0b0f0c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(chartCanvas, margin, margin);

  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(margin, margin + sourceHeight, sourceWidth, footerHeight);
  ctx.font = `600 ${Math.round(12 * scale)}px -apple-system, BlinkMacSystemFont, system-ui, sans-serif`;
  ctx.fillStyle = '#ced3c6';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText('Align', margin + 4 * scale, margin + sourceHeight + footerHeight / 2);
  ctx.font = `${Math.round(11 * scale)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.fillStyle = 'rgba(176,186,164,0.8)';
  ctx.textAlign = 'right';
  ctx.fillText(footer, canvas.width - margin - 4 * scale, margin + sourceHeight + footerHeight / 2);

  return canvas;
}

export async function chartImageBlob(chartCanvas, footer) {
  const canvas = composeChartCanvas(chartCanvas, footer);
  if (!canvas) return null;
  return canvasBlob(canvas, 'image/png');
}

function drawWrapped(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
  const words = String(text).split(/\s+/);
  let line = '';
  let lines = 0;
  for (let i = 0; i < words.length; i += 1) {
    const candidate = line ? line + ' ' + words[i] : words[i];
    if (ctx.measureText(candidate).width > maxWidth && line) {
      ctx.fillText(line, x, y + lines * lineHeight);
      lines += 1;
      line = words[i];
      if (lines >= maxLines) return y + lines * lineHeight;
    } else {
      line = candidate;
    }
  }
  if (line && lines < maxLines) {
    ctx.fillText(line, x, y + lines * lineHeight);
    lines += 1;
  }
  return y + lines * lineHeight;
}

/** A one-page report as a JPEG-backed PDF, drawn on the app's dark page. */
export function composeReportCanvas(options) {
  const width = 1240;
  const height = 1754;
  const margin = 64;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#0b0f0c';
  ctx.fillRect(0, 0, width, height);

  let y = margin + 8;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#f1f0eb';
  ctx.font = '700 38px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
  ctx.fillText('Align', margin, y + 30);
  ctx.font = '16px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
  ctx.fillStyle = 'rgba(156,159,149,0.9)';
  ctx.fillText('measurement report', margin, y + 55);
  ctx.font = '15px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'right';
  ctx.fillText(options.dateText, width - margin, y + 30);
  y += 90;

  const chart = options.chartCanvas;
  if (chart) {
    const chartWidth = width - margin * 2;
    const chartHeight = chartWidth * (chart.height / Math.max(1, chart.width));
    ctx.drawImage(chart, margin, y, chartWidth, chartHeight);
    y += chartHeight + 28;
  }

  const facts = options.facts || [];
  const factWidth = (width - margin * 2 - 16) / 3;
  const factHeight = 78;
  facts.slice(0, 9).forEach((fact, index) => {
    const column = index % 3;
    const row = Math.floor(index / 3);
    const x = margin + column * (factWidth + 8);
    const top = y + row * (factHeight + 8);
    ctx.fillStyle = '#121812';
    roundedRect(ctx, x, top, factWidth, factHeight, 12);
    ctx.fill();
    ctx.strokeStyle = 'rgba(160,190,150,0.16)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(156,159,149,0.9)';
    ctx.font = '12px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
    ctx.fillText(fact[0], x + 14, top + 25);
    ctx.fillStyle = '#f1f0eb';
    ctx.font = '600 21px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(fact[1], x + 14, top + 55);
  });
  y += Math.ceil(facts.length / 3) * (factHeight + 8) + 18;

  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(156,159,149,0.9)';
  ctx.font = '600 13px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
  ctx.fillText('EQ SUGGESTIONS', margin, y);
  y += 24;
  ctx.fillStyle = '#ced3c6';
  ctx.font = '17px ui-monospace, SFMono-Regular, Menlo, monospace';
  const eqLines = options.eqLines && options.eqLines.length
    ? options.eqLines
    : ['Within ±3 dB of the local average.'];
  eqLines.slice(0, 6).forEach((line) => {
    ctx.fillText(line, margin, y);
    y += 24;
  });
  y += 16;

  ctx.fillStyle = 'rgba(156,159,149,0.9)';
  ctx.font = '600 13px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
  ctx.fillText('SETTINGS', margin, y);
  y += 24;
  const settings = options.settings || [];
  const settingWidth = (width - margin * 2 - 20) / 2;
  settings.slice(0, 10).forEach((item, index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = margin + column * (settingWidth + 20);
    const top = y + row * 28;
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(156,159,149,0.9)';
    ctx.font = '14px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
    ctx.fillText(item[0], x, top);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ced3c6';
    ctx.font = '14px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(item[1], x + settingWidth, top);
  });

  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(120,132,112,0.9)';
  ctx.font = '13px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
  ctx.fillText('Align · measured in this browser', width / 2, height - 42);

  return canvas;
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Wrap a JPEG in a minimal one-page PDF. */
export function jpegToPdf(jpegBytes, width, height) {
  const encoder = new TextEncoder();
  const chunks = [];
  let length = 0;

  const pushBytes = (bytes) => {
    chunks.push(bytes);
    length += bytes.length;
  };
  const pushText = (text) => pushBytes(encoder.encode(text));

  pushText('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const offsets = [0];

  const object = (text, binary) => {
    offsets.push(length);
    pushText(text);
    if (binary) pushBytes(binary);
  };

  object('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  object('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  object('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
    '/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n');

  const imageHeader = '4 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + width +
    ' /Height ' + height + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 ' +
    '/Filter /DCTDecode /Length ' + jpegBytes.length + ' >>\nstream\n';
  const imageFooter = '\nendstream\nendobj\n';
  offsets.push(length);
  pushText(imageHeader);
  pushBytes(jpegBytes);
  pushText(imageFooter);

  const content = 'q 595 0 0 842 0 0 cm /Im0 Do Q\n';
  object('5 0 obj\n<< /Length ' + encoder.encode(content).length + ' >>\nstream\n' +
    content + 'endstream\nendobj\n');

  const xrefOffset = length;
  let xref = 'xref\n0 ' + (offsets.length) + '\n0000000000 65535 f \n';
  for (let i = 1; i < offsets.length; i += 1) {
    xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  pushText(xref);
  pushText('trailer\n<< /Size ' + offsets.length + ' /Root 1 0 R >>\nstartxref\n' +
    xrefOffset + '\n%%EOF\n');

  const out = new Uint8Array(length);
  let position = 0;
  chunks.forEach((chunk) => {
    out.set(chunk, position);
    position += chunk.length;
  });
  return out;
}

export async function reportPdfBlob(options) {
  const canvas = composeReportCanvas(options);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
  const jpeg = base64ToBytes(dataUrl.split(',')[1]);
  const pdf = jpegToPdf(jpeg, canvas.width, canvas.height);
  return new Blob([pdf], { type: 'application/pdf' });
}
