# MusicForDance

> CLI-инструмент для подготовки танцевальных треков с обратным отсчётом и замедленными копиями для разучивания хореографии.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-brightgreen.svg)](https://nodejs.org)
[![ffmpeg](https://img.shields.io/badge/ffmpeg-required-orange.svg)](https://ffmpeg.org)
[![Single file](https://img.shields.io/badge/distribution-single--file-success.svg)](#deploy-на-новый-пк)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#требования)

---

## TL;DR

Из одного аудиофайла генерирует **4 версии** для танцевального класса:

| Файл                   | Скорость | Назначение                                           |
|------------------------|---------:|------------------------------------------------------|
| `1.0x <name>.<ext>`    |   100 %  | оригинал + 5 тиков обратного отсчёта                 |
| `0.9x <name>.<ext>`    |    90 %  | замедление 10 % с сохранением высоты тона            |
| `0.8x <name>.<ext>`    |    80 %  | замедление 20 %                                      |
| `0.7x <name>.<ext>`    |    70 %  | замедление 30 %                                      |

**Расширение и качество выхода по умолчанию совпадают с исходником**:
MP3 320k → MP3 320k, FLAC 24-bit → FLAC 24-bit, WAV 16-bit → WAV 16-bit.

В каждой версии перед музыкой 5 тиков (4 коротких + 1 длинный 1с). Длинный
тик заканчивается **точно в момент начала музыки** — для синхронного старта
группы. Тики не растягиваются вместе с музыкой; растягивается только трек.

---

## Зачем это нужно

В танцевальном классе хореограф запускает трек, и группа должна стартовать
синхронно. Если трек начинается резко, без обратного отсчёта — половина
танцоров промахивается с первым шагом. Если использовать готовые
«countdown intro» в качестве отдельной дорожки — каждый раз нужно вручную
сводить тайминг.

Этот инструмент:

- **Автоматически** обрезает тишину в начале трека (sample-accurate).
- **Прибавляет** обратный отсчёт, синхронизированный с первым звуком.
- **Создаёт замедленные версии** (0.7× / 0.8× / 0.9×) с pitch preservation —
  чтобы можно было разбирать хореографию на меньшей скорости, не страдая
  от «гнусавости» замедленного вокала.
- **Сохраняет формат и качество исходника** (по умолчанию).

---

## Установка

### Требования

- **[Node.js](https://nodejs.org/) 18+**
- **[ffmpeg](https://ffmpeg.org/) 6+** собранный с `--enable-librubberband`
  (и `--enable-libmp3lame` для опционального `--mp3`).

### Установка зависимостей (Windows)

```powershell
winget install OpenJS.NodeJS
winget install Gyan.FFmpeg     # full build с librubberband + libmp3lame
# затем перезапустить терминал, чтобы PATH обновился
```

### Установка зависимостей (macOS / Linux)

```bash
# macOS
brew install node ffmpeg

# Debian / Ubuntu
sudo apt install nodejs ffmpeg
```

> **Важно:** ffmpeg должен включать `librubberband`. Проверка:
> `ffmpeg -filters | grep rubberband` должен вывести строку с `rubberband`.

### Получить инструмент

Скачать только `index.js` с GitHub (single-file, ничего больше не нужно):

```powershell
# Windows PowerShell
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/bivlked/MusicForDance/main/index.js" -OutFile "index.js"
```

```bash
# macOS / Linux
curl -O https://raw.githubusercontent.com/bivlked/MusicForDance/main/index.js
```

Или клонировать весь репозиторий:

```bash
git clone https://github.com/bivlked/MusicForDance.git
cd MusicForDance
```

---

## Использование

### 1. Drag-and-drop (Windows)

Перетащи аудиофайл (`.wav` / `.mp3` / `.m4a` / `.flac` / …) на `run.bat`.
Получишь 4 файла рядом с источником в **том же формате/качестве**.

### 2. Командная строка

```bash
# Auto-mode: формат и bitrate как у источника
node index.js "track.mp3"      # → mp3 c bitrate из source
node index.js "track.flac"     # → flac, тот же bit depth
node index.js "track.wav"      # → wav, тот же bit depth

# Принудительный формат
node index.js "track.mp3" --wav                  # → wav 24-bit
node index.js "track.wav" --mp3                  # → mp3 192k
node index.js "track.mp3" --bitrate 320k         # → mp3 320k

# Несколько файлов сразу
node index.js a.wav b.mp3 c.flac --out-dir ./batch

# Custom скорости
node index.js track.wav --ticks 4 --speeds 1.0,0.85,0.7
```

### 3. Получить справку

```bash
node index.js --help
```

---

## Опции

| Опция                | Default                | Описание                                                              |
|----------------------|------------------------|-----------------------------------------------------------------------|
| `--ticks <N>`        | `5`                    | Количество тиков в отсчёте (1..20). Последний всегда длинный.         |
| `--silence-db <X>`   | `-50`                  | Порог тишины в dB для обрезки начала. Диапазон −120..0.               |
| `--speeds <a,b,c>`   | `1.0,0.9,0.8,0.7`      | Список скоростей через запятую. Каждая в диапазоне 0.25..4.           |
| `--mp3`              | (выкл.)                | Принудительно MP3 (bitrate из источника или 192k fallback).           |
| `--wav`              | (выкл.)                | Принудительно WAV PCM (lossless).                                     |
| `--bitrate <X>, -b`  | (из источника)         | Bitrate для lossy: `320k`, `128k`, `320`. Override.                   |
| `--out-dir <path>`   | рядом с источником     | Папка для результатов (создаётся при необходимости).                  |
| `--setup <target>`   | —                      | Развернуть проект (`index.js` + `run.bat`) в указанную папку.         |
| `--force`, `-f`      | (выкл.)                | Разрешить `--setup` в непустую папку (перезаписывает файлы).          |
| `-h`, `--help`       |                        | Справка.                                                              |

---

## Формат и качество выхода

**По умолчанию** инструмент сохраняет codec, bitrate (для lossy) и bit depth
(для lossless) исходника:

| Источник                  | Auto-выход                      |
|---------------------------|---------------------------------|
| MP3 320 kbps              | MP3 320 kbps                    |
| MP3 128 kbps              | MP3 128 kbps                    |
| AAC 256 kbps (M4A)        | AAC 256 kbps (M4A)              |
| FLAC 24-bit               | FLAC 24-bit                     |
| FLAC 16-bit               | FLAC 16-bit                     |
| WAV PCM 32-bit            | WAV PCM 32-bit                  |
| WAV PCM 32-bit float      | WAV PCM 32-bit float            |
| WAV PCM 24-bit            | WAV PCM 24-bit                  |
| WAV PCM 16-bit            | WAV PCM 16-bit                  |
| Opus                      | Opus (bitrate из источника)     |
| Vorbis (OGG)              | Vorbis (OGG)                    |
| AC3 / E-AC3               | AC3 / E-AC3                     |
| ALAC                      | ALAC                            |
| WMA, DTS (нет encoder)    | fallback на WAV 24-bit          |

Сэмпл-rate сохраняется (с автоматическим снапом к ближайшему поддерживаемому
для MP3/Opus, если у источника редкий rate).

### Принудительные форматы

- `--wav` → PCM WAV. Bit depth = source (lossless) или 24-bit (lossy source).
- `--mp3` → libmp3lame. Bitrate = source-mp3-rate, иначе 192k.
- `--bitrate 320k` → переопределить bitrate в lossy.

---

## Deploy на новый ПК

Single-file architecture: для деплоя нужен только `index.js`.

1. Скопировать **только `index.js`** (через USB / OneDrive / e-mail).
2. Выполнить:
   ```bash
   node index.js --setup C:\Tools\MusicForDance
   ```
3. В целевой папке появятся `index.js` + `run.bat`. Также проверится наличие
   ffmpeg / librubberband / libmp3lame — со ссылками на установку, если
   чего-то не хватает.

Пример вывода `--setup`:

```
[setup] Целевая папка: C:\Tools\MusicForDance
[setup] ✓ index.js  (32.1 KB)
[setup] ✓ run.bat

[setup] Проверка окружения:
  ✓ Node.js — v24.15.0
  ✓ ffmpeg — 8.1-full_build-www.gyan.dev
  ✓ librubberband filter
  ✓ libmp3lame encoder

[setup] Готово. Использование на этом ПК:
  cd "C:\Tools\MusicForDance"
  node index.js "путь\к\треку.mp3"
  (или перетащи аудиофайл на run.bat)
```

---

## Пример вывода

```
[1/3] Анализ «track.mp3»
      mp3, 44100 Hz, 2ch, 0-bit, 320 kbps, длительность 215.43 с

[2/3] Генерация intro (5 тиков, 44100 Hz, stereo)
      861.3 KB → tmp

[3/3] Сборка 4 версий (MP3 320k)
  ✓ 1.0x track.mp3  (1.4s)
  ✓ 0.9x track.mp3  (8.2s)
  ✓ 0.8x track.mp3  (9.1s)
  ✓ 0.7x track.mp3  (10.6s)

Готово за 29.3s. Файлы в: C:\Music\Class
```

---

## Как это работает

Один процесс `ffmpeg` на каждую выходную версию: обрезка тишины в начале трека → замедление с сохранением высоты тона → склейка с заранее сгенерированным intro. Без промежуточных файлов на диске.

> 📚 **Подробности с диаграммой и расшифровкой каждого фильтра** — [docs/ARCHITECTURE.md §1](docs/ARCHITECTURE.md#1-цепочка-обработки-аудио).

---

## Качество и пережатие

В режиме по умолчанию выходные файлы остаются в том же кодеке и с тем же качеством, что и исходник: WAV/FLAC/ALAC — без потерь, MP3/AAC/Opus/Vorbis/AC3 — одна стадия повторного сжатия в тот же кодек с тем же битрейтом. На битрейте 192 кб/с и выше повторное сжатие практически неотличимо от оригинала на слух.

> 📚 **Подробности по форматам, точности 24-bit FLAC/ALAC, обработке VBR-кодеков и предупреждениям о смене частоты** — [docs/ARCHITECTURE.md §2](docs/ARCHITECTURE.md#2-качество-и-пережатие).

---

## Поддерживаемые форматы

**Входные:** WAV, MP3, M4A/AAC, FLAC, OGG, WMA, OPUS, AC3 и любой другой
формат, который читает ffmpeg.

**Каналы:** mono или stereo. Surround (5.1, 7.1) автоматически downmix → stereo.

**Sample rate:** сохраняется в выходе (с автоснапом для MP3/Opus при
редких rates источника).

---

## Структура репозитория

```
MusicForDance/
├── index.js          ← Единственный исполняемый файл (всё внутри)
├── package.json      ← Метаданные проекта
├── run.bat           ← Drag-drop wrapper для Windows
├── CHANGELOG.md      ← История версий
├── LICENSE           ← MIT
├── .gitignore
└── README.md
```

---

## Дизайн тиков

Короткий тик — 60 мс щелчка + 940 мс тишины (всего 1 секунда). Длинный финальный тик — ровно 1 секунда непрерывного звука, заканчивается **точно на последнем сэмпле intro** — следом без паузы начинается музыка. Это позволяет группе танцоров стартовать синхронно по обрыву длинного гудка.

> 📚 **Подробности про частоты, огибающую, как поменять тембр тиков** — [docs/ARCHITECTURE.md §3](docs/ARCHITECTURE.md#3-дизайн-тиков-обратного-отсчёта).

---

## Производительность

Тестовый трек 162 с / 24-bit / 48 kHz / stereo:

| Версия | Время    |
|--------|---------:|
| 1.0×   |  ~0.1 с  |
| 0.9×   |  ~6.7 с  |
| 0.8×   |  ~7.6 с  |
| 0.7×   |  ~8.9 с  |
| **Σ**  | **~23 с** |

`--mp3` режим примерно столько же + ~1.5 с на mp3-кодирование 1.0×.

---

## Ограничения

- **Sample-accurate trim** обрезает всё ниже `--silence-db` (default −50 dB)
  как «не музыку». Если в треке есть тихий осмысленный intro (например
  ambient на −55 dB) — понизь порог: `--silence-db -90`.
- **Surround** автоматически сводится к стерео. Если нужно сохранить 5.1 —
  обработай каналы вручную через ffmpeg отдельно.
- **MP3** поддерживает максимум 48 kHz; 96+ kHz источники ресэмплируются
  автоматически до 48 kHz.
- **WMA, DTS** не имеют encoder в стандартном ffmpeg — fallback на WAV 24-bit.

---

## Качество замедления

Замедление работает через библиотеку `librubberband` — растягивает трек по времени, не меняя высоту тона (без эффекта замедленной плёнки и «гнусавого» вокала). На скоростях 0.7–0.9× артефакты минимальны для популярной и танцевальной музыки.

> 📚 **Подробности про движки R2 / R3 librubberband и как добиться максимального качества** — [docs/ARCHITECTURE.md §4](docs/ARCHITECTURE.md#4-замедление-через-librubberband).

---

## Лицензия

[MIT](LICENSE) © 2026

---

## Contributing

Pull requests welcome. Ожидания:

- Single-file architecture сохраняется (никаких `lib/` или `node_modules`).
- Любые claim в README о sample-accurate или lossless должны быть подкреплены
  кодом (фильтрами ffmpeg или явной проверкой).
- Изменения в pipeline проверяются через `silencedetect` на тестовом
  файле — длинный гудок должен заканчиваться ровно на 5.0с.

История версий — в [CHANGELOG.md](CHANGELOG.md).
