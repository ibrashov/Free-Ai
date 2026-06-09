# Free AI Chat Full Guide

Этот документ описывает текущий проект `free-ai-vscode-chat`: что он делает, как устроен, как его запускать, как он читает и редактирует файлы, как связан с Odysseus, и что важно знать другому ИИ, если ему отправляют этот проект на анализ.

## 1. Коротко

`Free AI Chat` - это локальная VS Code extension-панель для общения с бесплатными/локальными AI-провайдерами через локальный gateway `free-claude-code`.

Основная цель:

```text
Free AI Chat = быстрый чат, объяснения, чтение файлов, предлагаемые правки
Codex/Odysseus = более надежная агентная работа, инструменты, сложные задачи
```

На данный момент Free AI Chat уже умеет:

- открываться как отдельная панель **Free AI** в VS Code;
- отправлять запросы в локальный gateway `http://127.0.0.1:8082`;
- выбирать провайдера: `Auto`, `Cerebras`, `Gemini`, `Gemini Fast`, `Groq`, `OpenRouter`, `Ollama`;
- сохранять локальную историю запросов;
- прикреплять текстовые/кодовые файлы кнопкой **Add file**;
- автоматически читать файлы по `@filename` из открытого workspace;
- просить модель сделать edit файла;
- показывать кнопку **Apply edit**;
- применять правку к файлу только после подтверждения пользователя в VS Code.

## 2. Главная архитектура

```text
VS Code Free AI panel
        |
        v
extension/extension.js
        |
        v
free-claude-code gateway
http://127.0.0.1:8082
        |
        v
Cerebras / Gemini / Groq / OpenRouter / Ollama
```

Отдельно рядом может работать Odysseus:

```text
Odysseus UI
http://127.0.0.1:7000
        |
        v
same free AI gateway
http://127.0.0.1:8082
```

То есть Free AI Chat и Odysseus могут использовать один и тот же локальный gateway, но это разные интерфейсы:

- Free AI Chat живет внутри VS Code.
- Odysseus живет как web UI на `127.0.0.1:7000`.

## 3. Важные пути проекта

Корень проекта:

```text
C:\Users\Ануар\Desktop\Папки\Anuar\free-ai-vscode-chat
```

Основные файлы:

```text
extension/extension.js
```

Главный код VS Code extension. Здесь находится:

- UI webview;
- отправка запроса в gateway;
- кнопка Add file;
- чтение `@filename`;
- безопасный Apply edit;
- история сообщений.

```text
extension/package.json
```

Manifest VS Code extension:

- id панели;
- команда `Free AI: Open Chat`;
- настройки gateway URL, auth token, default provider.

```text
extension/media/free-ai.svg
```

Иконка activity bar.

```text
scripts/Start-FreeAIConsole.ps1
scripts/Ask-FreeAI.ps1
```

PowerShell-скрипты для терминального использования Free AI.

```text
docs/
```

Документация проекта.

## 4. Gateway

Free AI Chat ожидает, что локальный gateway запущен здесь:

```text
http://127.0.0.1:8082
```

Проверка:

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:8082/health"
```

Ожидаемый ответ:

```json
{"status":"healthy"}
```

Auth token по умолчанию:

```text
freecc
```

Настройки VS Code:

```json
"freeAiConsole.gatewayUrl": "http://127.0.0.1:8082",
"freeAiConsole.authToken": "freecc",
"freeAiConsole.odysseusUrl": "http://127.0.0.1:7000",
"freeAiConsole.defaultProvider": "auto"
```

## 5. Установка расширения

Из папки extension:

```powershell
cd C:\Users\Ануар\Desktop\Папки\Anuar\free-ai-vscode-chat\extension
npx @vscode/vsce package --allow-missing-repository
code --install-extension .\anuar-free-ai-console-0.2.0.vsix --force
```

После установки нужно перезагрузить VS Code:

```text
Ctrl+Shift+P
Developer: Reload Window
```

Потом открыть activity bar icon **Free AI**.

## 6. Как пользоваться обычным чатом

Открой панель **Free AI** в VS Code.

Примеры:

```text
Explain this Flutter error simply
```

```text
Give me a plan for a GPS vehicle tracking app
```

```text
Write a simple Dart class for a lesson model
```

Отправка:

- кнопка **Send**;
- или `Ctrl+Enter`.

## 7. Провайдеры

В панели есть dropdown:

```text
Auto
Cerebras
Gemini
Gemini Fast
Groq
OpenRouter
Ollama
```

`Auto` сейчас работает консервативно:

```text
обычный запрос -> Cerebras
offline/local/private/ollama -> Ollama
```

Это сделано потому, что бесплатные провайдеры могут быть нестабильны.

## 8. Чтение файлов через Add file

Кнопка **Add file** открывает VS Code file picker.

Поддерживаются в первую очередь текстовые и кодовые файлы:

```text
txt, md, js, ts, jsx, tsx, dart, py, java, kt,
html, css, json, yaml, yml, xml, csv, log, sql
```

После выбора файла он появляется в списке attached files.

Пример запроса:

```text
Прочитай этот файл и объясни, что он делает
```

Или:

```text
Find bugs in the attached file
```

Что происходит технически:

1. Расширение читает файл через `vscode.workspace.fs.readFile`.
2. Содержимое добавляется в prompt внутри блока `--- ATTACHED FILES ---`.
3. Модель видит текст файла как контекст.
4. Модель отвечает в чат.

## 9. Чтение файлов через @filename

Теперь Free AI Chat умеет читать файлы без ручного прикрепления.

Формат:

```text
@filename
```

Примеры:

```text
Прочитай @README.md и кратко объясни проект
```

```text
Проверь @lib/main.dart и найди ошибку
```

```text
Edit @scripts/Start-FreeAIConsole.ps1 and fix the bug
```

Что происходит:

1. Расширение ищет `@filename` в тексте prompt.
2. Ищет этот файл внутри открытого VS Code workspace.
3. Если файл найден и безопасен, читает его.
4. Добавляет содержимое файла в prompt.
5. В истории показывает:

```text
Auto-read files:
- README.md
```

Ограничения:

- максимум 5 файлов за запрос;
- файл читается максимум до 50 000 символов;
- бинарные файлы пропускаются;
- поиск идет только внутри открытого workspace.

## 10. Защита секретных файлов

Расширение намеренно пропускает потенциально секретные файлы.

Примеры защищенных имен:

```text
.env
.env.local
token
secret
credentials
private-key
id_rsa
id_ed25519
*.pem
*.p12
*.pfx
*.key
```

Если пользователь напишет:

```text
read @.env
```

расширение должно пропустить этот файл.

## 11. Как работает edit файлов

Free AI Chat не имеет прямого свободного доступа к файловой системе как полноценный агент.

Вместо этого сделан безопасный workflow:

1. Пользователь дает файл через **Add file** или `@filename`.
2. Модель читает файл.
3. Если пользователь просит edit, модель должна вернуть полный новый текст файла в специальном формате.
4. Расширение распознает этот формат.
5. В чате появляется кнопка **Apply edit**.
6. Пользователь нажимает **Apply edit**.
7. VS Code показывает confirm dialog.
8. Только после подтверждения расширение записывает файл.

Это важно:

```text
Модель не пишет файл напрямую.
Расширение пишет файл только после подтверждения пользователя.
```

## 12. Формат edit-протокола

Когда модель хочет изменить файл, она должна вернуть:

```xml
<free_ai_file_edits>
<file path="exact attached file path">
complete new file content
</file>
</free_ai_file_edits>
```

Пример:

```xml
<free_ai_file_edits>
<file path="C:\Users\Ануар\Desktop\Project\README.md">
# New README

Updated content here.
</file>
</free_ai_file_edits>
```

Расширение проверяет:

- путь должен совпадать с файлом, который был прикреплен или прочитан через `@filename`;
- если путь не совпадает, правка игнорируется;
- если формат сломан, кнопка Apply edit не появится.

Поддерживается также старый JSON fallback:

```xml
<free_ai_file_edits>
[{"path":"exact attached file path","content":"complete new file content"}]
</free_ai_file_edits>
```

Но основной формат лучше использовать XML-like с `<file path="...">`.

## 13. Примеры edit-запросов

Через Add file:

```text
Add file -> выбрать README.md

Edit this file and make the introduction shorter
```

Через @filename:

```text
Edit @README.md and fix grammar mistakes
```

```text
Edit @lib/main.dart and add comments explaining the main widget
```

```text
Проверь @scripts/Start-FreeAIConsole.ps1 и исправь проблему, если найдешь
```

После ответа:

```text
Apply edit
```

Потом подтвердить в VS Code.

## 14. Чем Free AI Chat отличается от Codex

Codex:

- полноценный coding agent;
- может читать и редактировать workspace напрямую;
- может запускать команды и тесты;
- умеет сам применять патчи;
- лучше подходит для серьезной реализации.

Free AI Chat:

- легкая VS Code chat-панель;
- использует бесплатный/local gateway;
- читает файлы через Add file или `@filename`;
- может подготовить edit;
- применяет edit только по кнопке и подтверждению;
- не запускает команды;
- не делает сложную навигацию по проекту как агент.

## 15. Чем Free AI Chat отличается от Odysseus

Odysseus:

- отдельное web-приложение на `http://127.0.0.1:7000`;
- имеет agent mode;
- может вызывать tools;
- может читать/писать файлы через свои инструменты;
- более похож на self-hosted AI workspace.

Free AI Chat:

- встроен прямо в VS Code;
- проще и быстрее для небольших вопросов;
- теперь умеет безопасные file edits через подтверждение;
- не является полноценной заменой Odysseus agent mode.

## 16. Текущий статус интеграции с Odysseus

Проверенное состояние:

```text
Free AI gateway: http://127.0.0.1:8082/health -> healthy
Odysseus:        http://127.0.0.1:7000/api/health -> healthy
```

Odysseus был настроен так, чтобы локальный gateway `127.0.0.1:8082` считался Anthropic-compatible endpoint.

Free AI Chat и Odysseus могут использовать один gateway параллельно.

В версии `0.2.0` в панели Free AI есть кнопка **Odysseus**, а в Command Palette есть команда `Free AI: Open Odysseus Chat`. Они открывают локальный Odysseus UI по настройке `freeAiConsole.odysseusUrl`.

## 17. Ограничения

Free AI Chat пока не делает:

- shell command execution;
- full project indexing;
- deep multi-file refactoring без явного `@file`;
- гарантированно правильные edits на больших файлах;
- автоматический запуск тестов;
- полноценные tool calls как Codex/Odysseus.

Практически:

```text
маленький edit одного файла -> хорошо
прочитать файл и объяснить -> хорошо
создать план/архитектуру -> хорошо
большая миграция проекта -> лучше Codex/Odysseus
```

## 18. Что знать другому ИИ

Если этот документ отправляют другому ИИ, важно понимать:

1. Это локальный VS Code extension project.
2. Главный файл реализации: `extension/extension.js`.
3. Gateway находится на `http://127.0.0.1:8082`.
4. Free AI Chat использует Anthropic-style `/v1/messages`.
5. Ответ gateway приходит как SSE stream.
6. `parseSseText()` собирает текст из `content_block_delta`.
7. Файлы читаются двумя способами:
   - explicit picker: **Add file**;
   - inline reference: `@filename`.
8. Edits применяются только через extension-side confirmation.
9. Модель должна вернуть edit в блоке `<free_ai_file_edits>`.
10. Расширение не должно давать модели свободную запись любых файлов.

## 19. Главные функции в extension.js

```text
answer()
```

Главный обработчик запроса пользователя:

- принимает prompt;
- добавляет файлы из `@filename`;
- выбирает provider;
- вызывает gateway;
- извлекает edit-блоки;
- отправляет ответ в webview.

```text
pickFilesForPrompt()
```

Открывает VS Code file picker и читает выбранные файлы.

```text
resolveWorkspaceFileReferences()
```

Ищет и читает файлы, указанные как `@filename`.

```text
extractAllowedEdits()
```

Проверяет edit-блоки от модели и разрешает только те пути, которые были прочитаны пользователем.

```text
applyPendingEdit()
```

Показывает confirmation dialog и записывает файл через `vscode.workspace.fs.writeFile`.

```text
appendFilesToPrompt()
```

Добавляет содержимое файлов в prompt.

```text
extractFileEditBlocks()
```

Парсит `<free_ai_file_edits>`.

## 20. Пример полного сценария

Пользователь пишет:

```text
Edit @README.md and add a short installation section
```

Расширение:

```text
1. Находит README.md в workspace.
2. Читает файл.
3. Добавляет его в prompt.
4. Отправляет prompt в gateway.
```

Модель должна вернуть:

```xml
<free_ai_file_edits>
<file path="C:\...\README.md">
полный новый README.md
</file>
</free_ai_file_edits>
```

Расширение:

```text
1. Проверяет путь.
2. Создает pending edit.
3. Показывает кнопку Apply edit.
4. После подтверждения пользователя записывает README.md.
```

## 21. Как быстро проверить после установки

1. Перезагрузить VS Code:

```text
Developer: Reload Window
```

2. Открыть панель **Free AI**.

3. Проверить чтение:

```text
Read @README.md and summarize it in 3 bullets
```

4. Проверить edit на безопасном тестовом файле:

Создать файл:

```text
test-free-ai-edit.txt
```

Содержимое:

```text
hello
```

Спросить:

```text
Edit @test-free-ai-edit.txt and change hello to hello from Free AI
```

Ожидаемо:

- появится ответ;
- появится кнопка **Apply edit**;
- VS Code спросит подтверждение;
- после подтверждения файл изменится.

## 22. Рекомендованный workflow

Для простых задач:

```text
Free AI Chat
```

Для задач с одним файлом:

```text
Free AI Chat + @filename + Apply edit
```

Для сложных задач:

```text
Codex или Odysseus
```

Для проверки проекта:

```text
Codex запускает команды и тесты
Free AI объясняет идеи и предлагает варианты
Odysseus может работать как self-hosted agent UI
```

## 23. Важное предупреждение

Free AI Chat использует бесплатные/локальные модели через gateway. Они могут:

- ошибаться;
- возвращать неполный edit;
- путать формат;
- быть медленными;
- зависеть от лимитов провайдера.

Поэтому Apply edit специально требует подтверждение.

Перед применением важных правок лучше:

```text
1. Смотреть diff.
2. Делать git status.
3. Для кода запускать тесты/анализ.
```
