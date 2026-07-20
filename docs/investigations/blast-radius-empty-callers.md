# Розслідування: Blast Radius показує 0 callers/endpoints

| | |
|---|---|
| **Дата** | 2026-07-01 |
| **Гілка** | `tests/l04` |
| **PR** | [#11](https://github.com/SyukPublic/dev-digest/pull/11) — `test(blast-radius): add requestId to shared getContext helper - TEST ONLY` |
| **Репозиторій під ревʼю** | `SyukPublic/dev-digest` (`ccce0034-ba52-4a9e-bb5e-b4855703a301`) |
| **Статус** | ✅ Виправлено (повний реіндекс) |

---

## TL;DR

Blast radius для PR #11 показував **2 changed symbols, 0 callers, 0 endpoints**, хоча змінений хелпер `getContext` реально викликається у 8 файлах-маршрутах.

Причина **не** у зміні коду і **не** в екстракторі символів. Персистентний код-індекс репозиторію `SyukPublic/dev-digest` перебував у стані, де **всі 6416 рядків `references.decl_file` дорівнювали `NULL`** (жодне посилання не було зарезолвлене до файлу-декларації). Оскільки `getResolvedCallers` рахує callers лише за посиланнями, чий `decl_file` збігається зі зміненим файлом, результат був порожній.

Виправлення — **повний реіндекс через застосунок** (`POST /repos/:id/refresh`), який заново будує граф і виконує `resolveReferences`. Після нього blast radius дає **8 callers і 27 endpoints**.

---

## Симптом

Панель BLAST RADIUS на PR #11:

> This change has no detected downstream callers, so it does not affect any endpoints or cron jobs.
> `2 symbols · 0 callers · 0 endpoints · 0 cron/jobs`
> `2 changed symbol(s), no downstream callers found.`

Детермінований blast-map, переданий у LLM-summarizer:

```
Changed symbols:
  - getContext
  - RequestContext
Downstream impact:
  (no downstream callers found)
Impacted endpoints:
  (none)
```

Тобто **символи детектувалися коректно** (`getContext`, `RequestContext` з `server/src/modules/_shared/context.ts`), проблема — виключно у пошуку **callers**.

---

## Метод

Дотримано правила проєкту: *verify, don't recall* + відтворення в точному стеку з бісекцією по шарах. Гіпотези перевірялися на ґрунт-істині БД, а не з памʼяті.

### Як працює обчислення blast radius

1. `getBlastRadius(repoId, changedFiles)` — при `repoIntelEnabled` іде **персистентним** шляхом `tryPersistentBlast`
   (`server/src/modules/repo-intel/service.ts`).
2. Changed symbols = `getSymbolRows(repoId, changedFiles)` → знайшло `getContext` + `RequestContext`. ✔
3. Callers = `getResolvedCallers(repoId, changedFiles, names)`
   (`server/src/modules/repo-intel/repository.ts`), який фільтрує:
   ```sql
   WHERE references.repo_id = $1
     AND references.decl_file IN (changedFiles)   -- ключовий фільтр
     AND references.to_symbol IN (names)
   INNER JOIN file_rank ON file_rank.file_path = references.from_path
   ```
4. `decl_file` заповнюється кроком `resolveReferences` через import-граф
   (`references.from_path` → `file_edges` → `symbols` де `exported=true`, кандидат має бути унікальним).
   `0 або >1` кандидатів лишають `decl_file = NULL` — навмисна *precision-over-recall* політика
   (`service.ts:312-314`).

### Спростована гіпотеза

**«Немає кореневого `tsconfig.json` → dependency-cruiser не резолвить `.js`→`.ts` → немає ребер графа → NULL».**
Кореневого tsconfig справді немає (це не монорепо), але БД спростувала наслідок:

- `file_edges` присутні: **514** усього, зокрема **8 ребер у `_shared/context.ts`**.
- Контрольний репозиторій `burnjohn/dev-digest` з **ідентичними** даними резолвиться нормально.

Отже dependency-cruiser резолвить `.js`→`.ts` коректно; ребра є. Гіпотезу відкинуто.

---

## Докази (ґрунт-істина БД)

Порівняння двох репозиторіїв із побайтово однаковими сирими даними
(обидва `status=full`, `indexer_version=2`, той самий `last_indexed_sha=66727c85…`):

| Метрика | `burnjohn/dev-digest` (контроль) | `SyukPublic/dev-digest` (PR #11) |
|---|---|---|
| `file_edges` усього | 514 | 514 |
| ребра в `context.ts` | 8 | 8 |
| символ `getContext` `exported` | `true` | `true` |
| `cand`-join кандидатів (резолвабельних) | 648 | **648** |
| refs→`getContext` з `decl_file` NOT NULL | 36 / 36 | **0 / 36** |
| **ВСІ refs з `decl_file` NOT NULL** | **640 / 6416** | **0 / 6416** |

Ключ: у SyukPublic **джерельні дані резолвабельні** (648 кандидатів, як у контролі), але **збереженого результату немає** — усі `decl_file = NULL`.

### Доказ виправності (транзакція з ROLLBACK)

Повторний прогін точного `UPDATE` з `resolveReferences` на індексі SyukPublic (без збереження):

```
resolved BEFORE:               0
resolved AFTER re-run:         640
getContext refs резолвлено:    36  across 8 caller files
(transaction rolled back — нічого не персистовано; після rollback знову 0)
```

`file_facts` для цих 8 файлів-маршрутів містив **27 endpoints**.

---

## Першопричина

> Персистентний код-індекс `SyukPublic/dev-digest` мав **усі `references.decl_file = NULL`** — крок резолюції посилань не був збережений для цього репозиторію (індекс, найімовірніше, засіяно/знято зі снапшота **до** кроку резолюції й ніколи не оновлювався живою переіндексацією; контрольний `burnjohn` — оновлений).

Оскільки `getResolvedCallers` вимагає `decl_file IN changedFiles`, а всі значення `NULL`, повертається **0 callers → 0 endpoints**. Це стан індексу, а не дефект коду PR і не дефект логіки `resolveReferences` (запит коректний — доведено на контролі й транзакцією).

---

## Виправлення

Обрано **реіндекс через застосунок** (чистий HTTP, без ручних правок БД):

```
POST http://localhost:3001/repos/ccce0034-ba52-4a9e-bb5e-b4855703a301/refresh
→ {"status":"refreshing"}
```

Ланцюг: `refresh` ставить у чергу `CLONE_JOB_KIND` → його хендлер після переклонування ставить
`INDEX_JOB_KIND` → `RepoIntelService.indexRepo` → `runFullIndex`, який заново будує граф і викликає
`resolveReferences` (`server/src/modules/repos/service.ts:68`, `pipeline/full.ts:224`).

### Чому НЕ `resync`/incremental

`POST /repos/:id/resync` (`resyncRepo` → `runIncremental`) при **незмінному SHA** виходить на кроці
`sha_unchanged` (або `no_supported_changes`) **без** повторної резолюції
(`pipeline/incremental.ts:96-130`). Push гілки `tests/l04` не зрушив HEAD дефолтної гілки, тож
incremental був би no-op. Потрібен саме **повний** індекс.

---

## Верифікація

Після повного реіндексу (поллер зафіксував перехід `resolved 0 → 640`, `status=full`, `incr=null` —
підтверджує повний, а не incremental шлях). Точне дзеркало `getResolvedCallers` + `file_facts`:

- **8 callers**: `agents`, `polling`, `pulls`, `repo-intel`, `repos`, `reviews`, `settings`, `workspace`
  (`server/src/modules/<name>/routes.ts`)
- **27 endpoints_affected** (GET/POST/PUT/DELETE `/agents`, `/repos`, `/settings`, `/pulls/:id/...`,
  `/runs/:id/...` та ін.)

Вимога сценарію (≥2 callers, ≥1 endpoint) виконана з запасом.

**Дія користувача:** натиснути **Recompute** на PR #11 (blast кешується на рівні brief — UI треба
оновити один раз).

---

## Висновки / профілактика

1. **Порожній blast radius при коректних символах = нерезолвлений індекс.** Якщо `references.decl_file`
   усі `NULL`, `getResolvedCallers` (фільтр `decl_file IN changedFiles` + INNER JOIN `file_rank`)
   віддає 0 callers/endpoints, попри правильні `symbols`/`file_edges`.
2. **Швидка діагностика:** порівняти `count(*) FILTER (WHERE decl_file IS NOT NULL)` між репозиторіями;
   `0 / N` = нерезолвлений індекс.
3. **Фікс:** повний реіндекс (`POST /repos/:id/refresh`). `resync`/incremental — no-op при незмінному SHA.
4. **Зміна shared-хелпера для blast radius має бути викликною функцією.** Екстрактор
   (`server/src/lib/extract.ts`) рахує references лише як виклики (`sym(`, `.sym(`, `new Sym`, `<Sym`).
   Zod-схеми з `@devdigest/shared` не викликаються (`Schema.parse(...)`), тож не дали б callers навіть
   при коректному індексі — тому цільовим був `getContext`, а не Zod-контракт.
5. **Потенційне посилення продукту (поза цим тестом):** позначати в UI індекс із суцільним
   `decl_file = NULL` як `degraded/stale`, щоб «0 callers» не читалося як «впливу немає».

---

## Додаток — використані запити

```sql
-- Здоровʼя резолюції по репозиторію
SELECT count(*) AS total,
       count(*) FILTER (WHERE decl_file IS NOT NULL) AS resolved
FROM "references" WHERE repo_id = $1;

-- Посилання на getContext: скільки і куди зарезолвлені
SELECT decl_file, count(*) FROM "references"
WHERE repo_id = $1 AND to_symbol = 'getContext'
GROUP BY decl_file;

-- Кандидати резолюції (те, що resolveReferences МІГ би зарезолвити)
SELECT count(*) FROM (
  SELECT r.id
  FROM "references" r
  JOIN file_edges e ON e.repo_id = r.repo_id AND e.from_file = r.from_path
  JOIN symbols s ON s.repo_id = r.repo_id AND s.path = e.to_file
                AND s.name = r.to_symbol AND s.exported = true
  WHERE r.repo_id = $1
  GROUP BY r.id, e.to_file
) x;

-- Дзеркало getResolvedCallers для змінного файлу
SELECT r.from_path, count(*) AS refs
FROM "references" r
JOIN file_rank fr ON fr.repo_id = r.repo_id AND fr.file_path = r.from_path
WHERE r.repo_id = $1
  AND r.decl_file IN ('server/src/modules/_shared/context.ts')
  AND r.to_symbol IN ('getContext','RequestContext')
GROUP BY r.from_path;
```
