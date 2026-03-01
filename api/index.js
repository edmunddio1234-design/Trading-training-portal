// =============================================================================
// VERCEL SERVERLESS FUNCTION — Express backend for Impact Trading Academy
// Wraps your existing server.js routes for Vercel's serverless architecture
// Uses Vercel KV (Redis) for persistent data storage
// =============================================================================

const express = require('express');
const cors = require('cors');
const { kv } = require('@vercel/kv');

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// =============================================================================
// DATA PERSISTENCE LAYER (Vercel KV — replaces JSON file storage)
// =============================================================================

const DEFAULT_MODULES = require('./default-modules');

async function kvGet(key, fallback = null) {
  try {
    const data = await kv.get(key);
    return data || fallback;
  } catch (e) {
    console.error(`KV read error for ${key}:`, e.message);
    return fallback;
  }
}

async function kvSet(key, data) {
  try {
    await kv.set(key, data);
    return true;
  } catch (e) {
    console.error(`KV write error for ${key}:`, e.message);
    return false;
  }
}

async function getModules() {
  const modules = await kvGet('modules');
  if (modules && Array.isArray(modules) && modules.length > 0) return modules;
  await kvSet('modules', DEFAULT_MODULES);
  return DEFAULT_MODULES;
}

// =============================================================================
// MODULE ENDPOINTS
// =============================================================================

app.get('/api/modules', async (req, res) => {
  const modules = await getModules();
  res.json(modules);
});

app.put('/api/modules', async (req, res) => {
  const modules = req.body;
  if (!Array.isArray(modules)) return res.status(400).json({ error: 'Modules must be an array' });
  await kvSet('modules', modules);
  res.json({ success: true, count: modules.length });
});

app.post('/api/modules', async (req, res) => {
  const modules = await kvGet('modules', []);
  const newModule = { ...req.body, id: req.body.id || 'm' + Date.now() };
  modules.push(newModule);
  await kvSet('modules', modules);
  res.json({ success: true, module: newModule });
});

app.put('/api/modules/:id', async (req, res) => {
  const modules = await kvGet('modules', []);
  const idx = modules.findIndex(m => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Module not found' });
  modules[idx] = { ...req.body, id: req.params.id };
  await kvSet('modules', modules);
  res.json({ success: true, module: modules[idx] });
});

app.delete('/api/modules/:id', async (req, res) => {
  let modules = await kvGet('modules', []);
  modules = modules.filter(m => m.id !== req.params.id);
  await kvSet('modules', modules);
  res.json({ success: true });
});

// =============================================================================
// PROGRESS ENDPOINTS
// =============================================================================

app.get('/api/progress', async (req, res) => {
  const progress = await kvGet('progress', { completedModules: {}, quizState: {} });
  res.json(progress);
});

app.put('/api/progress', async (req, res) => {
  await kvSet('progress', req.body);
  res.json({ success: true });
});

// =============================================================================
// SETTINGS ENDPOINTS (API key storage)
// =============================================================================

app.get('/api/settings', async (req, res) => {
  const settings = await kvGet('settings', { geminiApiKey: '' });
  const masked = settings.geminiApiKey
    ? '********' + settings.geminiApiKey.slice(-4)
    : '';
  res.json({ geminiApiKey: masked, hasKey: !!settings.geminiApiKey });
});

app.put('/api/settings', async (req, res) => {
  const current = await kvGet('settings', {});
  const updated = { ...current, ...req.body };
  await kvSet('settings', updated);
  res.json({ success: true });
});

// =============================================================================
// AI IMAGE GENERATION ENDPOINT (Google Gemini)
// =============================================================================

function buildImagePrompt(moduleTitle, sectionTitle, sectionContent) {
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

app.post('/api/generate-visual', async (req, res) => {
  try {
    const { moduleId, sectionIndex, sectionTitle, sectionContent, moduleTitle } = req.body;

    const imageId = `${moduleId}_s${sectionIndex}`;
    const imageKey = `image_${imageId}`;
    const cached = await kvGet(imageKey);
    if (cached) {
      return res.json({
        success: true,
        imageUrl: `/api/images/${imageId}.png`,
        cached: true
      });
    }

    const settings = await kvGet('settings', {});
    const apiKey = settings.geminiApiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(400).json({
        error: 'No Gemini API key configured. Go to Settings to add your key.'
      });
    }

    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);
    const prompt = buildImagePrompt(moduleTitle, sectionTitle, sectionContent);

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-image" });
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["image", "text"] }
    });

    const response = result.response;
    let imageData = null;
    let mimeType = 'image/png';

    if (response.candidates && response.candidates[0]) {
      const parts = response.candidates[0].content.parts;
      for (const part of parts) {
        if (part.inlineData && part.inlineData.mimeType && part.inlineData.mimeType.startsWith('image/')) {
          imageData = part.inlineData.data;
          mimeType = part.inlineData.mimeType;
          break;
        }
      }
    }

    if (imageData) {
      await kvSet(imageKey, { imageData, mimeType });
      return res.json({ success: true, imageUrl: `/api/images/${imageId}.png`, cached: false });
    }

    try {
      const imagenModel = genAI.getGenerativeModel({ model: "imagen-3.0-generate-002" });
      const imagenResult = await imagenModel.generateImages({ prompt, config: { numberOfImages: 1 } });
      if (imagenResult.images && imagenResult.images.length > 0) {
        const imgData = imagenResult.images[0].imageBytes;
        await kvSet(imageKey, { imageData: imgData, mimeType: 'image/png' });
        return res.json({ success: true, imageUrl: `/api/images/${imageId}.png`, cached: false });
      }
    } catch (imagenErr) {}

    const textContent = response.candidates?.[0]?.content?.parts
      ?.filter(p => p.text)?.map(p => p.text)?.join('\n') || '';

    return res.json({
      success: false,
      error: 'Image generation not available with current model.',
      description: textContent
    });

  } catch (error) {
    console.error('Image generation error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate image' });
  }
});

app.post('/api/regenerate-visual', async (req, res) => {
  const { moduleId, sectionIndex } = req.body;
  const imageKey = `image_${moduleId}_s${sectionIndex}`;
  try { await kv.del(imageKey); } catch (e) {}
  req.url = '/api/generate-visual';
  app.handle(req, res);
});

app.post('/api/generate-module-visuals', async (req, res) => {
  const { moduleId } = req.body;
  const modules = await kvGet('modules', []);
  const mod = modules.find(m => m.id === moduleId);
  if (!mod) return res.status(404).json({ error: 'Module not found' });

  const settings = await kvGet('settings', {});
  const apiKey = settings.geminiApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'No API key configured' });

  const results = [];
  const contentSections = (mod.sections || []).filter(s => s.type === 'text' || !s.type);
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(apiKey);

  for (let i = 0; i < contentSections.length; i++) {
    const section = contentSections[i];
    const sectionIndex = mod.sections.indexOf(section);
    const imageId = `${moduleId}_s${sectionIndex}`;
    const imageKey = `image_${imageId}`;
    try {
      const cached = await kvGet(imageKey);
      if (cached) { results.push({ sectionIndex, imageUrl: `/api/images/${imageId}.png`, cached: true }); continue; }
      const prompt = buildImagePrompt(mod.title, section.title, section.content);
      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-image" });
      const result = await model.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { responseModalities: ["image", "text"] } });
      const response = result.response;
      let imageData = null; let mimeType = 'image/png';
      if (response.candidates && response.candidates[0]) {
        for (const part of response.candidates[0].content.parts) {
          if (part.inlineData && part.inlineData.mimeType?.startsWith('image/')) { imageData = part.inlineData.data; mimeType = part.inlineData.mimeType; break; }
        }
      }
      if (imageData) { await kvSet(imageKey, { imageData, mimeType }); results.push({ sectionIndex, imageUrl: `/api/images/${imageId}.png`, cached: false }); }
      else { results.push({ sectionIndex, error: 'No image generated' }); }
      if (i < contentSections.length - 1) await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (err) { results.push({ sectionIndex, error: err.message }); }
  }
  res.json({ success: true, results });
});

// =============================================================================
// IMAGE SERVING ENDPOINT (backward-compatible with frontend's imageUrl handling)
// Serves cached images from KV as binary HTTP responses
// =============================================================================

app.get('/api/images/:filename', async (req, res) => {
  try {
    const filename = req.params.filename.replace(/\.png$/, '');
    const imageKey = `image_${filename}`;
    const cached = await kvGet(imageKey);
    if (cached && cached.imageData) {
      const buffer = Buffer.from(cached.imageData, 'base64');
      res.setHeader('Content-Type', cached.mimeType || 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.send(buffer);
    }
    res.status(404).json({ error: 'Image not found' });
  } catch (e) {
    console.error('Image serve error:', e.message);
    res.status(500).json({ error: 'Failed to serve image' });
  }
});

// =============================================================================
// HEALTH CHECK
// =============================================================================

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

module.exports = app;
