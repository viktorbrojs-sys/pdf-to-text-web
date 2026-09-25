const Tesseract = require('tesseract.js');
const fs = require('fs');
const path = require('path');

/**
 * OCR Module - Extract text from images using Tesseract.js
 */

/**
 * Recognize text from a single image
 * @param {string} imagePath - Path to image file
 * @param {function} onProgress - Progress callback (0-100)
 * @returns {Promise<string>} Extracted text
 */
async function recognizeImage(imagePath, onProgress = () => {}) {
  try {
    const result = await Tesseract.recognize(
      imagePath,
      'rus+eng', // Support Russian and English
      {
        logger: (m) => {
          if (m.status === 'recognizing text') {
            onProgress(Math.round(m.progress * 100));
          }
        }
      }
    );
    
    return result.data.text;
  } catch (error) {
    console.error(`OCR error for ${imagePath}:`, error);
    throw error;
  }
}

/**
 * Recognize text from multiple images
 * @param {string[]} imagePaths - Array of image file paths
 * @param {function} onProgress - Progress callback with (step, total, percent)
 * @returns {Promise<string>} Combined extracted text
 */
async function recognizeMultipleImages(imagePaths, onProgress = () => {}) {
  const texts = [];
  
  for (let i = 0; i < imagePaths.length; i++) {
    const imagePath = imagePaths[i];
    const stepPercent = 100 / imagePaths.length;
    const basePercent = i * stepPercent;
    
    onProgress(i + 1, imagePaths.length, basePercent);
    
    const text = await recognizeImage(imagePath, (percent) => {
      const totalPercent = basePercent + (percent * stepPercent / 100);
      onProgress(i + 1, imagePaths.length, Math.round(totalPercent));
    });
    
    texts.push(text);
  }
  
  return texts.join('\n\n');
}

/**
 * Process all images in a directory
 * @param {string} imagesDir - Directory containing PNG images
 * @param {function} onProgress - Progress callback
 * @returns {Promise<string>} Extracted text from all images
 */
async function processDirectory(imagesDir, onProgress = () => {}) {
  const files = fs.readdirSync(imagesDir)
    .filter(f => f.endsWith('.png') || f.endsWith('.jpg'))
    .sort()
    .map(f => path.join(imagesDir, f));
  
  if (files.length === 0) {
    throw new Error('No images found in directory');
  }
  
  return recognizeMultipleImages(files, onProgress);
}

module.exports = {
  recognizeImage,
  recognizeMultipleImages,
  processDirectory
};
