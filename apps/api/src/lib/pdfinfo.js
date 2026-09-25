const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Get PDF file information
 * @param {string} pdfPath - Path to PDF file
 * @returns {Object} File info
 */
function getPdfInfo(pdfPath) {
  const stats = fs.statSync(pdfPath);
  
  let pdfInfo = {
    name: path.basename(pdfPath),
    path: pdfPath,
    size: stats.size,
    sizeFormatted: formatSize(stats.size),
    pages: 0,
    title: '',
    author: '',
    creationDate: '',
    pdfVersion: '',
    isTextBased: false
  };

  try {
    const info = execSync(`pdfinfo "${pdfPath}"`, { encoding: 'utf-8' });
    
    const pagesMatch = info.match(/Pages:\s+(\d+)/);
    if (pagesMatch) pdfInfo.pages = parseInt(pagesMatch[1]);
    
    const titleMatch = info.match(/Title:\s+(.+)/);
    if (titleMatch) pdfInfo.title = titleMatch[1].trim();
    
    const authorMatch = info.match(/Author:\s+(.+)/);
    if (authorMatch) pdfInfo.author = authorMatch[1].trim();

    const creationDateMatch = info.match(/CreationDate:\s+(.+)/);
    if (creationDateMatch) pdfInfo.creationDate = creationDateMatch[1].trim();

    const pdfVersionMatch = info.match(/PDF version:\s+(.+)/);
    if (pdfVersionMatch) pdfInfo.pdfVersion = pdfVersionMatch[1].trim();
    
  } catch (e) {
    console.error('pdfinfo error:', e.message);
  }

  // Check if PDF is text-based
  pdfInfo.isTextBased = checkIfTextBased(pdfPath);

  return pdfInfo;
}

/**
 * Check if PDF is text-based (not scanned)
 * @param {string} pdfPath - Path to PDF file
 * @returns {boolean}
 */
function checkIfTextBased(pdfPath) {
  try {
    const text = execSync(`pdftotext "${pdfPath}" - 2>/dev/null`, { 
      encoding: 'utf-8',
      timeout: 10000
    });
    
    // If we get meaningful text (more than just whitespace), it's text-based
    const cleanText = text.replace(/\s+/g, '').trim();
    return cleanText.length > 50;
  } catch (e) {
    return false;
  }
}

/**
 * Format file size to human readable
 * @param {number} bytes
 * @returns {string}
 */
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

module.exports = {
  getPdfInfo,
  checkIfTextBased,
  formatSize
};
