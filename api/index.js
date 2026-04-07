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

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// =============================================================================
// AUTH MIDDLEWARE (role-aware: admin vs student)
// =============================================================================

// resolveSession: attaches session info to req.session if token is valid
async function resolveSession(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const session = await kvGet(`session:${token}`);
  return session || null;
}

// requireAuth: any valid session (admin or student)
async function requireAuth(req, res, next) {
  const session = await resolveSession(req);
  if (!session) {
    return res.status(401).json({ error: 'Authorization required' });
  }
  req.userSession = session;
  next();
}

// requireAdmin: only admin sessions
async function requireAdmin(req, res, next) {
  const session = await resolveSession(req);
  if (!session) {
    return res.status(401).json({ error: 'Authorization required' });
  }
  if (session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  req.userSession = session;
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

app.put('/api/modules', requireAdmin, async (req, res) => {
  const modules = req.body;
  if (!Array.isArray(modules)) return res.status(400).json({ error: 'Modules must be an array' });
  await kvSet('modules', modules);
  res.json({ success: true, count: modules.length });
});

app.post('/api/modules', requireAdmin, async (req, res) => {
  const modules = await kvGet('modules', []);
  const newModule = { ...req.body, id: req.body.id || 'm' + Date.now() };
  modules.push(newModule);
  await kvSet('modules', modules);
  res.json({ success: true, module: newModule });
});

app.put('/api/modules/:id', requireAdmin, async (req, res) => {
  const modules = await kvGet('modules', []);
  const idx = modules.findIndex(m => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Module not found' });
  modules[idx] = { ...req.body, id: req.params.id };
  await kvSet('modules', modules);
  res.json({ success: true, module: modules[idx] });
});

app.delete('/api/modules/:id', requireAdmin, async (req, res) => {
  let modules = await kvGet('modules', []);
  modules = modules.filter(m => m.id !== req.params.id);
  await kvSet('modules', modules);
  res.json({ success: true });
});

// =============================================================================
// PROGRESS ENDPOINTS
// =============================================================================

app.get('/api/progress', requireAuth, async (req, res) => {
  const session = req.userSession;
  const key = session.role === 'student' ? `student_progress:${session.userId}` : 'progress';
  const progress = await kvGet(key, { completedModules: {}, quizState: {} });
  res.json(progress);
});

app.put('/api/progress', requireAuth, async (req, res) => {
  const session = req.userSession;
  const key = session.role === 'student' ? `student_progress:${session.userId}` : 'progress';
  await kvSet(key, req.body);
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

app.put('/api/settings', requireAdmin, async (req, res) => {
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
  try {
    const { moduleId, sectionIndex, sectionTitle, sectionContent, moduleTitle } = req.body;
    const imageId = `${moduleId}_s${sectionIndex}`;
    const imageKey = `image_${imageId}`;

    // Delete cached image first
    try { await kv.del(imageKey); } catch (e) { console.error('Cache delete error:', e); }

    // Get API key
    const settings = await kvGet('settings', {});
    const apiKey = settings.geminiApiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(400).json({ error: 'No Gemini API key configured. Go to Settings to add your key.' });
    }

    // Generate new image directly (no app.handle redirect)
    const ai = new GoogleGenAI({ apiKey });
    const prompt = buildImagePrompt(moduleTitle, sectionTitle, sectionContent);

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: prompt,
      config: { responseModalities: ['TEXT', 'IMAGE'] }
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

    return res.json({ success: false, error: 'Image generation returned text only — no image produced.' });
  } catch (error) {
    console.error('Regenerate visual error:', error);
    res.status(500).json({ error: error.message || 'Failed to regenerate image' });
  }
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
    const { moduleId, cacheOnly } = req.body;

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

    // If cacheOnly flag is set, don't auto-generate — just report no cache
    if (cacheOnly) {
      return res.json({ success: false, cached: false, message: 'No cached infographic' });
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
// LOGIN ENDPOINT (admin via env vars, students via KV)
// =============================================================================

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Username and password required' });
  }

  const adminUser = process.env.ADMIN_USERNAME;
  const adminPass = process.env.ADMIN_PASSWORD;

  // Check admin credentials first
  if (adminUser && adminPass && username === adminUser && password === adminPass) {
    const token = Buffer.from(`admin:${Date.now()}:${Math.random()}`).toString('base64');
    await kvSet(`session:${token}`, { role: 'admin', userId: 'admin', username });
    return res.json({ success: true, token, role: 'admin' });
  }

  // Check student credentials
  const students = await kvGet('students', []);
  const student = students.find(s => s.username === username && s.password === password);
  if (student) {
    const token = Buffer.from(`student:${student.id}:${Date.now()}`).toString('base64');
    await kvSet(`session:${token}`, { role: 'student', userId: student.id, username: student.username });
    return res.json({ success: true, token, role: 'student', studentId: student.id });
  }

  res.status(401).json({ success: false, error: 'Invalid username or password' });
});

// Session validation — returns role so frontend can restore permissions
app.post('/api/validate-session', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.json({ valid: false });
  const session = await kvGet(`session:${token}`);
  if (session) {
    res.json({ valid: true, role: session.role, userId: session.userId, username: session.username });
  } else {
    res.json({ valid: false });
  }
});

// =============================================================================
// STUDENT MANAGEMENT ENDPOINTS (admin only)
// =============================================================================

// List all students
app.get('/api/students', requireAdmin, async (req, res) => {
  const students = await kvGet('students', []);
  // Return without passwords
  const safe = students.map(s => ({ id: s.id, username: s.username, createdAt: s.createdAt }));
  res.json({ success: true, students: safe });
});

// Create a student account
app.post('/api/students', requireAdmin, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  if (username.length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  }
  if (password.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  }

  const students = await kvGet('students', []);

  // Check for duplicate username
  if (students.find(s => s.username.toLowerCase() === username.toLowerCase())) {
    return res.status(409).json({ error: 'A student with that username already exists' });
  }

  // Also check against admin username
  if (username.toLowerCase() === (process.env.ADMIN_USERNAME || '').toLowerCase()) {
    return res.status(409).json({ error: 'That username is reserved' });
  }

  const student = {
    id: 'stu_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
    username,
    password,
    createdAt: new Date().toISOString()
  };

  students.push(student);
  await kvSet('students', students);

  res.json({ success: true, student: { id: student.id, username: student.username, createdAt: student.createdAt } });
});

// Delete a student account (also clears their progress and sessions)
app.delete('/api/students/:id', requireAdmin, async (req, res) => {
  let students = await kvGet('students', []);
  const student = students.find(s => s.id === req.params.id);
  if (!student) return res.status(404).json({ error: 'Student not found' });

  students = students.filter(s => s.id !== req.params.id);
  await kvSet('students', students);

  // Clean up student's progress
  try { await kv.del(`student_progress:${req.params.id}`); } catch (e) {}

  res.json({ success: true });
});

// =============================================================================
// RESET SITE ENDPOINT (admin only — clears all student progress)
// =============================================================================

app.post('/api/reset-progress', requireAdmin, async (req, res) => {
  try {
    // Clear admin progress
    await kvSet('progress', { completedModules: {}, quizState: {} });

    // Clear all student progress
    const students = await kvGet('students', []);
    for (const student of students) {
      try { await kv.del(`student_progress:${student.id}`); } catch (e) {}
    }

    // Clear all mastery exam results (quiz_70_*)
    const modules = await getModules();
    for (const mod of modules) {
      try { await kv.del(`quiz_70_${mod.id}`); } catch (e) {}
    }

    res.json({ success: true, message: 'All progress and scores have been reset' });
  } catch (error) {
    console.error('Reset error:', error);
    res.status(500).json({ error: 'Failed to reset progress' });
  }
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
    // Support both @google/genai v1.x response formats
    const text = response.candidates?.[0]?.content?.parts?.[0]?.text
      || (typeof response.text === 'string' ? response.text : '')
      || '';

    if (!text) {
      console.error('Quiz generation: empty response from Gemini', JSON.stringify(response).substring(0, 500));
      return res.status(500).json({ error: 'Gemini returned an empty response. The model may be temporarily unavailable.' });
    }

    try {
      questions = JSON.parse(text);
    } catch (parseErr) {
      // Try to extract JSON array from response
      const match = text.match(/\[[\s\S]*\]/);
      if (match) {
        questions = JSON.parse(match[0]);
      } else {
        console.error('Quiz parse failure. Raw text:', text.substring(0, 300));
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

    const text = response.candidates?.[0]?.content?.parts?.[0]?.text
      || (typeof response.text === 'string' ? response.text : '')
      || '';
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

// ===== MENTOR VIDEO SEARCH QUERIES — Ross's videos mapped to modules =====
const MENTOR_VIDEO_QUERIES = {
  ross: {
    channelQuery: 'Warrior Trading Ross Cameron',
    m1: [
      'Ross Cameron Chasm of Fear day trading mindset',
      'Ross Cameron 5 reasons traders lose money',
      'Ross Cameron how to start day trading 2026 full training',
      'Ross Cameron survive till you thrive'
    ],
    m2: [
      'Ross Cameron supply demand day trading micro pullback',
      'Ross Cameron Level 2 hidden buyers day trading',
      'Ross Cameron how I find stocks retail trader',
      'Ross Cameron candlestick patterns actually using every day'
    ],
    m3: [
      'Ross Cameron MACD strategy spot big winners early',
      'Ross Cameron micro pullback strategy $175k',
      'Ross Cameron 7 candlestick patterns actually using',
      'Ross Cameron simple MACD strategy 5712%'
    ],
    m4: [
      'Ross Cameron how much risk should I take',
      'Ross Cameron max loss red day',
      'Ross Cameron 3 steps winning day trading',
      'Ross Cameron I kept losing money until I did this'
    ],
    m5: [
      'Ross Cameron 3 small accounts 3 brokers what I learned',
      'Ross Cameron $120k remote $240k office',
      'Ross Cameron how retire 9 to 5 job 3 years starting zero',
      'Ross Cameron grow small account zero experience full training'
    ],
    m6: [
      'Ross Cameron options day trading strategy',
      'Ross Cameron playing defense made me $25000',
      'Ross Cameron quality vs quantity trading less 3x income'
    ],
    m7: [
      'Ross Cameron does timing the market work',
      'Ross Cameron bear market strategy',
      'Ross Cameron hot cold cycle small cap'
    ],
    m8: [
      'Ross Cameron $500k 7 days day trading full training',
      'Ross Cameron $175k 3 hours day trading full training',
      'Ross Cameron 5 day trading tools actually use every day'
    ],
    m9: [
      'Ross Cameron Level 2 $65k hidden buyers',
      'Ross Cameron reading candlestick shapes charts zero experience',
      'Ross Cameron technical indicators candlestick charts'
    ],
    m10: [
      'Ross Cameron 1 month vs 1 year vs 1 decade day trading',
      'Ross Cameron 4 market types you need to understand',
      'Ross Cameron stop overtrading doing less made 3x'
    ],
    m13: [
      'Ross Cameron small cap momentum front side back side trading',
      'Ross Cameron downward spiral revenge trading psychology',
      'Ross Cameron micro pullback ABCD pattern execution'
    ],
    m14: [
      'Ross Cameron 10 second chart micro pullback entry strategy',
      'Ross Cameron Level 2 wall of sellers chipping away',
      'Ross Cameron Icebreaker quarter size position management'
    ],
    m15: [
      'Ross Cameron small account challenge $583 to millions',
      'Ross Cameron survive till you thrive base hit mentality',
      'Ross Cameron ABCD pattern cup and handle momentum setup'
    ]
  }
};

// Channel verification map — only videos from these channels count as "Mentor" videos.
// Videos from other channels are silently dropped (they still appear in general API results).
const MENTOR_CHANNEL_FILTER = {
  ross: ['warrior trading', 'ross cameron']
};

async function searchMentorVideos(moduleId, maxResults = 3) {
  const mentorVideos = [];
  for (const [mentorId, mentorConfig] of Object.entries(MENTOR_VIDEO_QUERIES)) {
    const queries = mentorConfig[moduleId];
    if (!queries || queries.length === 0) continue;

    // Channel filter: only keep videos actually from the mentor's channel
    const allowedChannels = MENTOR_CHANNEL_FILTER[mentorId] || [];
    const isFromMentor = (video) => {
      if (allowedChannels.length === 0) return true; // No filter defined = allow all
      const ch = (video.channel || '').toLowerCase();
      return allowedChannels.some(name => ch.includes(name));
    };

    // Search using the first query (most specific)
    const results = await searchYouTubeVideos(queries[0], maxResults + 2); // fetch extra to account for filtered-out videos
    const verified = results.filter(isFromMentor);
    if (verified.length > 0) {
      mentorVideos.push(...verified.slice(0, maxResults).map(v => ({ ...v, mentor: mentorId, mentorName: MENTOR_SOURCES[mentorId]?.name || mentorId })));
    } else if (queries.length > 1) {
      // Fallback to second query
      const fallback = await searchYouTubeVideos(queries[1], maxResults + 2);
      const verifiedFallback = fallback.filter(isFromMentor);
      mentorVideos.push(...verifiedFallback.slice(0, maxResults).map(v => ({ ...v, mentor: mentorId, mentorName: MENTOR_SOURCES[mentorId]?.name || mentorId })));
    }
  }
  return mentorVideos;
}

app.get('/api/youtube/:moduleId', async (req, res) => {
  const moduleId = req.params.moduleId;
  const curatedKey = `youtube_${moduleId}`;
  const apiCacheKey = `youtube_api_${moduleId}`;
  const mentorCacheKey = `youtube_mentor_${moduleId}`;

  // 1. Load curated (Mission Metrics) videos — these are permanent
  let curatedVideos = [];
  const curatedData = await kvGet(curatedKey);
  if (curatedData && curatedData.curated && curatedData.videos && curatedData.videos.length > 0) {
    curatedVideos = curatedData.videos;
  }

  // 2. Load mentor videos (Ross etc.) — cached separately, expire after 24h
  let mentorVideos = [];
  const mentorCached = await kvGet(mentorCacheKey);
  const ONE_DAY = 24 * 60 * 60 * 1000;

  if (mentorCached && mentorCached.videos && mentorCached.videos.length > 0 && mentorCached.fetchedAt) {
    const cacheAge = Date.now() - new Date(mentorCached.fetchedAt).getTime();
    if (cacheAge < ONE_DAY) {
      mentorVideos = mentorCached.videos;
    }
  }

  // Fetch fresh mentor videos if cache expired
  if (mentorVideos.length === 0 && MENTOR_VIDEO_QUERIES.ross && MENTOR_VIDEO_QUERIES.ross[moduleId]) {
    mentorVideos = await searchMentorVideos(moduleId, 3);
    if (mentorVideos.length > 0) {
      await kvSet(mentorCacheKey, { moduleId, videos: mentorVideos, fetchedAt: new Date().toISOString() });
    }
  }

  // 3. Load YouTube API search results (cached separately, expire after 24h)
  let apiVideos = [];
  const apiCached = await kvGet(apiCacheKey);

  if (apiCached && apiCached.videos && apiCached.videos.length > 0 && apiCached.fetchedAt) {
    const cacheAge = Date.now() - new Date(apiCached.fetchedAt).getTime();
    if (cacheAge < ONE_DAY) {
      apiVideos = apiCached.videos;
    }
  }

  // 4. If no fresh API results, fetch from YouTube API
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

  // 5. Combine: mentor videos FIRST, then curated, then API results (deduplicate by URL)
  const allUrls = new Set();
  const combined = [];

  // Mentor videos at top (tagged with mentor info)
  for (const v of mentorVideos) {
    if (!allUrls.has(v.url)) { allUrls.add(v.url); combined.push(v); }
  }
  // Curated next
  for (const v of curatedVideos) {
    if (!allUrls.has(v.url)) { allUrls.add(v.url); combined.push(v); }
  }
  // API results last
  for (const v of apiVideos) {
    if (!allUrls.has(v.url)) { allUrls.add(v.url); combined.push(v); }
  }

  if (combined.length > 0) {
    const source = mentorVideos.length > 0 ? 'mentor+api' :
                   curatedVideos.length > 0 ? 'curated+api' : 'youtube_api';
    return res.json({
      success: true, moduleId, videos: combined,
      curated: curatedVideos.length > 0, mentorVideos: mentorVideos.length, source
    });
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

// Yahoo Finance crumb + cookies cache (30 min TTL)
let yfCrumbCache = { crumb: null, cookies: null, ts: 0 };

async function getYahooCrumb() {
  if (yfCrumbCache.crumb && Date.now() - yfCrumbCache.ts < 30 * 60 * 1000) {
    return yfCrumbCache;
  }
  try {
    // Step 1: Get cookies
    const initResp = await fetch('https://fc.yahoo.com/', { redirect: 'manual' });
    const setCookies = initResp.headers.raw?.()?.['set-cookie'] || initResp.headers.getSetCookie?.() || [];
    const cookieStr = setCookies.map(c => c.split(';')[0]).join('; ');

    // Step 2: Get crumb
    const crumbResp = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Cookie': cookieStr
      }
    });
    const crumb = await crumbResp.text();

    yfCrumbCache = { crumb, cookies: cookieStr, ts: Date.now() };
    return yfCrumbCache;
  } catch (error) {
    console.error('Error fetching Yahoo crumb:', error.message);
    throw error;
  }
}

// Company profile & fundamentals
app.get('/api/stock-profile', async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'Symbol required' });
  const allowed = /^[A-Z0-9.\-]{1,10}$/i;
  if (!allowed.test(symbol)) return res.status(400).json({ error: 'Invalid symbol' });

  try {
    const modules = 'assetProfile,summaryDetail,defaultKeyStatistics,financialData,calendarEvents,earnings,incomeStatementHistory,incomeStatementHistoryQuarterly';

    // Get crumb and cookies for Yahoo Finance authentication
    const { crumb, cookies } = await getYahooCrumb();

    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol.toUpperCase())}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`;
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Cookie': cookies
      }
    });
    if (!resp.ok) return res.status(resp.status).json({ error: `Yahoo returned ${resp.status}` });
    const raw = await resp.json();
    const result = raw?.quoteSummary?.result?.[0];
    if (!result) return res.status(404).json({ error: 'No data found' });

    const profile = result.assetProfile || {};
    const summary = result.summaryDetail || {};
    const keyStats = result.defaultKeyStatistics || {};
    const financial = result.financialData || {};
    const calendar = result.calendarEvents || {};
    const earnings = result.earnings || {};
    const incomeAnnual = result.incomeStatementHistory?.incomeStatementHistory || [];
    const incomeQuarterly = result.incomeStatementHistoryQuarterly?.incomeStatementHistory || [];

    res.json({
      symbol: symbol.toUpperCase(),
      profile: {
        name: profile.longBusinessSummary ? profile.longBusinessSummary.substring(0, 200) + '...' : '',
        sector: profile.sector || '',
        industry: profile.industry || '',
        website: profile.website || '',
        employees: profile.fullTimeEmployees || 0,
        city: profile.city || '',
        state: profile.state || '',
        country: profile.country || ''
      },
      stats: {
        marketCap: summary.marketCap?.raw || 0,
        marketCapFmt: summary.marketCap?.fmt || '--',
        volume: summary.volume?.raw || 0,
        volumeFmt: summary.volume?.fmt || '--',
        avgVolume: summary.averageVolume?.raw || 0,
        avgVolumeFmt: summary.averageVolume?.fmt || '--',
        pe: summary.trailingPE?.fmt || '--',
        forwardPe: summary.forwardPE?.fmt || '--',
        eps: keyStats.trailingEps?.fmt || '--',
        beta: summary.beta?.fmt || '--',
        fiftyTwoWeekHigh: summary.fiftyTwoWeekHigh?.fmt || '--',
        fiftyTwoWeekLow: summary.fiftyTwoWeekLow?.fmt || '--',
        fiftyDayAvg: summary.fiftyDayAverage?.fmt || '--',
        twoHundredDayAvg: summary.twoHundredDayAverage?.fmt || '--',
        targetPrice: financial.targetMeanPrice?.fmt || '--',
        recommendation: financial.recommendationKey || '--',
        numberOfAnalysts: financial.numberOfAnalystOpinions?.raw || 0
      },
      dividends: {
        rate: summary.dividendRate?.fmt || '--',
        yield: summary.dividendYield?.fmt || '--',
        exDate: summary.exDividendDate?.fmt || '--',
        payoutRatio: summary.payoutRatio?.fmt || '--'
      },
      earningsDate: calendar.earnings?.earningsDate?.map(d => d.fmt) || [],
      earningsHistory: (earnings.earningsChart?.quarterly || []).map(q => ({
        quarter: q.date || '',
        actual: q.actual?.raw || 0,
        estimate: q.estimate?.raw || 0
      })),
      financials: {
        annual: incomeAnnual.slice(0, 4).map(stmt => ({
          date: stmt.endDate?.fmt || '',
          revenue: stmt.totalRevenue?.raw || 0,
          revenueFmt: stmt.totalRevenue?.fmt || '--',
          netIncome: stmt.netIncome?.raw || 0,
          netIncomeFmt: stmt.netIncome?.fmt || '--',
          grossProfit: stmt.grossProfit?.raw || 0,
          operatingIncome: stmt.operatingIncome?.raw || 0
        })),
        quarterly: incomeQuarterly.slice(0, 4).map(stmt => ({
          date: stmt.endDate?.fmt || '',
          revenue: stmt.totalRevenue?.raw || 0,
          revenueFmt: stmt.totalRevenue?.fmt || '--',
          netIncome: stmt.netIncome?.raw || 0,
          netIncomeFmt: stmt.netIncome?.fmt || '--'
        }))
      },
      performance: {
        revenueGrowth: financial.revenueGrowth?.fmt || '--',
        earningsGrowth: financial.earningsGrowth?.fmt || '--',
        profitMargin: financial.profitMargins?.fmt || '--',
        operatingMargin: financial.operatingMargins?.fmt || '--',
        returnOnEquity: financial.returnOnEquity?.fmt || '--',
        returnOnAssets: financial.returnOnAssets?.fmt || '--',
        debtToEquity: financial.debtToEquity?.fmt || '--',
        currentRatio: financial.currentRatio?.fmt || '--',
        freeCashflow: financial.freeCashflow?.fmt || '--'
      }
    });
  } catch (error) {
    console.error('Stock profile error:', error.message);
    res.status(500).json({ error: 'Failed to fetch profile' });
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

// Module 3 source
TUTOR_SOURCES['m3'] = `Module 3 Correlation Report: The Master Surge Strategy — Five Pillars of Institutional Timing

The Master Surge Strategy is the primary timing mechanism to identify market turns and major moves in advance. It is the central framework of the Impact Trading Academy system and integrates all prior module concepts into a unified execution model.

The Five Pillars of the Master Surge Strategy (All Five Required Together):

Pillar 1 — Understand Price Cycles:
Markets move in four repeating phases:
1. Accumulation: Institutions quietly buying at low prices. Sideways range after downtrend.
2. Markup: Price rising as demand overwhelms supply. Higher highs, higher lows staircase.
3. Distribution: Institutions quietly selling into strength at high prices. Sideways range at highs.
4. Markdown: Price falling as supply overwhelms demand. Lower highs, lower lows staircase.
No single phase lasts forever — the cycle repeats continuously across all timeframes.

Pillar 2 — Track Volume Surges:
Institutions control 80-90% of all market volume. Unusual volume spikes (2x-5x above 20-day average) are direct evidence of big money entering or exiting. Volume surge + price move = confirmed institutional conviction. Without volume confirmation, price moves are unreliable.

Pillar 3 — Watch Institutional Footprints:
Identify unfilled orders (leftover institutional buying/selling pressure) that create predictable supply and demand zones. The strongest zones are created by explosive departures — rapid price moves away that leave unfilled orders behind.

Pillar 4 — Confirm Trend Strength:
Always ensure the overarching trend supports your trade direction. Trading with the trend = institutional momentum on your side. Trading against the trend = fighting the biggest players in the market. Use multiple timeframes for confirmation.

Pillar 5 — Use Risk Management Every Time:
1% max risk per trade, 3:1 reward-to-risk ratio, S.E.T. rule (Stop, Entry, Target) on every trade without exception. This is non-negotiable regardless of how confident you feel.

Integration: No single pillar works alone. The power of the Master Surge Strategy comes from confirmation across ALL five pillars simultaneously. A trade that only meets 2-3 pillars is lower probability than one meeting all 5.

Price Cycle Phase Transition Signals:
A valid transition requires: (1) Volume surge of 2x-5x above 20-day average on the breakout/breakdown candle, (2) Price closes decisively outside the range, (3) First successful pullback retest — price returns to breakout level and holds.

Common Mistakes:
- Calling bottoms during markdown before accumulation range forms
- Chasing markup entries without waiting for pullbacks to demand zones
- Confusing distribution for consolidation
- Ignoring volume confirmation
- Trading against the dominant phase`;

// Module 4 source
TUTOR_SOURCES['m4'] = `Module 4 Correlation Report: Risk Management and the S.E.T. Rule

The 1% Rule — The Foundation of Survival:
Never risk more than 1% of total trading portfolio per trade. Formula: Total Account Balance × 1% = Maximum Dollar Risk Per Trade.
Example: $10,000 account × 1% = $100 max risk per trade. $50,000 account × 1% = $500 max risk.
This rule is NON-NEGOTIABLE. It is the mathematical foundation that makes the Chasm of Fear crossable — when you know your downside is capped at 1%, fear loses its grip.

The 3:1 Reward-to-Risk Ratio:
For every $1 risked, aim to earn $3. Risk = 1% per trade. Reward target = 3% per trade.
Profitability at different win rates with 3:1 ratio:
- 25% win rate = Break Even
- 30% win rate = +$20 Profit per 100 trades
- 40% win rate = +$60 Profit per 100 trades
- 50% win rate = +$100 Profit per 100 trades
Even a 30% win rate is profitable with disciplined 3:1 execution. This is the mathematical edge.

The S.E.T. Rule (Stop, Entry, Target):
Every trade MUST have all three defined BEFORE execution:
S — Stop: Protective floor (for longs) or ceiling (for shorts). Caps downside at 1% of account.
E — Entry: Exact buy/sell trigger price. Prepared before the move happens, not reactive.
T — Target: 3% profit objective (minimum 3:1 ratio). Set at the next opposing supply/demand zone.

Position Sizing Formula:
Position Size = Account Risk ÷ Trade Risk
Account Risk = 1% of total account value
Trade Risk = Distance between Entry and Stop in dollars per share
Example: $50,000 account, Entry $100, Stop $98
- Account Risk = $500 (1% of $50,000)
- Trade Risk = $2/share ($100 - $98)
- Position Size = 250 shares ($500 ÷ $2)

Contingency Orders vs. Standard Stop Losses:
Standard stops on options fail because option prices are "Noise" — they fluctuate based on time decay, implied volatility, and other factors beyond just price movement. Use Contingency Orders instead — exit the option position only when the UNDERLYING stock price hits your technical stop level. This prevents being stopped out by option premium noise.

Win/Loss Psychology:
A 70% losing percentage seems terrible but is irrelevant if you maintain 3:1 reward-to-risk. The goal is never perfection — it is profitability through disciplined risk control. Focus on the math, not the feelings.`;

// Module 5 source
TUTOR_SOURCES['m5'] = `Module 5 Correlation Report: Leverage Strategy and Asset Vehicles

Good Leverage vs. Bad Leverage:
Good Leverage: Used on non-depreciating assets, backed by strategy + risk management, calculated and intentional.
Bad Leverage: Emotional, speculative, depreciating assets, no risk control, reactive and impulsive.
The difference is never the amount of leverage — it is whether you have a plan and the discipline to follow it.

Leverage by Vehicle:
- Stocks: No leverage (1x). Require full capital outlay.
- Options: 10x-20x leverage. 1 contract controls 100 shares for a fraction of the cost.
- Futures: 20x-200x leverage. MES contracts accessible with ~$2,000 account.
- Forex/Crypto: 50x-100x leverage. Highest volatility, mandatory discipline required.

Mutual Funds vs ETFs:
Mutual Funds: Trade once/day at close, higher fees, no leverage, no stop-losses, bull-only, NOT compatible with options.
ETFs: Trade throughout the day, lower fees, leverage available, short selling, bull AND bear, stop-losses permitted, options compatible.
ETFs are superior for active traders. Recommended account for ETFs/Bonds: $50,000.

Options & LEAPS (10x-20x Leverage):
- 1 contract = 100 shares controlled for a fraction of the cost (the premium)
- Maximum loss = premium paid (perfect for 1% rule — defined risk)
- Strike Price = price at which you can buy/sell the stock
- Expiration Date = when the option expires (1 day to 3 years)
- LEAPS = Long-Term Equity Anticipation Securities expiring 2-3 years out
- Options quoted per share but control 100 shares (e.g., $5.00 quote = $500 total cost)
Example: Stock $100, Strike $90, Premium $500. You control $9,000 of stock for $500. If stock rises above $90 → option gains value. If stock drops → max loss is $500 only.

Futures (20x-200x Leverage):
- MES = Micro E-mini S&P 500 (1/10th of standard ES contract)
- 23-hour daily electronic trading access
- No $25,000 pattern day-trading requirement (only ~$2,000 needed)
- 60/40 tax rule: 60% long-term rate, 40% short-term rate regardless of holding period
- CRITICAL: Futures losses can exceed initial investment (unlike options). Must use protective stop orders.

Income Strategy by Timeframe:
- Daily: Futures ($2,000 min) — 1-2 hours of trading
- Weekly: Options & Futures ($5,000 min)
- Monthly: Options & Forex/Crypto ($25,000 min)
- Quarterly: Options & Forex/Crypto ($50,000 min)
- Yearly/Wealth: Stocks ($250,000 min)

Financial Purpose Categories:
Income: Bills, Fun, Kingdom Impact, General income
Wealth: Retirement, Legacy, Security, Freedom, Kingdom Impact`;

// Module 6 source
TUTOR_SOURCES['m6'] = `Module 6 Correlation Report: Options Deep Dive

Options Mechanics — Core Concepts:
- 1 contract = 100 shares
- Quoted per share (multiply by 100 for total cost)
- Maximum loss = premium paid (defined risk — perfect for 1% rule)
- Strike Price + Expiration Date = the two defining characteristics of any option
- Calls give the RIGHT to BUY at the strike price
- Puts give the RIGHT to SELL at the strike price

100 Shares vs. 1 Call Option (Stock at $100):
Buy 100 shares: Controls 100 shares, Cost $10,000, Max Loss $10,000 (entire investment)
Buy 1 call option: Controls right to 100 shares, Cost ~$500, Max Loss $500 (premium only)
This is Notional Control — controlling large amounts of stock for a fraction of the cost.

Leverage Ratio = (Stock Price × 100) / Option Premium Paid
Example: Stock at $100, Premium $5.00 → Leverage = ($100 × 100) / $500 = 20:1

LEAPS (Long-Term Equity Anticipation Securities):
- Options expiring up to 2-3 years out
- More time for the stock to move in your direction
- Less time decay pressure than short-term options
- Ideal for swing/position trading strategies
- Allow you to capture large moves with defined risk

Call Options — When to Use:
- Bullish on the underlying stock
- Want leveraged exposure with defined risk
- The S.E.T. rule applies: Stop (close the option if underlying hits stop), Entry (buy the call when setup triggers), Target (sell the option when target is reached or time-decay risk increases)

Put Options — When to Use:
- Bearish on the underlying stock
- Want to profit from a decline with defined risk
- Alternative to short selling (no unlimited risk)

Contingency Orders for Options:
Standard stop-losses on options fail because option premium moves with volatility and time decay, not just the stock price. Use Contingency Orders — set your exit based on the UNDERLYING STOCK price hitting your technical stop level. This prevents being stopped out by option premium noise while the stock is still in your zone.

The Greeks (Awareness Level):
- Delta: How much the option moves per $1 move in the stock
- Theta: How much value the option loses per day (time decay)
- Vega: How much the option moves per 1% change in implied volatility
- Understanding delta and theta helps with strike selection and timing`;

// Module 7 source
TUTOR_SOURCES['m7'] = `Module 7 Correlation Report: Futures Trading — The 23-Hour Advantage

Key Advantages of Futures:
1. 23-hour electronic trading access (trade almost around the clock)
2. No $25,000 pattern day-trading requirement (only ~$2,000 needed for MES)
3. High leverage: 20x-200x depending on the contract
4. 60/40 tax treatment (Section 1256 of the Internal Revenue Code)
5. Low commissions and exchange fees
6. Reduced overnight gap risk (market trades nearly continuously)
7. Suitable for daily income generation (1-2 hours of trading)

60/40 Tax Rule (Section 1256):
- 60% of ALL futures gains → taxed at the lower long-term capital gains rate
- 40% of ALL futures gains → taxed at the higher short-term capital gains rate
- Applies REGARDLESS of holding period — even a 5-minute futures day trade gets 60/40 treatment
Comparison: Stock day trader pays 100% short-term rate. Futures day trader pays blended rate. Result: Futures traders keep significantly more profit.

S&P 500 Micro E-mini (MES):
- MES = Micro E-mini S&P 500 futures contract
- Size: 1/10th of the standard ES (E-mini S&P 500) contract
- Makes futures accessible to smaller accounts (~$2,000 minimum)
- Same market exposure as standard contract at fraction of the size
- Best starting point for learning futures with real money

Major Futures Markets:
- Equity Index: S&P 500, Nasdaq, Dow, Russell, DAX, Nikkei, Hang Seng
- Interest Rates: 10-Year Treasury, 30-Year Bond, 2-Year Note
- Energy & Metals: Crude Oil, Natural Gas, Gold, Silver, Copper
- Currencies: Euro, Yen, Swiss Franc, GBP, AUD, CAD, USD Index
- Agriculture/Softs: Corn, Soybeans, Wheat, Coffee, Cocoa, Cotton, Sugar

CRITICAL Risk Warning:
Futures losses CAN EXCEED your initial investment (unlike options where max loss = premium). You MUST use protective stop orders. NEVER risk more than 1%. Apply S.E.T. without exception. Futures without discipline will destroy accounts faster than any other vehicle.

Futures vs. Options Risk Comparison:
- Options: Max loss = premium paid (defined, capped)
- Futures: Max loss = unlimited without stops (undefined, uncapped)
- Both require S.E.T. and 1% rule, but futures require even stricter discipline because the risk is not naturally capped`;

// Module 8 source
TUTOR_SOURCES['m8'] = `Module 8 Correlation Report: Trade Execution — The 4-Step Institutional Workflow

This module teaches the exact step-by-step process to execute trades like an institutional trader, removing emotion and ensuring preparation on every trade.

The 4-Step Execution Workflow:
Step 1 — Identify the Setup: Scan the chart for clear supply and demand zones created by previous institutional activity. The strongest setups occur at fresh zones that have not been revisited. Use multiple timeframes: higher timeframe (daily/weekly) for trend direction, lower timeframe (1-hour/15-min) for precise entry.

Step 2 — Spot Institutional Footprints: Confirm institutional presence at the zone. Key footprints: large-volume candles that created the zone, rapid price departure (shows urgency), minimal time spent in the zone (institutions filled quickly). Stronger footprints = higher probability.

Step 3 — Anticipate and Plan Before Price Arrives: Set your S.E.T. (Stop, Entry, Target) BEFORE price reaches your zone. Entry at edge of zone. Stop just beyond zone (max 1% risk). Target at least 3x risk (next opposing zone). If you wait until price arrives, emotions will cloud judgment.

Step 4 — Execute with S.E.T. Already Defined: When price reaches your zone and a confirmation pattern appears (basing candle, engulfing, rejection wick), execute the trade. Your S.E.T. is already set. No hesitation, no second-guessing.

Price Action Over Indicators:
Retail traders rely on lagging indicators (MACD, RSI, moving averages) that tell what ALREADY happened. Institutional traders focus on price action — raw movement revealing what is happening RIGHT NOW. By the time an indicator signals, the institutional move has already started. Read the chart, not the indicator.

Confirming Trend Direction:
Before executing, confirm dominant trend using supply/demand analysis. Uptrend: demand zones hold, price makes higher highs. Downtrend: supply zones hold, price makes lower lows. Never trade against the dominant trend without extreme confluence from multiple pillars.`;

// Module 9 source
TUTOR_SOURCES['m9'] = `Module 9 Correlation Report: Volume Analysis — Reading Institutional Activity

Volume is the fuel behind price movement. Without volume, price moves lack conviction and are likely to reverse. Volume is a lie detector for price — if price moves but volume does not confirm, the move is suspicious.

What Volume Bars Represent:
Volume bars show the total number of shares or contracts traded during a specific time period. Each bar corresponds to a price bar on your chart.

Normal Volume vs. Institutional Surges:
Normal volume = typical daily trading (mostly retail + algorithms maintaining liquidity).
Institutional surges = dramatic spikes (2x-5x normal) signaling big money entering or exiting.
Volume surge at a supply/demand zone = CONFIRMED institutional participation. One of the strongest confirmation signals in the Master Surge Strategy.

Volume Divergence Warning Signs:
Bearish divergence: Price makes new highs but volume DECREASES — institutions may be distributing (selling into strength). This is a warning to tighten stops or avoid new longs.
Bullish divergence: Price makes new lows but volume DECREASES — selling pressure is exhausting. Institutional accumulation may be beginning.

Practical Volume Checklist (Before Every Trade):
1. Is current volume above or below the 20-period average?
2. Did the setup zone form on high volume (institutional)?
3. Is volume increasing as price approaches your zone?
4. Is there volume divergence warning against your trade direction?
5. Does the volume pattern confirm or contradict the trend?
If volume does NOT confirm your setup → reduce position size or skip entirely.

Volume Quick Reference:
- High volume + price up = Strong bullish (institutional buying)
- High volume + price down = Strong bearish (institutional selling)
- Low volume + price up = Weak rally, likely to reverse
- Low volume + price down = Weak decline, may find support
- Volume spike at support = Demand zone activation
- Volume spike at resistance = Supply zone activation`;

// Module 10 source
TUTOR_SOURCES['m10'] = `Module 10 Correlation Report: Visual Guide — Recognizing Price Cycle Phases on Your Chart

This module bridges the gap between knowing the four-phase theory (Accumulation, Markup, Distribution, Markdown) and recognizing these phases in real time on a live chart.

Phase 1 — Accumulation (What It Looks Like):
Visual signatures: Sideways range after a prior downtrend. Volume low and declining (retail has given up). Range tightens over time as institutions absorb supply. Flat or slightly rising moving averages. Volume dries up on drops with occasional small spikes on up-moves (institutional accumulation). May last weeks or months.
Action: Wait for breakout confirmation. Do NOT buy inside the range without confirmation.

Phase 2 — Markup (What It Looks Like):
Visual signatures: Breakout above accumulation range with 2x-5x volume surge. Staircase pattern of higher highs and higher lows. Strong bullish candles with minimal upper wicks. Pullbacks hold above previous swing lows. Volume increases on up-moves, decreases on pullbacks. Moving averages fan out and slope upward.
Action: Buy pullbacks to demand zones formed during accumulation. Trail stops.

Phase 3 — Distribution (What It Looks Like):
Visual signatures: Sideways range at highs (similar to accumulation but at the top). Upper wicks appearing frequently (sellers absorbing buyers). Volume spikes on down-moves. False breakouts above resistance that quickly fail. Narrowing range. Moving averages flatten.
Action: Tighten stops on existing longs. Prepare for potential short setups.

Phase 4 — Markdown (What It Looks Like):
Visual signatures: Breakdown below distribution range with heavy volume. Staircase of lower highs and lower lows. Strong bearish candles with minimal lower wicks. Rallies fail at previous swing highs. Volume increases on drops, decreases on bounces. Moving averages slope downward as resistance.
Action: Sell rallies to supply zones or stay cash. Wait for next accumulation.

Phase Transition Confirmation (ALL required):
1. Volume surge: 2x-5x above 20-day average on breakout/breakdown candle
2. Price closes decisively outside the range (not just a wick)
3. First successful pullback retest holds

Common Mistakes:
- Calling bottom during markdown before accumulation range forms
- Chasing markup without waiting for pullback
- Confusing distribution for consolidation
- Ignoring volume confirmation
- Trading against the current phase`;

// Module 11 source
TUTOR_SOURCES['m11'] = `Module 11 Correlation Report: Visual Guide — Chart Patterns at Supply & Demand Zones

This module teaches the specific candlestick formations and price patterns that confirm institutional activity when price arrives at your supply/demand zones.

Pattern 1 — The Explosive Departure:
Strongest evidence of institutional activity. Price enters zone and immediately rockets away with large-bodied candles and high volume. 2-3 consecutive large candles with minimal wicks moving rapidly from zone. The faster and more violent the departure, the stronger the zone.

Pattern 2 — The Basing Candle:
Small-bodied candle (doji or spinning top) at a zone just before the move begins. Represents the brief moment where institutional orders are being filled. Your precision entry signal — stop goes just beyond the basing candle for tight risk. Without a basing candle, the zone may not be ready for entry.

Pattern 3 — The Engulfing Candle at a Zone:
Completely covers the previous candle body. Bullish engulfing at demand = buyers overwhelming sellers. Bearish engulfing at supply = sellers overwhelming buyers. One of the most reliable zone-confirmation patterns. Body should be significantly larger than prior candle, volume must confirm.

Pattern 4 — Rejection Wicks (Pin Bars) at Zones:
Long wicks with small bodies. At demand: long lower wick = sellers pushed down but buyers rejected aggressively. At supply: long upper wick = buyer rejection. The longer the wick relative to body, the stronger the rejection.

Pattern 5 — The Gap at a Zone (Imbalance Windows / Fair Value Gaps):
Price opens significantly above/below previous close. Gaps at zones represent extreme institutional urgency — orders so large price could not trade through gradually. Gap-ups from demand = bullish. Gap-downs from supply = bearish. The Fair Value Gap (FVG) is a three-candle pattern identifying these imbalance windows.

Pattern 6 — The Squeeze Before the Move:
Extremely low volatility (tight range, small candles) just before a major move. Narrowing Bollinger Bands, decreasing ATR, multiple small candles in a row. Wait for the breakout from the squeeze confirmed by volume. Do NOT trade inside the squeeze.

The Confirmation Stack (High-Probability Entries):
1. Price at confirmed supply or demand zone
2. At least one pattern appears (engulfing, rejection wick, basing, etc.)
3. Volume confirms institutional participation (above average)
4. Trade direction aligns with dominant trend/phase
5. S.E.T. defined with 1% max risk and 3:1 minimum reward
With 3+ confirmations stacked = high probability. Fewer than 2 = skip the trade.`;

// Module 12 source
TUTOR_SOURCES['m12'] = `Module 12 Correlation Report: Market Psychology & Historical Performance Analysis

This module explores the psychological traps that destroy traders and uses historical market data to build conviction in the system.

Dunning-Kruger Effect in Trading:
The Dunning-Kruger effect creates a dangerous progression for traders:
1. Mount Stupid (Peak of Confidence): New traders learn a few patterns and believe they have mastered the market. This is where the most reckless trades occur.
2. Valley of Despair: Reality hits — losses pile up and confidence collapses. Most traders quit here.
3. Slope of Enlightenment: Survivors begin to understand that trading is about probability, not prediction. They embrace risk management.
4. Plateau of Sustainability: Disciplined traders reach consistent profitability through rules, not feelings.

The Shiller PE Ratio (CAPE):
The Cyclically Adjusted Price-to-Earnings ratio smooths earnings over 10 years to identify whether the overall market is overvalued or undervalued. High CAPE = market is expensive relative to historical norms. Low CAPE = potential buying opportunity. This metric helps with phase identification at the macro level.

2022 Market Performance — Case Study:
The 2022 decline demonstrated every concept in the curriculum. Distribution phase visible at 2021 highs, followed by markdown through 2022. Traders who recognized the phase transition and managed risk survived. Those who bought the dip without volume confirmation got crushed.

Three Pillars of Trading Mastery (Meta-Framework):
1. Knowledge: Understanding the mechanics (modules 1-11)
2. Discipline: Following rules without deviation (S.E.T., 1% rule)
3. Patience: Waiting for setups that meet ALL five pillars of the Master Surge Strategy

Win/Loss Psychology:
A 70% loss rate is irrelevant with 3:1 reward-to-risk. Focus on the MATH of profitability, not the FEELING of individual trades.`;

// Module 13 source
TUTOR_SOURCES['m13'] = `Module 13 Correlation Report: Wealth-Building Frameworks & Long-Term Strategy

This module shifts from active trading mechanics to long-term wealth-building strategy, integrating trading income with investment compounding.

Compounding Power:
$10,000 at 10% for 30 years = ~$174,000 (S&P 500 average)
$10,000 at 20% for 30 years = ~$2,370,000 (Berkshire-level compounding)
Small increases in annual return create exponential differences over decades. The goal of active trading is to generate INCOME that feeds WEALTH accounts compounding at higher rates.

Income vs. Wealth Accounts:
Income Account: Active trading (futures daily, options weekly/monthly). Used for bills, lifestyle, giving.
Wealth Account: Long-term compounding (stocks, ETFs, LEAPS). Used for retirement, legacy, security, freedom.
The two accounts serve different purposes. Never confuse them. Trading income FUNDS wealth building.

Kingdom Impact:
The curriculum incorporates a faith-based approach where financial success enables giving and community impact. Both income and wealth have a "Kingdom Impact" allocation — the idea that building wealth creates capacity to serve others.

Structural Advantage of Small Accounts:
"It is a huge structural advantage to not have a lot of money." Small accounts can pursue high-growth opportunities that large funds cannot access due to position size and liquidity constraints. Use this advantage while you have it.

The Complete Trader's Lifecycle:
Phase 1: Education (Modules 1-11) — Learn the system
Phase 2: Paper Trading — Practice without risk
Phase 3: Small Account ($2,000-$5,000) — Daily futures income
Phase 4: Growing Account ($5,000-$25,000) — Weekly options + futures
Phase 5: Full Portfolio ($25,000+) — Monthly income + wealth building
Phase 6: Financial Freedom — Income exceeds expenses, wealth compounds`;

// Module 14 source
TUTOR_SOURCES['m14'] = `Module 14 Correlation Report: Options Strategies for Active Income

This module covers practical options strategies for generating regular income using the leveraged strategies taught throughout the curriculum.

Options for Weekly Income:
Use short-term options (1-2 weeks to expiration) on liquid stocks and ETFs. The goal is to capture quick directional moves using the supply/demand zones and Master Surge Strategy timing.

Call Options for Bullish Setups:
- Identify demand zone on a stock in markup phase
- Buy call option with strike at or near the demand zone
- Set contingency exit based on underlying stock's technical stop level
- Target: 3:1 reward-to-risk on the option premium

Put Options for Bearish Setups:
- Identify supply zone on a stock in distribution/markdown phase
- Buy put option with strike at or near the supply zone
- Same contingency order approach — exit based on underlying stock price, not option premium

LEAPS for Swing Trades:
- Use LEAPS (2-3 year expiration) for longer-term positions
- Less time decay pressure allows holding through pullbacks
- Ideal for capturing full markup phase moves
- Maximum loss still limited to premium paid

Strike Selection Principles:
- In-the-Money (ITM): Higher delta, moves more with stock, higher premium (lower leverage)
- At-the-Money (ATM): Balanced delta/premium, good for directional bets
- Out-of-the-Money (OTM): Lower premium (higher leverage), needs bigger move to profit, higher risk of total loss
For the Master Surge Strategy, ATM to slightly ITM options provide the best balance of leverage and probability.

Contingency Orders (Reinforced):
NEVER use standard stop-losses on options. Option premium fluctuates due to time decay and volatility changes. Use contingency orders that trigger option exit when the UNDERLYING STOCK hits your technical stop level.`;

// Module 15 source
TUTOR_SOURCES['m15'] = `Module 15 Correlation Report: Advanced Options — Leverage, Crisis Strategy & Capital Deployment

This is the capstone module covering advanced options deployment, crisis-based opportunity plays, and complete capital management.

Advanced Options — Leverage and Time Decay:
Understanding time decay (Theta) is critical for advanced options trading. Options lose value every day just from the passage of time. This decay accelerates as expiration approaches. Strategies to manage time decay: buy longer-dated options (LEAPS), avoid holding options through the last 30 days of rapid decay unless the trade is already deep in profit.

Never Waste a Good Crisis:
"If you have been sidelined, believe this is a good opportunity to scale into high conviction tokens. Do not capitulate." — This principle from Module 1's Chasm of Fear applies directly here. Crisis events (geopolitical shocks, market crashes, earnings disasters) create extreme supply/demand imbalances. While the 99% panic-sell, institutional traders accumulate at discount prices.

The crisis strategy:
1. Maintain cash reserves specifically for crisis opportunities
2. Have a pre-made watchlist of high-conviction names
3. When crisis hits, identify which demand zones are being tested
4. Scale in with quarter-size positions (Icebreaker approach)
5. Use LEAPS for maximum leverage with defined risk
6. Be patient — the Chasm of Fear separates winners from losers

Leverage Comparison — $20,000 Capital:
Stocks: Control $20,000 of stock (no leverage)
Options: Control $200,000-$400,000 of stock (10-20x leverage)
Futures: Control $400,000-$4,000,000 (20-200x leverage)
Same $20,000, vastly different control and profit potential — but also different risk profiles.

Why You Need a Trading Plan:
A written trading plan removes emotion from every decision. It should include: your account size, max risk per trade (1%), target vehicles, timeframe for income/wealth, the specific setups you trade (Master Surge Strategy zones), your S.E.T. for each position category, and rules for when NOT to trade.

Time Decay Deep Dive:
Theta decay is not linear — it accelerates. An option losing $5/day at 60 days to expiration might lose $20/day at 10 days to expiration. This non-linear decay is why LEAPS (2-3 year expiration) are preferred for swing positions. Short-term options (1-4 weeks) are best for trades where you expect quick movement within 1-5 days.

Capital Deployment Strategy:
Never deploy all capital at once. Use the Icebreaker approach:
1. Quarter-size starter position
2. Stay at quarter-size until $1,000 profit cushion realized
3. Only scale to full size after trade is validated
This prevents emotional hijacking during choppy periods and protects capital for the best setups.`;

// ===== MENTOR SOURCES — Curated mentor teachings per module =====
const MENTOR_SOURCES = {
  ross: {
    name: 'Ross',
    avatar: '🎓',
    title: 'Momentum Trading Mentor',
    m1: `The Momentum Synthesis: A Master Framework for High-Volatility Small-Cap Trading

1. Overview of the Topic
In the high-stakes arena of small-cap equities, momentum trading is the ultimate performance sport of numbers. The ability to capitalize on rapid price expansions—often 100% to 500% intraday—is not a matter of luck, but of professional execution and the management of statistical probabilities. This framework synthesizes elite execution tactics, rigorous risk mitigation, and the psychological fortitude required to bridge the "Chasm of Fear."

The "Cameron Method" is defined by the symbiotic relationship between technical chart patterns and high-impact news catalysts. It focuses on the fundamental imbalance of supply and demand, specifically identifying low-float stocks experiencing massive surges in Relative Volume (RVOL). By reconciling historical audits, real-time trading logs (Tradervue), and pedagogical manuals, we have developed a scalable, rule-based system that converts raw market data into consistent profitability.

2. Source Correlation Summary
Validation of a trading system requires the reconciliation of three distinct data points: instructional theory, historical audits, and real-time application. Without this "operational ground truth," a strategy is merely anecdotal.

The pedagogical focus of the Impact Trading Academy manual provides the "mindset foundation" necessary to avoid "emotional hijacking." This is evidenced in real-time recaps where technical patterns, such as the "Jack-Knife" candle, trigger primitive fear responses. Successful execution requires "emotional centering"—a state where a trader can process a sudden 10% rejection without succumbing to revenge trading or "shorter fuses" caused by external stressors.

3. Key Themes Found Across Sources
Elite trading is a multi-dimensional discipline requiring total alignment between market sentiment, technical setups, and personal state.

The Anatomy of a Catalyst: The quality of the news dictates the longevity of the price expansion. High-quality news like clinical trial results or defense contracts creates sustained demand, whereas speculative headlines often lead to "pop and drop" scenarios.

The Physics of Supply and Demand: The "Five Pillars of Stock Selection" (Price, Volume, News, Price Range, Float) represent the quantitative filter for a squeeze. A stock with a 10M share float trading 10M shares of volume is a 1:1 ratio. However, a 1M share float trading 10M shares of volume creates a 10:1 imbalance—the physical engine behind 1,000% moves.

The Temporal Window: Liquidity and "fresh news" are concentrated in the 7:00 AM – 10:00 AM EST window.

4. Important Agreements Between Sources
Professional standards built on universal mandates:
- The Primacy of Accuracy: Maintaining a 60-90% win rate on "A-Quality" setups provides financial and emotional capital for larger risks.
- Risk Mitigation (The Icebreaker Strategy): Start with quarter-sized "starter" positions. Full-size positions only after the trade proves validity.
- The "Front Side" Mandate: Aggressively trade the "front side" (higher highs, higher lows). Trading the "back side" is strictly prohibited.

5. Important Differences or Gaps
Account Constraints: Margin accounts allow high leverage and multiple intraday trades. Cash accounts are restricted by T+1 settlement, creating "One-Bullet Syndrome"—forcing traders to seek "home runs," leading to over-holding and catastrophic losses.

Data Gaps: International headlines (Singaporean/Chinese firms) are treated with technical skepticism—often move on vague news and prone to violent rejections.

6. Unique Insights
- The "Jack-Knife" Candle: A violent rejection caused by market orders, stop-loss triggers, and HFT algorithms. A "warning shot" that the ticker is no longer safe for retail.
- Psychology of Superstition as Confidence Proxy: Superstition serves as a psychological anchor, preventing the "short fuse" that leads to revenge trading.
- Verified Financial Reality: The audited figure of $15.8M (12.5M audited through December plus $3.3M YTD) anchors the strategy's validity.

7. The Execution Framework
Phase I - Pre-Trading Checklist: 9-point internal/external audit (sleep quality, emotional centering, market temperature, SPY sentiment).
Phase II - Selection & Scanning: Filter via Five Pillars. Identify leading percentage gainer. Check RVOL (ideally 100x to 13,000x above average).
Phase III - Entry & Patterns: Execute only on A-Quality logic: Micro-Pullback, ABCD Pattern, Cup and Handle.
Phase IV - Position Management: Start with Icebreaker. Scale to full size only after securing profit cushion (e.g., $1,000). Exit immediately on "back side" or "Jack-Knife."

8. Practical Takeaways
1. The 3-Loss Rule: Terminate trading after three consecutive large losses.
2. The 50% Give-Back Rule: If you surrender 50% of gains, walk away.
3. Broker-Level Restrictions: Implement Max Share Size Restriction in your platform.
4. The Pedagogical Path: Alpha Phase (simulator), Beta Phase (one trade per day with real money).
5. The Daily Audit: Log every trade in Tradervue. Track accuracy and P/L ratios.

9. Mastery Summary
Mastery is realizing trading is a Performance Sport of Numbers. 2025 data proves: Less is More—higher profits achieved with half the trades of 2024. Profitability is 20% strategy and 80% the discipline to execute when the "Chasm of Fear" opens.`,

    m2: `The Unified Theory of Momentum: A Synthesis of Market Mechanics and Tactical Execution

1. Overview: The Reconciliation of Institutional Physics and Tactical Execution
Professional trading is the calculated reconciliation of institutional physics and retail execution. Success is predicated on dual mastery: understanding the "why" of market movement—governed by supply and demand mechanics—and the "how" of tactical profitability—dictated by momentum strategies and extreme psychological discipline.

Two core pillars: Market Microstructure (institutional order flow moving the $50 trillion global equity market) and Momentum Trading (methodology to capitalize on resulting imbalances). To navigate the chasm between macro theory and the micro-reality of a $2,000 account, triangulate data from academic foundations and live execution transcripts.

2. Key Themes
- Institutional Dominance as Prime Mover: Institutions control 80-90% of volume. Professional momentum trading hunts for "100x relative volume" and "breaking news"—the literal footprints of these giants.
- The Geometry of Price Action: The OHLC bar is the fundamental market language. The Close represents consensus, while High/Low indicate conviction vs. disagreement. A high close relative to range signals buyer dominance.
- The Asymmetry of Risk: The Balance → Imbalance → Movement cycle. Enter during transition to "Imbalance" via the Icebreaker Strategy with quarter-size starters.

3. Important Agreements
1. Law of Supply and Demand: Price moves from order imbalance. When demand overwhelms supply (triggered by catalyst), price must rise to find equilibrium.
2. Value of Footprints: Large players cannot hide. Significant moves must be backed by heavy volume to be valid.
3. Systematic Methodology: Pre-trading Checklist and Step-by-Step Workflows eliminate gambling instinct. Success built on A-Quality setups.

4. Important Differences
- Zones vs. Pivots: "Demand/Supply Zones" represent physical reality of unfilled institutional orders. Simple "Pivots" or "Support/Resistance" are often psychological levels easily manipulated by HFT algorithms. Zones are more robust.
- Timeframe Focus: Manual analyzes daily/weekly OHLC for structure; tactical execution requires 10-second and 1-minute charts to identify the exact "Moment of Truth."
- Small Account Variable: Navigate PDT Rule and Cash Account limitations. Tightened filters: Price 1.50-6, Float <5M (vs. standard Price 2-20, Float <10M).

5. Unique Insights
- The Three-Stage Sequence: Balance (consolidation) → Imbalance (institutional entry) → Movement (directional surge).
- The Jack-Knife Candle: A mechanical predatory event where HFT algorithms and stop-loss cascades extract money from retail. A "rejection" warning the Momentum Phase is compromised.
- The Icebreaker Strategy: First trades use 1/4 size to build profit cushion. Only get aggressive once "in the green."

6. The Master Workflow
1. Scanning (Demand Detection): Small Account 5 Pillars (Price 1.50-6, Float <5M). Look for Institutional Footprint (volume 5x-100x above average).
2. Verification (Imbalance Confirmation): Confirm driven by fresh catalyst (Breaking News).
3. Execution (Zone Entry): Switch to 10-second/1-minute timeframe. Wait for Micro Pullback into Demand Zone. Buy the "Moment of Truth"—the second the first candle makes a new high.
4. Management (Scaling): Icebreaker technique. Size up only if green and breaking high of day. Exit on Jack-Knife or Supply Zone.
5. Decision to Abstain: If market is "Cold" or "Grinding" or trader not grounded, stay flat.

7. Practical Takeaways
Pre-Market: Assess sleep quality, identify market cycle (Hot vs. Cold), define max share size and daily max loss.
Execution: Verify A-Quality (all 5 Pillars + news catalyst), break the ice with 1/4 size, avoid the backside.
Risk: Maintain 2:1 Profit-Loss Ratio, Rule of Three (stop after 3 large losses or 50% give-back).

8. Final Summary
Trading is a game of statistics governed by supply and demand. Follow institutional footprints while maintaining extreme emotional discipline. Master the Balance → Imbalance → Movement cycle. Protect capital with the Icebreaker, wait for A-Quality setups, respect the Jack-Knife warning. Survive till you Thrive.`,

    m3: `The Warrior Framework: A Unified Synthesis of High-Velocity Momentum Trading

1. Overview of the Topic
Momentum trading, when executed at the institutional grade of a Senior Architect, is not an act of speculation but a rigorous discipline of probability, statistics, and clinical risk management. This report serves as a proprietary blueprint, synthesizing the high-velocity methodology pioneered by Ross Cameron across varying market cycles, account constraints, and physiological conditions.

We define "Momentum Trading" as the systematic exploitation of price imbalances in equities exhibiting extreme relative volume and volatility, almost exclusively triggered by fresh news catalysts. However, identifying the "what"—the asset—is merely a prerequisite. The structural integrity of this framework relies on the "how"—the systemic execution that converts market noise into an audited proof of concept.

2. Source Correlation Summary
The following table reconciles disparate market sessions to extract the "universal truths" of the system. Reconciling "Hot Market" scaling with "Small Account" constraints is vital for maintaining a consistent edge.

Source ID / Core Focus / Primary Asset Type:
- Source 1: High-Velocity Execution (10s charts) — Biotech, HFT-driven Short Squeezes (APVO)
- Source 6: Systemic Performance Psychology — Small-Cap Gainers (Data-driven feedback loops)
- Source 7: Cash Account Constraints — Low-Priced Stocks (1.50–6.00), One-Bullet Strategy
- Source 8: Remote Systems Architecture — Small-Cap Momentum (Starlink/Mobile Command)
- Source 11: Low-Liquidity Environmental Strategy — Holiday Continuation Stocks (AMCI)
- Source 12: Psychological Anchoring & Rituals — Recent IPOs, 1,500% Squeezes (APDN, SPB)
- Source 13: Scaling & Tax-Efficiency — Multi-Sector Small Caps (Roth IRA Strategy)
- Monday Scans: Supply/Demand Imbalances — Reverse Splits (HCTI, SLRX), Low-Float Gappers

The "5 Pillars of Stock Selection" serve as the boilerplate template across every source. While a "Hot" cycle allows for the exploitation of B-quality setups due to high FOMO, a "Cold" cycle mandates extreme selectivity, as even A-quality setups frequently fail to provide follow-through.

3. Key Themes Found Across Sources
Professional trading behavior is characterized by recurring patterns that transcend specific tickers and form a defensive perimeter around the trader's capital.

The Primacy of Risk Management: Throttling and Feedback Loops — The system mandates a distinction between aggressive scaling and the "Icebreaker Strategy." The Icebreaker requires starting with 1/4 size to "test the water," preventing an immediate hit to the Daily Max Loss. From a Performance Psychology perspective, this manages the Positive Feedback Loop (Accuracy → Confidence → Sizing). Conversely, a failure to manage the "Icebreaker" phase leads to the Negative Feedback Loop (Loss → Emotion → Revenge Trading), which triggers the "Downward Spiral."

The Dependency on Market Sentiment — The System Mandates that success is tethered to market sentiment. In "Hot" cycles, the "Hot Potato" strategy works because buying pressure absorbs B-quality flaws. In "Cold" cycles, the environment is so illiquid that even stocks meeting all five technical pillars fail. The system's "Educated Intuition" requires walking away when the "Gap Scanner" is devoid of high-quality catalysts.

Asymmetry of Time: The 4:00 AM – 10:00 AM Window — Profitability is concentrated in the 7:00 AM – 10:00 AM EST "Sweet Spot," driven by the morning news cycle. High-velocity opportunities often manifest at the 4:00 AM open, where European and early-riser liquidity create the initial "Front Side" of the day's move.

4. Important Agreements Between Sources
The following "Golden Rules" are the non-negotiable ground truths for the Warrior Framework:
- The 5 Pillars of Stock Selection (A-Quality Specification): Price $2 to $20, Relative Volume 5x minimum (ideally 100x), Fresh high-impact breaking news catalyst, Float under 20 million shares (ideally <5M), Percentage Gain up at least 25% for A-Quality small account consideration.
- The "Front Side of the Move": Universal agreement on trading the "stairstep" up—buying pullbacks while the MACD is positive and price is above VWAP. Avoid the "backside," where the stock breaks previous pullback lows.
- Technical Execution Layer: Reliance on VWAP, the 200-period moving average (daily resistance), and the MACD. High-velocity execution utilizes the 10-second chart to identify micro-pullbacks invisible on the 1-minute time frame.

5. Important Differences or Gaps
Systemic execution must adapt to specific structural and physiological constraints.

Standard Margin vs. Cash Account Strategy — Standard Margin Account permits up to 6x leverage and unlimited day trades, facilitating aggressive scaling. Cash Account creates a psychological minefield known as the "One Bullet" constraint. Because cash takes T+1 to settle, a trader is forced out of "Flow State," constantly calculating remaining buying power and feeling the pressure to make the single shot count.

Environmental & Physiological Variables — Office vs. Van: While Starlink provides mobile flexibility, the Senior Architect prioritizes a fixed office with fiber-optic reliability. Travel trading necessitates a 5G backup to mitigate satellite latency. Physiological Stress (The Dramamine Incident): Trading under physiological duress slows cognitive processing and affects speech. The system mandates "pumping the brakes" during such events. Gaps: The sources are largely silent on long-term tax implications (outside of the Roth IRA advantage) and deep fundamental drug analysis.

6. Unique Insights by Source
- The HFT "Jack Knife" Mechanism: A Liquidity Trap triggered by the convergence of market orders, stop orders, and HFT algorithms. These violent rejections are designed to "take money out of your pocket" by hitting stops before the move continues.
- Rituals as Emotional Anchors: The "Lucky Elephant" is not mere superstition; it is a psychological tool for Emotional Equilibrium. Rituals anchor confidence during "Cold" cycles to prevent the downward spiral.
- The Bubble "Hot Potato": During the final 12 months of an asset bubble (AI/Crypto), price appreciation is parabolic. The strategy is to ride the momentum while remaining the first to exit.
- Holiday Selectivity: Post-holiday sessions require "Cold Market" expectations—focusing on "Base Hits" rather than "Home Runs."

7. The Momentum Mastery System: Technical Manual
Phase I: The Pre-Trade Checklist — Internal: Did I sleep well? Am I emotionally centered? External: How was the market yesterday? Is there FOMO? Are there 40%+ gappers on the scanners?
Phase II: The Icebreaker Strategy (Margin of Safety) — 1) Initiate with 1/4 position size. 2) Goal: Secure a $1,000 "Cushion". 3) Once cushion is established, it acts as Margin of Safety, permitting scaling into full size (up to 20,000 shares). 4) If the first three trades are losers, the system mandates a "Stop Trade" for the day.
Phase III: Technical Execution (The Trigger) — Indicator Baseline: Price > VWAP; MACD positive. Entry Trigger: Focus on the Micro Pullback or ABCD pattern. Execution Layer: Monitor the 10-second chart. Buy the "first candle to make a new high" after a pullback. Do not wait for candle closes. The Squeeze: Target breakouts through whole and half-dollar levels where "sellers on the ask" are being absorbed.
Phase IV: The Exit Strategy — Base Hits: Prioritize locking in 18–25 cents per share. The 50% Profit Giveback Rule: If the daily goal is reached and then 50% is surrendered, the session is terminated immediately to mitigate "Emotional Hijack."

8. Practical Takeaways / Action Steps
1. Metric Tracking: Utilize TraderView to audit accuracy and profit-to-loss ratios. You cannot optimize a system you do not measure.
2. Simulation First: No real-money deployment is permitted without an Audited Proof of Concept in a simulator. Traders must graduate through the Alpha (active experience) and Beta (proof of concept) phases.
3. Broker Matching: Match the platform to the account size. Robinhood/Webull for small cash accounts; Interactive Brokers for high-volume margin scaling.
4. Discipline Over Strategy: Acknowledge that most failures are "System Faults" (breaking rules, revenge trading) rather than "Software Faults" (the strategy itself).

9. Final Integrated Summary
The Warrior Framework is a "career of statistics" fueled by the consistent exploitation of high-probability imbalances. Success is defined by $15.8 million in audited profits generated by staying in the "Sweet Spot" and maintaining the discipline to walk away on "No Trade Days." By utilizing the Icebreaker Strategy to test market sentiment, the trader ensures their longevity in a volatile profession.

10. What the Sources Collectively Teach
Professional trading is reactive, not predictive. It is the art of identifying a surge in demand (News/Volume) meeting a finite supply (Low Float/Reverse Splits) and capturing a slice of the resulting price action. The ultimate mandate is to "Survive till you Thrive." The goal of every session is to protect capital and confidence so that when the next "Hot" cycle arrives, you possess the resources and mental fortitude to capitalize on it fully.`,

    m4: `The Architecture of Momentum: A Synthesized Framework for High-Volatility Trading and Risk Mitigation

1. Overview of the Topic
In the high-stakes arena of small-cap equities, momentum trading is not a game of intuition; it is a "Performance Sport of Statistics." This specialized niche relies on extreme volatility and structural supply/demand imbalances, typically triggered by news-driven "shocks." For the retail trader, the transition from speculative gambling to professional-grade execution is entirely dependent on moving away from "gut feelings" toward a rigorous, data-driven methodology. Success in this field requires the radical acceptance of market data and the discipline to identify repeatable patterns while ruthlessly mitigating the inherent risks of "Jack Knife" volatility.

2. Source Correlation Summary
The following matrix synthesizes high-level strategic themes across diverse market conditions—ranging from "Hot" $100,000+ days to "Cold" holiday sessions—to validate the robustness of this unified trading philosophy.

Strategy Correlation Matrix:
- The Five Pillars of Selection: Shared across all sources. Core fundamental filters. Tickers: APVO, LGHL, NIVF.
- Icebreaker Positioning: Shared across all sources. Risk mitigation/Testing temperature. Tickers: RELI, LSE, BDRX.
- $1,000 Profit Cushion Rule: Shared across all sources. Scaling trigger for full size. Tickers: APVO, SOAR.
- Mobile Command Center: Unique context. Travel/Remote Performance.
- 10-Second Chart Execution: Shared across all sources. Required for high-speed timing. Tickers: SPB, APVO.
- "One Bullet" Discipline: Unique context. Small Account Challenges.
- Theme Rotation Analysis: Shared across all sources. Shifting from Crypto to Biotech. Tickers: LGHL, TH, AMCI.

The "So What?" Layer: Consistency across these sources proves that the strategy is not a "one-hit wonder." Whether the trader is navigating a Singapore-based crypto runner or a US-based biotech clinical trial, the mechanics of entry, risk, and scaling remain identical. This stability is what allows a professional to survive the "downward spiral" of cold markets and thrive during exponential hot cycles.

3. The Five Pillars of Stock Selection
The foundation of high-volatility trading rests on five non-negotiable criteria. When these pillars align, they create a massive supply/demand imbalance that dictates the competitive landscape.
1. Price (2-20): The retail "sweet spot" that ensures maximum accessibility and liquidity.
2. Relative Volume (5x Minimum): A definitive indicator that the stock has transitioned from obscurity to a primary market focal point.
3. Catalyst: Breaking news (e.g., Clinical trial remission rates or Treasury acquisitions) provides the fundamental "engine" for momentum.
4. Float (Supply Constraints): Ideally <5M to 10M shares. Low float is the direct cause of "Jack Knife" volatility; when demand surges, the lack of available shares forces the price to "skip" levels.
5. Percentage Gain (10%-25%): A verified signal that the momentum is real and the "Front Side of the Move" has begun.

The "So What?" Layer: This framework identifies an "imbalance." High demand (News + Volume) hitting low supply (Low Float) creates a vacuum that only a rapid price increase can fill. Your goal as a strategist is to participate in this vacuum before the "Backside of the Move" begins.

4. The "Icebreaker" and Risk Management
The greatest threat to a trader's longevity is "Emotional Hijacking." To counter this, we utilize the "Icebreaker Strategy" to test the market's temperature without exposing the "Emotional Center" to catastrophic damage.

The Golden Rules of Risk Performance:
- The 1/4 Size Starter Rule: Begin the session with 25% of your full position (e.g., 5,000 shares instead of 20,000).
- The "$1,000 Cushion" Mandate: You are forbidden from scaling to full size until you have secured a $1,000 profit cushion. This ensures you are trading with the "market's money" before taking maximum risk.
- Three Losses and Walk Away: If you suffer three consecutive losses, your "fuse" has shortened. You must walk away to prevent the "Downward Spiral," where losses get increasingly larger as you desperately chase "break-even" status.
- 50% Profit Give-Back Rule: If you hit your daily goal (e.g., $5,000) but then lose 50% of those gains, the session is over. Preservation of capital is a win.

The "So What?" Layer: A performance coach views rules as protection against the trader's own biology. By limiting size on the first trade, you avoid the "stubbornness" that leads to revenge trading. If the first trade is a loser, being down $800 is a "paper cut"; being down $5,000 on a full-sized error is a "psychological compound fracture."

5. Market Sentiment and Cycle Adaptation
Longevity in trading is defined by the ability to "trade the market you have, not the market you want."
- Hot Markets (The Aggressive Posture): In cycles like the APVO/LGHL $105,000 session, accuracy is high. You leverage the Positive Feedback Loop: Accuracy -> Cushion -> Size -> Wealth.
- Cold Markets (The Defensive Posture): During holiday sessions or periods where catalysts are "overplayed" (e.g., the fading "Crypto Treasury Catalyst"), the strategist shifts to "Theme Rotation" (e.g., moving back to Biotech Clinical Trials).
- The Gap: A $5,000 "base hit" in a cold market is statistically superior to a $100,000 day if the latter required reckless gambling. Forcing trades in a slow cycle is the primary cause of trader bankruptcy.

6. Environmental Discipline: The Mobile Command Center
Professionalism extends beyond the chart. The "Mobile Command Center"—a Sprinter van equipped with Starlink satellite and 5G hotspot redundancy—is a testament to the necessity of technical reliability.

The Internal Readiness Checklist:
- Sleep & Nutrition: Poor sleep leads to "shorter fuses" and impulsive entries.
- Emotional Centeredness: Identifying external stressors (e.g., personal frustrations) is a risk-mitigation strategy.
- Technical Redundancy: Starlink + 5G ensures you never suffer "slippage" or "price-improvement loss" due to a dropped connection during a high-speed move.

7. Technical Execution: The Micro Pullback Guide
In high-speed "Jack Knife" scenarios—exemplified by SPB's 400% squeeze and subsequent 90% collapse—standard 1-minute charts are too slow. A 10-second chart and Level 2 depth are non-negotiable for timing.

Step-by-Step Micro Pullback Strategy:
1. Identify the Spike: Stock must be on the "Front Side" on the 10-second chart.
2. The Pause: Wait for the first candle to close lower than the previous candle's high.
3. The Entry: Buy the exact moment the first candle makes a new high relative to the previous candle's high.
4. The Risk: Set a hard stop at the low of the pullback candle.
5. The "Jack Knife" Warning: Be aware that "Jack Knives" are caused by a "combination of market orders, stop orders, and HFT algorithms" designed to take money from the trader. Once a stock shows this behavior, it is no longer safe for high-size trades.

The "So What?" Layer: Timing must be surgical. Using 10-second charts allows you to "pay yourself" when you have profit, rather than watching a $2 squeeze evaporate into a $2 loss because a 1-minute candle hadn't closed yet.

8. Navigating the Small Account: The "One Bullet" Discipline
For traders with limited capital (the $2,000 range), buying power is a psychological constraint. This is the "One Bullet/One Hunt" approach.
1. Cash Account Utilization: Bypass the PDT rule to trade daily, provided funds settle.
2. The "One Trade Per Day" Rule: With limited buying power, you cannot afford to "spray and pray." You must save your one bullet for the A+ Pillar-compliant setup.
3. The "One Share" Apprenticeship: New traders should trade with one share to gain real-market experience and "price improvement" data without financial ruin.
4. Broker-Side Limits: Hard-code a maximum position size (e.g., 1,000 shares) in your broker settings to prevent an impulsive "all-in" mistake during a moment of FOMO.

9. Final Integrated Summary
The "Architecture of Momentum" is a holistic system where technical indicators are secondary to risk protocols. The "Secret" is the Positive Feedback Loop: Accuracy (Stock Selection) creates the Cushion ($1,000 profit), which justifies the Size (scaling to 20k shares), resulting in the Profit that builds long-term wealth.

10. The Big-Picture Lesson: Surviving Until You Thrive
Collectively, the data proves that trading is not about "never losing." The ground-truth metrics are clear: Average Winner: 18 cents per share. Average Loser: 14 cents per share. Success is found in these 4 cents of edge. By using the Icebreaker strategy to protect your emotional center and the Five Pillars to ensure accuracy, you minimize drawdowns during "Cold" cycles. This discipline ensures that your account—and your mind—are ready to capitalize when the next 400% squeeze presents itself. You don't need to be a genius; you just need to be a disciplined statistician who refuses to enter the "Downward Spiral."`,

    m5: `Comprehensive Synthesis of Momentum Trading Frameworks and Small Account Growth Strategies

1. Overview of the Topic
In the professional day trading arena, the line between failure and longevity is drawn at the transition from gambling to statistical probability. Trading is not a game of intuition; it is a performance sport rooted in data-driven consistency. The primary objective is to transform market volatility into a structured process, moving from the "hope" of a beginner to the "verified accuracy" of a strategist who has turned an initial $583 account into over $15.8 million—and recently $20 million—in audited profits.

This report establishes a definitive framework by synthesizing technical analysis, the "Icebreaker" risk management technique, and the specific architectural requirements for scaling small accounts. By bridging the gap between raw market data and psychological resilience, we move beyond "finding stocks" to "executing a process."

2. Source Correlation Summary
Reconciling diverse market sessions and educational directives is vital for identifying the "sweet spots" of profitability within volatile cycles. Success is found by mapping patterns across different seasons, such as the "August Slowness" or the year-end "Q4 Rally."

Key Source References:
- Source 1 (Strategy Recap): APVO/LSC trades; Inverted Head and Shoulders mechanics.
- Source 2 (Risk Disclosure): Fundamental requirements for risk management and practice.
- Source 3 (Market Planning): Weekend watch list preparation and weekly game plans.
- Source 4 (Infrastructure): Mobile trading (Sprinter van/Starlink/5G) and August seasonality.
- Source 5 (Sentiment Analysis): Impact of Fed comments; the "Crypto Treasury" catalyst lifecycle.
- Source 6 (Performance Metrics): Internal health checklists; Accuracy vs. Profit ratios; P&L mining.
- Source 7 (Risk Management): The Icebreaker Strategy; 1/4 sizing rules; the "Downward Spiral."
- Source 8 (Historical Data): Comparing 2021 "Home Run" markets to 2024/25 "Accuracy" markets.
- Source 9 (Hot Streaks): Maintaining 76-day winning streaks; A-Quality vs. B-Quality.
- Source 10 (Stopping Rules): 50% Give-Back rule; the "3 Consecutive Losses" mandate.
- Source 11 (Selection Pillars): The Five Pillars of Stock Selection; news vs. volume correlation.
- Source 12 (Small Account Growth): Robinhood/Webull cash accounts; PDT rule changes ($2k proposal).
- Source 13 (Execution Discipline): QNRX trade; VWAP rejection signals; avoiding "grinders."
- Source 14 (Pre-Market Analysis): MCVT watch; 4:00 AM session limitations; retail wave mechanics.
- Source 15 (Market Awareness): "No Trade Day" logic; identifying low-conviction spreads.
- Source 16 (Holiday Strategy): AMCI continuation; "Base hit" mentality during low-volume cycles.

The "So What?": These sources collectively shift the professional narrative away from ticker-chasing toward process-optimization. Profitability is a feedback loop: accuracy builds self-confidence, which allows for increased position sizing, leading to scaled profits.

3. Key Themes: The Five Pillars of Stock Selection
Capital erosion is almost always the result of overtrading "B-Quality" or "C-Quality" setups. Professionalism requires the discipline to only trade when the Five Pillars align:
- Price Range: 2-20 USD. Balances retail accessibility with meaningful volatility.
- Relative Volume: Minimum 5x average. Volume is the fuel for momentum.
- Catalyst/News: The "Why." Biotech clinical trials are "tried-and-true" compared to overplayed themes.
- Percentage Gain: Minimum 10-25% "gappers."
- Float/Supply: Ideally <10M shares. Understanding the 10x Supply/Demand Ratio: A 1M share float paired with 10M shares of volume creates a massive imbalance that can trigger a 1,000% move.

4. Technical Execution and Pattern Recognition
Technical analysis is the language used to mitigate entry risk.
- The Micro Pullback: The cornerstone of momentum. The entry is the "first candle to make a new high" on a 10-second or 1-minute chart. This was the engine behind the APVO move from $6 to $9.
- The ABCD Pattern: Pivot-break mechanics. On LSC, a pre-market pivot at $10.20 and high at $10.50 provided the "C-break" entry for a squeeze to $11.20.
- Trend Reversals (Cup and Handle / Inverted Head and Shoulders): LSC Example—After an initial $5,000 loss, the stock formed an Inverted Head and Shoulders near VWAP. Re-entry at the break-over VWAP transformed a red morning into a $15,000 profit. RELI Example—Utilized a Cup and Handle formation to recover losses.
- Warning Signals: Recognize "Jackknife" candles (sudden, violent flushes) and "Topping Tails" (long upper wicks). These indicate that high-frequency algorithms are "taking money out of your pocket."

5. Strategic Risk Management: The Icebreaker Technique
The "Icebreaker" is a market-testing tool designed to protect emotional capital and prevent the "downward spiral" of revenge trading.
- Position Sizing: Begin with 1/4 size (e.g., 5,000 shares if your max is 20,000).
- The Profit Cushion Rule: Scale to full size only after establishing a $1,000 profit cushion.
- The "Daily Max Loss" Rule: A hard stop. If reached, you walk away.
- The "50% Give-Back" Rule: Once you cross your daily goal, stop if you forfeit half of those gains.
- The "3 Consecutive Losses" Rule: If three "A-Quality" setups fail in a row, the market is "Cold," and the trader must shut down.

6. Important Gaps: Market Sentiment and Seasonality
Situational awareness differentiates a trader from a gambler.
- Catalyst Fatigue: The "Crypto Treasury" catalyst became overplayed, leading to "broken trust" and failed breakouts. In contrast, "Tried-and-True" Biotech clinical results remain a durable edge.
- Seasonality: August often sees a disconnect between the S&P 500 and small caps. This is the time for the "Lawn Mower" Mindset: the engine might be smoking and running rough, but as long as it's turning over (breaking even), you are surviving until the market heats up.

7. Small Account Architecture: Cash Accounts and the PDT Rule
Small accounts (<$25k) operate under the "One Bullet/One Hunt" psychology.
- Cash vs. Margin: Cash accounts avoid the Pattern Day Trader (PDT) rule but are limited by settlement times. FINRA has proposed a rule change to reduce the PDT requirement to just $2,000.
- Price Improvement: In commission-free brokers like Robinhood or Webull, "Price Improvement" (getting filled at $3.695 on a $3.70 ask) is a hidden edge. Over 3,000 trades a year, these half-cents aggregate into significant account growth.
- Discipline: The "One Trade a Day" philosophy is the best way to transition from a simulator to real money.

8. Psychological Resilience and Performance Centering
Execution is a function of the internal state.
- Emotional Centering: A "short fuse" can destroy a month of work. External stressors linger and cause stubbornness in trades 24 hours later.
- Rituals vs. Statistics: While traders may wear "Double Elephant" or "Lucky Cactus" shirts for "Double Luck," the professional knows that these are merely psychological anchors. The real luck is found in the TraderVue data that shows you make more money before 11:00 AM than any other time.

9. Practical Takeaways and Action Steps
Pre-Market: Internal Health Check (Sleep, Centering). Scanner Filter: Leading gainers >10% with a fresh "Why." Identify the "Sweet Spot" (Price/Float/Volume).
Execution: Break the Ice with 1/4 size to start. Scale: Add only when the trade is "working" and moves toward the high of day. Avoid the Backside: Once a stock makes a new low relative to its last pullback, it is on the "backside." Stop trading it.
Post-Market: Data Tracking: Log every trade to identify your specific profit windows. Accuracy Review: If accuracy drops below 60%, return to "A-Quality" only.

10. Final Integrated Summary: The Marathon Mindset
Success in day trading is the result of statistical consistency, radical acceptance of market conditions, and the courage to walk away. Profitability is not about the "home run"; it is a marathon where "Less is More." By adhering to the Five Pillars, the Icebreaker Strategy, and a rigorous internal checklist, a trader transforms market volatility into a structured path toward financial independence. Accuracy is the foundation; the rest is simply a matter of scale. Your career depends not on how much you make on your best day, but on how little you lose on your worst. Keep the engine running—survive till you thrive.`,

    m6: `Comprehensive Synthesis of Momentum Trading Methodologies and Risk Management Frameworks

1. Overview of Momentum Trading and Market Dynamics
Professionalism in the proprietary trading arena is defined by the transition from speculative gambling to the systematic exploitation of market inefficiencies. Momentum trading is not a search for "value"; it is the strategic identification of environments where volatility—the primary engine for profit—is surging. As demonstrated by Ross Cameron's audited performance of turning $600 into over $12.5 million, success is predicated on a structured approach to speculative small-cap equities.

In this framework, market participation is a function of "hot" and "cold" cycles. "Hot" market cycles, characterized by high liquidity and intense FOMO, provide the scalability required to generate six-figure daily profits. Scalability is the institutional reward for surviving "cold" cycles through capital preservation. The "sweet spot" for execution is identified at the intersection of a leading gainer, a powerful news catalyst, and a clean technical micro-pullback.

2. Source Correlation and Methodology Summary
Developing a universal trading edge necessitates reconciling various market sessions and account constraints. Whether operating under the "One Bullet" mentality of a restricted small account or the aggressive scaling of a large-scale Roth IRA, the underlying mechanics of supply and demand remain constant.

Focus Areas: Small Account Challenges (Cash settlement, PDT rule constraints, "One Shot" hunting — Conservative posture), Large Account Scaling (High-volume rotation, aggressive sizing, fiscal efficiency via Roth IRA — Aggressive posture), Technical Analysis (Micro-pullbacks, ABCD setups, VWAP/MACD alignment — Disciplined posture), Psychological Discipline (Managing the "Short Fuse," emotional centering, Alpha/Beta phases — Resilient posture).

The synergy is best illustrated by the "Icebreaker" strategy. This tactical maneuver serves as the bridge for small accounts to enter high-volatility environments without incurring catastrophic slippage or emotional compromise.

3. Key Themes: The Architecture of a High-Probability Trade
We do not trade stocks; we trade imbalances. High-probability trades occur when a news catalyst triggers a surge in demand that the finite supply (float) cannot absorb, forcing a parabolic "squeeze."

The Five Pillars of Stock Selection: Price Range 2-20, Relative Volume 5x+ above 60-day average, Catalyst/News (clinical trials, earnings beats, sector themes), Float preference <10M-20M shares (lower is always better), Percentage Gain 10%+ minimum.

4. Important Agreements: Consensus on Risk and Execution
The Icebreaker Strategy: Utilizing 1/4 size (starter position) to "test the water." Data-Driven Decisions: 222 green days vs. only 8 red days (including a 76-day hot streak) achieved through accuracy-first trading. Technical Precision: Universal reliance on VWAP, MACD, and Level 2. A professional trader identifies the "Wall"—such as a 20,000-share seller at $5.80—and uses its breakage as a high-conviction entry signal.

5. Important Differences or Gaps
The "Aggressive Scaling" producing a $138,866.11 day in a tax-free Roth IRA is only possible during high-liquidity "hot" markets. In contrast, "cold" or "choppy" environments necessitate a "No Trade" defensive posture. The "Cash Account" is burdened by the PDT rule and T+1 settlement, forcing a "One Shot" hunting mentality.

6. Unique Insights by Source
- Jack Knife Candles: HFT traps where a candle instantly rejects a breakout ($9.00 to $7.50), designed by algorithms to liquidate market orders.
- The 3 Core Components: Profitability is a three-legged stool: Accuracy, P/L Ratio, and Consistency.
- The Short Fuse: External stressors shorten a trader's fuse. When short, a trader becomes stubborn, refuses to cut losses, and enters a downward spiral.
- The Macro-Overlay: Awareness of institutional traps (HC Wainwright "Buy" ratings to facilitate secondary offerings). Track Jerome Powell's interest rate comments and seasonal "August/October" lulls.

7. The Combined Best Explanation: The Momentum Master-System
Execution Workflow: 1) Verification: Confirm the stock meets the Five Pillars. 2) The Entry: Execute an "Icebreaker" position on the "first candle to make a new high." 3) Confirmation: Monitor Level 2 for breakage of "hidden sellers" or "walls." 4) Scaling: Add full size only after a micro-pullback confirms support. 5) The Exit: Sell into strength at whole-dollar resistance or upon a negative MACD crossover.

The "So What?": Wait for the micro-pullback to ensure the risk-to-reward ratio allows for doubling the potential gain relative to the risk.

8. Practical Takeaways: Trader's Daily Protocol
Pre-Market: Set scanners for Price (2-20), Relative Volume (5x+), Float (<20M). Verify catalyst. Check Macro-Overlay (FOMC/Powell, secondary offering risks). Internal Check (sleep, emotional centering).
Execution: Icebreaker Entry 25% size. Technical Alignment (VWAP holding, MACD opening). Level 2 Watch. Hard Stop at low of previous pullback.
Post-Market: Import trades into TraderView. Analyze "Average Winner vs. Average Loser." Identify Alpha and Beta metrics.

9. Final Integrated Summary
Trading is a "performance sport of numbers." Profitability is not luck; it is the result of minimizing drawdowns in cold cycles and maximizing "hot" cycles. Discipline—not genius—is the barrier to entry.

10. The Big Picture Lesson
The market is a constant ebb and flow of sentiment where the only controllable variables are your risk per trade, your position size, and your emotional centeredness. Survive until you Thrive. Success is often like an old lawn mower: the engine might be smoking and running rough (the "Beta" phase), but if it's running, you are in the game. Stay disciplined, stay liquid, and remain in the market until the next 300% squeeze arrives.`,

    m7: `Comprehensive Synthesis of Momentum Trading Methodologies and Risk Management Frameworks

1. Overview of Momentum Day Trading Strategy
Momentum day trading, when executed within a rigorous analytical framework, is a volatility-based pursuit of "base hits"—consistent, high-probability gains—rather than a speculative gamble. Strategic imperatives mandate that a trader focus exclusively on the "front side" of a move, where an extreme imbalance between supply and demand drives rapid price appreciation. This methodology is not merely a theory but a proven system for capital appreciation, as evidenced by the transition of a $583 initial stake into over $15.8 million in total trading profits.

The core objective of the professional strategist is to wait for the market to provide "A-Quality" opportunities. By treating trading as a game of statistics, the practitioner eliminates the need for luck. This document synthesizes the data-driven framework governing stock selection, the "Icebreaker" risk management protocol, and the technical execution required to sustain long-term profitability.

2. Source Correlation Summary: Themes and Reliability
Risk Management: Shared across all sources. The "Icebreaker" technique and "Rules of Disengagement" are foundational constants. Essential for capital preservation during "cold" market cycles.
Stock Selection: Shared across all sources. The "5 Pillars" act as the primary noise filter. Verified consistency across 2021-2025 data sets.
Account Constraints: Unique context. Robinhood/Webull $2,000 challenge constraints shift focus to "one trade per day" mandate due to T+1 settlement.
Technical Execution: Unique context. High-resolution precision — identification on the 1-minute chart; execution on the 10-second chart.
Market Evolution: 2025 data shows a shift toward higher efficiency: similar profits with half the trades of 2024.

Strategic refinement involves adapting the framework to specific constraints. While the standard price range is 2-20, capital-constrained accounts must tighten to 1.50-6 to maintain sufficient buying power.

3. The Five Pillars of Stock Selection
Price Action: 2-20 range (1.50-6 for small accounts). Relative Volume: Minimum 5x average. The Catalyst: Biotech clinical trials are "tried-and-true" compared to overplayed themes. Percentage Gain: Minimum 10-25% "gappers." Float/Supply: Ideally <10M shares. The 10x Supply/Demand Ratio: A 1M share float paired with 10M shares of volume creates a massive imbalance triggering 1,000% moves.

4. Technical Execution and Pattern Recognition
The Micro Pullback: Cornerstone of momentum. Entry is the "first candle to make a new high" on a 10-second or 1-minute chart (engine behind APVO move from $6 to $9). The ABCD Pattern: Pivot-break mechanics. Trend Reversals (Cup and Handle / Inverted Head and Shoulders). Warning Signals: "Jackknife" candles and "Topping Tails" indicate HFT algorithms "taking money out of your pocket."

5. Strategic Risk Management: The Icebreaker Technique
Position Sizing: Begin with 1/4 size. The Profit Cushion Rule: Scale to full size only after $1,000 profit cushion. The "Daily Max Loss" Rule: Hard stop, walk away. The "50% Give-Back" Rule: Stop if you forfeit half of daily gains. The "3 Consecutive Losses" Rule: If three A-Quality setups fail in a row, the market is "Cold" — shut down.

6. Important Gaps: Market Sentiment and Seasonality
Catalyst Fatigue: The "Crypto Treasury" catalyst became overplayed, leading to "broken trust" and failed breakouts. "Tried-and-True" Biotech clinical results remain a durable edge. Seasonality: August often sees a disconnect between S&P 500 and small caps. This is the time for the "Lawn Mower" Mindset: the engine might be smoking, but as long as it's turning over (breaking even), you are surviving until the market heats up.

7. Small Account Architecture: Cash Accounts and the PDT Rule
Cash vs. Margin: Cash accounts avoid PDT but limited by settlement times. FINRA has proposed reducing PDT requirement to $2,000. Price Improvement: In commission-free brokers, "Price Improvement" (getting filled at $3.695 on a $3.70 ask) is a hidden edge. Over 3,000 trades a year, these half-cents aggregate significantly. Discipline: "One Trade a Day" philosophy is the best transition from simulator to real money.

8. Psychological Resilience and Performance Centering
Emotional Centering: A "short fuse" can destroy a month of work. External stressors linger and cause stubbornness 24 hours later. Rituals vs. Statistics: While traders may wear "Double Elephant" or "Lucky Cactus" shirts, the professional knows real luck is found in TraderVue data showing you make more money before 11:00 AM.

9. Practical Takeaways
Pre-Market: Internal Health Check. Scanner Filter: Leading gainers >10% with a fresh "Why." Identify the "Sweet Spot."
Execution: Break the Ice with 1/4 size. Scale only when working and moving toward high of day. Avoid the Backside.
Post-Market: Log every trade. If accuracy drops below 60%, return to "A-Quality" only.

10. Final Integrated Summary: The Marathon Mindset
Profitability is not about the "home run"; it is a marathon where "Less is More." Accuracy is the foundation; the rest is simply a matter of scale. Your career depends not on how much you make on your best day, but on how little you lose on your worst.`,

    m8: `Unified Professional Trading Framework: Integrating Momentum Execution with Quantitative Strategy Validation

1. Overview of the Trading Methodology
Professional trading is a high-stakes discipline requiring the synchronization of discretionary momentum with structured quantitative validation. Success is not found in a "silver bullet" indicator but in the calculated balance of "Pillar-based" stock selection and regime-aware execution. This methodology posits that the market is a series of repeatable environments where risk must be modeled before profit is pursued.

The scope of this framework synthesizes the live momentum techniques of Ross Cameron—specifically his focus on low-float catalysts—with the systematic options backtesting architecture of the Module 8 framework. This report serves as a blueprint for the "Master Operating Procedure," merging real-time tape reading with the probabilistic modeling of Markov Regimes and Black-Scholes pricing.

2. Source Correlation Summary
The "5 Pillars of Stock Selection" (Price, Relative Volume, News Catalyst, Percentage Gain, and Low Float) function as the momentum engine, identifying the "fuel" for the market. "Markov Regime Detection" provides the "current," categorizing the environment as Bull, Neutral, or Bear. For the quantitative trader, the pillars provide the specific instrument, while the regime determines the strategy's expectancy.

Methodological Alignment: Market Assessment (Pre-market checklist vs. Markov Regime Detection +/- 5% Momentum). Strategy Validation (Icebreaker quarter-size starters vs. Strategy Backtester simulated price series). Risk Control (1% Account Risk & Max Daily Loss vs. Max Drawdown & S.E.T. Rule Framework). Trade Execution (Micro Pullbacks & ABCD Patterns via tape reading vs. Black-Scholes Greeks: Delta, Theta, Vega).

The "Icebreaker Strategy" serves as a real-time validation tool, much like the "Strategy Backtester" — both prioritize capital preservation over aggressive gains.

3. Key Themes Found Across Sources
The Primacy of Risk Management: Never risk more than 1% of total equity on a single trade, aligning with the S.E.T. Rule (Strike, Entry, Target/Stop). Data-Driven Decision Making: $12.5 million in audited profits and a 76-day hot streak result from meticulous tracking — mirroring Black-Scholes pricing and Markov Chain probabilities. Psychological Resilience: A "No Trade Day" mirrors the backtester's identification of sub-optimal regimes. Volatility as Catalyst: Whether via High Relative Volume in stocks or Implied Volatility (IV) in options, the professional seeks environments where movement justifies risk.

4. Important Agreements and Synergy
Ross Cameron's benchmark of 75% accuracy with a 2:1 reward-to-risk ratio aligns with the "Expectancy Per Trade" formula. High win rates are mathematically irrelevant without positive expectancy and managed drawdowns. A profound synergy exists between the "Wheel" strategy and "Day 2 Continuation" trades — both rely on catalyst persistence.

5. Important Differences and Strategy Gaps
The Execution Window: Momentum is a "sprint" (7:00 AM - 10:00 AM EST). Options trading is a "marathon" focused on Days to Expiration. Instrument Specifics: "Jack Knife" candles are the antithesis of "smooth" Black-Scholes pricing. The Liquidity Paradox: The Backtester uses "synthetic price series" that smooth over live reality (e.g., FORD: 11.89 bid by 12.49 ask = 5% loss on entry).

6. Unique Insights
Ross Cameron's Psychological Frameworks: The Downward Spiral, Indifferent Trading (outcome of any single trade doesn't disturb center), Lucky Elephant/Bumblebee Mindset.
Module 8's Technical Frameworks: Markov Regime Thresholds (>+5% Bull, <-5% Bear), Transition Probability (75% stay in current regime vs. 25% transition).

7. Combined Best Explanation: Professional Trading Workflow
1) Regime Assessment: Markov-style momentum checks. >+5% Aggressive, +/-5% Neutral, <-5% Defensive.
2) Stock Selection: Apply Five Pillars with breaking news catalysts.
3) Strategy Validation: Run Backtest for historical expectancy or Icebreaker to confirm live tape temperature.
4) S.E.T. Execution: Define Strike (entry price), Entry timing (micro-pullback), Target/Stop (Delta/Gamma or Pivot levels).
5) Post-Trade Audit: Import to dashboard, monitor 2:1 winner-to-loser ratio.

8. Practical Takeaways
The 1% Rule: Prohibited from risking more than 1% of total account equity per trade. The Quarter-Size Start: Icebreaker on first two trades to validate current volatility. The Simulation Mandate: Complete 50% of Module 8 simulation exercises before committing real capital to a new strategy. The Exit Rule: Identify the "Backside of the Move" or "50% Profit Give-back" point and walk away immediately.

9. Final Integrated Summary
The convergence of momentum and math teaches that trading is not a game of prediction, but a game of disciplined probability management. Whether navigating Jack Knife candles of a low-float squeeze or managing Theta decay of an Iron Condor, adopt a "Risk-First" architecture. Profitability is the statistical outcome of waiting for A-Quality opportunities with extreme patience and protecting capital with clinical precision. By integrating real-time intuition with quantitative modeling, you become a strategist — the only sustainable path to becoming a "Green Trader."`,

    m9: `Strategic Synthesis of Momentum Day Trading: Low-Float Volatility and Risk Systems

1. Overview of Momentum Trading Dynamics
Momentum trading is a professional discipline requiring the strategic exploitation of market imbalances. This is a shift from "buy and hold" to a "buy and move" mandate. The goal is to capture high-velocity price expansion fueled by sudden influxes of market participants. This system is grounded in two non-negotiable pillars: volatility and liquidity. Volatility provides the range necessary for institutional-grade returns, while liquidity ensures entry and exit without catastrophic slippage.

The "Sweet Spot" exists at the intersection of the market's leading percentage gainers and high-volume technical pullbacks. We do not gamble on potential; we execute on proven strength. This synthesis has been validated by an audited track record reaching $15.5M-$15.8M in career profits, proving that momentum is a repeatable business process.

2. Source Correlation Summary
Predictive Phase: Watch List analytics serve as intelligence gathering — scanning for catalysts, analyzing float structures, establishing strategic mandate before the opening bell.
Execution and Auditing Phase: Recap and Challenge data represent "boots on the ground" reality, auditing theoretical strategy against live market constraints.

This framework scales across diverse environments, from high-leverage offshore margin accounts to US-based cash accounts restricted by the PDT rule. Whether trading in a $15M professional account or a $2,000 Robinhood challenge, the mechanics of momentum remain constant.

3. Key Themes: The Five Pillars and Strategy Frameworks
Price (2-20): Optimal range for retail participation. Relative Volume (5x+): Critical indicator of supply/demand shift. Catalyst (News): The fundamental engine (e.g., APVO's 75% remission rate news). Percentage Gain (10%+ to 25%+): Validates the move is real. Low Float (<10M-20M shares): Essential for "supply crunch."

Reverse Split mechanics further tighten supply. By reducing shares outstanding to increase price (Market Cap = Shares x Price), a company creates a low-float, high-price environment that traps short sellers during a news-driven demand surge.

Execution Frameworks: Micro Pullbacks (10-Second Entry on the "front side"), ABCD/Cup and Handle (trend continuation), Icebreaker Strategy (1/4 size starter, scale only after $1,000 profit cushion).

4. Important Agreements: Core Axioms
The Catalyst Mandate: News is the only sustainable driver of demand. The "Base Hit" Philosophy: Target 18-cent average gain per share — compounded over thousands of trades, small wins mitigate catastrophic loss. The Max Loss Rule: Stop after daily loss threshold, 50% peak gains give-back, or three consecutive losses.

5. Important Differences and Contextual Gaps
Hot Market: Aggressive strategy, trade A & B Quality, full size/max leverage, 70-80%+ accuracy. Cold Market: Defensive strategy, A-Quality only, Icebreaker/quarter size, 30-50% accuracy.

Sector and Brokerage Nuance: Distinguish between high-reliability US Biotech (APVO's 300% squeeze) and volatile Chinese/Hong Kong runners (LGHL, LSE) — international names have a "shorter fuse" with 90% drops following parabolic moves. "Commission-free" brokers use Payment for Order Flow (PFOF) — "Price Improvement" in half-cent increments is a profit-sharing mechanic on your order flow.

6. Unique Insights
The "Jack Knife" Algorithm Trap: Not a simple reversal — an HFT algorithm trap designed to hunt stop-orders and liquidate retail positions.
Infrastructure Redundancy: "Mobile Command Center" with Starlink and 5G redundancy — losing connectivity during a trade is unacceptable risk.
Market Sentiment Themes: Catalysts like "Crypto Treasury" eventually become "overplayed" — once the theme loses trust, even strong headlines fail to move price.

7. The Unified Trading Workflow
1) Intelligence (6:30 AM): Identify top gainers, validate against Five Pillars.
2) Validation: Confirm the "Front Side" move.
3) Entry (10-Second Chart): Execute Icebreaker on first candle to make new high.
4) Scaling: Add only if trade moves into immediate profit.
5) Exit: Liquidate into the "peak" before transition to "back side."

8. Practical Takeaways
Daily Pre-Trading Checklist: Internal (Sleep, emotional centering — even "Dramamine ferry incident" illustrates trading while compromised is a capital risk). External (Yesterday's leaders, S&P 500 sentiment, sector themes). Psychological (Lucky Elephant or Bumblebee sweaters as psychological anchors for "flow state").

The "One Bullet" Protocol: Under $25,000, adopt "surgical strike" mindset — one trade per day to bypass PDT, requiring extreme patience.

9. Final Integrated Summary
This framework transforms market volatility into a structured, audited business process. By prioritizing the Five Pillars and executing with 10-second chart precision, we move from speculation to statistical performance.

10. What the Sources Collectively Teach
Trading is a "Performance Sport" of statistics. Success is defined not by the stocks you trade, but by your discipline in following a repeatable system. Survival is the path to thriving. By managing the emotional "fuse" and adhering to strict risk thresholds, a trader ensures they remain capitalized to exploit the next hot cycle.`,

    m10: `The Architecture of Momentum: A Synthesized Framework for Small-Cap Day Trading

1. Overview of the Momentum Trading Ecosystem
Momentum trading in small-cap equities is the disciplined pursuit of volatility triggered by acute supply-demand imbalances. The system exploits extreme price extensions—often 100% gainers—through rigorous risk management and the harvesting of transient liquidity. This framework focuses on low-float securities (typically under 10 million shares) priced between $2.00 and $20.00 with exceptional relative volume. By targeting the "front side" of a move, the strategist captures parabolic growth driven by institutional-grade catalysts.

This introductory synthesis serves as the foundation for a cohesive master strategy, where individual trading sessions are distilled into a singular, repeatable architecture.

2. Source Correlation Summary
A robust framework requires correlating multiple trading sessions, watch lists, and educational deep-dives. Whether observing a $105,000 profit session or a disciplined "No-Trade Day," the underlying mechanics remain identical.

The "Master Workflow": 1) Scan: Real-time identification of top percentage gainers. 2) Identify Catalyst: Confirming a fundamental driver (FDA approvals, mergers, sector themes). 3) Apply "Five Pillars": Filtering through rigid selection criteria. 4) Execute via "Icebreaker": 1/4 position size to probe market receptivity. 5) Post-Trade Analysis: Mandatory auditing of performance metrics.

This workflow bridges the gap between high-frequency execution and retail account constraints, providing a scalable blueprint for professional-grade consistency.

3. Key Themes Found Across Sources
The Power of Volatility: Strategy relies on extreme price extensions — APVO's 361% surge, SPB's massive short squeeze. Without 100%+ gainers, the momentum edge evaporates.
Market Sentiment Cycles: Capital rotates through "flavors" — Biotech clinical results to "Crypto Treasuries" to Chinese IPOs/Singapore-based names (MCVT, LGCL).
The "Retail Reality": PDT rule requires $25,000 minimum for margin. Cash accounts need "one-shot-per-day" discipline.
Liquidity and "The Spread": Thin liquidity in low-float stocks where bid-ask spreads can induce immediate 5-10% drawdown upon entry.

4. Important Agreements: The "Non-Negotiables"
The Five Pillars of Stock Selection: Price 2.00-20.00, Relative Volume 5x+ (ideally 100x), Fresh breaking news catalyst, Float <10 million shares, Percentage Gain minimum 10% (25% mandated for high-probability).

The "Icebreaker Strategy" universally applied: In one session, Ross began the day 4/4 red using Icebreaker positions. Because size was throttled, he avoided emotional downward spiral and recovered to finish with $105,000 in profit.

5. Important Differences, Gaps, and Contextual Shifts
Hot vs. Cold Markets: "Hot" allows aggressive sizing into B-quality setups. "Cold or Holiday" requires "No-Trade Days" or extreme quality threshold to avoid "grinder" stocks.
Account Size Disciplines: Large accounts focus on scaling. Small accounts restricted by PDT must maintain "one-bullet" mentality.
Data Gaps: Exact entry prices often best understood via 10-second chart rather than 1-minute — a detail missing in broader recaps but essential for replicating entries.

6. Unique Insights by Source
The Jack-knife Candle: Violent, vertical rejection caused by market orders, stop-losses, and HFT algorithms designed to "take money out of your pocket." Avoid buying the "top of the spike."
Technical Redundancy: Mobile Command Center requires redundant internet (Starlink with 5G backup) for zero disruption.
Psychological Grounding: Minor physical annoyances can trigger emotional hijacking. If not centered, step away.
Regulatory Shifts: FINRA has proposed reducing PDT requirement from $25,000 to $2,000, which would radically expand retail trader participation.

7. The Combined Best Explanation: The Unified Trading Workflow
Multi-Timeframe Logic: Core setups (Micro Pullback, ABCD Pattern) may look "messy" on 1-minute chart but reveal clear "A-Quality" pivots on 15-minute timeframe or 10-second chart.
Momentum Resumption: Buy the first candle to make a new high following brief consolidation — entering at moment of momentum resumption, not chasing extended moves.
Risk Management — The 18/18 Score: Profitability governed by three core components: Accuracy, P/L Ratio, and Consistency. Professional score of 18/18 (6 points per category). The 50% Rule (walk away if giving back half of peak gains), The 3-Loss Rule (three consecutive losses means market is cold), The Cushion (Icebreaker builds profit cushion before full-size positions).

8. Practical Takeaways and Action Steps
1) Pre-Flight Checklist: Audit internal state and external market sentiment.
2) Strict Selection: Screen exclusively for Five Pillars. Reject "grinders" lacking fresh catalyst.
3) Probing Execution: Icebreaker for first 1-3 trades. Scale only when market validates "Hot" status.
4) Operational Discipline: Walk away when "window of profitability" (7:00 AM to 10:30 AM EST) closes or risk rule breached.

9. Final Integrated Summary: The Momentum Mindset
Momentum trading is a high-performance sport and a game of statistics. Success is defined not by predicting the future, but by managing losses when the market fails to behave as predicted. "Survive till you Thrive" — protecting capital during "Cold" cycles is the only way to ensure liquidity for "Hot" cycles.

10. What the Sources Collectively Teach: Three Categorical Truths
1) Identify the Cycle: The market moves in waves (Biotech, Crypto, etc.). Your primary job is recognizing the current theme and applying the corresponding risk profile.
2) Discipline Over Strategy: Even a perfect strategy fails without emotional fortitude to stop trading on red days or "no-trade" days.
3) Data-Driven Accountability: Rigorous tracking via TradeView or Excel is the only path to identifying psychological leaks and refining technical accuracy. Success is not about the home run; it is about base hits and absolute avoidance of the "strikeout" that ends a career.`,
    m11: `The Momentum Framework: A Correlated Analysis of High-Volatility Day Trading Strategies

1. Overview
In the contemporary small-cap equity market, the delta between sustainable professional performance and catastrophic capital erosion is defined by the transition from impulsive participation to a structured momentum framework. Operating within high-volatility environments requires a strategic synthesis of aggressive execution and clinical risk mitigation. This report codifies the methodologies required to navigate "hot" and "cold" market cycles, ensuring capital is deployed only when the statistical probability of success is maximized through rigorous technical and fundamental filters.

The scope of this analysis provides a high-level synthesis of professional trading methodologies, specifically the "Icebreaker" position management technique, the "Five Pillars" of technical stock selection, and the psychological architecture necessary to sustain long-term profitability in a $15.8 million audited environment. By examining the interplay between technical indicators—such as the 10-second chart, VWAP, and MACD—and fundamental catalysts, we establish a comprehensive workflow for the disciplined investor.

2. Cross-Source Themes: The Foundations of Momentum Trading
Consistency across varied market cycles is not a product of chance, but of a "universal blueprint" that remains invariant even as specific tickers fluctuate.

Risk Management as the Primary Profit Driver: Statistical analysis confirms that risk management, rather than profit-taking, is the primary driver of the equity curve. The Icebreaker technique serves as a strategic governor; traders initiate positions with "starter size" (typically 1/4 of a full position) to test market liquidity and momentum. By scaling to full size only after a profit cushion is established, the trader prevents "emotional hijacking." The imposition of a daily "max loss" limit acts as a definitive circuit breaker.

Market Sentiment and Thematic Cycles: Profitability is inextricably linked to the prevailing market "theme." A Biotech clinical trial catalyst often provides superior follow-through compared to overplayed themes. When a theme becomes saturated, even "A-Quality" setups may fail, necessitating a shift from aggressive to defensive positioning.

The Technical Language of the Market: Universal signals including Micro Pullbacks, ABCD setups, VWAP, and MACD serve as essential filters for assessing whether a trend is robust or if momentum is succumbing to exhaustion.

3. Corroborated Professional Standards
The Five Pillars of Stock Selection — an "A-Quality" trade must satisfy: Price ($2.00-$20.00, or $1.50-$6.00 for small accounts), Relative Volume (5x+ the 60-day average), Catalyst (verifiable breaking news), Low Float (under 10 million shares), Daily Gain (minimum 10%).

Setup Quality Tiering: Mathematical distinction between "A-Quality" and "B/C-Quality" setups. Trading inferior setups in "cold" markets is the leading cause of account drawdowns.

Regulatory Constraints: PDT Rule requires $25,000 for margin; cash accounts need "one shot, one kill" discipline. Proposed reduction to $2,000 would increase retail liquidity.

4. Differences and Strategic Conflicts
Trading Environment: Divergence between office and "Mobile Command Center" (Starlink/5G). Bid/Ask Spread risk in tickers like FOD can result in immediate ~5% unrealized loss upon entry.

Profit Variance: High-resonance catalyst sessions can produce $85,000; slow sessions might yield $9,000. Accuracy reaches 75-80% in "Hot" markets but drops to 30-40% during "Cold" cycles.

Account Divergence: Small Cash Account ($2,000) = high selectivity, limited bullets. Main Audited Account ($15.8M) = high-frequency scaling, 20,000-share positions.

5. Unique Insights
The "Jack Knife" Candle Warning: Violent rejection where stock drops multiple points in seconds (APVO $11.50 to $9, SPB $38 to $12). Driven by HFT algorithms designed to trigger stops.

The "Price Improvement" Factor: Commission-free brokers utilize order flow resulting in sub-penny fills significant over thousands of trades.

Secondary Offering Red Flags: S3 filings, shelf registrations, and underwriter price target adjustments as precursors to dilutive offerings.

6. The Unified Momentum Workflow
Phase I — Scanning (6:30-8:00 AM): Filter for "Leading Gainer" using Five Pillars with high relative volume and fresh catalyst.
Phase II — Evaluation (8:00-9:30 AM): Monitor 10-second chart for "Micro Pullbacks" before visible on longer timeframes.
Phase III — Execution (The Icebreaker): 1) Starter Entry at 1/4 size on MACD turn. 2) Add remaining 3/4 at HOD breakout. 3) If red, exit immediately; if green, profit becomes "cushion."
Phase IV — Exit (9:30-10:00 AM): Once stock "stairssteps down," pump the brakes. Peak profitability window closes by 10:00 AM.

7. Three Golden Rules
1) Never Scale into a Loser — averaging down is the hallmark of the amateur.
2) Respect the "Jack Knife" — violent algorithm-driven rejection means reduce size or walk away.
3) The 50% Rule — if 50% of peak daily gain is relinquished, cease trading. Preserving capital and psychological health is the only path to longevity.

8. Final Summary
The Momentum Framework ensures traders remain "right more often than wrong" while losses stay mathematically insignificant compared to winners. The path to turning any account into a high-value asset is paved with discipline and a "Survive till you Thrive" mentality — relentless base hits and rigorous capital preservation during cold cycles. Simulator practice is the non-negotiable prerequisite for live execution.`,
    m12: `Comprehensive Correlated Report: Momentum Trading Dynamics and Risk Management Frameworks

1. Overview
In the high-frequency domain of equities trading, a quantitative, data-driven approach to momentum is the primary differentiator between institutional-grade longevity and retail attrition. Market volatility acts as a dual-edged catalyst: it provides the parabolic expansion necessary for significant capital appreciation while simultaneously manifesting liquidity vacuums and systemic risks. Professional momentum trading is not an exercise in prediction, but a systematic identification of high-probability imbalances between supply and demand, executed within a verified window of statistical edge.

This report synthesizes multi-source insights from Ross Cameron, whose audited track record — turning an initial $583 into over $15.5 million — serves as the empirical foundation for this framework.

2. Cross-Source Themes: The Foundations of Momentum
The Five Pillars of Stock Selection: Price Action ($2.00-$20.00, or $1.50-$6.00 for small accounts), Relative Volume (minimum 5x, with "sensation" moves at 100x+), News Catalyst (biotech clinical results, earnings beats, sector catalysts), Float Management (<10M-20M shares, ideally <10M for squeeze effect), Percentage Gain (>10-25% intraday).

These pillars function as a professional sieve, ensuring capital is only deployed into A-quality setups with high statistical probability.

The Icebreaker Strategy: Risk management begins before a full position is taken. Starting with quarter-size (e.g., 5,000 shares for a 20,000-share max), the strategist evaluates if the market is respecting technical levels. Only after securing a profit cushion does the trader scale up, preventing "emotional hijack."

3. Cross-Source Agreements: The Consensus on Discipline
Universal Trading Truths: Daily Max Loss acts as a hard circuit breaker. The "Front Side" Rule — only trade upward trajectory (higher highs/lows); trading the "Back Side" is a primary cause of capital depletion. Data Tracking via metrics (Accuracy vs. P/L Ratio) is non-negotiable. Simulated Practice is a mandatory "dues-paying" phase before risking real capital.

Market Sentiment and Aggression: In "Hot" markets, high liquidity and FOMO allow even B-quality setups to produce 70%+ accuracy. In "Cold" markets, even A-quality setups face failure, requiring defensive postures. "Sitting on hands" during cold cycles is as productive as trading during hot ones.

4. Comparative Analysis: Differences in Strategy and Execution
Large/Margin vs. Small/Cash Accounts: Margin accounts offer unlimited trades; cash accounts face PDT rule and overnight settlement creating "one shot, one bullet" psychology. Cash traders must wait for T+1 settlement.

Catalyst Predictability — US vs. Foreign: Biotech catalysts are "tried-and-true" with predictable price action. Chinese/Hong Kong IPOs treated with high skepticism — not reviewed by US auditors, frequently exhibit "pop and drop" behavior requiring a "hot potato" exit approach.

Stock Lending Mechanics: In retail platforms like Robinhood, disabling "Stock Lending" reduces localized selling pressure during a squeeze.

5. Unique Insights and Specialized Concepts
The "Jack-Knife" Candle: Sudden violent rejection triggered by HFT algorithms programmed to hunt stop-losses at psychological levels (whole and half-dollar marks).

Mobile Command Centers: "Sprinter Van" setup (Starlink/5G) ensures institutional routine from any location during "hot" market windows.

The "Houston, We Have a Problem" Protocol: Modeled after Apollo 13 — throw all data on the table after a significant loss. Analyze hold times, accuracy, and price ranges to identify the pattern of failure rather than blaming luck.

Psychological Red Flags: Unrelated emotional residue (the "Parking Lot Incident") shortens the "trading fuse," leading to stubbornness, abandoned stops, and catastrophic revenge trading.

6. The Master Strategy: Alpha-to-Omega Execution Workflow
Golden Hour (7:00 AM - 10:00 AM EST):
1) Internal Audit — verify sleep, nutrition, emotional centering.
2) External Scan — identify leading gappers (>10% gain) with relative volume >5x and fresh catalyst.
3) The Icebreaker Entry — quarter-size to "feel" the market; full size only after $1,000 profit threshold.
4) Front-Side Focus — trade ABCD or Micro Pullback patterns on higher highs.
5) Technical Exit — identify "Back-Side" where stock fails to make higher high.
6) Profit Preservation — cease if 50% of peak gains surrendered or three consecutive large losses.

7. Actionable Takeaways
Technical Education: Internalize "Micro Pullback Strategy" and "Small Account Worksheet."
Scanner Calibration: Configure for Relative Volume (>5x) and Low Float (<10M).
Broker-Level Enforcement: Hard-code "Max Position Size" at broker level as physical barrier against emotional spiraling.
Statistical Verification: Execute minimum 100 trades in simulator to verify positive P/L ratio before committing capital.

8. Final Summary
Profitability in momentum trading is a function of accuracy, and accuracy is a function of discipline. The market rewards patient execution of A-quality setups meeting the five pillars. By utilizing the Icebreaker strategy and focusing on the front-side of moves, traders mitigate HFT jack-knife candles and emotional volatility. The objective: survive until you thrive — preserving capital during the grind so the trader is fully funded when the next 300% biotech short squeeze arrives.`,
    m13: `Comprehensive Analysis of Small-Cap Momentum Trading Strategies: A Multi-Source Correlation Report

1. Document Overview and Strategic Context
In the high-stakes environment of small-cap equity markets, momentum trading serves as a primary vehicle for rapid capital appreciation. This report synthesizes quantitative metrics, instructional modules, and live execution recaps to provide a unified strategic framework. By correlating data from seasoned professionals — including audited results showing over $12.5 million in career profits — we establish a clear path from theoretical market mechanics to high-probability execution and essential risk mitigation.

The scope focuses on the transition from static strategy to dynamic execution, analyzing how market sentiment serves as the ultimate filter for performance. This synthesis identifies recurrent themes across thousands of trades, providing foundational knowledge to navigate the "front side" of a move while avoiding the capital-destructive "back side."

2. Cross-Source Thematic Analysis
The Primacy of the Catalyst: High-velocity momentum requires a fundamental imbalance. Breaking news (Biotech clinical trials, structural "Crypto Treasury" shifts) provides the "Why." The "So What?" layer is crucial — for companies like LGHL, a crypto-focused headline transforms the entity into a holding company for digital assets, making the stock explosive but hyper-sensitive to Bitcoin price fluctuations.

Dynamic Risk Management: The Icebreaker Strategy serves as the defensive gatekeeper — 1/4 size "test" position to gauge market synchronization. Only after validation does the trader move to "Scaling" — offensive expansion into strength. In "cold" cycles, losses are throttled at the gate.

Data-Driven Discipline: Professional framework operates on 67-76% accuracy rate with targeted average gain of 18 cents per share. Quantitative rigor replaces intuition, allowing audit by price range, float, and time of day to identify the specific "sweet spot."

3. Strategic Agreements and Core Pillars
The Five Pillars: Price ($2.00-$20.00), Relative Volume (5x+ average), News Catalyst (the "Why"), Percentage Gain (10-25%+), Float (ideally <10M shares).

Rules for Walking Away: The 50% Profit Give-Back Rule (terminate session if 50% of realized gains lost), The Three-Loss Frustration Rule (three consecutive losses signal lack of synchronization), Hard Daily Max Loss Limit (pre-set dollar figure requiring immediate exit).

4. Strategic Differences and Situational Adaptations
Account Types: Large Margin Accounts use 20,000+ share sizes with aggressive scaling. Small Cash Accounts (Robinhood/Webull) restricted by "one-bullet" mentality due to T+1 settlement — a break-even trade wastes the day's only opportunity.

Market Sentiment: Hot Markets driven by FOMO where B/C quality setups succeed. Cold Markets characterized by "rejection" where even A+ setups fail. The Icebreaker prevents revenge trading in non-conducive environments.

Setup Performance: Front-Side Momentum (Micro Pullback, ABCD Pattern — higher highs). Back-Side/Recovery (Inverted Head & Shoulders, Cup & Handle, VWAP Reclaims — lower probability than pure front-side).

5. Unique Insights
The "Jack-Knife" Phenomenon: HFT algorithm rejections — APVO exhibited violent drops from $9.00 to $7.50 and $11.50 to $9.00 in seconds. Once displayed, stock is deemed unsafe for standard size.

Institutional Indicators: Analyst "price target hikes" (e.g., HC Wainwright adjusting BTAI from $8 to $10) often precede S3/Shelf Registration or secondary offerings. Review 8-K filings to detect impending dilution.

Psychology of the "Downward Spiral": Small loss → sadness → anger → "Hail Mary" mentality → taking C-quality setups with A-quality size → account liquidation.

6. The Unified Momentum Framework: Daily Lifecycle
Phase 1 — Pre-Market Analysis (4:00-7:00 AM): Scanners identify leading gappers. Find the single "best" stock, not a basket of mediocre ones.
Phase 2 — The Icebreaker: Build $1,000 profit cushion using 1/4 size. This entry is the gatekeeper confirming "Safe-to-Trade."
Phase 3 — Scaling into Strength: Full size (20,000 shares) only on proven front-side patterns like Micro Pullback.
Phase 4 — Profit Extraction: Sell into "Front Side" (higher highs/lows). Cease on "Back Side" — first candle to break the low of previous pullback.

7. Actionable Takeaways
1) Quantitative Audit: If average winner isn't approaching 18 cents/share, you're overtrading B-quality setups.
2) Enforce Icebreaker Cap: No full-size position until realized profit cushion established.
3) Validate Institutional Filings: Verify S3/Shelf Registration before entering biotech runners. Be wary of HC Wainwright "suspect" news.
4) Master the Technical Exit: Stop buying when stock produces candle breaking the low of previous pullback. This single rule prevents majority of profit give-back.
5) "One-Bullet" Discipline: Trade as if you have one opportunity per day — forces waiting for A+ setups.

8. Final Summary
The ultimate philosophy: "Less is More." Professionalism defined by quality of trades, not quantity. Market sentiment is the final and most powerful filter. Prioritize "Survive till you Thrive" — preserve capital during slow cycles for firepower when the market heats up. Consistent simulator profitability is a non-negotiable prerequisite before live capital deployment.`,
    m14: `The Momentum Trader's Blueprint: A Correlated Intelligence Report on Intraday Volatility and Risk Management

1. Overview: The Strategic Landscape of Momentum Trading
In intraday trading, success is not speculation but a disciplined, data-driven profession. Personal psychology must be meticulously aligned with market cycles — transitioning from "hot" cycles (aggressively pursuing A-quality setups) to "cold" cycles (defensive posture to protect expected value). With a verified track record growing $583 into over $15.8 million in audited profits, this blueprint establishes a framework for consistency and technical precision.

2. Cross-Source Thematic Analysis: The Architecture of a Trade
Breaking News as Primary Catalyst: Whether biotech Phase 3 results (APVO's 75% remission rate) or corporate treasury announcements, the "freshness" of news determines momentum intensity. Without a fundamental catalyst, a stock lacks sustained demand to overcome institutional resistance.

The Low-Float Variable: Stocks with float <10M-20M shares create the environment for 100%+ gains. When massive volume (demand) hits restricted shares (supply), price is forced into violent upward adjustments. Low-float is the difference between a "base hit" and explosive volatility.

Icebreaker Position Management: Initiating with quarter-sized position (5,000 shares vs. 20,000 full size) during low-confidence discovery phase. Protects session EV by preventing early "emotional hijack." On green days accuracy hits 80%; red days drop to 30-40% — the Icebreaker limits exposure on low-accuracy mornings.

3. Points of Convergence: Universal Laws
The "Five Pillars" Protocol: Price ($2.00-$20.00), Volume (5x+ daily average), News (fresh catalyst), Float (<10M ideally, max 20M), Percentage Gain (10-25% minimum).

The 7:00 AM - 10:00 AM Window: Strategic significance of early morning news cycle and pre-market volume (starting 4:00 AM).

"Micro Pullback" Supremacy: The 10-second candlestick chart is the most reliable entry tool. Enter as the first 10-second candle makes a new high after a brief pause.

Price Improvement: Brokers like Webull/Robinhood yield "half-cent fills" (e.g., $3.695 on $3.70 ask). Over thousands of trades, this edge significantly impacts the bottom line.

4. Strategic Divergences
Small Account vs. Main Account: $2,000 cash account governed by "One Bullet" mentality (PDT rule, settlement times) creates pressure to hold losers. $15.8M margin account allows infinite scalability.

Market Cycle Adaptations: Hot Market — B-quality setups tradable due to FOMO liquidity. "Crypto-Treasury" catalyst became exhausted (pop and drop). Biotech remains tried-and-true for sustained moves.

The "Jackknife" Variable: Biotech and Hong Kong/Singapore stocks (APVO, LGCL, HKD) exhibit rapid violent rejections dropping dollars in seconds. After two jackknifes, classified as A-minus or B-quality requiring tighter stops.

"No-Catalyst" Risk: International names (HKD, LGCL) moving 100%+ without news are high-risk — prone to sudden unexplained collapses without fundamental demand.

5. Unique Insights: The Human Factor
The "Lawn Mower" Analogy: Break-even trader running "rough" — either "running rich" (over-trading) or "running lean" (lack of opportunity). Flow state requires "Starter Fluid" (fresh catalyst) and proper "Choke" adjustment (risk management).

The "Ferry Boat" Lesson: External stressors subtly alter focus. Being "jolted" or physically compromised requires immediate 50% size reduction or cessation.

Starlink/Mobile Command Center: Flow state requires technical redundancy — mobile setups with Starlink and 5G backups ensure zero blackouts during high-stakes moves.

6. The Master-Tier Combined Strategy: Ideal Trade Lifecycle
1) Selection: Scanners filter for Five Pillars.
2) Validation: Correlate news with Level 2 "Wall of Sellers." Identify large seller at whole/half-dollar increment, wait for wall to be "chipped away."
3) Execution: Icebreaker entry (1/4 size) on 10-second micro pullback. Enter as first candle makes new high.
4) Scaling: Double position only after $1,000 profit cushion established and "Front Side" intact (higher highs/lows on 1-minute chart).
5) Exiting: Identify "Topping Tails" or "Backside of the Move" (stairstepping down) to lock profit.

7. Professional Risk Matrix
Three consecutive losses → walk away immediately (prevent emotional hijack).
Giving back 50% of daily gains → stop trading (capital preservation).
Missing the 4:00 AM move → wait for 7:00 AM retail wave (avoid FOMO chasing backside).
External stress/compromise → 50% size reduction or stop.

Golden Rules: Accept "No-Trade Days" as discipline victories. Respect Daily Max Loss as unbreakable law. Mental Reset for "Ticker Emotional Residue" — never revenge-trade the same ticker. Never trade sleep-deprived.

8. Final Summary
Success is a "Houston, we have a problem" analytical mindset — relentless data pursuit and radical acceptance of market conditions. Evolution from $600 to $15.8M+ achieved through unwavering A-quality pursuit with 2:1 or 4:1 P/L ratio and 75-80% accuracy. Competence forged through exhaustive simulator practice. Master the 10-second micro pullback, respect the risk matrix, treat every trade as a statistical entry in a lifelong career.`,
    m15: `Comprehensive Analysis of Small-Cap Momentum Trading: Strategies, Risk Management, and Market Microstructure

1. Executive Overview
In small-cap day trading, the delta between institutional-grade performance and catastrophic failure is defined by the trader's ability to align internal execution with external market sentiment. Success is the systematic application of technical frameworks for long-term capital preservation. The "Warrior Trading" methodology treats trading as a high-performance sport, prioritizing "surviving till you thrive" — shifting focus from 400% "home runs" to disciplined capture of high-probability, high-volatility catalysts.

The core mission: strategic utilization of supply/demand imbalances in small-cap equities to scale accounts while maintaining rigorous risk mitigation. This analysis covers the mechanics and psychological frameworks necessary for audited multi-million dollar milestones.

2. The "Warrior" Framework
The Five Pillars of Stock Selection: Price ($2-$20, small accounts $1.50-$6.00), Percentage Gain (+10-25% minimum proving momentum), Relative Volume (5x+ average, peak days 10x-100x), Low Float (under 10M shares, ideally under 5M for parabolic squeezes), News Catalyst (fundamental reason like "frontline AML 75% remission rate" or "crypto treasury strategies").

Market Sentiment Cycles: "Hot" markets — FOMO allows B-quality setups to resolve profitably ("pedal to the metal" sizing). "Cold" markets — even A-quality setups may fail, requiring reduced sizing or sitting on hands.

Technical Setup Hierarchy: 1) Micro Pullback — primary entry tool, anticipatory buying as candle makes new high while still forming. 2) ABCD Pattern — 15-minute pivot break identifying surge (A-B), consolidation (B-C), breakout (D). 3) Cup and Handle — rounded consolidation with shallow handle building pressure, effective when MACD positive.

3. The Non-Negotiables of Risk
The Icebreaker Strategy: Mandatory protocol testing market "heat" before full capital. First trades at quarter-size (5,000 shares vs. 20,000 full). Locked at quarter-size until crossing profit threshold. Only after being up for the day does scaling to full aggressive sizing occur.

Stopping Rules: 50% Profit Give-back (walk away to preserve remaining gains), Three Consecutive Frustrated Losses (signals misalignment with market timing), Daily Max Loss Limit (hard cap, e.g., 10% of account mandating immediate termination).

The 10% Rule: For small accounts — symmetrical 10% daily risk limit coupled with 10% daily reward target. Paired with high accuracy, facilitates exponential equity curve growth.

4. Operational Differences
Cash vs. Margin Accounts: Cash accounts — not PDT restricted but limited by T+1 settlement ("one bullet per day," all-in/all-out risk, high FOMO psychology). Margin accounts — require $25K minimum but provide instant settlement, multi-trade scaling capability.

Broker Constraints: Mobile platforms (Robinhood/Webull) have execution lag and limited pre-market (7:00 AM). Professional desktop platforms access pre-market at 4:00 AM — critical window for primary momentum moves. Mobile Command Centers (Sprinter vans with Starlink) maintain 120mbps connectivity regardless of geography.

Catalyst Efficacy: Biotech Clinical Results remain gold standard. Crypto Treasury Strategies become overplayed ("pop and drop"). Chinese/Hong Kong IPOs move on zero news with extreme jack-knife risk and lack transparent audit trails.

5. Unique Insights and Case Studies
The APVO "Jack-Knife": Ripped $6.00 to $9.00, jack-knifed to $7.50. Second rip to $11.50, violent drop to $9.00. HFT algorithms "take money right out of your pocket." Once exhibited, stock deemed "unsafe" for significant size.

The "Blue Sky" Setup (MCTR): Stock breaking all-time high ($12.00 level) — no historical resistance or "overhead supply" from previous sellers. Allows unrestricted upward expansion, though initial "double top" resistance common.

Internal State Management: The "Dramamine/Ferry" lesson — being jolted awake or medicated disrupts Alpha/Beta states for high-frequency decisions. If not emotionally grounded or physically optimal, unfit for market participation.

6. The Unified Trading Strategy
The "Lawn Mower" Analogy: Break-even trader = engine running "rough" at 60% accuracy. Fine-tuning = narrowing to A-quality setups, improving P/L ratio until reaching 75-80% accuracy in hot streaks.

The Positive Feedback Loop: 1) Accuracy on high-quality setups → 2) Confidence builds "flow state" → 3) Larger sizing deployed → 4) Exponential profit growth.

The "Base Hit" Mentality: Average winners of 18 cents per share. Consistent 18-cent gains statistically superior to "swinging for the fences." Audited results: $583 to $15.8M+ (path to $20M) built on small, predictable daily winners.

7. Actionable Takeaways
Pre-Trading 9-Point Scan: Internal checks (sleep 7+ hours, emotional groundedness, recent performance streak). External checks (market sentiment, yesterday's performance, strong stocks holding/reversing, S&P 500 big picture, scanner activity 20%+ gainers, FOMO/sentiment levels).

Sim-to-Live Transition: Alpha Phase (simulator experience, pay dues risk-free), Beta Phase (live cash account, one trade/day for "proof of concept"), Scaling Phase (increase size only after 10 consecutive profitable days).

Mandate Data Tracking: TraderVue or similar tools are non-negotiable. Identify "Sweet Spot" (stocks under $10, trades 7:00-10:00 AM, floats under 5M) to eliminate losing variables.

8. Final Summary
"Survive till you Thrive." Longevity is not luck or hitting 400% squeezes — it's radical acceptance of market conditions and Icebreaker discipline. Success built on financial literacy and relentless performance metric tracking. Focus on the 18-cent "base hit," maintain high accuracy, ruthlessly cut losses to stabilize the equity curve. This disciplined approach is the only sustainable path to the $20 million audited milestone and beyond.`
  }
};

// Mentor chat endpoint
app.post('/api/trading-ai/mentor', async (req, res) => {
  try {
    const { question, moduleId, mentorId, history } = req.body;

    if (!question || !question.trim()) {
      return res.status(400).json({ error: 'Question is required' });
    }
    if (!mentorId || !MENTOR_SOURCES[mentorId]) {
      return res.status(400).json({ error: 'Unknown mentor' });
    }

    // Rate limiting (shared with tutor)
    const allowed = await checkTutorRateLimit();
    if (!allowed) {
      return res.status(429).json({
        success: false,
        answer: "You've reached the question limit (30/hour). Take a break and come back shortly!",
        rateLimited: true
      });
    }

    // Get Anthropic API key
    const settings = await kvGet('settings', {});
    const apiKey = settings.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(400).json({ error: 'No Anthropic API key configured. An admin needs to set this up in Settings.' });
    }

    const mentor = MENTOR_SOURCES[mentorId];
    const mentorContent = mentor[moduleId] || '';

    if (!mentorContent) {
      return res.json({
        success: true,
        answer: `${mentor.name} hasn't shared specific teachings for this module yet. Check back soon — more content is being added!`
      });
    }

    // Get module title
    const modules = await getModules();
    const mod = modules.find(m => m.id === moduleId);
    const moduleTitle = mod ? mod.title : 'this module';

    const systemPrompt = `You are ${mentor.name}, a seasoned trading mentor at the Impact Trading Academy. You are speaking directly to a student who is studying Module: "${moduleTitle}".

YOUR TEACHING MATERIAL (answer ONLY from this):
---
${mentorContent}
---

RULES FOR RESPONDING AS ${mentor.name.toUpperCase()}:
1. Speak in first person as ${mentor.name}. Use phrases like "In my experience...", "What I've found is...", "The way I teach this is..."
2. Answer ONLY using the teaching material above. If the question goes beyond your material, say "That's a great question, but it goes beyond what I cover in this module. Stick to the core concepts here first."
3. Be direct, confident, and motivating — like a mentor who genuinely wants the student to succeed.
4. Use ${mentor.name}'s specific terminology and frameworks (e.g., "Cameron Method", "Jack-Knife candle", "Icebreaker Strategy", "Front Side Mandate").
5. When explaining concepts, ground them in real examples from the material.
6. Keep answers focused and practical — 2-4 paragraphs. Students need clarity, not lectures.
7. If the student asks about risk, ALWAYS reinforce the rules: 1% Rule, 3-Loss Rule, 50% Give-Back Rule.
8. End with a specific actionable step the student can take right now.
9. Never give specific financial advice or recommend specific trades. You are a mentor and educator.`;

    // Build messages array
    const messages = [];
    if (Array.isArray(history)) {
      for (const h of history.slice(-4)) {
        if (h.role === 'user' || h.role === 'assistant') {
          messages.push({ role: h.role, content: h.content });
        }
      }
    }
    messages.push({ role: 'user', content: question });

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
      console.error('Mentor API error:', response.status, errData);
      return res.status(response.status).json({
        error: errData.error?.message || `API returned ${response.status}`
      });
    }

    const data = await response.json();
    const answer = data.content
      ?.filter(c => c.type === 'text')
      ?.map(c => c.text)
      ?.join('\n') || 'I was unable to generate a response. Please try again.';

    // Fetch relevant mentor videos for this module (from cache if available)
    let mentorVideos = [];
    try {
      const mentorCacheKey = `youtube_mentor_${moduleId}`;
      const mentorCached = await kvGet(mentorCacheKey);
      const ONE_DAY_MS = 24 * 60 * 60 * 1000;
      if (mentorCached && mentorCached.videos && mentorCached.videos.length > 0 && mentorCached.fetchedAt) {
        const cacheAge = Date.now() - new Date(mentorCached.fetchedAt).getTime();
        if (cacheAge < ONE_DAY_MS) {
          mentorVideos = mentorCached.videos.filter(v => v.mentor === mentorId);
        }
      }
      if (mentorVideos.length === 0 && MENTOR_VIDEO_QUERIES[mentorId] && MENTOR_VIDEO_QUERIES[mentorId][moduleId]) {
        const freshVideos = await searchMentorVideos(moduleId, 3);
        mentorVideos = freshVideos.filter(v => v.mentor === mentorId);
      }
    } catch (vErr) {
      console.error('Mentor video fetch error (non-blocking):', vErr.message);
    }

    // Fallback: if YouTube API returned nothing, generate YouTube search links
    // from MENTOR_VIDEO_QUERIES so students ALWAYS get clickable video links
    if (mentorVideos.length === 0 && MENTOR_VIDEO_QUERIES[mentorId] && MENTOR_VIDEO_QUERIES[mentorId][moduleId]) {
      const queries = MENTOR_VIDEO_QUERIES[mentorId][moduleId];
      mentorVideos = queries.slice(0, 3).map(q => ({
        title: q.replace(/Ross Cameron /i, '').trim(),
        url: `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
        thumbnail: null,
        fallback: true
      }));
    }

    res.json({
      success: true,
      answer,
      mentorId,
      mentorName: mentor.name,
      moduleId,
      model: data.model,
      usage: data.usage,
      videos: mentorVideos.slice(0, 3).map(v => ({
        title: v.title,
        url: v.url,
        thumbnail: v.thumbnail || null,
        fallback: v.fallback || false
      }))
    });

  } catch (error) {
    console.error('Mentor chat error:', error);
    res.status(500).json({ error: error.message || 'Failed to get mentor response' });
  }
});

// Mentor status endpoint
app.get('/api/trading-ai/mentor-status', async (req, res) => {
  const settings = await kvGet('settings', {});
  const hasKey = !!(settings.anthropicApiKey || process.env.ANTHROPIC_API_KEY);
  const mentors = {};
  for (const [id, mentor] of Object.entries(MENTOR_SOURCES)) {
    mentors[id] = {
      name: mentor.name,
      avatar: mentor.avatar,
      title: mentor.title,
      modules: Object.keys(mentor).filter(k => k.startsWith('m') && /^m\d+$/.test(k))
    };
  }
  res.json({ available: hasKey, mentors });
});

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
// TRADINGVIEW UDF DATAFEED ENDPOINTS
// Implements the Universal Data Feed (UDF) protocol for TradingView Charting Library
// Docs: https://www.tradingview.com/charting-library-docs/latest/connecting_data/UDF/
// =============================================================================

// UDF: Server configuration
app.get('/api/udf/config', (req, res) => {
  res.json({
    supports_search: true,
    supports_group_request: false,
    supports_marks: false,
    supports_timescale_marks: false,
    supports_time: true,
    exchanges: [
      { value: '', name: 'All Exchanges', desc: '' },
      { value: 'NYSE', name: 'NYSE', desc: 'New York Stock Exchange' },
      { value: 'NASDAQ', name: 'NASDAQ', desc: 'NASDAQ Stock Market' },
      { value: 'AMEX', name: 'AMEX', desc: 'NYSE American' }
    ],
    symbols_types: [
      { name: 'All types', value: '' },
      { name: 'Stock', value: 'stock' },
      { name: 'ETF', value: 'etf' }
    ],
    supported_resolutions: ['1', '5', '15', '30', '60', '120', '240', 'D', 'W', 'M'],
    currency_codes: ['USD']
  });
});

// UDF: Server time
app.get('/api/udf/time', (req, res) => {
  res.send(Math.floor(Date.now() / 1000).toString());
});

// UDF: Symbol search
app.get('/api/udf/search', async (req, res) => {
  const { query, type, exchange, limit = 30 } = req.query;
  if (!query || query.length < 1) return res.json([]);

  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=${Math.min(parseInt(limit) || 30, 50)}&newsCount=0&listsCount=0`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MissionMetrics/1.0)' }
    });
    if (!resp.ok) return res.json([]);
    const data = await resp.json();

    const results = (data.quotes || [])
      .filter(r => {
        if (type === 'stock' && r.quoteType !== 'EQUITY') return false;
        if (type === 'etf' && r.quoteType !== 'ETF') return false;
        if (exchange && r.exchange && !r.exchange.toUpperCase().includes(exchange.toUpperCase())) return false;
        return r.quoteType === 'EQUITY' || r.quoteType === 'ETF';
      })
      .map(r => ({
        symbol: r.symbol,
        full_name: `${r.exchange || 'US'}:${r.symbol}`,
        description: r.shortname || r.longname || r.symbol,
        exchange: r.exchange || 'US',
        type: r.quoteType === 'ETF' ? 'etf' : 'stock',
        ticker: r.symbol
      }));

    res.json(results);
  } catch (error) {
    console.error('UDF search error:', error.message);
    res.json([]);
  }
});

// UDF: Resolve symbol
app.get('/api/udf/symbols', async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ s: 'error', errmsg: 'Symbol required' });

  const clean = symbol.includes(':') ? symbol.split(':').pop() : symbol;
  const allowed = /^[A-Z0-9.\-]{1,10}$/i;
  if (!allowed.test(clean)) return res.status(400).json({ s: 'error', errmsg: 'Invalid symbol' });

  try {
    // Fetch basic quote data from Yahoo to get exchange, name, timezone
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(clean)}&quotesCount=1&newsCount=0&listsCount=0`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MissionMetrics/1.0)' }
    });
    let name = clean;
    let exchange = 'US';
    let qType = 'stock';
    if (resp.ok) {
      const data = await resp.json();
      const match = (data.quotes || []).find(q => q.symbol === clean.toUpperCase());
      if (match) {
        name = match.shortname || match.longname || clean;
        exchange = match.exchange || 'US';
        qType = match.quoteType === 'ETF' ? 'etf' : 'stock';
      }
    }

    res.json({
      name: clean.toUpperCase(),
      ticker: clean.toUpperCase(),
      description: name,
      type: qType,
      session: '0930-1600',
      timezone: 'America/New_York',
      exchange: exchange,
      listed_exchange: exchange,
      minmov: 1,
      pricescale: 100,
      has_intraday: true,
      has_daily: true,
      has_weekly_and_monthly: true,
      supported_resolutions: ['1', '5', '15', '30', '60', '120', '240', 'D', 'W', 'M'],
      volume_precision: 0,
      data_status: 'delayed_streaming',
      currency_code: 'USD',
      original_currency_code: 'USD',
      format: 'price'
    });
  } catch (error) {
    console.error('UDF symbol resolve error:', error.message);
    res.status(500).json({ s: 'error', errmsg: 'Failed to resolve symbol' });
  }
});

// UDF: Historical bars
// Maps TradingView resolution codes to Yahoo Finance intervals and ranges
app.get('/api/udf/history', async (req, res) => {
  const { symbol, from, to, resolution, countback } = req.query;
  if (!symbol) return res.json({ s: 'error', errmsg: 'Symbol required' });

  const clean = symbol.includes(':') ? symbol.split(':').pop() : symbol;
  const allowed = /^[A-Z0-9.\-]{1,10}$/i;
  if (!allowed.test(clean)) return res.json({ s: 'error', errmsg: 'Invalid symbol' });

  // Map TradingView resolution to Yahoo Finance interval
  const resolutionMap = {
    '1': '1m', '5': '5m', '15': '15m', '30': '30m',
    '60': '60m', '120': '60m', '240': '60m',
    'D': '1d', '1D': '1d', 'W': '1wk', '1W': '1wk', 'M': '1mo', '1M': '1mo'
  };
  const interval = resolutionMap[resolution] || '1d';

  // Yahoo Finance range limits by interval
  // Intraday (1m): max 7 days; 5m/15m/30m: max 60 days; 60m: max 730 days
  const fromTs = parseInt(from) || Math.floor(Date.now() / 1000) - 365 * 86400;
  const toTs = parseInt(to) || Math.floor(Date.now() / 1000);

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(clean.toUpperCase())}?period1=${fromTs}&period2=${toTs}&interval=${interval}&includePrePost=false`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MissionMetrics/1.0)' }
    });

    if (!resp.ok) {
      return res.json({ s: 'no_data', nextTime: toTs });
    }

    const raw = await resp.json();
    const result = raw?.chart?.result?.[0];
    if (!result || !result.timestamp || result.timestamp.length === 0) {
      return res.json({ s: 'no_data', nextTime: toTs });
    }

    const ts = result.timestamp;
    const quote = result.indicators?.quote?.[0] || {};

    const t = [], o = [], h = [], l = [], c = [], v = [];

    for (let i = 0; i < ts.length; i++) {
      const open = quote.open?.[i];
      const high = quote.high?.[i];
      const low = quote.low?.[i];
      const close = quote.close?.[i];
      const vol = quote.volume?.[i];

      if (open != null && high != null && low != null && close != null) {
        t.push(ts[i]);
        o.push(+open.toFixed(4));
        h.push(+high.toFixed(4));
        l.push(+low.toFixed(4));
        c.push(+close.toFixed(4));
        v.push(vol || 0);
      }
    }

    if (t.length === 0) {
      return res.json({ s: 'no_data', nextTime: toTs });
    }

    // If countback is specified, return only the last N bars
    if (countback) {
      const cb = parseInt(countback);
      if (cb > 0 && cb < t.length) {
        const start = t.length - cb;
        return res.json({
          s: 'ok',
          t: t.slice(start),
          o: o.slice(start),
          h: h.slice(start),
          l: l.slice(start),
          c: c.slice(start),
          v: v.slice(start)
        });
      }
    }

    res.json({ s: 'ok', t, o, h, l, c, v });
  } catch (error) {
    console.error('UDF history error:', error.message);
    res.json({ s: 'error', errmsg: 'Failed to fetch historical data' });
  }
});

// =============================================================================
// CHART TRAINING — LIVE OHLCV FOR PRACTICE ENGINE
// =============================================================================

const TRAINING_SYMBOLS = [
  'AAPL','MSFT','NVDA','TSLA','AMZN','GOOGL','META','SPY','QQQ',
  'AMD','NFLX','DIS','BA','JPM','GS','V','WMT','HD','CRM','ORCL'
];

app.post('/api/training/live-bars', async (req, res) => {
  try {
    const { difficulty = 'easy', symbol } = req.body || {};
    const sym = symbol || TRAINING_SYMBOLS[Math.floor(Math.random() * TRAINING_SYMBOLS.length)];
    const n = difficulty === 'easy' ? 10 : difficulty === 'medium' ? 16 : 24;

    // Fetch 6 months of daily data from Yahoo Finance
    const now = Math.floor(Date.now() / 1000);
    const sixMonthsAgo = now - (180 * 86400);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${sixMonthsAgo}&period2=${now}&interval=1d`;

    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TradingAcademy/1.0)' }
    });
    const data = await resp.json();

    if (!data.chart || !data.chart.result || !data.chart.result[0]) {
      return res.status(400).json({ error: 'No data returned for ' + sym, fallback: true });
    }

    const result = data.chart.result[0];
    const quote = result.indicators?.quote?.[0] || {};
    const timestamps = result.timestamp || [];

    // Build bar array in same format as frontend genChart()
    const allBars = [];
    for (let i = 0; i < timestamps.length; i++) {
      const o = quote.open?.[i], h = quote.high?.[i], l = quote.low?.[i], c = quote.close?.[i];
      if (o == null || h == null || l == null || c == null) continue;
      allBars.push({
        o: +o.toFixed(2), h: +h.toFixed(2), l: +l.toFixed(2), c: +c.toFixed(2),
        bull: c >= o, idx: allBars.length,
        date: new Date(timestamps[i] * 1000).toISOString().split('T')[0],
        vol: quote.volume?.[i] || 0
      });
    }

    if (allBars.length < n) {
      return res.json({ success: false, error: 'Not enough bars for ' + sym, fallback: true });
    }

    // Pick a random window of n bars (avoid the last 5 days to prevent stale-data edge)
    const maxStart = Math.max(0, allBars.length - n - 5);
    const start = Math.floor(Math.random() * maxStart);
    const window = allBars.slice(start, start + n).map((b, i) => ({
      ...b, idx: i, phase: null, phaseDir: null, patIdx: -1
    }));

    res.json({ success: true, symbol: sym, bars: window, totalBars: allBars.length, live: true });
  } catch (error) {
    console.error('Training live bars error:', error.message);
    res.json({ success: false, error: error.message, fallback: true });
  }
});

// =============================================================================
// HEALTH CHECK
// =============================================================================

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

module.exports = app;

