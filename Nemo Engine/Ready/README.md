# Nemo Engine 11.5.2 — Ready RU

Это две готовые русскоязычные сборки Nemo Engine для SillyTavern. Исходные `General RP` и `Default RP` не изменены.

## Какой файл выбрать

| Файл | Назначение |
| --- | --- |
| `Nemo Engine 11.5.2 - Ready RU RP.json` | Обычный связный RP, включая взрослые сцены, когда они нужны сюжету |
| `Nemo Engine 11.5.2 - Ready RU Gooner RP.json` | Gooner Vex, Gooner Protocol и инициативные партнёры без Slop/Masterpiece |

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

Все Fetish-переключатели по умолчанию выключены: заголовок раздела сам ничего не активирует. В Prompt Manager можно включить нужный модуль; это обычный переключатель, не программирование.

Без специального замысла не включайте вместе:

- `Feminization` и `Forced Fem Classic`;
- `NTR` и `Netori`;
- несколько обязательных HTML-панелей.

Для `Dating Sim`, `Corruption` или `Forced Fem Classic` включите также `Harmonized HTML`.

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

GitHub Actions запускает `Nemo Engine/tools/validate-ready-presets.mjs`. Проверяются исходный SHA-256, все 456 prompts, оба prompt-order, взаимоисключающие группы, planning/scratchpad-зависимости, взрослый стек, финальный runtime-tail и 97 regex.

