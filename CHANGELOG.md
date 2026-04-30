# Changelog

Все значимые изменения проекта документируются в этом файле.

Формат основан на [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
проект следует [Semantic Versioning](https://semver.org/lang/ru/).

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
