# Nemo Engine 11.5.2 — Ready RU

Это три готовые русскоязычные сборки Nemo Engine для SillyTavern. Каждая воспроизводимо собирается из канонического `General RP`; `Default RP` не изменён.

## Какой файл выбрать

| Файл | Назначение |
| --- | --- |
| `Nemo Engine 11.5.2 - Ready RU RP.json` | Обычный связный RP, включая взрослые сцены, когда они нужны сюжету |
| `Nemo Engine 11.5.2 - Ready RU Gooner RP.json` | Gooner Vex, Gooner Protocol и инициативные партнёры без Slop/Masterpiece |
| `Nemo Engine 11.5.2 - Ready RU Psychology Humiliation JOI RP.json` | Narrative Vex, психологический реализм, Humiliation и JOI с прямой речью и управляемой процедурой |

## Установка

1. Скачайте один JSON из этой папки.
2. В SillyTavern откройте **AI Response Configuration**.
3. В **Chat Completion Presets** нажмите **Import** и выберите скачанный файл.
4. Выберите импортированный preset в списке.

Код, терминал и ручное копирование prompt-ов не нужны.

## Что исправлено

- оба runtime-профиля приведены к одной конфигурации;
- оставлена ровно одна Vex-персона;
- выбраны `Balanced` и `Grounded` вместо конфликтующего shipped-набора;
- включены Main Prompt, Main Plan и Character Turn Simulation;
- Pacing Beats и Narrative Hook получили необходимую planning-цепочку;
- включён Modular Scratchpad вместе с Consequence Tab и Loader Resolver;
- служебный scratchpad скрыт из отображения, но остаётся в контексте;
- planning и narration сразу выбраны на русском;
- старое упоминание выключенного Council удалено из assistant prefill;
- очистка старых HTML-блоков включена;
- внутренний план не показывается пользователю.

## Fetish

В обычной и Gooner-сборках все Fetish-переключатели выключены: заголовок раздела сам ничего не активирует. В Psychology Humiliation JOI включены только `Humiliation` и `JOI`; остальные Fetish-модули остаются выключенными. В Prompt Manager можно изменить выбор вручную.

Без специального замысла не включайте вместе:

- `Feminization` и `Forced Fem Classic`;
- `NTR` и `Netori`;
- несколько обязательных HTML-панелей.

Для `Dating Sim`, `Corruption` или `Forced Fem Classic` включите также `Harmonized HTML`.

## Psychology Humiliation JOI

Третья сборка основана на обычном Narrative-профиле, а не на Gooner Vex. В ней включены `Dirty Talk`, `Dom Language`, `Manipulation Realism`, `Psychological & Emotional Realism`, `Humiliation` и `JOI`. JOI ведёт интерактивную процедуру по подтверждённому состоянию разговора, поддерживает остановку и паузу и завершает сессию явным выходом и нейтральной проверкой состояния; она не имитирует настоящий таймер и не выдумывает действия пользователя.

Остальные Fetish-модули, Gooner Protocol, Proactive Partners, Slop и Masterpiece остаются выключенными, поэтому профиль не смешивает несовместимые режимы автоматически.

## Gooner

Во втором файле уже включены совместимые `Gooner Vex`, `Modern NSFW Core`, `Gooner Protocol` и `Proactive Partners`.

`Gooner Slop` и `Gooner’s Masterpiece` намеренно выключены: они подменяют самостоятельных персонажей функциями удовлетворения и конфликтуют с причинным ядром Nemo. Их можно включить вручную только для намеренно упрощённого режима.

## Trackers

Trackers по умолчанию выключены, поэтому они не засоряют каждый ответ панелями. Если нужен tracker, включите:

1. один renderer (`HTML/CSS`, `ASCII` или `Regex`);
2. нужный tracker;
3. центральный `Tracker Toggle`;
4. одну theme, если выбранный renderer её использует.

## ChatGPT

В ChatGPT эти presets используются как спецификация письма. Точный SillyTavern runtime — макросы, depth injection, автоматические regex, tracker UI и постоянный scratchpad — требует импорта JSON в SillyTavern.

## Проверка

GitHub Actions сначала пересобирает Ready-файлы, затем запускает `Nemo Engine/tools/validate-ready-presets.mjs` и проверяет отсутствие расхождений с генератором. Проверяются исходный SHA-256, все 458 prompts, три варианта, оба prompt-order, взаимоисключающие группы, planning/scratchpad-зависимости, взрослый стек, финальный runtime-tail и 97 regex.
