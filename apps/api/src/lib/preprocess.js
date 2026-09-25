let sharp;
try { sharp = require('sharp'); } catch (e) { sharp = null; }
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

/**
 * Preprocess image for better OCR quality
 * - Convert to grayscale
 * - Increase contrast
 * - Sharpen
 * - Normalize size
 */
async function preprocessImage(inputPath, options = {}) {
  if (!sharp) {
    logger.warn('sharp not available, skipping preprocessing');
    return inputPath;
  }

  const {
    grayscale = true,
    sharpen = true,
    normalize = true,
    contrast = 1.5,
    quality = 95
  } = options;

  const ext = path.extname(inputPath).toLowerCase();
  const outputPath = inputPath.replace(ext, `_preprocessed${ext}`);

  try {
    logger.info('Preprocessing image', { input: inputPath, options });

    let pipeline = sharp(inputPath);

    // Convert to grayscale (significantly improves OCR)
    if (grayscale) {
      pipeline = pipeline.grayscale();
    }

    // Normalize / auto-level
    if (normalize) {
      pipeline = pipeline.normalize();
    }

    // Increase contrast via modulate
    if (contrast !== 1.0) {
      pipeline = pipeline.modulate({
        brightness: 1.0,
        saturation: 0  // remove color for cleaner OCR
      });
    }

    // Sharpen for cleaner text edges
    if (sharpen) {
      pipeline = pipeline.sharpen({ sigma: 1.5 });
    }

    // Output as PNG for lossless quality
    await pipeline
      .png({ quality })
      .toFile(outputPath);

    logger.info('Preprocessing complete', { output: outputPath });
    return outputPath;
  } catch (error) {
    logger.error('Preprocessing failed', { error: error.message });
    // Return original on failure
    return inputPath;
  }
}

/**
 * Preprocess multiple images in a directory
 */
async function preprocessImages(imagePaths, options = {}) {
  const results = [];
  for (const imgPath of imagePaths) {
    const processed = await preprocessImage(imgPath, options);
    results.push(processed);
  }
  return results;
}

module.exports = { preprocessImage, preprocessImages };
