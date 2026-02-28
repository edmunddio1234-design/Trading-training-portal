require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));
app.use('/api/images', express.static(path.join(__dirname, 'data', 'images')));

// =============================================================================
// DATA PERSISTENCE LAYER (JSON file storage)
// =============================================================================

const DATA_DIR = path.join(__dirname, 'data');
const MODULES_FILE = path.join(DATA_DIR, 'modules.json');
const PROGRESS_FILE = path.join(DATA_DIR, 'progress.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const IMAGES_DIR = path.join(DATA_DIR, 'images');

// Ensure directories and files exist
[DATA_DIR, IMAGES_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

function readJSON(filePath, fallback = null) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch (e) {
    console.error(`Error reading ${filePath}:`, e.message);
  }
  return fallback;
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// Initialize default modules if none exist
function getDefaultModules() {
  // Only returns defaults if modules.json doesn't exist yet
  if (fs.existsSync(MODULES_FILE)) return readJSON(MODULES_FILE, []);

  const defaults = require('./api/default-modules');
  writeJSON(MODULES_FILE, defaults);
  return defaults;
}

// =============================================================================
// MODULE ENDPOINTS
// =============================================================================

// GET all modules
app.get('/api/modules', (req, res) => {
  const modules = getDefaultModules();
  res.json(modules);
});

// PUT update all modules (bulk save)
app.put('/api/modules', (req, res) => {
  const modules = req.body;
  if (!Array.isArray(modules)) return res.status(400).json({ error: 'Modules must be an array' });
  writeJSON(MODULES_FILE, modules);
  res.json({ success: true, count: modules.length });
});

// POST add a single module
app.post('/api/modules', (req, res) => {
  const modules = readJSON(MODULES_FILE, []);
  const newModule = { ...req.body, id: req.body.id || 'm' + Date.now() };
  modules.push(newModule);
  writeJSON(MODULES_FILE, modules);
  res.json({ success: true, module: newModule });
});

// PUT update a single module
app.put('/api/modules/:id', (req, res) => {
  const modules = readJSON(MODULES_FILE, []);
  const idx = modules.findIndex(m => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Module not found' });
  modules[idx] = { ...req.body, id: req.params.id };
  writeJSON(MODULES_FILE, modules);
  res.json({ success: true, module: modules[idx] });
});

// DELETE a module
app.delete('/api/modules/:id', (req, res) => {
  let modules = readJSON(MODULES_FILE, []);
  modules = modules.filter(m => m.id !== req.params.id);
  writeJSON(MODULES_FILE, modules);
  res.json({ success: true });
});

// =============================================================================
// PROGRESS ENDPOINTS
// =============================================================================

app.get('/api/progress', (req, res) => {
  const progress = readJSON(PROGRESS_FILE, { completedModules: {}, quizState: {} });
  res.json(progress);
});

app.put('/api/progress', (req, res) => {
  writeJSON(PROGRESS_FILE, req.body);
  res.json({ success: true });
});

// =============================================================================
// SETTINGS ENDPOINTS (API key storage)
// =============================================================================

app.get('/api/settings', (req, res) => {
  const settings = readJSON(SETTINGS_FILE, { geminiApiKey: '' });
  // Mask API key for security - only show last 4 chars
  const masked = settings.geminiApiKey
    ? '********' + settings.geminiApiKey.slice(-4)
    : '';
  res.json({ geminiApiKey: masked, hasKey: !!settings.geminiApiKey });
});

app.put('/api/settings', (req, res) => {
  const current = readJSON(SETTINGS_FILE, {});
  const updated = { ...current, ...req.body };
  writeJSON(SETTINGS_FILE, updated);
  res.json({ success: true });
});

// =============================================================================
// AI IMAGE GENERATION ENDPOINT (Google Gemini)
// =============================================================================

app.post('/api/generate-visual', async (req, res) => {
  try {
    const { moduleId, sectionIndex, sectionTitle, sectionContent, moduleTitle } = req.body;

    // Check for cached image first
    const imageId = `${moduleId}_s${sectionIndex}`;
    const cachedPath = path.join(IMAGES_DIR, `${imageId}.png`);
    if (fs.existsSync(cachedPath)) {
      return res.json({
        success: true,
        imageUrl: `/api/images/${imageId}.png`,
        cached: true
      });
    }

    // Get API key from settings or env
    const settings = readJSON(SETTINGS_FILE, {});
    const apiKey = settings.geminiApiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(400).json({
        error: 'No Gemini API key configured. Go to Settings to add your key.'
      });
    }

    // Use Gemini to generate image
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);

    // Use imagen-3.0-generate-002 for image generation
    const prompt = buildImagePrompt(moduleTitle, sectionTitle, sectionContent);

    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash-exp",
    });

    const result = await model.generateContent({
      contents: [{
        role: "user",
        parts: [{
          text: prompt
        }]
      }],
      generationConfig: {
        responseModalities: ["image", "text"],
      }
    });

    const response = result.response;
    let imageData = null;

    // Extract image from response parts
    if (response.candidates && response.candidates[0]) {
      const parts = response.candidates[0].content.parts;
      for (const part of parts) {
        if (part.inlineData && part.inlineData.mimeType && part.inlineData.mimeType.startsWith('image/')) {
          imageData = part.inlineData.data;
          break;
        }
      }
    }

    if (imageData) {
      // Save to cache
      const buffer = Buffer.from(imageData, 'base64');
      fs.writeFileSync(cachedPath, buffer);

      return res.json({
        success: true,
        imageUrl: `/api/images/${imageId}.png`,
        cached: false
      });
    }

    // If Gemini didn't return an image (model limitation), try Imagen
    try {
      const imagenResult = await generateWithImagen(genAI, prompt, cachedPath, imageId);
      return res.json(imagenResult);
    } catch (imagenErr) {
      // Final fallback: return the text description
      const textContent = response.candidates?.[0]?.content?.parts
        ?.filter(p => p.text)
        ?.map(p => p.text)
        ?.join('\n') || '';

      return res.json({
        success: false,
        error: 'Image generation not available with current model. Try updating your API settings.',
        description: textContent
      });
    }

  } catch (error) {
    console.error('Image generation error:', error);
    res.status(500).json({
      error: error.message || 'Failed to generate image'
    });
  }
});

// Try Imagen model as fallback
async function generateWithImagen(genAI, prompt, cachedPath, imageId) {
  const model = genAI.getGenerativeModel({ model: "imagen-3.0-generate-002" });
  const result = await model.generateImages({
    prompt: prompt,
    config: { numberOfImages: 1 }
  });

  if (result.images && result.images.length > 0) {
    const imageData = result.images[0].imageBytes;
    const buffer = Buffer.from(imageData, 'base64');
    fs.writeFileSync(cachedPath, buffer);

    return {
      success: true,
      imageUrl: `/api/images/${imageId}.png`,
      cached: false
    };
  }
  throw new Error('No images returned from Imagen');
}

// Build a focused prompt for educational visuals
function buildImagePrompt(moduleTitle, sectionTitle, sectionContent) {
  // Truncate content to key info for the prompt
  const shortContent = sectionContent
    ? sectionContent.substring(0, 400).replace(/\n/g, ' ')
    : '';

  return `Create a professional educational infographic or diagram for a trading academy course.

Module: "${moduleTitle}"
Section: "${sectionTitle}"
Key content: ${shortContent}

Requirements:
- Clean, modern design with a dark navy (#1B2A4A) and emerald green (#10B981) color scheme
- Professional financial/trading aesthetic
- Use charts, diagrams, flowcharts, or visual metaphors as appropriate
- Include key data points or concepts from the section
- Make it visually clear and educational
- NO watermarks, NO stock photo feel
- Dimensions suitable for a web banner (landscape, roughly 16:9)
- Text should be minimal but impactful - let visuals tell the story`;
}

// =============================================================================
// REGENERATE (force new image, clearing cache)
// =============================================================================

app.post('/api/regenerate-visual', async (req, res) => {
  const { moduleId, sectionIndex } = req.body;
  const imageId = `${moduleId}_s${sectionIndex}`;
  const cachedPath = path.join(IMAGES_DIR, `${imageId}.png`);

  // Delete cached version
  if (fs.existsSync(cachedPath)) {
    fs.unlinkSync(cachedPath);
  }

  // Forward to generate endpoint
  req.url = '/api/generate-visual';
  app.handle(req, res);
});

// =============================================================================
// BULK GENERATE ALL VISUALS FOR A MODULE
// =============================================================================

app.post('/api/generate-module-visuals', async (req, res) => {
  const { moduleId } = req.body;
  const modules = readJSON(MODULES_FILE, []);
  const mod = modules.find(m => m.id === moduleId);
  if (!mod) return res.status(404).json({ error: 'Module not found' });

  const results = [];
  const contentSections = (mod.sections || []).filter(s => s.type === 'text' || !s.type);

  for (let i = 0; i < contentSections.length; i++) {
    const section = contentSections[i];
    const sectionIndex = mod.sections.indexOf(section);
    try {
      // Make internal request
      const imageId = `${moduleId}_s${sectionIndex}`;
      const cachedPath = path.join(IMAGES_DIR, `${imageId}.png`);

      if (fs.existsSync(cachedPath)) {
        results.push({ sectionIndex, imageUrl: `/api/images/${imageId}.png`, cached: true });
        continue;
      }

      const settings = readJSON(SETTINGS_FILE, {});
      const apiKey = settings.geminiApiKey || process.env.GEMINI_API_KEY;
      if (!apiKey) {
        results.push({ sectionIndex, error: 'No API key' });
        continue;
      }

      const { GoogleGenerativeAI } = require('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(apiKey);
      const prompt = buildImagePrompt(mod.title, section.title, section.content);

      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });
      const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ["image", "text"] }
      });

      const response = result.response;
      let imageData = null;

      if (response.candidates && response.candidates[0]) {
        for (const part of response.candidates[0].content.parts) {
          if (part.inlineData && part.inlineData.mimeType?.startsWith('image/')) {
            imageData = part.inlineData.data;
            break;
          }
        }
      }

      if (imageData) {
        fs.writeFileSync(cachedPath, Buffer.from(imageData, 'base64'));
        results.push({ sectionIndex, imageUrl: `/api/images/${imageId}.png`, cached: false });
      } else {
        results.push({ sectionIndex, error: 'No image generated' });
      }

      // Rate limiting: wait 2 seconds between API calls
      if (i < contentSections.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    } catch (err) {
      results.push({ sectionIndex, error: err.message });
    }
  }

  res.json({ success: true, results });
});

// =============================================================================
// CATCH-ALL: serve the SPA
// =============================================================================

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// =============================================================================
// START SERVER
// =============================================================================

app.listen(PORT, () => {
  console.log(`\n  Impact Trading Academy Server`);
  console.log(`  ================================`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Status:  Running\n`);
});
