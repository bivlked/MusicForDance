#!/usr/bin/env node
/**
 * countdown-audio — Подготовка танцевальных треков с обратным отсчётом.
 *
 * Self-contained CLI. Зависимости только runtime:
 *   • Node.js 18+
 *   • ffmpeg 6+ собранный с --enable-librubberband (и --enable-libmp3lame для --mp3)
 *
 * Развёртывание на новый ПК — копируешь только этот файл, выполняешь:
 *   node index.js --setup C:\countdown-audio
 *
 * Использование:
 *   node index.js <input> [<input2> ...] [опции]
 *   node index.js --help
 */

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawn } = require('child_process');

// ─── CONSTANTS ───────────────────────────────────────────────────────
const FFPROBE = 'ffprobe';
const FFMPEG  = 'ffmpeg';
const ANSI_CLEAR_LINE = process.stdout.isTTY ? '\x1b[K' : '';

const DEFAULT_SPEEDS      = [1.0, 0.9, 0.8, 0.7];
const DEFAULT_TICKS       = 5;
const DEFAULT_SILENCE_DB  = -50;
const DEFAULT_MP3_BITRATE = '192k';
const VALID_BITS          = new Set([16, 24, 32]);

const HEADER_SIZE      = 44;
const BITS_PER_SAMPLE  = 16;
const BYTES_PER_SAMPLE = 2;

// ─── WAV ENCODER ─────────────────────────────────────────────────────
function encodeWavPcm16(samples, sampleRate, channels) {
    const byteRate   = sampleRate * channels * BYTES_PER_SAMPLE;
    const blockAlign = channels * BYTES_PER_SAMPLE;
    const dataSize   = samples.length * BYTES_PER_SAMPLE;
    const buf        = Buffer.alloc(HEADER_SIZE + dataSize);

    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + dataSize, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);                      // PCM format
    buf.writeUInt16LE(channels, 22);
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(byteRate, 28);
    buf.writeUInt16LE(blockAlign, 32);
    buf.writeUInt16LE(BITS_PER_SAMPLE, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(dataSize, 40);

    Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).copy(buf, HEADER_SIZE);
    return buf;
}

function monoToStereo(monoSamples) {
    const out = new Int16Array(monoSamples.length * 2);
    for (let i = 0, j = 0; i < monoSamples.length; i++, j += 2) {
        const v = monoSamples[i];
        out[j]     = v;
        out[j + 1] = v;
    }
    return out;
}

// ─── TICK GENERATORS ─────────────────────────────────────────────────
// Короткий тик: 60мс щелчок (1000+2000Гц с экспоненциальным затуханием),
// затем 940мс тишины. Длина 1.0с — стандартный «удар» в отсчёте.
function generateTickMono(sampleRate) {
    const totalSamples = Math.floor(sampleRate * 1.0);
    const clickSamples = Math.floor(sampleRate * 0.06);
    const samples      = new Int16Array(totalSamples);
    const amp          = 0.92 * 32767;
    const tauSamples   = sampleRate * 0.015;

    for (let i = 0; i < clickSamples; i++) {
        const t = i / sampleRate;
        const env = Math.exp(-i / tauSamples);
        const s = (
            Math.sin(2 * Math.PI * 1000 * t) * 0.7 +
            Math.sin(2 * Math.PI * 2000 * t) * 0.3
        ) * env * amp;
        samples[i] = Math.max(-32768, Math.min(32767, Math.round(s)));
    }
    return samples;
}

// Длинный финальный тик: ровно 1.0с, 800+1600Гц, fade-in 20мс / fade-out 100мс.
// Заканчивается на самом последнем сэмпле intro — следом sample-accurate идёт музыка.
function generateLongBuzzMono(sampleRate) {
    const totalSamples = Math.floor(sampleRate * 1.0);
    const fadeInN      = Math.floor(sampleRate * 0.020);
    const fadeOutN     = Math.floor(sampleRate * 0.100);
    const plateauEnd   = totalSamples - fadeOutN;
    const samples      = new Int16Array(totalSamples);
    const amp          = 0.88 * 32767;

    // Знаменатель fadeOutN-1 гарантирует env=0 на самом последнем сэмпле,
    // а не env=1/fadeOutN (микро-щелчок ~ -75 dBFS на стыке с музыкой).
    const fadeOutDenom = Math.max(1, fadeOutN - 1);
    for (let i = 0; i < totalSamples; i++) {
        const t = i / sampleRate;
        let env = 1;
        if (i < fadeInN) env = i / fadeInN;
        else if (i >= plateauEnd) env = (totalSamples - 1 - i) / fadeOutDenom;
        const s = (
            Math.sin(2 * Math.PI * 800 * t) * 0.7 +
            Math.sin(2 * Math.PI * 1600 * t) * 0.3
        ) * env * amp;
        samples[i] = Math.max(-32768, Math.min(32767, Math.round(s)));
    }
    return samples;
}

// ─── INTRO BUILDER ───────────────────────────────────────────────────
function buildIntroWav({ sampleRate, channels, count = DEFAULT_TICKS }) {
    if (!Number.isInteger(count) || count < 1) {
        throw new Error(`count must be integer >= 1 (got ${count})`);
    }
    if (channels !== 1 && channels !== 2) {
        throw new Error(`channels must be 1 or 2 (got ${channels})`);
    }
    if (!Number.isFinite(sampleRate) || sampleRate < 8000) {
        throw new Error(`sampleRate must be >= 8000 (got ${sampleRate})`);
    }

    const tick = generateTickMono(sampleRate);
    const buzz = generateLongBuzzMono(sampleRate);
    const total = new Int16Array(tick.length * (count - 1) + buzz.length);
    let offset = 0;
    for (let i = 0; i < count - 1; i++) {
        total.set(tick, offset);
        offset += tick.length;
    }
    total.set(buzz, offset);

    const interleaved = (channels === 2) ? monoToStereo(total) : total;
    return encodeWavPcm16(interleaved, sampleRate, channels);
}

// ─── PROCESS HELPERS ─────────────────────────────────────────────────
function runProcess(cmd, args, { onStderr } = {}) {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, { windowsHide: true });
        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', d => { stdout += d.toString('utf8'); });
        proc.stderr.on('data', d => {
            const s = d.toString('utf8');
            stderr += s;
            if (onStderr) onStderr(s);
        });

        proc.once('error', reject);
        proc.once('close', (code, signal) => {
            if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                const tail = stderr.slice(-2000) || stdout.slice(-500);
                const reason = signal ? `signal ${signal}` : `exit code ${code}`;
                reject(new Error(`${path.basename(cmd)} failed (${reason})\n${tail}`));
            }
        });
    });
}

async function probe(filePath) {
    // -of json обязателен: и stream, и format содержат поле bit_rate. Плоский
    // key=value parser silently выберет неправильный, а нам нужны оба
    // (stream предпочтительнее, format — fallback для VBR AAC где stream=N/A).
    const { stdout } = await runProcess(FFPROBE, [
        '-v', 'error',
        '-select_streams', 'a:0',
        '-show_entries', 'stream=sample_rate,channels,bits_per_sample,bits_per_raw_sample,codec_name,duration,bit_rate:format=bit_rate',
        '-of', 'json',
        filePath,
    ]);

    let parsed;
    try {
        parsed = JSON.parse(stdout);
    } catch (err) {
        throw new Error(`ffprobe вернул невалидный JSON: ${err.message}`);
    }

    const stream = (parsed.streams && parsed.streams[0]) || {};
    const format = parsed.format || {};

    const bps    = parseInt(stream.bits_per_sample, 10);
    const bpsRaw = parseInt(stream.bits_per_raw_sample, 10);
    const bitsPerSample = (Number.isFinite(bps) && bps > 0)
        ? bps
        : (Number.isFinite(bpsRaw) && bpsRaw > 0 ? bpsRaw : 16);

    const sampleRate = parseInt(stream.sample_rate, 10);
    const channels   = parseInt(stream.channels, 10);
    const duration   = parseFloat(stream.duration);
    const streamBR   = parseInt(stream.bit_rate, 10);
    const formatBR   = parseInt(format.bit_rate, 10);

    if (!Number.isFinite(sampleRate) || !Number.isFinite(channels)) {
        throw new Error('ffprobe не нашёл аудио-стрим в файле');
    }

    return {
        sampleRate, channels, bitsPerSample,
        duration:       Number.isFinite(duration) ? duration : null,
        streamBitRate:  Number.isFinite(streamBR) && streamBR > 0 ? streamBR : null,
        formatBitRate:  Number.isFinite(formatBR) && formatBR > 0 ? formatBR : null,
        codec:          stream.codec_name || '',
    };
}

function pcmCodecForBits(bits) {
    switch (bits) {
        case 16: return 'pcm_s16le';
        case 24: return 'pcm_s24le';
        case 32: return 'pcm_s32le';
        default: return 'pcm_s24le';
    }
}

// libmp3lame supported sample rates: MPEG-1 (32k, 44.1k, 48k),
// MPEG-2 (16k, 22.05k, 24k), MPEG-2.5 (8k, 11.025k, 12k).
const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
function snapToMp3Rate(rate) {
    if (rate >= 48000) return 48000;
    let best = MP3_RATES[0];
    let bestDiff = Math.abs(rate - best);
    for (const r of MP3_RATES) {
        const d = Math.abs(rate - r);
        if (d < bestDiff) { best = r; bestDiff = d; }
    }
    return best;
}

// Lossy декодеры: для них исходный bits_per_sample не значит ничего —
// внутренний формат float; кодирование в 16-bit квантизировало бы лишний раз.
const LOSSY_CODECS = new Set([
    'mp3', 'mp2', 'mp1',
    'aac', 'aac_latm',
    'opus', 'vorbis',
    'wmav1', 'wmav2', 'wmavoice',
    'ac3', 'eac3', 'truehd',
    'dts', 'dca',
]);

// Opus поддерживает только конкретный набор частот.
const OPUS_RATES = [8000, 12000, 16000, 24000, 48000];
function snapToOpusRate(rate) {
    if (rate >= 48000) return 48000;
    let best = OPUS_RATES[0];
    let bestDiff = Math.abs(rate - best);
    for (const r of OPUS_RATES) {
        const d = Math.abs(rate - r);
        if (d < bestDiff) { best = r; bestDiff = d; }
    }
    return best;
}

/**
 * Выбрать output codec/extension/quality исходя из источника и user override.
 * Возвращает spec, который buildOutput использует для построения ffmpeg args.
 *
 * @param {Object} meta — результат probe (codec, bitsPerSample, bitRate, sampleRate)
 * @param {string} formatOverride — 'auto' | 'wav' | 'mp3'
 * @param {string|null} bitrateOverride — например '320k', null = из источника
 */
function chooseOutputSpec(meta, formatOverride, bitrateOverride) {
    const warnings = [];

    // Утилита: bitrate из источника или fallback. Chain: stream → format → default.
    // Если попали на format-fallback — пишем warning, чтобы пользователь видел
    // что bitrate взят из контейнера (типично для VBR AAC, где stream=N/A).
    const bitrateFromSource = (fallback) => {
        if (bitrateOverride) return bitrateOverride;
        if (meta.streamBitRate) return `${Math.round(meta.streamBitRate / 1000)}k`;
        if (meta.formatBitRate) {
            const br = `${Math.round(meta.formatBitRate / 1000)}k`;
            warnings.push(`Bitrate из контейнера (stream=N/A): ${br}`);
            return br;
        }
        return fallback;
    };

    // Утилита: bit-depth для PCM-выхода.
    const pcmBitsForSource = () => {
        if (LOSSY_CODECS.has(meta.codec)) return 24;            // lossy → 24-bit
        return VALID_BITS.has(meta.bitsPerSample) ? meta.bitsPerSample : 24;
    };

    // Принудительный WAV
    if (formatOverride === 'wav') {
        const bits = pcmBitsForSource();
        return { kind: 'pcm', codec: pcmCodecForBits(bits), ext: 'wav',
                 sampleFmt: null, label: `WAV ${bits}-bit`, warnings };
    }

    // Принудительный MP3
    if (formatOverride === 'mp3') {
        const br = bitrateOverride || (meta.codec === 'mp3' && (meta.streamBitRate || meta.formatBitRate)
            ? `${Math.round((meta.streamBitRate || meta.formatBitRate) / 1000)}k`
            : '192k');
        return {
            kind:   'lossy',
            codec:  'libmp3lame',
            ext:    'mp3',
            bitrate: br,
            sampleRateClamp: snapToMp3Rate,
            sampleFmt: null,
            label:  `MP3 ${br}`,
            warnings,
        };
    }

    // Auto: подобрать по источнику.
    switch (meta.codec) {
        case 'pcm_s16le': case 'pcm_s24le': case 'pcm_s32le': case 'pcm_f32le': {
            const bits = pcmBitsForSource();
            return { kind: 'pcm', codec: pcmCodecForBits(bits), ext: 'wav',
                     sampleFmt: null, label: `WAV ${bits}-bit`, warnings };
        }
        case 'flac': {
            // FLAC sample formats: только s16/s32. 24-bit хранится через
            // s32 + bits_per_raw_sample=24 (NOT s24 — такого формата у ffmpeg нет).
            const srcBits = meta.bitsPerSample || 24;
            const spec = { kind: 'lossless', codec: 'flac', ext: 'flac', warnings };
            if (srcBits <= 16) {
                spec.sampleFmt = 's16';
                spec.label = 'FLAC 16-bit';
            } else if (srcBits === 24) {
                spec.sampleFmt = 's32';
                spec.bitsPerRawSample = 24;
                spec.label = 'FLAC 24-bit';
            } else {
                spec.sampleFmt = 's32';
                spec.label = 'FLAC 32-bit';
            }
            return spec;
        }
        case 'alac': {
            // ALAC encoder в ffmpeg принимает только planar форматы: s16p, s32p.
            // 24-bit aналогично FLAC: s32p + bits_per_raw_sample=24.
            const srcBits = meta.bitsPerSample || 24;
            const spec = { kind: 'lossless', codec: 'alac', ext: 'm4a', warnings };
            if (srcBits <= 16) {
                spec.sampleFmt = 's16p';
                spec.label = 'ALAC 16-bit';
            } else if (srcBits === 24) {
                spec.sampleFmt = 's32p';
                spec.bitsPerRawSample = 24;
                spec.label = 'ALAC 24-bit';
            } else {
                spec.sampleFmt = 's32p';
                spec.label = 'ALAC 32-bit';
            }
            return spec;
        }
        case 'mp3': case 'mp2': case 'mp1': {
            const br = bitrateFromSource('192k');
            return { kind: 'lossy', codec: 'libmp3lame', ext: 'mp3', bitrate: br,
                     sampleRateClamp: snapToMp3Rate, sampleFmt: null,
                     label: `MP3 ${br}`, warnings };
        }
        case 'aac': case 'aac_latm': {
            const br = bitrateFromSource('192k');
            return { kind: 'lossy', codec: 'aac', ext: 'm4a', bitrate: br,
                     sampleFmt: null, label: `AAC ${br}`, warnings };
        }
        case 'opus': {
            const br = bitrateFromSource('128k');
            return { kind: 'lossy', codec: 'libopus', ext: 'opus', bitrate: br,
                     sampleRateClamp: snapToOpusRate, sampleFmt: null,
                     label: `Opus ${br}`, warnings };
        }
        case 'vorbis': {
            const br = bitrateFromSource('192k');
            return { kind: 'lossy', codec: 'libvorbis', ext: 'ogg', bitrate: br,
                     sampleFmt: null, label: `Vorbis ${br}`, warnings };
        }
        case 'ac3': {
            const br = bitrateFromSource('192k');
            return { kind: 'lossy', codec: 'ac3', ext: 'ac3', bitrate: br,
                     sampleFmt: null, label: `AC3 ${br}`, warnings };
        }
        case 'eac3': {
            const br = bitrateFromSource('192k');
            return { kind: 'lossy', codec: 'eac3', ext: 'eac3', bitrate: br,
                     sampleFmt: null, label: `E-AC3 ${br}`, warnings };
        }
        // Кодеки без encoder в gyan.dev ffmpeg (WMA, DTS) → fallback на WAV
        default: {
            const bits = pcmBitsForSource();
            return {
                kind: 'pcm', codec: pcmCodecForBits(bits), ext: 'wav',
                sampleFmt: null,
                label: `WAV ${bits}-bit (fallback: нет encoder для «${meta.codec}»)`,
                warnings,
            };
        }
    }
}

function channelLayoutName(channels) {
    if (channels === 1) return 'mono';
    if (channels === 2) return 'stereo';
    throw new Error(`Unsupported channel count: ${channels} (expected 1 or 2)`);
}

// Главный pipeline: intro + source → silenceremove → [rubberband] → concat → output.
// Один процесс ffmpeg на каждую версию, без промежуточных файлов на диске.
async function buildOutput({
    introPath, sourcePath, outputPath,
    tempo, silenceThreshDb, sampleRate, channels,
    outputSpec,
    onProgress,
}) {
    const layout = channelLayoutName(channels);

    // detection=peak:window=0 — sample-accurate решение по каждому сэмплу.
    // Default (rms+window=0.02) усреднял бы по 20мс окну, что давало бы до
    // 10–20мс смещения trim точки относительно реального onset.
    const silenceFilter = `silenceremove=start_periods=1:start_silence=0:start_threshold=${silenceThreshDb}dB:detection=peak:window=0`;

    const sourceFilters = [silenceFilter];
    if (Math.abs(tempo - 1.0) > 1e-6) {
        sourceFilters.push(`rubberband=tempo=${tempo}:pitch=1.0`);
    }
    const formatFilter = `aformat=sample_fmts=fltp:sample_rates=${sampleRate}:channel_layouts=${layout}`;
    sourceFilters.push(formatFilter);
    // asetpts=N/SR/TB — сбрасываем PTS на основе sample-counter, чтобы concat
    // получал стримы с timestamp 0 (защита от MP3 edit-list / encoder delay).
    sourceFilters.push('asetpts=N/SR/TB');

    const filterComplex = [
        `[0:a]${formatFilter},asetpts=N/SR/TB[intro]`,
        `[1:a]${sourceFilters.join(',')}[main]`,
        `[intro][main]concat=n=2:v=0:a=1[out]`,
    ].join(';');

    const args = [
        '-y',
        '-hide_banner',
        '-nostdin',
        '-i', introPath,
        '-i', sourcePath,
        '-filter_complex', filterComplex,
        '-map', '[out]',
        '-c:a', outputSpec.codec,
    ];

    if (outputSpec.bitrate) {
        args.push('-b:a', outputSpec.bitrate);
    }

    // sampleFmt передаём только для FLAC/ALAC (PCM-кодек сам определяет формат
    // именем; lossy энкодеры берут что им удобно из fltp).
    if (outputSpec.sampleFmt) {
        args.push('-sample_fmt', outputSpec.sampleFmt);
    }
    // 24-bit FLAC/ALAC: ffmpeg хранит s32, но кодирует только нижние 24 бита.
    if (outputSpec.bitsPerRawSample) {
        args.push('-bits_per_raw_sample', String(outputSpec.bitsPerRawSample));
    }

    const targetRate = outputSpec.sampleRateClamp
        ? outputSpec.sampleRateClamp(sampleRate)
        : sampleRate;
    args.push('-ar', String(targetRate));
    args.push('-ac', String(channels));

    args.push(outputPath);
    await runProcess(FFMPEG, args, { onStderr: onProgress });
}

// ─── ARGS / VALIDATION ───────────────────────────────────────────────
function parseArgs(argv) {
    const out = {
        inputs:      [],
        ticks:       DEFAULT_TICKS,
        silenceDb:   DEFAULT_SILENCE_DB,
        speeds:          DEFAULT_SPEEDS,
        outDir:          null,
        formatOverride:  'auto',     // 'auto' | 'wav' | 'mp3'
        bitrateOverride: null,       // например '320k'; null = взять из источника
        setupTarget:     null,
        force:           false,
    };

    // Возвращает значение для опции, бросая понятную ошибку при отсутствии или
    // если значение похоже на следующий флаг (--xxx). Отрицательные числа (-50)
    // пропускаются, потому что они начинаются с одного `-`, а не `--`.
    const readValue = (i, name) => {
        const v = argv[i];
        if (v === undefined) throw new Error(`${name} требует значение`);
        if (v.startsWith('--')) throw new Error(`${name} требует значение, найден флаг ${v}`);
        return v;
    };

    const parseStrictInt = (s, name) => {
        if (!/^-?\d+$/.test(s)) throw new Error(`${name}: ожидается целое число (получено: ${s})`);
        return parseInt(s, 10);
    };
    const parseStrictFloat = (s, name) => {
        if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`${name}: ожидается число (получено: ${s})`);
        return parseFloat(s);
    };

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case '--ticks':
                out.ticks = parseStrictInt(readValue(++i, '--ticks'), '--ticks');
                break;
            case '--silence-db':
                out.silenceDb = parseStrictFloat(readValue(++i, '--silence-db'), '--silence-db');
                break;
            case '--speeds': {
                const raw = readValue(++i, '--speeds');
                out.speeds = raw.split(',').map(s => {
                    if (!/^-?\d+(\.\d+)?$/.test(s)) {
                        throw new Error(`--speeds: невалидное число «${s}»`);
                    }
                    return parseFloat(s);
                });
                break;
            }
            case '--out-dir':
            case '-o':
                out.outDir = readValue(++i, '--out-dir');
                break;
            case '--mp3':
            case '-mp3':
                out.formatOverride = 'mp3';
                break;
            case '--wav':
            case '-wav':
                out.formatOverride = 'wav';
                break;
            case '--bitrate':
            case '-b': {
                const raw = readValue(++i, '--bitrate');
                if (!/^\d+k?$/i.test(raw)) {
                    throw new Error(`--bitrate: ожидается «N» или «Nk» (получено: ${raw})`);
                }
                out.bitrateOverride = /k$/i.test(raw) ? raw.toLowerCase() : `${raw}k`;
                break;
            }
            case '--setup':
            case '-setup':
                out.setupTarget = readValue(++i, '--setup');
                break;
            case '--force':
            case '-f':
                out.force = true;
                break;
            case '-h':
            case '--help':
                printHelp();
                process.exit(0);
                break;
            default:
                if (a.startsWith('-')) {
                    throw new Error(`Неизвестный флаг: ${a} (см. --help)`);
                }
                out.inputs.push(a);
        }
    }
    return out;
}

function validateArgs(args) {
    if (args.setupTarget !== null) {
        if (!args.setupTarget) return '--setup требует путь: --setup C:\\path\\to\\target';
        return null;
    }
    if (args.inputs.length === 0) {
        return 'не указан входной аудиофайл';
    }
    if (!Number.isInteger(args.ticks) || args.ticks < 1 || args.ticks > 20) {
        return `--ticks должен быть целым 1..20 (получено: ${args.ticks})`;
    }
    if (!Number.isFinite(args.silenceDb) || args.silenceDb >= 0 || args.silenceDb < -120) {
        return `--silence-db должен быть отрицательным числом, не ниже -120 (получено: ${args.silenceDb})`;
    }
    if (args.speeds.length === 0) {
        return '--speeds: нет валидных значений';
    }
    if (args.speeds.some(s => s < 0.25 || s > 4)) {
        return `--speeds: значения в диапазоне 0.25..4 (получено: ${args.speeds.join(',')})`;
    }
    return null;
}

function printHelp() {
    console.log(`
MusicForDance — подготовка танцевальных треков с обратным отсчётом

ИСПОЛЬЗОВАНИЕ:
  node index.js <input.wav|.mp3|.m4a|.flac|...> [<input2> ...] [опции]
  node index.js --setup <target-dir>

ОПЦИИ:
  --out-dir <path>     Папка для результатов (default: рядом с источником)
  --ticks <N>          Сколько тиков в отсчёте (default: 5; 1..20)
  --silence-db <dB>    Порог тишины для обрезки в начале (default: -50)
  --speeds <list>      Список скоростей через запятую (default: 1.0,0.9,0.8,0.7)
  --mp3                Принудительно MP3 (default bitrate 192k или из источника)
  --wav                Принудительно WAV PCM (lossless)
  --bitrate <X>, -b    Bitrate для lossy: «320k» / «128k» / «320» (default: из источника)
  --setup <target>     Создать папку и развернуть туда index.js + run.bat
                       для использования на новом ПК
  --force, -f          Разрешить --setup в непустую папку (перезаписывает файлы)
  -h, --help           Эта справка

ПО УМОЛЧАНИЮ выходной формат и качество совпадают с исходным:
  MP3 320kbps  → MP3 320kbps
  FLAC 24-bit  → FLAC 24-bit
  WAV  16-bit  → WAV  16-bit
  AAC  256k    → AAC  256k

ПРИМЕРЫ:
  node index.js "track.mp3"                    # → mp3 c bitrate исходника
  node index.js "track.flac"                   # → flac тот же bit depth
  node index.js "track.mp3" --wav              # → wav 24-bit
  node index.js "track.wav" --mp3              # → mp3 192k
  node index.js "track.mp3" --bitrate 320k     # → mp3 320k
  node index.js "track.wav" --ticks 4 --speeds 1.0,0.85,0.7
  node index.js a.wav b.mp3 c.flac --out-dir ./output
  node index.js --setup C:\\Tools\\MusicForDance

ВЫХОДНЫЕ ФАЙЛЫ:
  Имя «<speed>x <basename>.<ext>», расширение совпадает с форматом выхода.
    1.0x track.mp3
    0.9x track.mp3
    0.8x track.mp3
    0.7x track.mp3

ФОРМАТ ВЫХОДА:
  Default (auto):  тот же codec/bitrate что у источника, чтобы не терять
                   качество и не менять формат непредсказуемо.
                   PCM/FLAC/ALAC сохраняют bit depth; MP3/AAC/Opus/Vorbis/AC3 —
                   bitrate; lossy → 24-bit при принудительном --wav.
  --wav:           PCM WAV; bit depth = source (или 24-bit для lossy).
  --mp3:           libmp3lame; bitrate из источника (если MP3) или 192k;
                   sample rate снапится к ближайшему MP3-supported.
`);
}

// ─── HELPERS ─────────────────────────────────────────────────────────
function fmtTime(ms) {
    const s = ms / 1000;
    return s < 60 ? `${s.toFixed(1)}s` : `${(s / 60).toFixed(1)}m`;
}

function formatSpeed(speed) {
    const rounded = Math.round(speed * 1000) / 1000;
    let s = rounded.toString();
    if (!s.includes('.')) s += '.0';
    return s;
}

function progressUpdater(label) {
    if (!process.stdout.isTTY) return undefined;
    let last = '';
    return chunk => {
        const m = chunk.match(/time=(\d+:\d+:\d+\.\d+)/g);
        if (!m) return;
        const t = m[m.length - 1];
        if (t === last) return;
        last = t;
        process.stdout.write(`\r  [${label}] ${t}${ANSI_CLEAR_LINE}`);
    };
}

function uniqueIntroPath() {
    const name = `countdown_intro_${process.pid}_${Date.now()}.wav`;
    return path.join(os.tmpdir(), name);
}

// ─── EMBEDDED FILES (for --setup) ────────────────────────────────────
const RUN_BAT_CONTENT = `@echo off
chcp 65001 > nul

if "%~1"=="" goto :no_args

cd /d "%~dp0"
node index.js %*
if errorlevel 1 goto :error

echo.
pause
exit /b 0

:no_args
echo.
echo Drag an audio file onto this .bat to process it.
echo Supported formats: .wav .mp3 .m4a .flac
echo.
pause
exit /b 1

:error
echo.
echo === ERROR ===
pause
exit /b 1
`;

// ─── DEPENDENCY CHECK ────────────────────────────────────────────────
async function checkDependencies() {
    const results = [];

    results.push({
        name:  'Node.js',
        ok:    true,
        detail: process.version,
    });

    try {
        const { stdout, stderr } = await runProcess(FFMPEG, ['-hide_banner', '-version']);
        const versionMatch = (stdout + stderr).match(/ffmpeg version (\S+)/);
        results.push({
            name:   'ffmpeg',
            ok:     true,
            detail: versionMatch ? versionMatch[1] : 'найден',
        });

        const { stdout: filters } = await runProcess(FFMPEG, ['-hide_banner', '-filters']);
        const hasRubberband = / rubberband\s/.test(filters);
        results.push({
            name:        'librubberband filter',
            ok:          hasRubberband,
            detail:      hasRubberband ? '' : 'фильтр rubberband отсутствует',
            installHint: hasRubberband ? null : 'Нужен ffmpeg full build от gyan.dev. Установка: winget install Gyan.FFmpeg',
        });

        const { stdout: encoders } = await runProcess(FFMPEG, ['-hide_banner', '-encoders']);
        const hasMp3 = / libmp3lame\s/.test(encoders);
        results.push({
            name:        'libmp3lame encoder',
            ok:          hasMp3,
            detail:      hasMp3 ? '' : 'нужен только для --mp3',
            installHint: hasMp3 ? null : 'Тот же fix: winget install Gyan.FFmpeg',
        });
    } catch (_err) {
        results.push({
            name:        'ffmpeg',
            ok:          false,
            detail:      'не найден в PATH',
            installHint: 'winget install Gyan.FFmpeg  (затем перезапусти терминал, чтобы PATH обновился)',
        });
    }

    return results;
}

// ─── SETUP COMMAND ───────────────────────────────────────────────────
async function runSetup(targetPath, { force = false } = {}) {
    const target      = path.resolve(targetPath);
    const myPath      = path.resolve(__filename);
    const targetIndex = path.join(target, 'index.js');
    const targetBat   = path.join(target, 'run.bat');

    // Защита от случайного перезаписывания самого себя.
    if (path.resolve(targetIndex) === myPath) {
        throw new Error(`--setup указывает на исходную папку текущего скрипта (${target}). Выбери другую папку.`);
    }

    // Защита от typo в пути: блокируем перезапись непустой папки без --force.
    if (fs.existsSync(target)) {
        const stat = fs.statSync(target);
        if (!stat.isDirectory()) {
            throw new Error(`--setup target существует, но это не папка: ${target}`);
        }
        const entries = fs.readdirSync(target);
        if (entries.length > 0 && !force) {
            throw new Error(
                `Папка не пустая (${entries.length} файлов). ` +
                `Чтобы перезаписать, добавь флаг --force.\n  ${target}`
            );
        }
    }

    console.log(`\n[setup] Целевая папка: ${target}`);
    fs.mkdirSync(target, { recursive: true });

    fs.copyFileSync(myPath, targetIndex);
    console.log(`[setup] ✓ index.js  (${(fs.statSync(targetIndex).size / 1024).toFixed(1)} KB)`);

    fs.writeFileSync(targetBat, RUN_BAT_CONTENT);
    console.log(`[setup] ✓ run.bat`);

    console.log(`\n[setup] Проверка окружения:`);
    const checks  = await checkDependencies();
    for (const c of checks) {
        const mark = c.ok ? '✓' : '✗';
        console.log(`  ${mark} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    }
    const missing = checks.filter(c => !c.ok);

    console.log(`\n[setup] Готово. Использование на этом ПК:`);
    console.log(`  cd "${target}"`);
    console.log(`  node index.js "путь\\к\\треку.wav"`);
    console.log(`  (или перетащи аудиофайл на run.bat)`);

    if (missing.length) {
        console.log(`\n[setup] ⚠ Для работы нужно доустановить:`);
        for (const c of missing) {
            if (c.installHint) console.log(`  ${c.installHint}`);
        }
        process.exitCode = 2;
    }
}

// ─── PROCESS ONE FILE ────────────────────────────────────────────────
async function processFile(inputPath, args) {
    const baseName = path.basename(inputPath, path.extname(inputPath));
    const outDir = args.outDir
        ? path.resolve(args.outDir)
        : path.dirname(inputPath);
    fs.mkdirSync(outDir, { recursive: true });

    console.log(`\n[1/3] Анализ «${path.basename(inputPath)}»`);
    const meta = await probe(inputPath);
    const durStr = meta.duration !== null ? `${meta.duration.toFixed(2)} с` : 'неизвестна';
    const sourceBR = meta.streamBitRate || meta.formatBitRate;
    const brStr  = sourceBR ? `, ${Math.round(sourceBR / 1000)} kbps` : '';
    console.log(`      ${meta.codec}, ${meta.sampleRate} Hz, ${meta.channels}ch, ${meta.bitsPerSample}-bit${brStr}, длительность ${durStr}`);

    let channels = meta.channels;
    if (channels > 2) {
        console.log(`      ⚠ ${channels} каналов → downmix to stereo`);
        channels = 2;
    }

    const sampleRate = meta.sampleRate;
    if (sampleRate > 384000) {
        throw new Error(`Слишком высокий sample rate: ${sampleRate} Hz (макс 384000)`);
    }

    const outputSpec = chooseOutputSpec(meta, args.formatOverride, args.bitrateOverride);
    for (const w of outputSpec.warnings || []) {
        console.log(`      ⚠ ${w}`);
    }
    const outExt      = outputSpec.ext;
    const formatLabel = outputSpec.label;

    // Pre-build output paths и проверка коллизий (например 0.999 и 1.0
    // округляются в один и тот же tag → silent overwrite).
    const outputs = args.speeds.map(s => ({
        speed: s,
        tag:   formatSpeed(s),
        name:  `${formatSpeed(s)}x ${baseName}.${outExt}`,
    }));
    const seenNames = new Set();
    for (const o of outputs) {
        if (seenNames.has(o.name)) {
            throw new Error(`Дубликат имени выхода «${o.name}» (несколько скоростей округляются одинаково)`);
        }
        seenNames.add(o.name);
    }

    console.log(`\n[2/3] Генерация intro (${args.ticks} тиков, ${sampleRate} Hz, ${channels === 2 ? 'stereo' : 'mono'})`);
    const introBuf  = buildIntroWav({ sampleRate, channels, count: args.ticks });
    const introPath = uniqueIntroPath();
    fs.writeFileSync(introPath, introBuf);
    console.log(`      ${(introBuf.length / 1024).toFixed(1)} KB → tmp`);

    try {
        console.log(`\n[3/3] Сборка ${args.speeds.length} версий (${formatLabel})`);
        const t0    = Date.now();
        const isTTY = process.stdout.isTTY;

        for (const o of outputs) {
            const { speed, tag, name: outName } = o;
            const outPath = path.join(outDir, outName);
            const tStart  = Date.now();

            if (isTTY) process.stdout.write(`  • ${outName}`);
            try {
                await buildOutput({
                    introPath,
                    sourcePath:      inputPath,
                    outputPath:      outPath,
                    tempo:           speed,
                    silenceThreshDb: args.silenceDb,
                    sampleRate,
                    channels,
                    outputSpec,
                    onProgress:      progressUpdater(tag + 'x'),
                });
                const elapsed = fmtTime(Date.now() - tStart);
                if (isTTY) process.stdout.write(`\r  ✓ ${outName}  (${elapsed})${ANSI_CLEAR_LINE}\n`);
                else       console.log(`  ✓ ${outName}  (${elapsed})`);
            } catch (err) {
                if (isTTY) process.stdout.write(`\r  ✗ ${outName}  ОШИБКА${ANSI_CLEAR_LINE}\n`);
                else       console.error(`  ✗ ${outName}  ОШИБКА`);
                throw err;
            }
        }

        console.log(`\nГотово за ${fmtTime(Date.now() - t0)}. Файлы в: ${outDir}`);
    } finally {
        try { fs.unlinkSync(introPath); } catch (_) { /* file might be gone already */ }
    }
}

// ─── MAIN ────────────────────────────────────────────────────────────
async function main() {
    let args;
    try {
        args = parseArgs(process.argv.slice(2));
    } catch (err) {
        console.error(`Ошибка: ${err.message}\n`);
        printHelp();
        process.exit(1);
    }

    const validationError = validateArgs(args);
    if (validationError) {
        console.error(`Ошибка: ${validationError}\n`);
        printHelp();
        process.exit(1);
    }

    if (args.setupTarget !== null) {
        await runSetup(args.setupTarget, { force: args.force });
        return;
    }

    const resolved = args.inputs.map(p => path.resolve(p));
    const missing  = resolved.filter(p => !fs.existsSync(p));
    if (missing.length) {
        console.error('Файлы не найдены:');
        for (const p of missing) console.error(`  ${p}`);
        process.exit(1);
    }

    if (resolved.length === 1) {
        await processFile(resolved[0], args);
    } else {
        for (let i = 0; i < resolved.length; i++) {
            console.log(`\n═══ [${i + 1}/${resolved.length}] ${path.basename(resolved[i])} ═══`);
            await processFile(resolved[i], args);
        }
    }
}

process.once('SIGINT',  () => { console.error('\nПрервано пользователем'); process.exit(130); });
process.once('SIGTERM', () => { process.exit(143); });

main().catch(err => {
    console.error(`\nОшибка: ${err.message}`);
    process.exit(1);
});
