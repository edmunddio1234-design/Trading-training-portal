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
  if (modules && Array.isArray(modules) && modules.length > 0) {
    // Merge metadata fields from DEFAULT_MODULES into KV-stored modules
    // This ensures fields added after initial KV save (simulations, keywords,
    // notebookPrompts, youtubeVideos, requiredExercises) are always present
    return modules.map(kvMod => {
      const defaultMod = DEFAULT_MODULES.find(d => d.id === kvMod.id);
      if (!defaultMod) return kvMod;
      return {
        ...kvMod,
        simulations: kvMod.simulations || defaultMod.simulations || [],
        keywords: kvMod.keywords || defaultMod.keywords || [],
        notebookPrompts: kvMod.notebookPrompts || defaultMod.notebookPrompts || [],
        youtubeVideos: kvMod.youtubeVideos || defaultMod.youtubeVideos || [],
        requiredExercises: kvMod.requiredExercises ?? defaultMod.requiredExercises ?? 2,
        sections: kvMod.sections || defaultMod.sections || [],
        quiz: kvMod.quiz || defaultMod.quiz || []
      };
    });
  }
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
    const { moduleId, sectionIndex, sectionTitle, sectionContent, moduleTitle, cacheOnly } = req.body;

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

    // If cacheOnly flag is set, don't auto-generate — just report no cache
    if (cacheOnly) {
      return res.json({ success: false, cached: false, message: 'No cached image' });
    }

    const settings = await kvGet('settings', {});
    const apiKey = settings.geminiApiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(400).json({
        error: 'No Gemini API key configured. Go to Settings to add your key.'
      });
    }

    const { GoogleGenAI } = require('@google/genai');
    const ai = new GoogleGenAI({ apiKey });
    const prompt = buildImagePrompt(moduleTitle, sectionTitle, sectionContent);

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: prompt,
      config: {
        responseModalities: ['TEXT', 'IMAGE']
      }
    });

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

    const textContent = response.candidates?.[0]?.content?.parts
      ?.filter(p => p.text)?.map(p => p.text)?.join('\n') || '';

    return res.json({
      success: false,
      error: 'Image generation not available. The model returned text only.',
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
  const modules = await getModules();
  const mod = modules.find(m => m.id === moduleId);
  if (!mod) return res.status(404).json({ error: 'Module not found' });

  const settings = await kvGet('settings', {});
  const apiKey = settings.geminiApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'No API key configured' });

  const results = [];
  const contentSections = (mod.sections || []).filter(s => s.type === 'text' || !s.type);
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });

  for (let i = 0; i < contentSections.length; i++) {
    const section = contentSections[i];
    const sectionIndex = mod.sections.indexOf(section);
    const imageId = `${moduleId}_s${sectionIndex}`;
    const imageKey = `image_${imageId}`;
    try {
      const cached = await kvGet(imageKey);
      if (cached) { results.push({ sectionIndex, imageUrl: `/api/images/${imageId}.png`, cached: true }); continue; }
      const prompt = buildImagePrompt(mod.title, section.title, section.content);
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: prompt,
        config: { responseModalities: ['TEXT', 'IMAGE'] }
      });
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
// INFOGRAPHIC GENERATION ENDPOINT
// Generates a full module infographic using Gemini 2.5 Flash Image
// =============================================================================

function buildInfographicPrompt(moduleTitle, moduleSubtitle, sections) {
  const sectionSummaries = sections
    .filter(s => s.type === 'text' || !s.type)
    .slice(0, 8)
    .map(s => `• ${s.title}: ${(s.content || '').substring(0, 200)}`)
    .join('\n');

  const statSections = sections
    .filter(s => s.type === 'stats')
    .map(s => s.stats ? s.stats.map(st => `${st.num} — ${st.lbl}`).join(', ') : '')
    .filter(Boolean)
    .join('; ');

  return `Create a professional LANDSCAPE infographic (wide format, 1920x1080 ratio) for a trading academy training module.

MODULE TITLE: "${moduleTitle}"
MODULE SUBTITLE: "${moduleSubtitle || ''}"

KEY SECTIONS AND CONCEPTS:
${sectionSummaries}

${statSections ? `KEY STATISTICS: ${statSections}` : ''}

DESIGN REQUIREMENTS:
- MUST be LANDSCAPE orientation (wider than tall, 16:9 aspect ratio)
- Use a premium dark navy (#1B2A4A) background with emerald green (#10B981) accents
- Professional financial/trading infographic style
- Include the module title prominently at the top
- Organize key concepts into clear visual sections with icons, arrows, or flowcharts
- Use data visualizations, charts, or diagrams where appropriate
- Include key statistics and numbers prominently displayed
- Clean modern typography — bold headers, readable body text
- Add "IMPACT TRADING ACADEMY" branding at the top
- Add "Powered by Mission Metrics" at the bottom
- Professional gradient backgrounds on cards/sections
- NO watermarks, NO stock photo feel, NO clipart
- Make it look like a premium Wall Street educational poster
- Color palette: Navy #1B2A4A, Emerald #10B981, White #FFFFFF, Light accents #0B7A60
- Ensure ALL text is legible and properly spaced`;
}

app.post('/api/generate-infographic', async (req, res) => {
  try {
    const { moduleId } = req.body;

    // Check cache first
    const infographicKey = `infographic_${moduleId}`;
    const cached = await kvGet(infographicKey);
    if (cached) {
      return res.json({
        success: true,
        imageUrl: `/api/infographics/${moduleId}.png`,
        cached: true
      });
    }

    // Get the module data
    const modules = await kvGet('modules', []);
    const mod = modules.find(m => m.id === moduleId);
    if (!mod) return res.status(404).json({ error: 'Module not found' });

    const settings = await kvGet('settings', {});
    const apiKey = settings.geminiApiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(400).json({
        error: 'No Gemini API key configured. Go to Settings to add your key.'
      });
    }

    const { GoogleGenAI } = require('@google/genai');
    const ai = new GoogleGenAI({ apiKey });
    const prompt = buildInfographicPrompt(mod.title, mod.subtitle, mod.sections || []);

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: prompt,
      config: {
        responseModalities: ['TEXT', 'IMAGE']
      }
    });

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
      await kvSet(infographicKey, { imageData, mimeType });
      return res.json({ success: true, imageUrl: `/api/infographics/${moduleId}.png`, cached: false });
    }

    return res.json({
      success: false,
      error: 'Infographic generation not available. The model returned text only.'
    });

  } catch (error) {
    console.error('Infographic generation error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate infographic' });
  }
});

app.post('/api/regenerate-infographic', async (req, res) => {
  const { moduleId } = req.body;
  const infographicKey = `infographic_${moduleId}`;
  try { await kv.del(infographicKey); } catch (e) {}
  req.url = '/api/generate-infographic';
  app.handle(req, res);
});

// Serve infographic images from KV
app.get('/api/infographics/:filename', async (req, res) => {
  try {
    const moduleId = req.params.filename.replace(/\.png$/, '');
    const infographicKey = `infographic_${moduleId}`;
    const cached = await kvGet(infographicKey);
    if (cached && cached.imageData) {
      const buffer = Buffer.from(cached.imageData, 'base64');
      res.setHeader('Content-Type', cached.mimeType || 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.send(buffer);
    }
    res.status(404).json({ error: 'Infographic not found' });
  } catch (e) {
    console.error('Infographic serve error:', e.message);
    res.status(500).json({ error: 'Failed to serve infographic' });
  }
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
// LOGIN ENDPOINT (credentials stored as environment variables)
// =============================================================================

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  const validUsername = process.env.ADMIN_USERNAME;
  const validPassword = process.env.ADMIN_PASSWORD;

  if (!validUsername || !validPassword) {
    return res.status(500).json({ success: false, error: 'Server login not configured' });
  }

  if (username === validUsername && password === validPassword) {
    // Generate a simple session token so the frontend can persist login state
    const token = Buffer.from(`${username}:${Date.now()}`).toString('base64');
    await kvSet('session_token', token);
    res.json({ success: true, token });
  } else {
    res.status(401).json({ success: false, error: 'Invalid username or password' });
  }
});

// Session validation endpoint — checks if a stored token is still valid
app.post('/api/validate-session', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.json({ valid: false });
  const storedToken = await kvGet('session_token');
  res.json({ valid: token === storedToken });
});

// =============================================================================
// MASTERY QUIZ GENERATION (70 questions per module via Gemini)
// =============================================================================

app.post('/api/quizzes/generate/:moduleId', async (req, res) => {
  try {
    const { moduleId } = req.params;
    const { force } = req.body || {};

    // Check cache first (unless force regenerate)
    const quizKey = `quiz_70_${moduleId}`;
    if (!force) {
      const cached = await kvGet(quizKey);
      if (cached && cached.questions && cached.questions.length >= 70) {
        return res.json({ success: true, ...cached, cached: true });
      }
    }

    // Get module content for context
    const modules = await getModules();
    const mod = modules.find(m => m.id === moduleId);
    if (!mod) return res.status(404).json({ error: 'Module not found' });

    const settings = await kvGet('settings', {});
    const apiKey = settings.geminiApiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(400).json({ error: 'No Gemini API key configured. Go to Settings to add your key.' });
    }

    // Build content summary from module sections
    const contentSummary = (mod.sections || [])
      .filter(s => s.type === 'text' || !s.type)
      .map(s => `${s.title}: ${(s.content || '').substring(0, 300)}`)
      .join('\n');

    const keywords = (mod.keywords || []).join(', ') || mod.title;

    const prompt = `Generate exactly 70 multiple-choice quiz questions for a trading education module.

MODULE: "${mod.title}"
SUBTITLE: "${mod.subtitle || ''}"
KEY TOPICS: ${keywords}

CONTENT SUMMARY:
${contentSummary.substring(0, 3000)}

REQUIREMENTS:
- 70 questions total, numbered 1-70
- Each question has exactly 4 options
- One correct answer per question (0-indexed: 0=first option, 1=second, 2=third, 3=fourth)
- Include a brief explanation for the correct answer
- Difficulty mix: 20 easy, 30 medium, 20 hard
- Question types: concept definitions, scenario decisions, risk management calculations, strategy application
- All questions must directly relate to the module content
- For any chart-related questions: UP/bullish = GREEN, DOWN/bearish = RED (real-world trading colors)
- Passing score: 50/70 (71.4%)

Return ONLY a valid JSON array (no markdown, no code blocks):
[{"question":"...","options":["A","B","C","D"],"correct":0,"explanation":"...","difficulty":"easy"},...]`;

    const { GoogleGenAI } = require('@google/genai');
    const ai = new GoogleGenAI({ apiKey });

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: { responseMimeType: 'application/json' }
    });

    let questions = [];
    const text = response.candidates?.[0]?.content?.parts?.[0]?.text || '';

    try {
      questions = JSON.parse(text);
    } catch (parseErr) {
      // Try to extract JSON array from response
      const match = text.match(/\[[\s\S]*\]/);
      if (match) {
        questions = JSON.parse(match[0]);
      } else {
        return res.status(500).json({ error: 'Failed to parse quiz questions from AI response' });
      }
    }

    if (!Array.isArray(questions) || questions.length < 10) {
      return res.status(500).json({ error: 'AI returned insufficient questions', count: questions.length });
    }

    const quizData = {
      moduleId,
      questions: questions.slice(0, 70),
      generatedAt: new Date().toISOString(),
      version: 1
    };

    await kvSet(quizKey, quizData);
    res.json({ success: true, ...quizData, cached: false });

  } catch (error) {
    console.error('Quiz generation error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate quiz' });
  }
});

app.get('/api/quizzes/:moduleId', async (req, res) => {
  const quizKey = `quiz_70_${req.params.moduleId}`;
  const cached = await kvGet(quizKey);
  if (cached && cached.questions) {
    return res.json({ success: true, ...cached });
  }
  res.json({ success: false, questions: [], message: 'No quiz generated yet. Click Generate to create one.' });
});

// =============================================================================
// NOTEBOOK / JOURNAL ENDPOINTS
// =============================================================================

app.post('/api/notebook', async (req, res) => {
  try {
    const { moduleId, title, content, prompt: entryPrompt } = req.body;
    if (!moduleId || !content || content.trim().length < 10) {
      return res.status(400).json({ error: 'Notebook entry must have moduleId and content (min 10 chars)' });
    }

    const notebook = await kvGet('notebook', []);
    const entry = {
      id: 'nb_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      moduleId,
      title: title || 'Untitled Entry',
      content: content.trim(),
      prompt: entryPrompt || '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    notebook.push(entry);
    await kvSet('notebook', notebook);
    res.json({ success: true, entry });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/notebook/:moduleId', async (req, res) => {
  const notebook = await kvGet('notebook', []);
  const entries = notebook.filter(e => e.moduleId === req.params.moduleId);
  res.json({ success: true, entries });
});

app.get('/api/notebook', async (req, res) => {
  const notebook = await kvGet('notebook', []);
  res.json({ success: true, entries: notebook });
});

// =============================================================================
// STRATEGY BUILDER ENDPOINTS
// =============================================================================

app.post('/api/strategy/generate/:moduleId', async (req, res) => {
  try {
    const { moduleId } = req.params;
    const { force } = req.body || {};

    const stratKey = `strategy_${moduleId}`;
    if (!force) {
      const cached = await kvGet(stratKey);
      if (cached && cached.strategy) {
        return res.json({ success: true, ...cached, cached: true });
      }
    }

    const modules = await getModules();
    const mod = modules.find(m => m.id === moduleId);
    if (!mod) return res.status(404).json({ error: 'Module not found' });

    const settings = await kvGet('settings', {});
    const apiKey = settings.geminiApiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(400).json({ error: 'No Gemini API key configured.' });
    }

    const contentSummary = (mod.sections || [])
      .filter(s => s.type === 'text' || !s.type)
      .map(s => `${s.title}: ${(s.content || '').substring(0, 300)}`)
      .join('\n');

    const prompt = `Create a detailed trading strategy playbook based on this trading module.

MODULE: "${mod.title}"
SUBTITLE: "${mod.subtitle || ''}"
KEY TOPICS: ${(mod.keywords || []).join(', ') || mod.title}

CONTENT:
${contentSummary.substring(0, 3000)}

Generate a complete strategy with these sections:
1. "strategyName" - A compelling name for this strategy
2. "principleSource" - Which module principles this strategy is built on
3. "marketConditions" - When to use this strategy (bull/bear/sideways)
4. "setupConditions" - What to look for before entering (3-5 conditions)
5. "entryRules" - Exact entry trigger rules (be specific)
6. "positionSizing" - How to size the position using 1% rule and S.E.T.
7. "stopLossRules" - Where to place stops and why
8. "profitTargets" - Exit rules and profit targets (3:1 minimum)
9. "commonMistakes" - Top 5 mistakes to avoid
10. "whenNotToUse" - Conditions where this strategy fails

IMPORTANT: For any chart references: UP/bullish = GREEN, DOWN/bearish = RED (real-world trading colors)

Return ONLY valid JSON (no markdown, no code blocks):
{"strategyName":"...","principleSource":"...","marketConditions":"...","setupConditions":["..."],"entryRules":["..."],"positionSizing":"...","stopLossRules":"...","profitTargets":"...","commonMistakes":["..."],"whenNotToUse":["..."]}`;

    const { GoogleGenAI } = require('@google/genai');
    const ai = new GoogleGenAI({ apiKey });

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: { responseMimeType: 'application/json' }
    });

    const text = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
    let strategy;
    try {
      strategy = JSON.parse(text);
    } catch (parseErr) {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) strategy = JSON.parse(match[0]);
      else return res.status(500).json({ error: 'Failed to parse strategy from AI response' });
    }

    const stratData = {
      moduleId,
      strategy,
      generatedAt: new Date().toISOString()
    };

    await kvSet(stratKey, stratData);
    res.json({ success: true, ...stratData, cached: false });

  } catch (error) {
    console.error('Strategy generation error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate strategy' });
  }
});

app.get('/api/strategy/:moduleId', async (req, res) => {
  const stratKey = `strategy_${req.params.moduleId}`;
  const cached = await kvGet(stratKey);
  if (cached && cached.strategy) return res.json({ success: true, ...cached });
  res.json({ success: false, strategy: null, message: 'No strategy generated yet.' });
});

// =============================================================================
// YOUTUBE VIDEO MANAGEMENT (YouTube Data API v3 + KV caching)
// =============================================================================

// Helper: Search YouTube Data API v3 for real videos
async function searchYouTubeVideos(query, maxResults = 6) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return [];

  try {
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=${maxResults}&relevanceLanguage=en&safeSearch=moderate&videoDuration=medium&key=${apiKey}`;
    const searchRes = await fetch(searchUrl);
    if (!searchRes.ok) return [];
    const searchData = await searchRes.json();

    if (!searchData.items || searchData.items.length === 0) return [];

    // Get video durations from videos endpoint
    const videoIds = searchData.items.map(item => item.id.videoId).join(',');
    const detailsUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${videoIds}&key=${apiKey}`;
    const detailsRes = await fetch(detailsUrl);
    const detailsData = detailsRes.ok ? await detailsRes.json() : { items: [] };
    const durationMap = {};
    (detailsData.items || []).forEach(v => {
      // Parse ISO 8601 duration (PT12M34S) to readable format
      const match = v.contentDetails.duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
      if (match) {
        const h = match[1] ? `${match[1]}:` : '';
        const m = match[2] || '0';
        const s = match[3] ? match[3].padStart(2, '0') : '00';
        durationMap[v.id] = h ? `${h}${m.padStart(2,'0')}:${s}` : `${m}:${s}`;
      }
    });

    return searchData.items.map(item => ({
      title: item.snippet.title,
      url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
      channel: item.snippet.channelTitle,
      thumbnail: item.snippet.thumbnails.medium?.url || item.snippet.thumbnails.default?.url,
      duration: durationMap[item.id.videoId] || '',
      description: item.snippet.description?.substring(0, 120) || '',
      publishedAt: item.snippet.publishedAt
    }));
  } catch (err) {
    console.error('YouTube API error:', err.message);
    return [];
  }
}

app.get('/api/youtube/:moduleId', async (req, res) => {
  const ytKey = `youtube_${req.params.moduleId}`;

  // Check KV cache first
  const cached = await kvGet(ytKey);
  if (cached && cached.videos && cached.videos.length > 0) {
    // Curated videos (set via PUT) are permanent — never expire
    if (cached.curated) {
      return res.json({ success: true, ...cached, source: 'curated' });
    }
    // Auto-fetched videos expire after 24 hours
    if (cached.fetchedAt) {
      const cacheAge = Date.now() - new Date(cached.fetchedAt).getTime();
      const ONE_DAY = 24 * 60 * 60 * 1000;
      if (cacheAge < ONE_DAY) {
        return res.json({ success: true, ...cached, source: 'cache' });
      }
    }
  }

  // Search YouTube API using module title
  const mod = DEFAULT_MODULES.find(m => m.id === req.params.moduleId);
  if (!mod) return res.status(404).json({ error: 'Module not found' });

  const searchQuery = `${mod.title} trading tutorial`;
  const videos = await searchYouTubeVideos(searchQuery, 6);

  if (videos.length > 0) {
    // Cache results in KV
    const data = { moduleId: req.params.moduleId, videos, fetchedAt: new Date().toISOString() };
    await kvSet(ytKey, data);
    return res.json({ success: true, ...data, source: 'youtube_api' });
  }

  // Final fallback: try with just keywords
  const keywordQuery = (mod.keywords || []).slice(0, 3).join(' ') + ' trading';
  const fallbackVideos = await searchYouTubeVideos(keywordQuery, 6);

  if (fallbackVideos.length > 0) {
    const data = { moduleId: req.params.moduleId, videos: fallbackVideos, fetchedAt: new Date().toISOString() };
    await kvSet(ytKey, data);
    return res.json({ success: true, ...data, source: 'youtube_api_keywords' });
  }

  res.json({ success: true, moduleId: req.params.moduleId, videos: [], source: 'none' });
});

app.put('/api/youtube/:moduleId', async (req, res) => {
  try {
    const { videos } = req.body;
    if (!Array.isArray(videos)) return res.status(400).json({ error: 'Videos must be an array' });
    const ytKey = `youtube_${req.params.moduleId}`;
    const data = { moduleId: req.params.moduleId, videos, curated: true, fetchedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await kvSet(ytKey, data);
    res.json({ success: true, ...data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// WEBULL ONBOARDING STATUS
// =============================================================================

app.get('/api/onboarding', async (req, res) => {
  const onboarding = await kvGet('onboarding', {
    accountCreated: false,
    paperTradingEnabled: false,
    platformFamiliarized: false,
    firstTradeExecuted: false,
    watchlistCreated: false,
    completedAt: null
  });
  const steps = ['accountCreated', 'paperTradingEnabled', 'platformFamiliarized', 'firstTradeExecuted', 'watchlistCreated'];
  const done = steps.filter(s => onboarding[s]).length;
  res.json({ success: true, ...onboarding, completionPercent: Math.round((done / steps.length) * 100), isComplete: done === steps.length });
});

app.put('/api/onboarding', async (req, res) => {
  try {
    const current = await kvGet('onboarding', {});
    const updated = { ...current, ...req.body };
    const steps = ['accountCreated', 'paperTradingEnabled', 'platformFamiliarized', 'firstTradeExecuted', 'watchlistCreated'];
    const done = steps.filter(s => updated[s]).length;
    if (done === steps.length && !updated.completedAt) {
      updated.completedAt = new Date().toISOString();
    }
    await kvSet('onboarding', updated);
    res.json({ success: true, ...updated, completionPercent: Math.round((done / steps.length) * 100), isComplete: done === steps.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// SIMULATION EXERCISE ENDPOINTS
// =============================================================================

app.get('/api/simulations/:moduleId', async (req, res) => {
  const simKey = `simulations_${req.params.moduleId}`;
  const results = await kvGet(simKey, { moduleId: req.params.moduleId, exercises: {} });
  res.json({ success: true, ...results });
});

app.post('/api/simulations/:moduleId/:exerciseId', async (req, res) => {
  try {
    const { moduleId, exerciseId } = req.params;
    const { entry, stop, target, reasoning, confidence } = req.body;

    const simKey = `simulations_${moduleId}`;
    const current = await kvGet(simKey, { moduleId, exercises: {} });

    current.exercises[exerciseId] = {
      completed: true,
      entry,
      stop,
      target,
      reasoning,
      confidence: confidence || 3,
      submittedAt: new Date().toISOString()
    };

    await kvSet(simKey, current);
    res.json({ success: true, exercise: current.exercises[exerciseId] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// HEALTH CHECK
// =============================================================================

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

module.exports = app;
