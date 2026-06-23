import OpenAI, { toFile } from 'openai';
import dotenv from 'dotenv';
import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAT_MODEL = 'gpt-4o-mini';
const openai = new OpenAI({ apiKey: process.env.API_KEY });

const LANG_NAMES = { ru: 'Russian', hu: 'Hungarian' };
const SUPPORTED = ['ru', 'hu'];

const TMP_DIR = os.tmpdir();
const TTS_PATH = path.join(TMP_DIR, 'huarhuar_output.mp3');

// ── Multer ────────────────────────────────────────────────────────────────────
const upload = multer({
    dest: TMP_DIR,
    limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB – Whisper max
    fileFilter: (_req, file, cb) => {
        if (!file.mimetype.startsWith('audio/')) {
            return cb(new Error('Only audio files are accepted'));
        }
        cb(null, true);
    },
});

// ── Transcription ─────────────────────────────────────────────────────────────
async function transcribe(filePath, originalname, mimetype, sourceLang) {
    const stream = fs.createReadStream(filePath);
    const file = await toFile(stream, originalname, { type: mimetype });
    const resp = await openai.audio.transcriptions.create({
        file,
        model: 'whisper-1',
        language: sourceLang, // Force language detection
        prompt: 'Привет. Как дела? Szia, hogy vagy? (Russian and Hungarian)',
        response_format: 'verbose_json',
    });
    return { text: resp.text, language: resp.language };
}

// ── Translation ───────────────────────────────────────────────────────────────
async function translate(text, fromLang, toLang) {
    const resp = await openai.chat.completions.create({
        model: CHAT_MODEL,
        temperature: 0.3,
        messages: [
            {
                role: 'system',
                content:
                    `You are a professional translator. ` +
                    `Translate the following ${LANG_NAMES[fromLang]} text into ${LANG_NAMES[toLang]}. ` +
                    `Output only the translation, nothing else.`,
            },
            { role: 'user', content: text },
        ],
    });
    return resp.choices[0].message.content.trim();
}

// ── Text-to-Speech ────────────────────────────────────────────────────────────
async function synthesize(text) {
    const resp = await openai.audio.speech.create({
        model: 'tts-1',
        voice: 'alloy',
        input: text,
    });
    const buf = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(TTS_PATH, buf);
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// POST /translate – receive browser audio blob, return JSON
app.post('/translate', upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No audio file received' });

    const sourceLang = req.body.sourceLang || 'ru';
    const targetLang = sourceLang === 'ru' ? 'hu' : 'ru';

    const { path: filePath, originalname, mimetype } = req.file;
    try {
        const { text } = await transcribe(filePath, originalname, mimetype, sourceLang);

        const translation = await translate(text, sourceLang, targetLang);

        await synthesize(translation);

        res.json({
            original: text,
            originalLang: sourceLang,
            originalLangName: LANG_NAMES[sourceLang],
            translation,
            targetLang: targetLang,
            targetLangName: LANG_NAMES[targetLang],
        });
    } catch (err) {
        console.error('[/translate]', err.message);
        res.status(500).json({ error: 'Translation failed: ' + err.message });
    } finally {
        fs.unlink(filePath, () => { });
    }
});

// GET /audio – stream the latest TTS output
app.get('/audio', (_req, res) => {
    if (!fs.existsSync(TTS_PATH)) return res.status(404).end();
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(TTS_PATH).pipe(res);
});

// Multer/validation error handler
app.use((err, _req, res, _next) => {
    console.error(err.message);
    res.status(400).json({ error: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n  Huarhuar running → http://localhost:${PORT}\n`);
});
