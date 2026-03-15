// =============================================================================
// VERCEL SERVERLESS FUNCTION — Express backend for Impact Trading Academy
// Wraps your existing server.js routes for Vercel's serverless architecture
// Uses Vercel KV (Redis) for persistent data storage
// =============================================================================

const express = require('express');
const cors = require('cors');
const { kv } = require('@vercel/kv');
const { GoogleGenAI } = require('@google/genai');

const app = express();

// =============================================================================
// CONSTANTS
// =============================================================================

const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// =============================================================================
// AUTH MIDDLEWARE
// =============================================================================

// requireAuth middleware: validates Bearer token against stored session
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization required' });
  }

  const token = authHeader.slice(7); // Remove 'Bearer '
  const storedToken = await kvGet('session_token');

  if (!storedToken || token !== storedToken) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  next();
}

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
        // Merge section-level media fields (e.g. youtubeUrl) from defaults into KV sections
        sections: (kvMod.sections || defaultMod.sections || []).map((sec, idx) => {
          const defaultSec = (defaultMod.sections || [])[idx];
          if (!defaultSec || !defaultSec.media) return sec;
          return { ...sec, media: sec.media || defaultSec.media };
        }),
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

app.put('/api/modules', requireAuth, async (req, res) => {
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

app.put('/api/modules/:id', requireAuth, async (req, res) => {
  const modules = await kvGet('modules', []);
  const idx = modules.findIndex(m => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Module not found' });
  modules[idx] = { ...req.body, id: req.params.id };
  await kvSet('modules', modules);
  res.json({ success: true, module: modules[idx] });
});

app.delete('/api/modules/:id', requireAuth, async (req, res) => {
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

app.put('/api/progress', requireAuth, async (req, res) => {
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
  const anthropicMasked = settings.anthropicApiKey
    ? '********' + settings.anthropicApiKey.slice(-4)
    : '';
  res.json({ geminiApiKey: masked, hasKey: !!settings.geminiApiKey, anthropicApiKey: anthropicMasked, hasAnthropicKey: !!settings.anthropicApiKey });
});

app.put('/api/settings', requireAuth, async (req, res) => {
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
  const moduleId = req.params.moduleId;
  const curatedKey = `youtube_${moduleId}`;
  const apiCacheKey = `youtube_api_${moduleId}`;

  // 1. Load curated (Mission Metrics) videos — these are permanent
  let curatedVideos = [];
  const curatedData = await kvGet(curatedKey);
  if (curatedData && curatedData.curated && curatedData.videos && curatedData.videos.length > 0) {
    curatedVideos = curatedData.videos;
  }

  // 2. Load YouTube API search results (cached separately, expire after 24h)
  let apiVideos = [];
  const apiCached = await kvGet(apiCacheKey);
  const ONE_DAY = 24 * 60 * 60 * 1000;

  if (apiCached && apiCached.videos && apiCached.videos.length > 0 && apiCached.fetchedAt) {
    const cacheAge = Date.now() - new Date(apiCached.fetchedAt).getTime();
    if (cacheAge < ONE_DAY) {
      apiVideos = apiCached.videos;
    }
  }

  // 3. If no fresh API results, fetch from YouTube API
  if (apiVideos.length === 0) {
    const mod = DEFAULT_MODULES.find(m => m.id === moduleId);
    if (mod) {
      const searchQuery = `${mod.title} trading tutorial`;
      apiVideos = await searchYouTubeVideos(searchQuery, 6);

      if (apiVideos.length === 0) {
        const keywordQuery = (mod.keywords || []).slice(0, 3).join(' ') + ' trading';
        apiVideos = await searchYouTubeVideos(keywordQuery, 6);
      }

      if (apiVideos.length > 0) {
        await kvSet(apiCacheKey, { moduleId, videos: apiVideos, fetchedAt: new Date().toISOString() });
      }
    }
  }

  // 4. Combine: curated videos FIRST, then API results (deduplicate by URL)
  const curatedUrls = new Set(curatedVideos.map(v => v.url));
  const uniqueApiVideos = apiVideos.filter(v => !curatedUrls.has(v.url));
  const combined = [...curatedVideos, ...uniqueApiVideos];

  if (combined.length > 0) {
    const source = curatedVideos.length > 0 && uniqueApiVideos.length > 0 ? 'curated+api' :
                   curatedVideos.length > 0 ? 'curated' : 'youtube_api';
    return res.json({ success: true, moduleId, videos: combined, curated: curatedVideos.length > 0, source });
  }

  if (!DEFAULT_MODULES.find(m => m.id === moduleId)) {
    return res.status(404).json({ error: 'Module not found' });
  }

  res.json({ success: true, moduleId, videos: [], source: 'none' });
});

app.put('/api/youtube/:moduleId', requireAuth, async (req, res) => {
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

app.put('/api/onboarding', requireAuth, async (req, res) => {
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
// YAHOO FINANCE STOCK DATA — S.E.T. SIMULATOR
// =============================================================================

app.get('/api/stock-data', async (req, res) => {
  const { symbol, range = '1y', interval = '1d' } = req.query;
  if (!symbol) return res.status(400).json({ error: 'Symbol parameter is required' });

  const allowed = /^[A-Z0-9.\-]{1,10}$/i;
  if (!allowed.test(symbol)) return res.status(400).json({ error: 'Invalid symbol format' });

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol.toUpperCase())}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&includePrePost=false`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MissionMetrics/1.0)' }
    });
    if (!resp.ok) {
      return res.status(resp.status).json({ error: `Yahoo Finance returned ${resp.status}` });
    }
    const raw = await resp.json();
    const result = raw?.chart?.result?.[0];
    if (!result) return res.status(404).json({ error: 'No data found for symbol' });

    const ts = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] || {};
    const meta = result.meta || {};

    // Build clean OHLCV array
    const candles = [];
    for (let i = 0; i < ts.length; i++) {
      const o = quote.open?.[i], h = quote.high?.[i], l = quote.low?.[i], c = quote.close?.[i], v = quote.volume?.[i];
      if (o != null && h != null && l != null && c != null) {
        candles.push({
          date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
          open: +o.toFixed(2),
          high: +h.toFixed(2),
          low: +l.toFixed(2),
          close: +c.toFixed(2),
          volume: v || 0
        });
      }
    }

    res.json({
      symbol: meta.symbol || symbol.toUpperCase(),
      currency: meta.currency || 'USD',
      exchangeName: meta.exchangeName || '',
      regularMarketPrice: meta.regularMarketPrice || candles[candles.length - 1]?.close || 0,
      previousClose: meta.previousClose || 0,
      candles
    });
  } catch (error) {
    console.error('Stock data fetch error:', error.message);
    res.status(500).json({ error: 'Failed to fetch stock data. Try again.' });
  }
});

// Ticker search/autocomplete
app.get('/api/stock-search', async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 1) return res.json([]);

  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0&listsCount=0`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MissionMetrics/1.0)' }
    });
    if (!resp.ok) return res.json([]);
    const data = await resp.json();
    const results = (data.quotes || [])
      .filter(r => r.quoteType === 'EQUITY' || r.quoteType === 'ETF')
      .map(r => ({ symbol: r.symbol, name: r.shortname || r.longname || '', type: r.quoteType, exchange: r.exchange || '' }));
    res.json(results);
  } catch (error) {
    res.json([]);
  }
});

// =============================================================================
// AI TUTOR ENDPOINT (Anthropic Claude API)
// Answers student questions using module content + correlation reports
// =============================================================================

// Rate limiting helper: max 30 requests per hour (stored in KV)
async function checkRateLimit(key) {
  const now = Date.now();
  const window = 60 * 60 * 1000; // 1 hour
  const maxRequests = 30;

  let data = await kvGet(key, { requests: [] });
  // Filter to only requests within the window
  data.requests = (data.requests || []).filter(t => now - t < window);
  if (data.requests.length >= maxRequests) {
    return false; // Rate limited
  }
  data.requests.push(now);
  await kvSet(key, data);
  return true;
}

// Rate limiting: per-endpoint keys
async function checkTutorRateLimit() { return checkRateLimit('rate_limit_tutor'); }
async function checkTradeReviewRateLimit() { return checkRateLimit('rate_limit_trade_review'); }
async function checkSnapshotRateLimit() { return checkRateLimit('rate_limit_snapshot'); }

// Correlation reports — rich source material from NotebookLM, keyed by module ID
const TUTOR_SOURCES = {};

// Module 1 source
TUTOR_SOURCES['m1'] = `Module 1 Concept Correlation Report: Video-to-Theory Mapping

Core Concept Analysis: Financial Reality vs. Retail Myths
Success in financial markets is predicated on internalizing statistical probabilities and institutional mechanics. There is a fundamental divergence between the 99% (retail) and the 1% (institutional).

The 1% Reality vs. The 99% Myth:
- "The Profitability Divide": Retail traders fail due to a lack of a statistical edge, ignoring the Statistical Theory of Ruin. Only 3% of day traders are profitable; a mere 1% achieve long-term consistency.
- "Institutional Liquidity Generation": Large entities must "induce" retail selling/buying to fill hundred-million-dollar positions. Institutions drive prices past retail "support" to trigger stop-losses, creating the necessary counterparties.
- Market Narrative over Patterns: Price action requires a fundamental catalyst to sustain institutional momentum.

The Mathematics of Control:
Institutional leverage is defined by the concept of Notional Control.
Leverage Ratio = (Stock Price x 100) / Option Premium Paid
- Retail Constraint: Buying a stock at $799/share with $20,000 allows only 25 shares.
- Institutional Leverage: Utilizing options permits the control of hundreds of shares with the same capital. A 10% move in the underlying asset can yield 50%-100%+ returns.
- Risk Management: The 1% Risk Rule is non-negotiable. On a $60,000 trade, a 7% stop-loss at $19.13 limits the loss to $4,200.

Psychological Framework: The Investor Arc and Mindset Mastery
The "Investor Psychology Arc" tracks the emotional journey of market participants.

Three Mindset Shifts for Institutional Alignment:
1. Indecision as "Disbelief": Small-bodied candles with equal wicks signify a draw between buyers and sellers, appearing before major breakouts or reversals.
2. The Control Shift as "Transition": Long wicks and small bodies represent a "Market Structure Signature." A large upper wick indicates buyers were rejected by institutional supply.
3. Strength as "Optimism/Markup": Large-bodied candles with minimal wicks indicate institutional momentum. The body-to-wick ratio confirms sellers have been fully absorbed.

Navigating "The Chasm of Fear" (Crisis & Opportunity):
The "Chasm of Fear" is the period of maximum emotional volatility where retail sentiment reaches peak panic.
- During the Iranian missile attack on Israel, Bitcoin dropped $10,000 and Nvidia lost $212 billion in market cap.
- While the 99% capitulated, the principle states: "If you have been sidelined, believe this is a good opportunity to scale into high conviction tokens. Do not capitulate."
- A Module 1 trader utilizes the "Chasm" to execute contrarian entries, identifying that peak geopolitical or social panic often marks institutional bottoming.

Institutional Mechanics: Liquidity, Inducement, and the "1% Strategy":
Phase 3: Distribution — sideways chop is not "market confusion," but institutions managing exits by selling positions to retail buyers still trapped in the "Euphoria" stage.
- Technical Definition of an Inducement Trap: An area that appears to be a valid "Order Block" or "Support Zone" but lacks an institutional Imbalance. A true imbalance has at least 3x more volume than its diagonal counterpart on a footprint chart.

The Five Pillars of Success:
1. Stack the odds in your favor — Use strategies backed by data and history, not gut feelings.
2. Follow rules — Rules protect you from emotional mistakes that destroy accounts.
3. Be disciplined — Consistency beats intensity every single time.
4. Be coachable — Learn from others with proven results and be willing to adapt.
5. Be decisive — Success requires taking action, not endless analysis paralysis.

The S.E.T. Rule: Every trade must have Stop, Entry, and Target defined before execution. The 1% Risk Rule limits risk to 1% of total account per trade. With a 3:1 reward-to-risk ratio, even a 30% win rate is profitable.`;

// Module 2 source
TUTOR_SOURCES['m2'] = `Module 2 Correlation Report: Market Mechanics & TradingLab Video Implementations

Market Mechanics: Level 2 Data and Order Flow Dynamics
The Bid/Ask Mechanism:
- Bid: The highest price buyers are willing to pay.
- Ask: The lowest price sellers are willing to accept.
- Spread: The gap between the two. A tight spread = high liquidity; wide spread = volatility and risk.

Institutional Footprints: Stacking vs. Imbalances
- Stacking (Intent): Identified on Level 2 when multiple exchanges show large orders at the same price. A "wall" or intent to defend a level.
- Imbalances (Execution): Unlike price bars, imbalances are read diagonally. Buyers attack sellers one price level above, and sellers attack buyers one price level below. An imbalance is confirmed when one side has at least 3x more volume than its diagonal counterpart.

Key Order Flow Metrics:
- VAH/VAL (Value Area High/Low): The boundaries containing 70% of the candle's volume.
- CVD (Cumulative Volume Delta): Tracks total buying/selling pressure over time. CVD Divergence indicates seller exhaustion and an imminent institutional reversal.

Advanced Chart Reading: Beyond Pattern Memorization
The Three-Candle Classification:
1. Strength Candles: Large bodies, minimal wicks. One side has absolute control.
2. Control Shift Candles: Long wicks, small bodies. The previous side lost the battle; the "story" is in the wick, not the color.
3. Indecision Candles (Dojis): Small bodies, equal wicks. A draw in effort, often preceding a major breakout.

Storytelling: The "22 vs. 4" Case Study:
If it takes sellers 22 candles to drop price to a certain level, but buyers erase that entire move in only 4 candles, the "story" is one of overwhelming buyer dominance. Any retail "bearish pattern" is irrelevant.

The Story of the Wick:
- Large Upper Wick: Sellers absorbing buyers; expect downward movement.
- Large Lower Wick: Buyers absorbing sellers; expect upward movement.
- Wickless (Bullish): Absolute buyer control; no resistance.
- Wickless (Bearish): Absolute seller control; no resistance.

Supply & Demand: Institutional Zones and Inducement Traps
Zone Identification Workflow:
1. Locate Fair Value Gaps (FVG): Identify explosive three-candle moves that leave a gap.
2. Identify the Origin: The candle that initiated the move is the True Zone.
3. Identify Inducement: A weak support/resistance level that sits above a True Demand zone or below a True Supply zone.

The Trap Mechanism: Institutions require liquidity (sell orders) to fill large buy orders. They create Inducement — a persuasive area that influences retail traders to enter early. Price sweeps through the Inducement Zone to trigger stops, providing liquidity for institutional orders at the True Zone.

Confirmation: Absorption Initiation Pattern (AIP):
1. Absorption: Price enters the zone and a candle shows sellers/buyers being "soaked up."
2. Initiation: A follow-up candle closes in the trade's direction with imbalance agreement.

Fibonacci "Sniper" Strategy:
1. Identify an unmitigated 4-hour Fair Value Gap (FVG).
2. Wait for price to sweep a recent low (liquidity grab).
3. Wait for a "Change of Character" (CHoCH).
4. Draw Fib from the low to the high of the CHoCH move.
5. Execute at the Golden Zone (0.706, 0.618, 0.79 retracement).

RSI Mastery:
- 2-Day RSI Divergence: Price makes lower low but RSI makes higher low = 81.16% win rate on SPY.
- 80/20 RSI Settings: Shift from retail 70/30 to 80/20 to filter noise.
- Upper Quadrant Bounce: In strong uptrends, RSI pullback to 50 Midline = long entry.

Market Structure and Price Cycle Phases:
1. Accumulation: Quiet buying at lows. Sideways range after downtrend. Wait for breakout.
2. Markup: Riding price higher. HH/HL staircase. Buy pullbacks to demand.
3. Distribution: Quiet selling at highs. Sideways chop; upper wicks. Tighten stops.
4. Markdown: Riding price lower. LH/LL staircase. Sell rallies to supply.

Transition Signals: A valid phase transition requires a 2x-5x volume surge above the recent average on the breakout/breakdown candle, and a first successful pullback retest.

Risk Management:
- 1% Rule: Never risk more than 1% of total equity on a single trade.
- Contingency vs. Stop Loss: Standard stops on options fail because option prices are "Noise." Use Contingency Orders — exit only when the underlying stock price hits a technical level.
- S.E.T. Rule: No trade without pre-defined Stop, Entry, and Target. Every setup must provide at least 3:1 Reward-to-Risk.

Live Market Success Protocol:
1. Phase Recognition — Confirmed Markup or Markdown?
2. Transition Confirmation — 2x-5x volume surge on breakout?
3. Liquidity Check — Has price swept a recent high/low?
4. Zone Validation — Is price entering a True Zone?
5. Execution Confirmation — AIP or Control Shift candle at the zone?
6. Risk Check — 1% risk, 3:1 RR, Contingency Order set?

--- CORRELATION REPORT 2: Market Mechanics vs. Professional Execution ---

Module 2 Strategic Overview:
Module 2 constitutes the critical transition from psychological theory to the high-frequency execution environment. This phase functions as the bridge between internal mindset and external market microstructure. Identifying institutional footprints is the non-negotiable prerequisite for capturing alpha.

Mission Metrics for Module 2:
- Market Literacy: Recognition that 80-90% of volume is professional, not retail (Institutional Dominance)
- Order Flow Dynamics: Comprehension of price movement as a result of order consumption (Supply and Demand Physics)
- Price Bar Interpretation: Decoding buyer/seller consensus via bar relationships (OHLC Microstructure)

Lesson-by-Lesson Breakdown:
Lesson 1 - Who Really Moves the Market: Identifies hedge funds and pension funds as the primary drivers of the $50T global market. Introduces the "Footprints in the Sand" metaphor.
Lesson 2 - Market Volume Breakdown: Quantifies the institutional (80-90%) vs. retail (10-20%) imbalance.
Lesson 3 - Supply and Demand: Price appreciation occurs when demand consumes available supply; depreciation occurs when supply overwhelms demand.
Lesson 4 - Reading the Price Bar (OHLC): Deconstructs the four critical data points to reveal buyer vs. seller control.
Lesson 5 - Demand and Supply Zones: Unfilled institutional orders create zones of pending liquidity, serving as future catalysts.
Lesson 6 - How Orders Create Movement: Balance to Imbalance to Movement. Imbalances represent institutional intervention.

OHLC Bar Reading Workflows:
- Close > Open (Bullish Consensus): Buyers consumed supply; price ended higher.
- Close < Open (Bearish Consensus): Sellers dominated; price concluded lower.
- Close near High: Unrelenting buying pressure and professional control into the close.
- Close near Low: Extreme selling pressure and seller dominance.
- Large Range (High minus Low): High-stakes volatility and lack of consensus.
- Topping Tails: Visual manifestation of bearish consensus (Close far from High).

The Balance to Imbalance to Movement Cycle:
Balance = equilibrium (buy and sell orders equal). Imbalance = massive institutional order consumes liquidity on one side. Movement = price shifts rapidly until new Balance. Unfilled orders at Imbalance create tradeable Demand and Supply Zones.

The 5 Pillars of Stock Selection (Practical Execution Filter):
1. Already Up 10%: Baseline momentum validation.
2. Relative Volume (RVOL) > 5x: Proves institutional footprints are present vs 20-day average.
3. News Catalyst: Fresh information (biotech, earnings, sector themes) sparking professional interest.
4. Low Float (<10M): Restricted supply ensures demand imbalance = explosive movement.
5. Price (2-20): Sector most susceptible to volatility once institutional momentum is established.

Position Management — The Icebreaker Strategy:
- Entry: Quarter-size starter position (e.g., 5,000 shares toward 20,000-share goal).
- Profit Threshold: Stay at quarter-size until $1,000 profit cushion realized.
- Scaling: Only after trade is validated and $1,000 threshold met, scale into Full Size.
- This prevents emotional hijacking during choppy cycles.

The Micro Pullback Setup:
When a ticker rips on breaking news = massive Imbalance. The Micro Pullback (one-candle rest in uptrend) allows entry on first candle to make new high. Captures the Movement phase with risk defined at the low of the pullback. This is the Front Side of the move.

Cross-Reference Matrix (Theory to Practice):
- Institutional Footprints = Day Trade Dash Scanners (High RVOL) — HIGH alignment
- Demand Zones = Buying the Dip / Micro Pullbacks — HIGH alignment
- Order Flow Imbalance = Level 2 Analysis / Sellers on the Ask — HIGH alignment
- Short Trade Mechanics = Short Squeezes / Jack-knife Rejections — MEDIUM alignment
- Balance/Imbalance = Front Side (Imbalance) vs. Back Side (Balance) — HIGH alignment

Critical Execution Rules:
- Rule of Three: Walk away after three consecutive losses to prevent revenge trading.
- Slippage and Predatory Algos: Jack-knife Candles = HFT algorithms consuming liquidity. Always check spread before entry.
- No scaling to full size without $1,000 profit cushion (Icebreaker rule).
- Integrate 5 Pillars into Demand Zone Identification as a hard filter.
- Add Spread and Slippage check to every entry to ensure viable risk-to-reward.

Master Workflow for Module 2 Success:
1. Scan: Identify tickers meeting 5 Pillars (Price, RVOL > 5x, News, Float < 10M, Up 10%).
2. Filter: Isolate Institutional Footprint — high-volume price departure.
3. Map: Define Demand Zone at origin of imbalance.
4. Wait: Radical Acceptance as price pulls back to zone.
5. Enter: Quarter-Size Icebreaker at first candle to make new high, risk capped at pullback low.
6. Scale: Full Size only after $1,000 profit cushion.
7. Exit: Lock in the 18-cent base hit to build daily equity.`;

app.post('/api/trading-ai/ask', async (req, res) => {
  try {
    const { question, moduleId, history } = req.body;

    if (!question || !question.trim()) {
      return res.status(400).json({ error: 'Question is required' });
    }

    // Rate limiting
    const allowed = await checkTutorRateLimit();
    if (!allowed) {
      return res.status(429).json({
        success: false,
        answer: "You've reached the question limit (30/hour). Take a break, review the module material, and come back shortly!",
        rateLimited: true
      });
    }

    // Get Anthropic API key
    const settings = await kvGet('settings', {});
    const apiKey = settings.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(400).json({
        error: 'No Anthropic API key configured. Go to Settings to add your key.'
      });
    }

    // Get module content from KV for additional context
    const modules = await getModules();
    const mod = modules.find(m => m.id === moduleId);
    const moduleContent = mod
      ? (mod.sections || [])
          .filter(s => s.type === 'text' || !s.type)
          .map(s => `${s.title}: ${(s.content || '').substring(0, 500)}`)
          .join('\n\n')
      : '';

    // Get correlation report source material
    const correlationReport = TUTOR_SOURCES[moduleId] || '';

    // Build the system prompt
    const systemPrompt = `You are the Impact Trading Academy AI Tutor — an expert trading educator powered by the Master Surge Strategy curriculum. You are helping a student who is studying ${mod ? `Module: "${mod.title}"` : 'the trading curriculum'}.

YOUR KNOWLEDGE BASE (answer ONLY from this material):
${correlationReport ? `\n--- CORRELATION REPORT (PRIMARY SOURCE) ---\n${correlationReport}\n---\n` : ''}
${moduleContent ? `\n--- MODULE LESSON CONTENT ---\n${moduleContent}\n---\n` : ''}

RULES:
1. Answer ONLY using the knowledge base above. If the question is outside the module material, say "That topic isn't covered in this module. Try checking the relevant module or ask a different question."
2. Be encouraging but precise. Use specific terms from the curriculum (S.E.T. Rule, Chasm of Fear, Five Pillars, Notional Control, AIP, etc.)
3. When explaining concepts, reference the specific framework or strategy name.
4. If the student asks about a trading calculation, walk them through it step by step.
5. Keep answers concise but thorough — aim for 2-4 paragraphs unless a longer explanation is needed.
6. Never give specific financial advice or recommend specific trades. You are an educator, not an advisor.
7. If asked about risk, ALWAYS reinforce the 1% Rule and S.E.T. Rule.
8. Use the "institutional vs. retail" framing from the curriculum when relevant.
9. ALWAYS conclude your answer by directing the student to practice using a specific tool on the portal. Match the tool to the concept discussed:
   - Chart reading, price action, OHLC, zones, timeframes → "Now open the Live Charts tool and practice identifying this on a real chart."
   - Volume surges, sector rotation, institutional activity, stock screening → "Head to the Market Scanner to scan for stocks showing these signals right now."
   - Trading halts, circuit breakers, volatility events → "Check the Halt Tracker to see real-time halts and practice reading the codes."
   - Trade performance, win rate, P&L, review → "Log this in your Trade Journal and review your stats."
   - Sentiment, retail crowd behavior, contrarian signals → "Use the Sentiment Scanner to check what retail traders are saying about this ticker."
   - Technical indicators, RSI, MACD, kNN predictions → "Run this through the ML Prediction Indicator to see what the signals show."
   - Risk management, position sizing, S.E.T. calculations → "Open the Options Backtester and use the S.E.T. Calculator to practice sizing this trade."
   - General concepts or mindset → "Review the module flipbook in the Document Library, then test yourself with the Knowledge Check quiz above."
   Be specific — name the exact tool and what to do with it.`;

    // Build messages array with conversation history
    const messages = [];
    if (Array.isArray(history)) {
      for (const h of history.slice(-4)) { // Keep last 4 exchanges for context
        if (h.role === 'user' || h.role === 'assistant') {
          messages.push({ role: h.role, content: h.content });
        }
      }
    }
    messages.push({ role: 'user', content: question });

    // Call Anthropic Claude API
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        messages: messages
      })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      console.error('Anthropic API error:', response.status, errData);
      return res.status(response.status).json({
        error: errData.error?.message || `Anthropic API returned ${response.status}`
      });
    }

    const data = await response.json();
    const answer = data.content
      ?.filter(c => c.type === 'text')
      ?.map(c => c.text)
      ?.join('\n') || 'I was unable to generate a response. Please try again.';

    res.json({
      success: true,
      answer,
      moduleId,
      model: data.model,
      usage: data.usage
    });

  } catch (error) {
    console.error('AI Tutor error:', error);
    res.status(500).json({ error: error.message || 'Failed to get AI tutor response' });
  }
});

// Endpoint to check if AI Tutor is available (has API key)
app.get('/api/trading-ai/status', async (req, res) => {
  const settings = await kvGet('settings', {});
  const hasKey = !!(settings.anthropicApiKey || process.env.ANTHROPIC_API_KEY);
  // Check which modules have correlation reports loaded
  const availableModules = Object.keys(TUTOR_SOURCES);
  res.json({ available: hasKey, modules: availableModules });
});


// =============================================================================
// COMPANY LOOKUP — Ticker ↔ Company Name Resolution
// Reusable across all backtesters, screeners, and search components
// =============================================================================

app.get('/api/company-lookup', async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 1) return res.json({ results: [] });

  const query = q.trim();
  const cacheKey = `company_lookup_${query.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;

  try {
    // Check cache first (1-hour TTL)
    const cached = await kvGet(cacheKey);
    if (cached && cached.fetchedAt && Date.now() - cached.fetchedAt < 3600000) {
      return res.json({ results: cached.results, cached: true });
    }

    // Yahoo Finance search for ticker ↔ name resolution
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0&listsCount=0`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MissionMetrics/1.0)' }
    });
    if (!resp.ok) return res.json({ results: [] });
    const data = await resp.json();

    const results = (data.quotes || [])
      .filter(r => r.quoteType === 'EQUITY' || r.quoteType === 'ETF' || r.quoteType === 'INDEX')
      .map(r => ({
        symbol: r.symbol,
        name: r.longname || r.shortname || '',
        shortName: r.shortname || '',
        type: r.quoteType,
        exchange: r.exchange || '',
        sector: r.sector || '',
        industry: r.industry || ''
      }));

    // Cache for 1 hour
    await kvSet(cacheKey, { results, fetchedAt: Date.now() });
    res.json({ results, cached: false });
  } catch (error) {
    console.error('Company lookup error:', error.message);
    res.json({ results: [] });
  }
});


// =============================================================================
// AI TRADE REVIEW — Server-side Claude analysis of a trade setup
// Called by the backtester confirmation modal before running simulations
// =============================================================================

app.post('/api/ai-trade-review', async (req, res) => {
  try {
    const { symbol, direction, entry, stop, target, risk, reward, ratio, posSize } = req.body;

    if (!symbol || !entry || !stop || !target) {
      return res.status(400).json({ error: 'Missing required trade setup fields (symbol, entry, stop, target).' });
    }

    // Rate limiting — separate from tutor endpoint
    const allowed = await checkTradeReviewRateLimit();
    if (!allowed) {
      return res.status(429).json({
        error: 'Rate limit reached (30 AI reviews/hour). Try again shortly.',
        rateLimited: true
      });
    }

    // Get Anthropic API key
    const settings = await kvGet('settings', {});
    const apiKey = settings.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(400).json({ error: 'No Anthropic API key configured. Go to Settings to add your key.' });
    }

    const dir = direction || 'LONG';
    const prompt = `You are a trading coach for the Impact Trading Academy. Analyze this trade setup briefly and practically.

SETUP:
- Symbol: ${symbol}
- Direction: ${dir}
- Entry: $${Number(entry).toFixed(2)}
- Stop: $${Number(stop).toFixed(2)}
- Target: $${Number(target).toFixed(2)}
- Risk/Share: $${Number(risk || 0).toFixed(2)}
- Reward/Share: $${Number(reward || 0).toFixed(2)}
- R:R Ratio: ${ratio || '?'}:1
- Position Size: ${posSize || '?'} shares

Provide exactly this JSON (no markdown, just raw JSON):
{
  "grade": "A/B/C/D/F",
  "label": "one of: Clean Setup, Solid Plan, Acceptable, Risky, Weak, Aggressive",
  "summary": "1-2 sentence overall assessment",
  "pros": ["2-3 strengths of this setup"],
  "cons": ["1-3 concerns or weaknesses"],
  "suggestion": "One specific actionable suggestion to improve this setup"
}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 400,
        system: 'You are a trading analyst. Return ONLY valid JSON. Apply the S.E.T. Rule framework: Stop first, Entry second, Target last. A 3:1 reward-to-risk ratio is the standard. Be honest but constructive.',
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      console.error('AI Trade Review API error:', response.status, errData);
      return res.status(response.status).json({
        error: errData.error?.message || `Anthropic API returned ${response.status}`
      });
    }

    const data = await response.json();
    const rawText = data.content?.filter(c => c.type === 'text')?.map(c => c.text)?.join('') || '';

    // Parse the JSON response
    let analysis;
    try {
      analysis = JSON.parse(rawText);
    } catch (parseErr) {
      // Try to extract JSON from response if it has extra text
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        analysis = JSON.parse(jsonMatch[0]);
      } else {
        return res.json({ success: true, raw: rawText, parseFailed: true });
      }
    }

    res.json({ success: true, analysis, model: data.model, usage: data.usage });

  } catch (error) {
    console.error('AI Trade Review error:', error);
    res.status(500).json({ error: error.message || 'Failed to analyze trade setup' });
  }
});


// =============================================================================
// COMPANY SNAPSHOT — Live Intelligence + Claude AI Analysis
// Returns market data + AI-generated trading insights for any ticker
// =============================================================================

app.get('/api/company-snapshot', async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'Symbol parameter is required' });

  const sym = symbol.toUpperCase().trim();
  const allowed = /^[A-Z0-9.\-]{1,10}$/;
  if (!allowed.test(sym)) return res.status(400).json({ error: 'Invalid symbol format' });

  const cacheKey = `snapshot_${sym}`;

  try {
    // Check cache (15-minute TTL for live data)
    const cached = await kvGet(cacheKey);
    if (cached && cached.fetchedAt && Date.now() - cached.fetchedAt < 900000) {
      return res.json({ ...cached, cached: true });
    }

    // Rate limiting for non-cached requests (separate from AI tutor)
    const rateLimitOk = await checkSnapshotRateLimit();
    if (!rateLimitOk) {
      return res.status(429).json({ error: 'Rate limit reached (30 AI requests/hour). Cached results still available.' });
    }

    // --- STEP 1: Fetch comprehensive Yahoo Finance data ---
    const [chartResp, searchResp] = await Promise.all([
      fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1y&interval=1d&includePrePost=false`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MissionMetrics/1.0)' }
      }),
      fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(sym)}&quotesCount=1&newsCount=0&listsCount=0`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MissionMetrics/1.0)' }
      })
    ]);

    if (!chartResp.ok) {
      return res.status(chartResp.status).json({ error: `Yahoo Finance returned ${chartResp.status}` });
    }

    const chartRaw = await chartResp.json();
    const result = chartRaw?.chart?.result?.[0];
    if (!result) return res.status(404).json({ error: 'No data found for symbol' });

    const meta = result.meta || {};
    const ts = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] || {};

    // Build candle array
    const candles = [];
    for (let i = 0; i < ts.length; i++) {
      const o = quote.open?.[i], h = quote.high?.[i], l = quote.low?.[i], c = quote.close?.[i], v = quote.volume?.[i];
      if (o != null && h != null && l != null && c != null) {
        candles.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), o: +o.toFixed(2), h: +h.toFixed(2), l: +l.toFixed(2), c: +c.toFixed(2), v: v || 0 });
      }
    }

    if (candles.length === 0) return res.status(404).json({ error: 'No price data available' });

    // --- STEP 2: Compute market metrics ---
    const current = candles[candles.length - 1];
    const high52 = Math.max(...candles.map(c => c.h));
    const low52 = Math.min(...candles.map(c => c.l));
    const avgVolume = Math.round(candles.reduce((s, c) => s + c.v, 0) / candles.length);
    const currentVolume = current.v;
    const marketCap = meta.marketCap || 0;

    // Volatility (20-day standard deviation of returns)
    const returns20 = candles.slice(-21).map((c, i, a) => i === 0 ? 0 : (c.c - a[i - 1].c) / a[i - 1].c).slice(1);
    const meanRet = returns20.reduce((s, r) => s + r, 0) / returns20.length;
    const stdDev = Math.sqrt(returns20.reduce((s, r) => s + (r - meanRet) ** 2, 0) / returns20.length);
    const annualizedVol = +(stdDev * Math.sqrt(252) * 100).toFixed(1);

    // Recent 20-day range
    const recent20 = candles.slice(-20);
    const recentHigh = Math.max(...recent20.map(c => c.h));
    const recentLow = Math.min(...recent20.map(c => c.l));

    // Trend: 50-day SMA vs current price
    const sma50 = candles.length >= 50 ? +(candles.slice(-50).reduce((s, c) => s + c.c, 0) / 50).toFixed(2) : current.c;
    const sma20 = candles.length >= 20 ? +(candles.slice(-20).reduce((s, c) => s + c.c, 0) / 20).toFixed(2) : current.c;

    // Momentum: RSI 14-day
    const rsiPeriod = 14;
    let gains = 0, losses = 0;
    const rsiCandles = candles.slice(-(rsiPeriod + 1));
    for (let i = 1; i < rsiCandles.length; i++) {
      const diff = rsiCandles[i].c - rsiCandles[i - 1].c;
      if (diff > 0) gains += diff; else losses += Math.abs(diff);
    }
    const avgGain = gains / rsiPeriod;
    const avgLoss = losses / rsiPeriod;
    const rsi = avgLoss === 0 ? 100 : +(100 - (100 / (1 + avgGain / avgLoss))).toFixed(1);

    // Performance periods
    const perfCalc = (days) => {
      if (candles.length < days + 1) return null;
      const old = candles[candles.length - days - 1].c;
      return +((current.c - old) / old * 100).toFixed(2);
    };

    // Classifications
    const volatilityLevel = annualizedVol < 20 ? 'Low' : annualizedVol < 40 ? 'Medium' : 'High';
    const volumeClassification = currentVolume > avgVolume * 1.5 ? 'Unusual (High)' : currentVolume > avgVolume * 0.8 ? 'Strong' : 'Weak';
    const trendClassification = current.c > sma50 && sma20 > sma50 ? 'Uptrend' : current.c < sma50 && sma20 < sma50 ? 'Downtrend' : 'Range-Bound';

    // Max drawdown in the year
    let peak = candles[0].h, maxDD = 0;
    for (const c of candles) {
      if (c.h > peak) peak = c.h;
      const dd = (peak - c.l) / peak * 100;
      if (dd > maxDD) maxDD = dd;
    }

    // Company identity from search
    let companyName = meta.shortName || meta.longName || sym;
    let sector = '', industry = '';
    try {
      if (searchResp.ok) {
        const searchData = await searchResp.json();
        const match = (searchData.quotes || [])[0];
        if (match) {
          companyName = match.longname || match.shortname || companyName;
          sector = match.sector || '';
          industry = match.industry || '';
        }
      }
    } catch (e) { /* search enrichment is optional */ }

    // Build market data object
    const marketData = {
      symbol: sym,
      companyName,
      sector,
      industry,
      currentPrice: current.c,
      previousClose: meta.previousClose || (candles.length > 1 ? candles[candles.length - 2].c : current.c),
      marketCap,
      avgVolume,
      currentVolume,
      high52: +high52.toFixed(2),
      low52: +low52.toFixed(2),
      recentHigh: +recentHigh.toFixed(2),
      recentLow: +recentLow.toFixed(2),
      sma20,
      sma50,
      rsi,
      annualizedVolatility: annualizedVol,
      volatilityLevel,
      volumeClassification,
      trendClassification,
      maxDrawdown: +maxDD.toFixed(1),
      performance: {
        '5d': perfCalc(5),
        '20d': perfCalc(20),
        '60d': perfCalc(60),
        '120d': perfCalc(120),
        '250d': perfCalc(250)
      },
      exchange: meta.exchangeName || ''
    };

    // --- STEP 3: Claude AI Analysis ---
    let aiInsights = null;
    try {
      const settings = await kvGet('settings', {});
      const apiKey = settings.anthropicApiKey || process.env.ANTHROPIC_API_KEY;

      if (apiKey) {
        const dataPrompt = `Analyze this stock for a trader using the Impact Trading Academy system. Be concise.

TICKER: ${sym}
COMPANY: ${companyName}
SECTOR: ${sector} | INDUSTRY: ${industry}
PRICE: $${current.c} | 52-WEEK: $${low52.toFixed(2)} - $${high52.toFixed(2)}
SMA20: $${sma20} | SMA50: $${sma50} | RSI: ${rsi}
VOLATILITY: ${annualizedVol}% (${volatilityLevel}) | VOLUME: ${volumeClassification}
TREND: ${trendClassification} | MAX DRAWDOWN: ${maxDD.toFixed(1)}%
PERFORMANCE: 5d=${perfCalc(5)}% | 20d=${perfCalc(20)}% | 60d=${perfCalc(60)}% | 120d=${perfCalc(120)}%

Provide exactly this JSON structure (no markdown, just raw JSON):
{
  "trendSummary": "2-3 sentence trend analysis with momentum direction",
  "tradingInsights": ["3-5 concise trading nuggets relevant to this stock right now"],
  "historicalContext": "2-3 sentences on notable patterns, good/bad periods, and major drawdowns",
  "keyLevels": { "support": <nearest support price>, "resistance": <nearest resistance price> },
  "traderTakeaway": "One-sentence bottom line for a trader looking at this stock today"
}`;

        const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: CLAUDE_MODEL,
            max_tokens: 512,
            system: 'You are a trading analyst for the Impact Trading Academy. Return ONLY valid JSON, no markdown fences, no explanation text. Apply the Master Surge Strategy framework: institutional footprints, supply/demand zones, 1% risk rule, S.E.T. discipline.',
            messages: [{ role: 'user', content: dataPrompt }]
          })
        });

        if (aiResp.ok) {
          const aiData = await aiResp.json();
          const aiText = aiData.content?.filter(c => c.type === 'text')?.map(c => c.text)?.join('') || '';
          try {
            aiInsights = JSON.parse(aiText);
          } catch (parseErr) {
            // Try extracting JSON from response
            const jsonMatch = aiText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              try { aiInsights = JSON.parse(jsonMatch[0]); } catch (e) { /* AI analysis optional */ }
            }
          }
        }
      }
    } catch (aiError) {
      console.warn('Company snapshot AI analysis failed:', aiError.message);
      // AI enrichment is optional — market data still returns
    }

    // Build final response
    const snapshot = {
      ...marketData,
      aiInsights,
      fetchedAt: Date.now()
    };

    // Cache for 15 minutes
    await kvSet(cacheKey, snapshot);
    res.json({ ...snapshot, cached: false });

  } catch (error) {
    console.error('Company snapshot error:', error.message);
    res.status(500).json({ error: 'Failed to fetch company snapshot. Try again.' });
  }
});

// =============================================================================
// HEALTH CHECK
// =============================================================================

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

module.exports = app;
