#!/usr/bin/env node
/**
 * smoke.js — end-to-end проверка ключевых пайплайнов MusicForDance.
 *
 * Контракт: только built-in модули Node.js + системный ffmpeg/ffprobe.
 * Запуск: `node tests/smoke.js` из корня репо.
 *
 * Проверяет:
 *   1. PCM s16 — базовый pipeline (intro + main, формат и тайминги).
 *   2. FLAC 24-bit — sample_fmt=s32 + bits_per_raw_sample=24 (v1.0.1).
 *   3. pcm_f32le — float сохраняется, нет 32f→32i quantize (v1.0.1).
 *   4. M4A AAC — bitrate берётся из источника, не дефолт 192k (v1.0.1).
 *   5. Замедление 0.8× — ветка rubberband реально работает и растягивает
 *      длительность (до v1.0.3 все тесты шли на 1.0×, где rubberband
 *      не подключается — сломанное замедление осталось бы незамеченным).
 *   6. --setup — e2e развёртывание: index.js копируется байт-в-байт,
 *      сгенерированный run.bat совпадает с run.bat из репозитория
 *      (ловит расхождение встроенной константы RUN_BAT_CONTENT с файлом).
 *
 * Если ffmpeg/ffprobe нет в PATH — печатает SKIP и выходит с code 0.
 * Тест 5 отдельно пропускается, если ffmpeg собран без librubberband.
 */

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// ─── PATHS / CONFIG ──────────────────────────────────────────────────
const ROOT     = path.resolve(__dirname, '..');
const CLI      = path.join(ROOT, 'index.js');
const TMP_DIR  = fs.mkdtempSync(path.join(os.tmpdir(), 'mfd_smoke_'));
const FFMPEG   = 'ffmpeg';
const FFPROBE  = 'ffprobe';
const NODE     = process.execPath;

const cleanupTargets = [TMP_DIR];
let testsPassed = 0;
let testsFailed = 0;

// ─── HELPERS ─────────────────────────────────────────────────────────
function run(cmd, args, opts = {}) {
    const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
    return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}

function ffmpegAvailable() {
    const r = run(FFMPEG, ['-hide_banner', '-version']);
    if (r.error || r.code !== 0) return false;
    const r2 = run(FFPROBE, ['-hide_banner', '-version']);
    return !r2.error && r2.code === 0;
}

function synthFixture(filePath, opts) {
    const { sampleRate = 44100, channels = 1, durationSec = 2,
            codec, sampleFmt, bitsPerRawSample, qa, bitrate } = opts;
    const lavfi = `sine=frequency=440:duration=${durationSec}:sample_rate=${sampleRate}`;
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', lavfi];
    if (channels === 2) args.push('-ac', '2');
    args.push('-c:a', codec);
    if (sampleFmt) args.push('-sample_fmt', sampleFmt);
    if (bitsPerRawSample) args.push('-bits_per_raw_sample', String(bitsPerRawSample));
    if (qa !== undefined) args.push('-q:a', String(qa));
    if (bitrate)  args.push('-b:a', bitrate);
    args.push(filePath);
    const r = run(FFMPEG, args);
    if (r.code !== 0) {
        throw new Error(`synthFixture failed for ${filePath}: ${r.stderr.slice(-500)}`);
    }
}

function ffprobeJson(filePath) {
    const r = run(FFPROBE, [
        '-v', 'error',
        '-show_streams', '-show_format',
        '-of', 'json',
        filePath,
    ]);
    if (r.code !== 0) {
        throw new Error(`ffprobe failed on ${filePath}: ${r.stderr.slice(-300)}`);
    }
    return JSON.parse(r.stdout);
}

function runCli(inputPath, extraArgs = []) {
    const args = [CLI, inputPath, '--out-dir', TMP_DIR, ...extraArgs];
    const r = run(NODE, args);
    if (r.code !== 0) {
        throw new Error(`CLI failed (exit ${r.code}):\nSTDOUT:\n${r.stdout.slice(-800)}\nSTDERR:\n${r.stderr.slice(-800)}`);
    }
    return r;
}

function expectedOutputName(inputPath, speed, ext) {
    const base = path.basename(inputPath, path.extname(inputPath));
    return `${formatSpeed(speed)}x ${base}.${ext}`;
}

function formatSpeed(speed) {
    const rounded = Math.round(speed * 1000) / 1000;
    let s = rounded.toString();
    if (!s.includes('.')) s += '.0';
    return s;
}

function check(label, actual, predicate, expectedDesc) {
    if (predicate(actual)) {
        console.log(`    ✓ ${label} = ${JSON.stringify(actual)}`);
    } else {
        console.log(`    ✗ ${label} = ${JSON.stringify(actual)} (ожидается: ${expectedDesc})`);
        throw new Error(`assert failed: ${label}`);
    }
}

function approxEq(a, b, tol) {
    return Math.abs(a - b) <= tol;
}

function runTest(name, fn) {
    process.stdout.write(`\n[${name}]\n`);
    try {
        fn();
        testsPassed++;
        console.log(`  ✓ PASS`);
    } catch (err) {
        testsFailed++;
        console.log(`  ✗ FAIL: ${err.message}`);
    }
}

// ─── TESTS ───────────────────────────────────────────────────────────
function test1_pcmS16() {
    const inputPath = path.join(TMP_DIR, 'in_s16.wav');
    synthFixture(inputPath, { codec: 'pcm_s16le', sampleRate: 44100, channels: 2, durationSec: 3 });

    runCli(inputPath, ['--speeds', '1.0', '--ticks', '5']);

    const outPath = path.join(TMP_DIR, expectedOutputName(inputPath, 1.0, 'wav'));
    if (!fs.existsSync(outPath)) throw new Error(`выход не создан: ${outPath}`);

    const probe  = ffprobeJson(outPath);
    const stream = probe.streams[0];
    const fmt    = probe.format;
    const dur    = parseFloat(fmt.duration);

    check('codec',        stream.codec_name, x => x === 'pcm_s16le',  'pcm_s16le');
    check('sample_rate',  parseInt(stream.sample_rate, 10), x => x === 44100, '44100');
    check('channels',     stream.channels, x => x === 2, '2');
    // intro 5с + main 3с = 8с (silenceremove не отрезает sine — там нет silence в начале)
    check('duration',     dur, x => approxEq(x, 8.0, 0.15), '≈ 8.0 ± 0.15с');
}

function test2_flac24() {
    const inputPath = path.join(TMP_DIR, 'in_24.flac');
    synthFixture(inputPath, {
        codec: 'flac', sampleFmt: 's32', bitsPerRawSample: 24,
        sampleRate: 44100, channels: 1, durationSec: 1,
    });

    runCli(inputPath, ['--speeds', '1.0', '--ticks', '3']);

    const outPath = path.join(TMP_DIR, expectedOutputName(inputPath, 1.0, 'flac'));
    if (!fs.existsSync(outPath)) throw new Error(`выход не создан: ${outPath}`);

    const stream = ffprobeJson(outPath).streams[0];
    check('codec',                stream.codec_name, x => x === 'flac', 'flac');
    check('sample_fmt',           stream.sample_fmt, x => x === 's32',  's32');
    check('bits_per_raw_sample',  parseInt(stream.bits_per_raw_sample, 10), x => x === 24, '24');
}

function test3_pcmF32le() {
    const inputPath = path.join(TMP_DIR, 'in_f32.wav');
    synthFixture(inputPath, { codec: 'pcm_f32le', sampleRate: 44100, channels: 1, durationSec: 1 });

    runCli(inputPath, ['--speeds', '1.0', '--ticks', '3']);

    const outPath = path.join(TMP_DIR, expectedOutputName(inputPath, 1.0, 'wav'));
    if (!fs.existsSync(outPath)) throw new Error(`выход не создан: ${outPath}`);

    const stream = ffprobeJson(outPath).streams[0];
    check('codec',       stream.codec_name, x => x === 'pcm_f32le', 'pcm_f32le');
    check('sample_fmt',  stream.sample_fmt, x => x === 'flt',       'flt');
}

function test4_aacM4a() {
    const inputPath = path.join(TMP_DIR, 'in.m4a');
    // CBR 256k + 3с — детерминированный bitrate, заведомо удалённый от дефолта 192k.
    // (С `-q:a 4` source kbps плавает между ffmpeg-версиями и в редких случаях
    // может оказаться ~192, делая anti-regression check бесполезным — находка M2 внешнего аудита.)
    synthFixture(inputPath, {
        codec: 'aac', bitrate: '256k',
        sampleRate: 44100, channels: 2, durationSec: 3,
    });

    // Setup-sanity: убеждаемся что фикстура реально показывает bitrate далеко
    // от 192. Если ffmpeg выдал что-то в окрестности 192 — фикстура негодная,
    // тест бы прошёл при регрессии. Лучше явно упасть с осмысленной ошибкой.
    const srcProbe    = ffprobeJson(inputPath);
    const srcStreamBR = parseInt(srcProbe.streams[0].bit_rate, 10);
    const srcFormatBR = parseInt(srcProbe.format.bit_rate, 10);
    const srcBR = Number.isFinite(srcStreamBR) && srcStreamBR > 0 ? srcStreamBR : srcFormatBR;
    if (!Number.isFinite(srcBR) || srcBR <= 0) {
        throw new Error(`источник AAC без читаемого bit_rate: ${JSON.stringify(srcProbe.streams[0])}`);
    }
    const srcKbps = Math.round(srcBR / 1000);
    if (Math.abs(srcKbps - 192) <= 10) {
        throw new Error(
            `setup: source kbps=${srcKbps} слишком близко к дефолту 192 — ` +
            `фикстура неинформативная (не отличает «взято из источника» от «дефолт»). ` +
            `Поднять synth bitrate.`
        );
    }

    const cliRes = runCli(inputPath, ['--speeds', '1.0', '--ticks', '3']);

    const outPath = path.join(TMP_DIR, expectedOutputName(inputPath, 1.0, 'm4a'));
    if (!fs.existsSync(outPath)) throw new Error(`выход не создан: ${outPath}`);

    // Контракт Phase 1 NEW-P1.2: CLI читает source bitrate и передаёт его
    // ffmpeg'у как `-b:a`. Label `(AAC <N>k)` ровно отражает значение,
    // которое buildOutput() пушит в `-b:a` (одна и та же строка `outputSpec.bitrate`
    // в index.js: chooseOutputSpec → label = `AAC ${br}`, build → -b:a ${br}).
    const labelMatch = cliRes.stdout.match(/Сборка\s+\d+\s+верс[^()]+\(AAC\s+(\d+)k\)/);
    if (!labelMatch) {
        throw new Error(`не нашёл label «(AAC Nk)» в stdout CLI:\n${cliRes.stdout.slice(-600)}`);
    }
    const cliKbps = parseInt(labelMatch[1], 10);

    const outProbe  = ffprobeJson(outPath);
    const outStream = outProbe.streams[0];
    check('codec', outStream.codec_name, x => x === 'aac', 'aac');
    check('CLI bitrate label', cliKbps,
        x => approxEq(x, srcKbps, 5),
        `≈ source ${srcKbps} ±5 kbps`);
    check('not default 192k', cliKbps,
        x => x !== 192,
        `!== 192 (source=${srcKbps}, default=192)`);

    // Дополнительный output-side sanity (находка M1 внешнего аудита): ffmpeg aac encoder для
    // pure sine выдаёт ниже target bitrate (rate-distortion), но точно НЕ
    // должен болтаться на ~32k или внутри ~190..194 (то была бы регрессия
    // на дефолт 192k без чтения источника). Допускаем [40k .. srcKbps*1.3].
    const outStreamBR = parseInt(outStream.bit_rate, 10);
    const outFormatBR = parseInt(outProbe.format.bit_rate, 10);
    const outBR  = Number.isFinite(outStreamBR) && outStreamBR > 0 ? outStreamBR : outFormatBR;
    const outKbps = Math.round(outBR / 1000);
    check('output bit_rate not in default-192 zone', outKbps,
        x => Math.abs(x - 192) > 15 || cliKbps === 192,
        `вне [177..207] kbps (encoder для pure sine != дефолт)`);
    check('output bit_rate sane', outKbps,
        x => x >= 40 && x <= Math.round(srcKbps * 1.3),
        `[40 .. ${Math.round(srcKbps * 1.3)}] kbps (encoder rate-distortion для pure sine)`);
}

function test5_slowdown() {
    // Замедление требует librubberband. ffmpeg без него — не провал теста,
    // а ограничение окружения: печатаем SKIP (основной сценарий инструмента
    // на такой сборке в принципе не работает, но smoke не должен врать FAIL).
    const filters = run(FFMPEG, ['-hide_banner', '-filters']).stdout;
    if (!/ rubberband\s/.test(filters)) {
        console.log('    ~ SKIP: ffmpeg собран без librubberband');
        return;
    }

    const inputPath = path.join(TMP_DIR, 'in_slow.wav');
    synthFixture(inputPath, { codec: 'pcm_s16le', sampleRate: 44100, channels: 1, durationSec: 4 });

    runCli(inputPath, ['--speeds', '0.8', '--ticks', '3']);

    const outPath = path.join(TMP_DIR, expectedOutputName(inputPath, 0.8, 'wav'));
    if (!fs.existsSync(outPath)) throw new Error(`выход не создан: ${outPath}`);

    const probe = ffprobeJson(outPath);
    const dur   = parseFloat(probe.format.duration);
    // intro 3с + main 4с/0.8 = 3 + 5 = 8с. Допуск ±0.3с покрывает
    // блочную природу time-stretching (rubberband работает окнами).
    check('duration', dur, x => approxEq(x, 8.0, 0.3), '≈ 8.0 ± 0.3с (3с intro + 4с/0.8)');
    check('codec', probe.streams[0].codec_name, x => x === 'pcm_s16le', 'pcm_s16le');
}

function test6_setup() {
    const setupDir = path.join(TMP_DIR, 'setup_target');
    const r = run(NODE, [CLI, '--setup', setupDir]);
    // Код 2 = «развёрнуто, но не все зависимости найдены» (например, ffmpeg
    // без libmp3lame): файлы при этом уже скопированы, паритет проверяем.
    if (r.code !== 0 && r.code !== 2) {
        throw new Error(`--setup завершился с кодом ${r.code}:\nSTDOUT:\n${r.stdout.slice(-500)}\nSTDERR:\n${r.stderr.slice(-500)}`);
    }

    const deployedIndex = fs.readFileSync(path.join(setupDir, 'index.js'));
    const sourceIndex   = fs.readFileSync(CLI);
    check('index.js скопирован байт-в-байт', deployedIndex.equals(sourceIndex), x => x === true, 'true');

    // Нормализуем CRLF/LF: git на Windows может хранить файлы с разными
    // окончаниями строк, содержательно сравниваем текст.
    const norm = s => s.replace(/\r\n/g, '\n');
    const deployedBat = norm(fs.readFileSync(path.join(setupDir, 'run.bat'), 'utf8'));
    const repoBat     = norm(fs.readFileSync(path.join(ROOT, 'run.bat'), 'utf8'));
    check('run.bat == репозиторный run.bat', deployedBat === repoBat, x => x === true,
        'true (RUN_BAT_CONTENT в index.js разошёлся с run.bat в репо?)');
}

// ─── MAIN ────────────────────────────────────────────────────────────
function cleanup() {
    for (const p of cleanupTargets) {
        try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
}

function main() {
    console.log('MusicForDance smoke-test');
    console.log(`  CLI:  ${CLI}`);
    console.log(`  TMP:  ${TMP_DIR}`);

    if (!ffmpegAvailable()) {
        console.log('\nSKIP: ffmpeg/ffprobe не найдены в PATH (smoke требует их для синтеза фикстур).');
        cleanup();
        process.exit(0);
    }

    try {
        runTest('1/6 PCM s16 baseline (intro+main timing, format)', test1_pcmS16);
        runTest('2/6 FLAC 24-bit auto preserve',                    test2_flac24);
        runTest('3/6 pcm_f32le preserve',                           test3_pcmF32le);
        runTest('4/6 M4A AAC bitrate from source',                  test4_aacM4a);
        runTest('5/6 slowdown 0.8x via rubberband',                 test5_slowdown);
        runTest('6/6 --setup deploy + run.bat parity',              test6_setup);
    } finally {
        cleanup();
    }

    console.log('');
    if (testsFailed === 0) {
        console.log(`✓ smoke OK (${testsPassed}/${testsPassed} tests)`);
        process.exit(0);
    } else {
        console.log(`✗ smoke FAILED (${testsFailed} of ${testsPassed + testsFailed} tests)`);
        process.exit(1);
    }
}

// Подчистить tmp при любом неперехваченном выходе
process.on('exit', cleanup);
process.on('SIGINT',  () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

main();
