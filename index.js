import OpenAI from 'openai';
import dotenv from 'dotenv';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import os from 'os';

dotenv.config();

// Change this if you have access to a different model (e.g. 'gpt-4o-mini')
const CHAT_MODEL = 'gpt-4o-mini';

const openai = new OpenAI({ apiKey: process.env.API_KEY });

const LANG_NAMES = { hy: 'Armenian', hu: 'Hungarian' };
const SUPPORTED = ['hy', 'hu'];

const TMP_DIR = os.tmpdir();
const REC_PATH = path.join(TMP_DIR, 'huarhuar_input.wav');
const TTS_PATH = path.join(TMP_DIR, 'huarhuar_output.mp3');

// ── Recording ────────────────────────────────────────────────────────────────

async function recordAudio(rl) {
    console.log('🎙  Recording… Press Enter to stop.\n');

    return new Promise((resolve, reject) => {
        // arecord: 16-bit signed LE, 16 kHz, mono – ideal for Whisper
        const rec = spawn('arecord', [
            '-f', 'S16_LE',
            '-r', '16000',
            '-c', '1',
            '-t', 'wav',
            REC_PATH,
        ], { stdio: ['ignore', 'ignore', 'ignore'] });

        rec.on('error', (err) => {
            reject(
                err.code === 'ENOENT'
                    ? new Error('arecord not found.\nInstall ALSA utils:  sudo apt install alsa-utils')
                    : err,
            );
        });

        // Next Enter press stops the recording
        rl.once('line', () => {
            rec.kill('SIGTERM');
            setTimeout(resolve, 400); // small delay so the file is fully written
        });
    });
}

// ── Transcription ─────────────────────────────────────────────────────────────

async function transcribe() {
    const resp = await openai.audio.transcriptions.create({
        file: fs.createReadStream(REC_PATH),
        model: 'whisper-1',
        response_format: 'verbose_json', // includes the detected language code
    });
    return { text: resp.text, language: resp.language }; // language is ISO 639-1
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

async function speak(text) {
    const resp = await openai.audio.speech.create({
        model: 'tts-1',
        voice: 'alloy',
        input: text,
    });
    const buf = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(TTS_PATH, buf);
}

// ── Playback ──────────────────────────────────────────────────────────────────

function trySpawn(cmd, args) {
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, args, { stdio: 'ignore' });
        p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
        p.on('error', reject);
    });
}

async function playAudio() {
    // Try common players in order; resolve silently if none are found
    const players = [
        ['ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', TTS_PATH]],
        ['mpg123', ['-q', TTS_PATH]],
        ['cvlc', ['--play-and-exit', '--quiet', TTS_PATH]],
    ];

    for (const [cmd, args] of players) {
        try {
            await trySpawn(cmd, args);
            return;
        } catch {
            // try next
        }
    }
    console.warn('⚠  No audio player found. Install ffmpeg:  sudo apt install ffmpeg');
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function main() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    console.log('\n═══════════════════════════════════════════════');
    console.log('    🇦🇲 Armenian ↔ Hungarian Voice Translator 🇭🇺  ');
    console.log('═══════════════════════════════════════════════\n');
    console.log('Speak Armenian → get Hungarian, or speak Hungarian → get Armenian.\n');

    const loop = async () => {
        const answer = await new Promise((res) =>
            rl.question('Press Enter to start recording  (type "quit" to exit): ', res),
        );

        if (answer.trim().toLowerCase() === 'quit') {
            console.log('\nGoodbye!\n');
            rl.close();
            return;
        }

        try {
            // 1. Record
            await recordAudio(rl);

            // 2. Transcribe
            console.log('\n⏳ Transcribing…');
            const { text, language } = await transcribe();
            console.log(`\n  Detected language : ${LANG_NAMES[language] ?? language} (${language})`);
            console.log(`  Transcription     : "${text}"`);

            if (!SUPPORTED.includes(language)) {
                console.log(`\n⚠  Language "${language}" is not supported. Please speak Armenian or Hungarian.\n`);
                return loop();
            }

            // 3. Translate
            const target = language === 'hy' ? 'hu' : 'hy';
            console.log(`\n⏳ Translating to ${LANG_NAMES[target]}…`);
            const translation = await translate(text, language, target);
            console.log(`  Translation       : "${translation}"`);

            // 4. Speak
            console.log('\n🔊 Speaking…');
            await speak(translation);
            await playAudio();
            console.log();
        } catch (err) {
            console.error('\n✗ Error:', err.message, '\n');
        }

        loop();
    };

    loop();
}

main();
