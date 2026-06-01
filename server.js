/**
 * NORI Vision Server
 * Handles describe and hazard scanning via Gemini 1.5 Flash.
 * Deploy to Railway / Render — one instance handles all users.
 *
 * Routes:
 *   POST /describe  — on-demand full scene description
 *   POST /hazard    — safety scan while walking
 *   GET  /health    — uptime check
 */

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app  = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' })); // images come in as base64

// ── Gemini key pool — add more keys as you scale ──────────────────────────
// Each key = 1,500 RPM free. Rotate round-robin so no single key hits limits.
// Add keys to .env as GEMINI_KEY_1, GEMINI_KEY_2, etc.
const geminiKeys = [];
let keyIndex = 0;

for (let i = 1; i <= 10; i++) {
  const key = process.env[`GEMINI_KEY_${i}`];
  if (key) geminiKeys.push(new GoogleGenerativeAI(key));
}

if (geminiKeys.length === 0) {
  console.error('No Gemini API keys found. Add GEMINI_KEY_1 to .env');
  process.exit(1);
}

console.log(`Loaded ${geminiKeys.length} Gemini key(s)`);

function getNextClient() {
  const client = geminiKeys[keyIndex % geminiKeys.length];
  keyIndex++;
  return client;
}

// ── Prompts ────────────────────────────────────────────────────────────────

const HAZARD_PROMPT = `You are a real-time safety assistant for a blind person who is walking.
Analyze this image and report ONLY what affects their immediate safety and navigation.

Respond in this exact priority order — skip any category if nothing relevant:

1. IMMEDIATE DANGERS (say these first, always):
   - Moving vehicles (cars, bikes, scooters) — direction and distance
   - Traffic light color — red, yellow, or green
   - Walk or don't walk signal
   - Safe or unsafe to cross the street
   - Stairs or sudden drop ahead
   - Fast moving objects coming toward them

2. PATH OBSTACLES:
   - Anything blocking the walking path — poles, people, barriers, furniture
   - Curbs, steps, ramps — up or down
   - Wet floor, ice, uneven ground
   - Low hanging obstacles — branches, signs

3. TRANSIT:
   - Bus number if visible
   - Bus doors location — open or closed
   - Train or subway approaching

4. NAVIGATION AIDS:
   - Street signs or intersection names
   - Building entrances or exits
   - Crosswalk location
   - Elevator or escalator nearby

Rules:
- Be specific and directional. Say "car moving from your right" not "there is a car"
- Say "step down 2 feet ahead" not "there are stairs"
- Say "red light, do not cross" not "traffic light visible"
- Say "bus 42 arriving on your left" not "a bus is here"
- If the path looks completely clear say only: "Path is clear"
- Maximum 2 sentences. No pleasantries. No filler words.
- Speak directly to the person as if you are their eyes`;

const DESCRIBE_PROMPT = `You are NORI, an AI companion helping a blind person understand their surroundings.
Describe this scene fully and accurately so they can navigate and interact with confidence.

Include:
- Where they are (type of room, indoor/outdoor, street, store, etc.)
- Everything important around them with direction (left, right, ahead, behind)
- Any text visible — signs, labels, screens, doors — read it exactly
- People nearby and what they are doing
- Any potential hazards or obstacles
- Anything they might want to interact with (counter, door, elevator button, ATM)

Rules:
- Be specific. Say "trashcan on your right" not "container nearby"
- Give directions. Say "refrigerator straight ahead" not just "refrigerator"
- Read all visible text exactly as written
- 3-4 sentences maximum
- Plain language, no jargon
- Speak directly to the person`;

// ── Helper: call Gemini with image ────────────────────────────────────────
async function callGemini(base64Image, mimeType, prompt) {
  const client = getNextClient();
  const model  = client.getGenerativeModel({ model: 'gemini-2.0-flash' });

  const result = await model.generateContent([
    {
      inlineData: {
        mimeType: mimeType || 'image/jpeg',
        data: base64Image,
      },
    },
    prompt,
  ]);

  return result.response.text().trim();
}

// ── Routes ─────────────────────────────────────────────────────────────────

// Health check — Railway / Render ping this to keep the server alive
app.get('/health', (req, res) => {
  res.json({ status: 'ok', keys: geminiKeys.length, uptime: process.uptime() });
});

// On-demand full scene description
app.post('/describe', async (req, res) => {
  const { image, mimeType } = req.body;

  if (!image) {
    return res.status(400).json({ error: 'image is required (base64)' });
  }

  try {
    const description = await callGemini(image, mimeType, DESCRIBE_PROMPT);
    res.json({ description });
  } catch (err) {
    console.error('[/describe] Gemini error:', err.message);
    res.status(500).json({ error: 'vision_failed', message: err.message });
  }
});

// Continuous hazard scanning — called every 3s while walking
app.post('/hazard', async (req, res) => {
  const { image, mimeType } = req.body;

  if (!image) {
    return res.status(400).json({ error: 'image is required (base64)' });
  }

  try {
    const result = await callGemini(image, mimeType, HAZARD_PROMPT);

    // If Gemini says path is clear, send empty so app stays silent
    const isClear = result.toLowerCase().includes('path is clear') ||
                    result.toLowerCase().includes('no hazard') ||
                    result.toLowerCase().includes('nothing');

    res.json({
      hazard:  isClear ? null : result,
      isClear,
    });
  } catch (err) {
    console.error('[/hazard] Gemini error:', err.message);
    res.status(500).json({ error: 'vision_failed', message: err.message });
  }
});

app.listen(port, () => {
  console.log(`NORI Vision Server running on port ${port}`);
});
