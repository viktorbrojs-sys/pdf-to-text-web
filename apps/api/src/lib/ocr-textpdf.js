const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Extract text from text-based PDF using pdftotext
 */
function extractTextFromPdf(pdfPath, options = {}) {
  const { layout = false } = options;
  try {
    const flag = layout ? '-layout' : '';
    const text = execSync(`pdftotext ${flag} "${pdfPath}" -`, {
      encoding: 'utf-8',
      timeout: 30000
    });
    return text;
  } catch (error) {
    console.error('pdftotext error:', error.message);
    throw new Error(`Failed to extract text: ${error.message}`);
  }
}

/**
 * Extract embedded images from PDF using pdfimages
 * Returns array of { page, path, width, height }
 */
function extractPdfImages(pdfPath) {
  try {
    const baseName = path.basename(pdfPath, path.extname(pdfPath));
    const outDir = path.join(path.dirname(pdfPath), 'pdf-images', baseName);
    fs.mkdirSync(outDir, { recursive: true });

    // Extract images
    execSync(`pdfimages -j -p -f 1 -l 9999 "${pdfPath}" "${outDir}/img"`, {
      encoding: 'utf-8',
      timeout: 60000,
      stdio: 'ignore'
    });

    // Get image list with page numbers
    const listOutput = execSync(`pdfimages -list -f 1 -l 9999 "${pdfPath}"`, {
      encoding: 'utf-8',
      timeout: 30000
    });

    const images = [];
    const lines = listOutput.split('\n');
    for (const line of lines) {
      const m = line.trim().match(/^\s*(\d+)\s+(\d+)\s+(\w+)\s+(\d+)\s+(\d+)/);
      if (m) {
        images.push({
          page: parseInt(m[1]),
          num: parseInt(m[2]),
          type: m[3],
          width: parseInt(m[4]),
          height: parseInt(m[5])
        });
      }
    }

    // Match extracted files with metadata
    const files = fs.readdirSync(outDir)
      .filter(f => /\.(jpg|jpeg|png)$/i.test(f))
      .sort();

    for (let i = 0; i < files.length; i++) {
      const filePath = path.join(outDir, files[i]);
      const meta = images.find(img => img.num === i);
      if (meta) {
        meta.path = filePath;
      } else {
        images.push({ page: 0, num: i, path: filePath, width: 0, height: 0 });
      }
    }

    return images.filter(img => img.path);
  } catch (error) {
    console.error('pdfimages error:', error.message);
    return [];
  }
}

/**
 * Parse pdftotext -bbox output to get word positions per page
 * Returns Map<pageNumber, Array<{xMin, yMin, xMax, yMax, text}>>
 */
function parseBboxOutput(pdfPath) {
  try {
    const output = execSync(`pdftotext -bbox "${pdfPath}" -`, {
      encoding: 'utf-8',
      timeout: 60000
    });

    const pages = new Map();
    let currentPage = 0;

    const pageRegex = /<page\s+width="([\d.]+)"\s+height="([\d.]+)">/;
    const wordRegex = /<word\s+xMin="([\d.]+)"\s+yMin="([\d.]+)"\s+xMax="([\d.]+)"\s+yMax="([\d.]+)">([^<]*)<\/word>/;

    for (const line of output.split('\n')) {
      const pm = line.match(pageRegex);
      if (pm) {
        currentPage++;
        pages.set(currentPage, []);
        continue;
      }

      const wm = line.match(wordRegex);
      if (wm && currentPage > 0) {
        const words = pages.get(currentPage);
        words.push({
          xMin: parseFloat(wm[1]),
          yMin: parseFloat(wm[2]),
          xMax: parseFloat(wm[3]),
          yMax: parseFloat(wm[4]),
          text: wm[5].trim()
        });
      }
    }

    return pages;
  } catch (error) {
    console.error('bbox parse error:', error.message);
    return new Map();
  }
}

/**
 * Extract text with layout preservation
 */
function extractTextWithLayout(pdfPath) {
  return extractTextFromPdf(pdfPath, { layout: true });
}

/**
 * Convert extracted text to Markdown format
 */
function textToMarkdown(text, fileName) {
  let md = text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const lines = md.split('\n');
  const processedLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const nextLine = lines[i + 1]?.trim();

    if (line.length > 0 && line.length < 100 &&
        (nextLine === '' || nextLine === undefined) &&
        line === line.toUpperCase() &&
        !line.match(/^\d/)) {
      processedLines.push(`## ${line}`);
    } else {
      processedLines.push(line);
    }
  }

  return `# ${fileName}\n\n${processedLines.join('\n')}`;
}

module.exports = {
  extractTextFromPdf,
  extractTextWithLayout,
  extractPdfImages,
  parseBboxOutput,
  textToMarkdown
};
