const fs = require('fs');
const path = require('path');
const logger = require('./logger');
let sharp;
try {
  sharp = require('sharp');
} catch (e) {
  sharp = null;
  logger.error('sharp failed to load in export.js — image cropping/embedding will be unavailable', { error: e.message });
}

function sanitizeControlChars(str) {
  return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

// Parse [Изображение: /path/to/image.png] markers from text
function parseImageMarkers(text) {
  const regex = /\[Изображение:\s*(.[^\]]*?)(?::(\d+),(\d+),(\d+),(\d+))?\]/g;
  const images = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    images.push({ path: match[1].trim(), fullMatch: match[0] });
  }
  return images;
}

async function exportToMarkdown(text, outputPath) {
  // Replace [Изображение: path] and [Изображение: path:x1,y1,x2,y2] with Markdown image syntax.
  // Must be async: cropping via sharp is inherently async (there is no synchronous crop+encode
  // API — a previous version called a non-existent `.toBufferSync()`, which threw on every
  // single coordinate-based crop and silently dropped the image instead of embedding it).
  const sanitized = sanitizeControlChars(text);
  const regex = /\[Изображение:\s*(.[^\]]*?)(?::(\d+),(\d+),(\d+),(\d+))?\]/g;
  let result = '';
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(sanitized)) !== null) {
    result += sanitized.slice(lastIndex, match.index);
    lastIndex = match.index + match[0].length;
    const [, rawPath, x1, y1, x2, y2] = match;
    const trimmed = rawPath.trim();
    if (!fs.existsSync(trimmed)) continue; // marker dropped — no image at that path
    const hasCoords = x1 !== undefined;
    try {
      if (hasCoords) {
        if (!sharp) continue; // coordinates present but no way to crop — skip, don't embed the full page
        const w = parseInt(x2) - parseInt(x1), h = parseInt(y2) - parseInt(y1);
        if (w >= 10 && h >= 10) {
          try {
            const cropped = await sharp(trimmed).extract({ left: parseInt(x1), top: parseInt(y1), width: w, height: h }).png().toBuffer();
            result += `![image](data:image/png;base64,${cropped.toString('base64')})`;
          } catch (e) {} // invalid coordinates — skip entirely
        }
        // region too small (likely hallucinated coordinates) — skip
      } else {
        // No coordinates — embed full image
        const imgData = fs.readFileSync(trimmed);
        result += `![image](data:image/png;base64,${imgData.toString('base64')})`;
      }
    } catch (e) {}
  }
  result += sanitized.slice(lastIndex);
  fs.writeFileSync(outputPath, result, 'utf-8');
  return outputPath;
}

async function exportToDocx(text, outputPath) {
  const { Document, Packer, Paragraph, TextRun, ImageRun } = require('docx');

  const sanitized = sanitizeControlChars(text);
  const lines = sanitized.split('\n');
  const paragraphs = [];

  for (const line of lines) {
    // Check for image marker (with optional coordinates)
    const imgMatch = line.match(/\[Изображение:\s*(.[^\]]*?)(?::(\d+),(\d+),(\d+),(\d+))?\]/);
    if (imgMatch) {
      const imgPath = imgMatch[1].trim();
      const hasCoords = imgMatch[2] !== undefined;
      if (fs.existsSync(imgPath)) {
        try {
          let imgBuffer = null;
          if (hasCoords && sharp) {
            const x1 = parseInt(imgMatch[2]), y1 = parseInt(imgMatch[3]);
            const x2 = parseInt(imgMatch[4]), y2 = parseInt(imgMatch[5]);
            const w = x2 - x1, h = y2 - y1;
            if (w >= 10 && h >= 10) {
              try { imgBuffer = await sharp(imgPath).extract({ left: x1, top: y1, width: w, height: h }).png().toBuffer(); } catch (e) {}
            }
          } else if (!hasCoords) {
            imgBuffer = fs.readFileSync(imgPath);
          }
          if (!imgBuffer) continue; // Skip invalid/hallucinated coordinates
          // Separator before image
          paragraphs.push(new Paragraph({
            children: [new TextRun({ text: '────────────────────────────────────' })],
            spacing: { after: 100 }
          }));
          // Calculate proportional size (max 250px width)
          let imgW = 250, imgH = 160;
          try {
            const meta = await sharp(imgBuffer).metadata();
            if (meta.width && meta.height) {
              imgW = Math.min(250, meta.width);
              imgH = Math.round(imgW * meta.height / meta.width);
            }
          } catch (e) {}
          paragraphs.push(new Paragraph({
            children: [new ImageRun({
              data: imgBuffer,
              transformation: { width: imgW, height: imgH },
              type: 'png'
            })],
            spacing: { after: 100 }
          }));
          // Separator after image
          paragraphs.push(new Paragraph({
            children: [new TextRun({ text: '────────────────────────────────────' })],
            spacing: { after: 200 }
          }));
        } catch (e) {
          paragraphs.push(new Paragraph({ children: [new TextRun({ text: line })] }));
        }
      } else {
        paragraphs.push(new Paragraph({ children: [new TextRun({ text: line })] }));
      }
      continue;
    }

    if (line.startsWith('# ')) {
      paragraphs.push(new Paragraph({
        children: [new TextRun({ text: line.substring(2), bold: true, size: 32 })],
        heading: 'TITLE'
      }));
    } else if (line.startsWith('## ')) {
      paragraphs.push(new Paragraph({
        children: [new TextRun({ text: line.substring(3), bold: true, size: 28 })],
        heading: 'HEADING_1'
      }));
    } else if (line.startsWith('### ')) {
      paragraphs.push(new Paragraph({
        children: [new TextRun({ text: line.substring(4), bold: true, size: 24 })],
        heading: 'HEADING_2'
      }));
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      paragraphs.push(new Paragraph({
        children: [new TextRun({ text: '• ' + line.substring(2) })],
        indent: { left: 720 }
      }));
    } else if (line.trim() === '') {
      paragraphs.push(new Paragraph({ children: [] }));
    } else {
      const parts = line.split(/(\*\*[^*]+\*\*)/g);
      const children = parts.map(part => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return new TextRun({ text: part.slice(2, -2), bold: true });
        }
        return new TextRun({ text: part });
      });
      paragraphs.push(new Paragraph({ children }));
    }
  }

  const doc = new Document({
    sections: [{
      properties: {},
      children: paragraphs
    }]
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);

  return outputPath;
}

function loadDejaVuFontBase64() {
  const fontPaths = [
    // Bundled fonts (works on all platforms including macOS packaged app)
    path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans.ttf'),
    path.join(process.resourcesPath || '', 'assets', 'fonts', 'DejaVuSans.ttf'),
    // Linux system fonts
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/TTF/DejaVuSans.ttf',
    '/usr/local/share/fonts/DejaVuSans.ttf',
    // macOS Homebrew
    '/opt/homebrew/share/fonts/DejaVuSans.ttf',
    '/usr/local/share/fonts/dejavu/DejaVuSans.ttf'
  ];
  for (const fontPath of fontPaths) {
    if (fs.existsSync(fontPath)) {
      return fs.readFileSync(fontPath).toString('base64');
    }
  }
  logger.warn('DejaVu font not found, PDF may not render Cyrillic correctly');
  return null;
}

async function exportToPdf(text, outputPath) {
  const { jsPDF } = require('jspdf');

  const doc = new jsPDF({ unit: 'pt', format: 'a4' });

  const fontBase64 = loadDejaVuFontBase64();
  if (fontBase64) {
    doc.addFileToVFS('DejaVuSans.ttf', fontBase64);
    doc.addFont('DejaVuSans.ttf', 'DejaVuSans', 'normal');
    doc.addFont('DejaVuSans.ttf', 'DejaVuSans', 'bold');
    doc.addFont('DejaVuSans.ttf', 'DejaVuSans', 'italic');
    doc.addFont('DejaVuSans.ttf', 'DejaVuSans', 'bolditalic');
    doc.setFont('DejaVuSans');
  }

  const bodyFontSize = 10;
  const margin = 50;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const maxWidth = pageWidth - 2 * margin;

  let y = margin;
  const lines = text.split('\n');

  function newPage() {
    doc.addPage();
    y = margin;
  }

  function setBodyFont() {
    doc.setFontSize(bodyFontSize);
    doc.setFont('DejaVuSans', 'normal');
  }

  function getLineHeight(size) {
    return size * 1.5;
  }

  setBodyFont();

  for (const line of lines) {
    if (y > pageHeight - margin) {
      newPage();
    }

    // Check for image marker (with optional coordinates)
    const imgMatch = line.match(/\[Изображение:\s*(.[^\]]*?)(?::(\d+),(\d+),(\d+),(\d+))?\]/);
    if (imgMatch) {
      const imgPath = imgMatch[1].trim();
      const hasCoords = imgMatch[2] !== undefined;
      if (fs.existsSync(imgPath)) {
        try {
          let imgData = null;
          if (hasCoords && sharp) {
            const x1 = parseInt(imgMatch[2]), y1 = parseInt(imgMatch[3]);
            const x2 = parseInt(imgMatch[4]), y2 = parseInt(imgMatch[5]);
            const w = x2 - x1, h = y2 - y1;
            if (w >= 10 && h >= 10) {
              try { imgData = await sharp(imgPath).extract({ left: x1, top: y1, width: w, height: h }).png().toBuffer(); } catch (e) {}
            }
          } else if (!hasCoords) {
            imgData = fs.readFileSync(imgPath);
          }
          if (!imgData) continue; // Skip invalid/hallucinated coordinates

          // Separator line before image
          doc.setDrawColor(150, 150, 150);
          doc.line(margin, y, margin + maxWidth, y);
          y += 8;
          const imgBase64 = imgData.toString('base64');
          // Calculate proportional size (max 40% of page width)
          let imgWidth = maxWidth * 0.4;
          let imgHeight = imgWidth * 0.6;
          try {
            if (sharp) {
              const meta = await sharp(imgData).metadata();
              if (meta.width && meta.height) {
                imgHeight = imgWidth * meta.height / meta.width;
              }
            }
          } catch (e) {}
          if (y + imgHeight > pageHeight - margin) newPage();
          doc.addImage(imgBase64, 'PNG', margin, y, imgWidth, imgHeight);
          y += imgHeight + 8;

          // Separator line after image
          doc.line(margin, y, margin + maxWidth, y);
          y += 12;
        } catch (e) {
          // Image failed, skip
        }
      }
      continue;
    }

    if (line.startsWith('# ')) {
      doc.setFontSize(14);
      doc.setFont('DejaVuSans', 'bold');
      const wrapped = doc.splitTextToSize(line.substring(2), maxWidth);
      for (const wl of wrapped) {
        if (y > pageHeight - margin) newPage();
        doc.text(wl, margin, y);
        y += getLineHeight(14);
      }
      setBodyFont();
      y += 6;
    } else if (line.startsWith('## ')) {
      doc.setFontSize(12);
      doc.setFont('DejaVuSans', 'bold');
      const wrapped = doc.splitTextToSize(line.substring(3), maxWidth);
      for (const wl of wrapped) {
        if (y > pageHeight - margin) newPage();
        doc.text(wl, margin, y);
        y += getLineHeight(12);
      }
      setBodyFont();
      y += 4;
    } else if (line.startsWith('### ')) {
      doc.setFontSize(11);
      doc.setFont('DejaVuSans', 'bold');
      const wrapped = doc.splitTextToSize(line.substring(4), maxWidth);
      for (const wl of wrapped) {
        if (y > pageHeight - margin) newPage();
        doc.text(wl, margin, y);
        y += getLineHeight(11);
      }
      setBodyFont();
      y += 3;
    } else if (line.trim() === '') {
      y += getLineHeight(bodyFontSize);
    } else {
      // Parse **bold** and *italic* in regular text
      const parts = line.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
      const textParts = [];
      for (const part of parts) {
        if (part.startsWith('**') && part.endsWith('**')) {
          textParts.push({ text: part.slice(2, -2), style: 'bold' });
        } else if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
          textParts.push({ text: part.slice(1, -1), style: 'italic' });
        } else {
          textParts.push({ text: part, style: 'normal' });
        }
      }
      // Render each text part separately with correct font
      for (const tp of textParts) {
        if (!tp.text) continue;
        if (tp.style === 'bold') {
          doc.setFont('DejaVuSans', 'bold');
        } else if (tp.style === 'italic') {
          doc.setFont('DejaVuSans', 'italic');
        } else {
          doc.setFont('DejaVuSans', 'normal');
        }
        const wrapped = doc.splitTextToSize(tp.text, maxWidth);
        for (const wl of wrapped) {
          if (y > pageHeight - margin) newPage();
          doc.text(wl, margin, y);
          y += getLineHeight(bodyFontSize);
        }
      }
      // Reset font after line
      setBodyFont();
    }
  }

  doc.save(outputPath);
  return outputPath;
}

/**
 * Export to multiple formats
 * @param {string} text - Text content
 * @param {string} baseName - Base file name (without extension)
 * @param {string} outputDir - Output directory
 * @param {string[]} formats - Array of formats: ['md', 'docx', 'pdf']
 */
async function exportToMultiple(text, baseName, outputDir, formats = ['md', 'docx', 'pdf']) {
  const results = {};
  logger.info('Export to multiple formats', { baseName, formats });
  
  for (const format of formats) {
    const outputPath = path.join(outputDir, `${baseName}.${format}`);
    
    try {
      logger.info('Exporting format', { format, outputPath });
      switch (format) {
        case 'md':
          await exportToMarkdown(text, outputPath);
          break;
        case 'docx':
          await exportToDocx(text, outputPath);
          break;
        case 'pdf':
          await exportToPdf(text, outputPath);
          break;
      }
      results[format] = { success: true, path: outputPath };
      logger.info('Export successful', { format, outputPath });
    } catch (error) {
      results[format] = { success: false, error: error.message };
      logger.error('Export failed', { format, error: error.message });
    }
  }
  
  return results;
}

module.exports = {
  exportToMarkdown,
  exportToDocx,
  exportToPdf,
  exportToMultiple
};
