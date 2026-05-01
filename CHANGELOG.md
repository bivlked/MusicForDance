# Changelog

Все значимые изменения проекта документируются в этом файле.

Формат основан на [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
проект следует [Semantic Versioning](https://semver.org/lang/ru/).

## [Unreleased]

## [1.0.1] — 2026-05-01

Patch-релиз: исправления находок code-аудита от 2026-04-30 + smoke-тест.

### Исправлено
- **FLAC/ALAC bit-depth теперь гарантированно соответствует источнику.**
  Раньше `buildOutput()` не передавал `-sample_fmt`, и encoder выбирал формат
  сам — лейбл «FLAC 24-bit» мог не соответствовать реальному выходу. Теперь
  для FLAC 24-bit передаётся `-sample_fmt s32 -bits_per_raw_sample 24` (это
  единственный валидный способ хранить 24-bit в FLAC: формата `s24` в ffmpeg
  нет). Для ALAC используются planar форматы (`s16p` / `s32p`).
- **Bitrate для AAC/M4A с VBR теперь читается корректно.**
  `probe()` дополнительно запрашивает `format=bit_rate` через `-of json`
  и использует chain `streamBitRate → formatBitRate → default`. Раньше для
  VBR AAC, у которого stream `bit_rate=N/A`, происходил silent fallback
  на дефолт 192k. При попадании на format-fallback теперь печатается
  предупреждение `⚠ Bitrate из контейнера (stream=N/A): Nk`.
- **SIGINT теперь корректно убивает дочерний ffmpeg и удаляет временный
  intro-файл.** Раньше `process.exit(130)` срабатывал сразу — ffmpeg-процесс
  оставался зомби, временный WAV в `os.tmpdir()` не удалялся. Теперь handler
  посылает `SIGTERM`, ждёт `child.once('close')` (с 2-секундным watchdog
  на `SIGKILL`), очищает temp-файл и только потом завершает процесс.
- **`pcm_f32le` источник больше не квантизируется silently в `pcm_s32le`.**
  `pcmCodecForBits(bits, isFloat)` принимает дополнительный флаг и для
  32-bit float возвращает `pcm_f32le`. Лейбл выхода — `WAV 32-bit float`.

### Добавлено
- **Smoke-test `tests/smoke.js`** — end-to-end проверка четырёх ключевых
  pipeline'ов (PCM s16, FLAC 24-bit auto preserve, pcm_f32le auto preserve,
  M4A AAC bitrate-from-source). Использует только built-in модули Node.js
  и системные ffmpeg/ffprobe; пропускается с exit 0 если ffmpeg отсутствует.
- **Предупреждения о snap sample rate** для MP3/Opus когда rate источника
  не входит в поддерживаемый набор (`⚠ MP3 не поддерживает 96000 Hz →
  snap к 48000 Hz`).
- **Строка `WAV PCM 32-bit float` в таблице «Формат и качество выхода»**
  README — отражает новое поведение для `pcm_f32le` источников.

### Изменено
- **LICENSE**: copyright «MusicForDance contributors» → «bivlked».
- **`parseArgs()`**: `--help` теперь устанавливает флаг `helpRequested`
  вместо inline `process.exit(0)`. Обрабатывается в `main()` до
  `validateArgs()` — поведение для пользователя не меняется
  (`node index.js --help` по-прежнему печатает справку и выходит с 0).

## [1.0.0] — 2026-04-30

Первый публичный релиз.

### Добавлено
- Single-file CLI: вся логика в одном `index.js`.
- Генерация WAV/MP3/FLAC/AAC/Opus/Vorbis/AC3 файлов с обратным отсчётом тиков
  (4 коротких + 1 длинный гудок 1с).
- Замедленные версии 0.9× / 0.8× / 0.7× через `librubberband` с сохранением высоты тона.
- Sample-accurate выравнивание длинного финального тика с началом музыки
  (фильтр `silenceremove` с `detection=peak:window=0`, `asetpts=N/SR/TB`
  на обоих стримах перед `concat`).
- **Auto-format mode (default)**: выходной формат и качество совпадают с
  исходным (MP3 320k → MP3 320k; FLAC 24-bit → FLAC 24-bit; WAV 16-bit →
  WAV 16-bit; AAC 256k → AAC 256k и т.д.).
- Поддержка форматов на входе: WAV, MP3, M4A/AAC, FLAC, OGG, WMA, OPUS, AC3 и др.
- Auto-downmix surround (5.1, 7.1) → stereo.
- Флаг `--mp3` для принудительного MP3 (bitrate из источника или 192k fallback);
  автоснап sample rate к ближайшему MP3-supported (8/11.025/12/16/22.05/24/32/44.1/48 кГц).
- Флаг `--wav` для принудительного WAV PCM (lossless).
- Флаг `--bitrate <X>` (`-b`) для override bitrate в lossy форматах.
- Флаг `--setup <target>` для self-deploy на новый ПК (копирует index.js
  + генерит run.bat + проверяет ffmpeg/librubberband/libmp3lame с
  install hints через `winget`).
- Флаг `--force` (`-f`) для перезаписи непустой папки в `--setup`.
- Multi-input: обработка нескольких файлов в одном запуске.
- Drag-drop wrapper `run.bat` с UTF-8 console (chcp 65001) и `%*` для
  передачи всех аргументов.
- Строгая валидация аргументов: `--ticks` только integer, `--speeds`
  только числа, отказ от неизвестных флагов.
- Detection collision имён выходов (например `0.9996` и `1.0` оба → `1.0x`).
- TTY-aware вывод: ANSI-прогресс на терминале, чистые `✓`-строки в pipe.
- Обработка SIGINT/SIGTERM для корректного завершения.

### Качество
- Bulk-copy WAV-encoder: `Buffer.from(typedArray.buffer).copy(dest)` —
  ~50× быстрее побайтового цикла.
- Lossy-источники при принудительном `--wav` выходят 24-bit (избегаем 16-bit
  квантизации decoded-float-данных).
- Длинный финальный тик: env=0 на самом последнем сэмпле (нет микро-щелчка
  на стыке с музыкой).

[Unreleased]: https://github.com/bivlked/MusicForDance/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/bivlked/MusicForDance/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/bivlked/MusicForDance/releases/tag/v1.0.0
