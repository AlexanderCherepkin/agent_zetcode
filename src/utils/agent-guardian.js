import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';
import http from 'http';
import { chromium, firefox } from 'playwright';

const SITE_DIR = path.resolve('output', 'site_clone');
const NEXT_DIR = path.resolve('output', 'generated_nextjs_project');
const GUARDIAN_DIR = path.resolve('.guardian');
const GOLDEN_DIR = path.join(GUARDIAN_DIR, 'golden_master');
const SNAPSHOTS_DIR = path.join(GUARDIAN_DIR, 'snapshots');
const HISTORY_FILE = path.join(GUARDIAN_DIR, 'history.json');
const AGENT_ERROR_LOG = path.join(GUARDIAN_DIR, 'LAST_AGENT_ERROR.log');

// MIME-типы для временного проверочного сервера
const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
};

// Файлы и папки внутри output/site_clone, за которыми ведется наблюдение
const PROTECTED_PATTERNS = [
  /^specs[\\/]/i,
  /^assets[\\/]fonts[\\/]/i,
  /^raw_template\.html$/i,
  /^js[\\/](?!agent-content-bridge\.js).*\.js$/i
];

function isProtectedPath(relPath) {
  return PROTECTED_PATTERNS.some((regex) => regex.test(relPath));
}

function hashContent(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

// Загрузка истории шагов
async function loadHistory() {
  try {
    const raw = await fs.readFile(HISTORY_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { currentStep: 0, steps: [] };
  }
}

async function saveHistory(history) {
  await fs.mkdir(GUARDIAN_DIR, { recursive: true });
  await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
}

// Вспомогательная функция копирования всех рабочих файлов site_clone (включая все *.html и *.json)
async function copySiteWorkingFiles(srcDir, destDir) {
  if (!fsSync.existsSync(srcDir)) return;
  await fs.mkdir(destDir, { recursive: true });

  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isFile() && (entry.name.endsWith('.html') || entry.name.endsWith('.json'))) {
      await fs.cp(srcPath, destPath, { force: true });
    } else if (entry.isDirectory() && ['css', 'js'].includes(entry.name)) {
      await fs.cp(srcPath, destPath, { recursive: true, force: true });
    }
  }
}

// Быстрая проверка целостности файла (Синтаксис и структура — БЕЗ АВТО-ОТКАТА)
async function validateFileIntegrity(fullPath, relPath) {
  try {
    const content = await fs.readFile(fullPath, 'utf-8');

    // 1. Проверка JSON-файлов (content.json, pages-map.json и др.)
    if (fullPath.endsWith('.json')) {
      if (!content.trim()) {
        return { valid: false, reason: 'Файл JSON пуст' };
      }
      const parsed = JSON.parse(content);
      if (relPath.endsWith('content.json') && (!parsed.texts || !parsed.images)) {
        return {
          valid: false,
          reason: 'В content.json отсутствуют корневые ключи "texts" или "images"'
        };
      }
      return { valid: true };
    }

    // 2. Проверка главного index.html
    if (relPath === 'index.html') {
      if (content.length < 300) {
        return { valid: false, reason: 'index.html слишком мал (возможна неполная запись)' };
      }
      if (!content.includes('<body') || !content.includes('</html>')) {
        return { valid: false, reason: 'В index.html нарушена базовая структура <body> / </html>' };
      }
      return { valid: true };
    }

    // 3. Проверка React/Next.js компонентов (.jsx / .tsx)
    if (fullPath.endsWith('.jsx') || fullPath.endsWith('.tsx')) {
      if (content.trim().length < 30) {
        return { valid: false, reason: 'JSX-компонент пуст или не дописан' };
      }
      const openBraces = (content.match(/\{/g) || []).length;
      const closeBraces = (content.match(/\}/g) || []).length;
      if (Math.abs(openBraces - closeBraces) > 2) {
        return {
          valid: false,
          reason: `Нарушен баланс фигурных скобок ({: ${openBraces}, }: ${closeBraces})`
        };
      }
      return { valid: true };
    }

    return { valid: true };
  } catch (err) {
    return { valid: false, reason: `Ошибка синтаксиса файла: ${err.message}` };
  }
}

// 1. ИНИЦИАЛИЗАЦИЯ ЗОЛОТОГО СЛЕПКА (GOLDEN MASTER)
async function initGoldenMaster() {
  console.log('🛡️ [Guardian] Создание неприкосновенного Золотого Слепка (Golden Master)...');
  if (!fsSync.existsSync(SITE_DIR)) {
    console.error('❌ Папка output/site_clone не найдена! Сначала запустите: npm run extract -- <URL>');
    return;
  }

  await fs.mkdir(GOLDEN_DIR, { recursive: true });
  await fs.mkdir(SNAPSHOTS_DIR, { recursive: true });

  await fs.cp(SITE_DIR, path.join(GOLDEN_DIR, 'site_clone'), { recursive: true, force: true });
  if (fsSync.existsSync(NEXT_DIR)) {
    await fs.cp(NEXT_DIR, path.join(GOLDEN_DIR, 'generated_nextjs_project'), {
      recursive: true,
      force: true
    });
  }

  await createSnapshot('Инициализация эталонного состояния (Golden Master)');
  console.log('✅ [Guardian] Золотой слепок сохранен в .guardian/golden_master!');
  console.log('👉 Ручной откат на N шагов назад: npm run rollback -- -1 (или -2, -3)');
  console.log('👉 Полный сброс (только вручную): npm run reset-golden');
}

// 2. СОЗДАНИЕ ПОШАГОВОГО СНАПШОТА
async function createSnapshot(description = 'Сохранение контрольной точки') {
  const history = await loadHistory();
  const nextStep =
    history.steps.length > 0
      ? Math.max(...history.steps.map((s) => s.step), history.currentStep) + 1
      : 1;
  const stepName = `step_${String(nextStep).padStart(3, '0')}`;
  const targetSnapDir = path.join(SNAPSHOTS_DIR, stepName);

  await fs.mkdir(targetSnapDir, { recursive: true });

  if (fsSync.existsSync(SITE_DIR)) {
    const siteSnap = path.join(targetSnapDir, 'site_clone');
    await copySiteWorkingFiles(SITE_DIR, siteSnap);
  }

  if (fsSync.existsSync(NEXT_DIR)) {
    const nextSnap = path.join(targetSnapDir, 'generated_nextjs_project');
    await fs.mkdir(nextSnap, { recursive: true });
    for (const item of ['app', 'components', 'data', 'tailwind.config.js']) {
      const srcPath = path.join(NEXT_DIR, item);
      if (fsSync.existsSync(srcPath)) {
        await fs.cp(srcPath, path.join(nextSnap, item), { recursive: true, force: true });
      }
    }
  }

  const record = {
    step: nextStep,
    id: stepName,
    timestamp: new Date().toLocaleString('ru-RU'),
    description
  };

  history.currentStep = nextStep;
  history.steps.push(record);

  if (history.steps.length > 50) {
    const oldest = history.steps.shift();
    await fs.rm(path.join(SNAPSHOTS_DIR, oldest.id), { recursive: true, force: true }).catch(() => {});
  }

  await saveHistory(history);
  console.log(`📸 [Guardian] Записан шаг #${nextStep} (${stepName}): ${description}`);
  return record;
}

// 3. РУЧНОЙ ОТКАТ ПО ТРЕБОВАНИЮ (НА 1, 2, 3 ШАГА НАЗАД ИЛИ К КОНКРЕТНОМУ НОМЕРУ ШАГА)
async function rollbackToStep(targetArg = null, isRelativeStepsBack = false) {
  const history = await loadHistory();
  if (history.steps.length === 0) {
    console.log('⚠️ История шагов пуста.');
    return;
  }

  // Находим индекс текущего активного шага в массиве истории
  let currentIdx = history.steps.findIndex((s) => s.step === history.currentStep);
  if (currentIdx === -1) {
    currentIdx = history.steps.length - 1;
  }

  let targetRecord = null;
  const rawStr = targetArg !== null ? String(targetArg).trim() : '';

  if (!rawStr) {
    // Без аргументов: откат ровно на 1 шаг назад
    const targetIdx = Math.max(0, currentIdx - 1);
    targetRecord = history.steps[targetIdx];
  } else if (isRelativeStepsBack || rawStr.startsWith('-')) {
    // Откат на N шагов назад (например: -1, -2, -3 или через команду back 1, back 2, back 3)
    const stepsBack = Math.abs( parseInt(rawStr, 10) );
    if (isNaN(stepsBack) || stepsBack < 1) {
      console.error(`❌ Некорректное количество шагов для отката: ${rawStr}`);
      return;
    }
    const targetIdx = Math.max(0, currentIdx - stepsBack);
    targetRecord = history.steps[targetIdx];
    console.log(`⏪ Запрошен откат на ${stepsBack} шаг(а/ов) назад от шага #${history.steps[currentIdx].step}...`);
  } else {
    // Переход к конкретному номеру шага (например: 5 или #5)
    const cleanNum = parseInt(rawStr.replace(/^#/, ''), 10);
    targetRecord = history.steps.find((s) => s.step === cleanNum);
  }

  if (!targetRecord) {
    console.error(`❌ Шаг "${targetArg}" не найден в истории. Проверьте список: npm run guard -- list`);
    return;
  }

  const snapDir = path.join(SNAPSHOTS_DIR, targetRecord.id);
  if (!fsSync.existsSync(snapDir)) {
    console.error(`❌ Папка снапшота ${targetRecord.id} не найдена.`);
    return;
  }

  console.log(
    `⏪ [Guardian] Восстановление проекта к шагу #${targetRecord.step} (${targetRecord.timestamp}: ${targetRecord.description})...`
  );

  const siteSnap = path.join(snapDir, 'site_clone');
  if (fsSync.existsSync(siteSnap)) {
    await copySiteWorkingFiles(siteSnap, SITE_DIR);
  }

  const nextSnap = path.join(snapDir, 'generated_nextjs_project');
  if (fsSync.existsSync(nextSnap)) {
    await fs.cp(nextSnap, NEXT_DIR, { recursive: true, force: true });
  }

  // Обновляем указатель текущего шага, НЕ удаляя историю (чтобы можно было свободно ходить вперед/назад)
  history.currentStep = targetRecord.step;
  await saveHistory(history);

  console.log(`✅ [Guardian] Проект успешно переключен на состояние шага #${targetRecord.step}!`);
}

// 4. ПОЛНЫЙ СБРОС К ЗОЛОТОМУ СЛЕПКУ (ТОЛЬКО ПО РУЧНОЙ КОМАНДЕ)
async function resetToGoldenMaster() {
  const goldenSite = path.join(GOLDEN_DIR, 'site_clone');
  if (!fsSync.existsSync(goldenSite)) {
    console.error('❌ Золотой слепок не найден. Сначала выполните: npm run guard:init');
    return;
  }

  console.log('🔄 [Guardian] Полное восстановление сайта из Золотого Слепка по вашему запросу...');
  await fs.cp(goldenSite, SITE_DIR, { recursive: true, force: true });

  const goldenNext = path.join(GOLDEN_DIR, 'generated_nextjs_project');
  if (fsSync.existsSync(goldenNext)) {
    await fs.cp(goldenNext, NEXT_DIR, { recursive: true, force: true });
  }

  await createSnapshot('Ручной сброс к Golden Master');
  console.log('✅ [Guardian] Сайт полностью восстановлен в исходное состояние!');
}

// ============================================================================
// 5. ПРОВЕРКА РЕНДЕРА ЧЕРЕЗ БРАУЗЕР (БЕЗ ПРИНУДИТЕЛЬНОГО АВТО-ОТКАТА)
// ============================================================================
function startTempStaticServer(rootDir) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(async (req, res) => {
      try {
        const urlObj = new URL(req.url, 'http://127.0.0.1');
        let pathname = decodeURIComponent(urlObj.pathname);
        if (pathname === '/') pathname = '/index.html';

        const filePath = path.join(rootDir, pathname);
        const data = await fs.readFile(filePath);
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      resolve({ server: srv, url: `http://127.0.0.1:${address.port}` });
    });
    srv.on('error', reject);
  });
}

async function launchVerifyBrowser(engineType, isHeaded = false) {
  if (engineType === 'chromium') {
    return await chromium.launch({
      headless: !isHeaded,
      args: ['--disable-blink-features=AutomationControlled']
    });
  }
  return await firefox.launch({ headless: !isHeaded });
}

async function runBrowserAudit(testUrl, isHeaded) {
  let browser;
  try {
    browser = await launchVerifyBrowser('chromium', isHeaded);
  } catch {
    console.log('   ⚠️ Chromium недоступен для проверки, запускаю через Firefox...');
    browser = await launchVerifyBrowser('firefox', isHeaded);
  }

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    const fatalJsErrors = [];
    const missingLocalAssets = [];

    page.on('pageerror', (err) => {
      if (/SyntaxError|ReferenceError/i.test(err.stack || err.message)) {
        fatalJsErrors.push(err.message);
      }
    });

    page.on('response', (res) => {
      if (res.status() === 404 && res.url().startsWith(testUrl)) {
        const relUrl = res.url().replace(testUrl, '');
        if (
          relUrl.startsWith('/css/') ||
          relUrl === '/content.json' ||
          relUrl.includes('agent-content-bridge')
        ) {
          missingLocalAssets.push(relUrl);
        }
      }
    });

    await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    const domReport = await page.evaluate(() => {
      const body = document.body;
      if (!body) return { hasBody: false };

      const scrollHeight = Math.max(
        body.scrollHeight || 0,
        document.documentElement?.scrollHeight || 0
      );
      const visibleBlocks = Array.from(
        document.querySelectorAll('section, header, main, div, h1, h2, p, img, video, canvas')
      ).filter((el) => {
        const s = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return (
          s.display !== 'none' &&
          s.visibility !== 'hidden' &&
          parseFloat(s.opacity) > 0.02 &&
          r.width > 20 &&
          r.height > 15
        );
      });

      const agentTextNodes = document.querySelectorAll('[data-agent-text]').length;
      const bodyTextLength = (body.innerText || '').trim().length;
      const loadedStylesheets = document.styleSheets.length;

      return {
        hasBody: true,
        scrollHeight,
        visibleBlocksCount: visibleBlocks.length,
        agentTextNodes,
        bodyTextLength,
        loadedStylesheets
      };
    });

    await fs.mkdir(GUARDIAN_DIR, { recursive: true });
    const previewPath = path.join(GUARDIAN_DIR, 'last_verify_preview.png');
    await page.screenshot({ path: previewPath, fullPage: false });

    return {
      domReport,
      fatalJsErrors,
      missingLocalAssets,
      previewPath
    };
  } finally {
    await browser.close();
  }
}

async function verifySiteRender(options = { autoRollback: false, isHeaded: false }) {
  console.log('\n🔍 [Guardian Verify] Запуск браузерной проверки рендера сайта...');

  for (const relFile of ['index.html', 'content.json']) {
    const full = path.join(SITE_DIR, relFile);
    if (!fsSync.existsSync(full)) {
      const reason = `Отсутствует критический файл: ${relFile}`;
      await handleVerifyFailure(reason, options.autoRollback);
      return false;
    }
    const check = await validateFileIntegrity(full, relFile);
    if (!check.valid) {
      await handleVerifyFailure(`Ошибка в файле ${relFile}: ${check.reason}`, options.autoRollback);
      return false;
    }
  }

  const { server, url } = await startTempStaticServer(SITE_DIR);

  try {
    const audit = await runBrowserAudit(url, options.isHeaded);
    const r = audit.domReport;
    const problems = [];

    if (!r.hasBody) {
      problems.push('Тег <body> отсутствует в DOM');
    } else {
      if (r.scrollHeight < 180) {
        problems.push(`Малая высота страницы (scrollHeight=${r.scrollHeight}px)`);
      }
      if (r.visibleBlocksCount < 3) {
        problems.push(`Мало видимых элементов (найдено ${r.visibleBlocksCount})`);
      }
      if (r.loadedStylesheets === 0) {
        problems.push('Не загрузилась ни одна таблица стилей CSS');
      }
    }

    if (audit.missingLocalAssets.length > 0) {
      problems.push(`Ошибки 404 для системных файлов: ${audit.missingLocalAssets.join(', ')}`);
    }

    if (problems.length > 0) {
      const brokenScreen = path.join(GUARDIAN_DIR, 'broken_render.png');
      await fs.cp(audit.previewPath, brokenScreen, { force: true }).catch(() => {});
      await handleVerifyFailure(problems.join(' | '), options.autoRollback);
      return false;
    }

    console.log('✅ [Guardian Verify] Рендер в порядке! Все проверки пройдены:');
    console.log(
      `   ├── Высота страницы: ${r.scrollHeight}px | Видимых блоков: ${r.visibleBlocksCount}`
    );
    console.log(
      `   ├── Узлов контента [data-agent-text]: ${r.agentTextNodes} | Таблиц CSS: ${r.loadedStylesheets}`
    );
    console.log(`   └── Скриншот проверки: .guardian/last_verify_preview.png\n`);
    return true;
  } finally {
    server.close();
  }
}

async function handleVerifyFailure(reason, shouldRollback) {
  console.warn(`\n⚠️ [Guardian Verify] Обнаружены замечания по рендеру:`);
  console.warn(`   Причина: ${reason}`);

  await fs.mkdir(GUARDIAN_DIR, { recursive: true });
  const errorMsg = `[${new Date().toISOString()}] BROWSER VERIFY WARNING: ${reason}\n`;
  await fs.writeFile(AGENT_ERROR_LOG, errorMsg, 'utf-8');

  if (shouldRollback) {
    console.log('⏪ Выполняется запрошенный откат к предыдущему шагу...');
    await rollbackToStep('-1', true);
  } else {
    console.log('ℹ️ Авто-откат отключен. Вы можете исправить файл или откатиться вручную.');
  }
}

// 6. РЕЖИМ НАБЛЮДЕНИЯ И ЗАПИСИ ИСТОРИИ ШАГОВ (БЕЗ АВТО-ОТКАТОВ!)
async function startWatchdog() {
  if (!fsSync.existsSync(path.join(GOLDEN_DIR, 'site_clone'))) {
    await initGoldenMaster();
  }

  console.log('\n🛡️ =============================================================');
  console.log('🛡️ AGENT GUARDIAN АКТИВЕН (Режим безопасной записи истории)');
  console.log('🛡️ • АВТО-ОТКАТ ОТКЛЮЧЕН: ваши правки никогда не сбрасываются сами');
  console.log('🛡️ • Каждое валидное сохранение записывается в историю шагов');
  console.log('🛡️ • Откат выполняется ТОЛЬКО по вашей команде (на 1, 2, 3 шага)');
  console.log('🛡️ =============================================================\n');

  const fileHashes = new Map();
  const debounceTimers = new Map();

  const watchTargets = [SITE_DIR, NEXT_DIR].filter((d) => fsSync.existsSync(d));

  for (const baseDir of watchTargets) {
    fsSync.watch(baseDir, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const relPath = filename.replace(/\\/g, '/');
      const fullPath = path.join(baseDir, filename);

      if (debounceTimers.has(fullPath)) {
        clearTimeout(debounceTimers.get(fullPath));
      }

      // Ждем 800 мс после последнего изменения, чтобы файл гарантированно дописался на диск
      const timer = setTimeout(async () => {
        debounceTimers.delete(fullPath);
        try {
          if (!fsSync.existsSync(fullPath)) return;
          const stat = await fs.stat(fullPath);
          if (stat.isDirectory()) return;

          const buf = await fs.readFile(fullPath);
          const currentHash = hashContent(buf);
          if (fileHashes.get(fullPath) === currentHash) return;

          const isSiteClone = baseDir === SITE_DIR;
          if (isSiteClone && isProtectedPath(relPath)) {
            console.log(`ℹ️ [Guardian] Изменен системный файл: ${relPath}`);
          }

          // Проверяем синтаксис файла (JSON / HTML / JSX) без отката
          const validation = await validateFileIntegrity(fullPath, relPath);

          if (!validation.valid) {
            console.warn(
              `\n⚠️ [Guardian] В файле "${relPath}" обнаружена незавершенная правка или ошибка синтаксиса:`
            );
            console.warn(`   Причина: ${validation.reason}`);
            console.warn(
              `   👉 Авто-откат НЕ выполняется. Допишите файл (или откатитесь вручную: npm run rollback).\n`
            );

            const errorMsg = `[${new Date().toISOString()}] SYNTAX WARNING on ${relPath}: ${validation.reason}\n`;
            await fs.writeFile(AGENT_ERROR_LOG, errorMsg, 'utf-8').catch(() => {});
            return;
          }

          // Когда файл сохранен корректно — фиксируем новый шаг в истории
          fileHashes.set(fullPath, currentHash);
          await createSnapshot(`Обновлен файл ${path.basename(baseDir)}/${relPath}`);
        } catch {
          // Игнорируем промежуточные состояния файловой системы
        }
      }, 800);

      debounceTimers.set(fullPath, timer);
    });
  }
}

// 7. ПРОСМОТР СПИСКА ВСЕХ ШАГОВ
async function listHistory() {
  const history = await loadHistory();
  console.log('\n📜 ИСТОРИЯ ШАГОВ ПРОЕКТА (.guardian/snapshots):');
  if (history.steps.length === 0) {
    console.log('   (Пока нет записанных шагов)');
    return;
  }
  history.steps.forEach((s) => {
    const marker = s.step === history.currentStep ? '👉 [ТЕКУЩИЙ]' : '            ';
    console.log(`   ${marker} Шаг #${s.step} (${s.id}) | ${s.timestamp} | ${s.description}`);
  });
  console.log('\n💡 Команды ручного управления откатами:');
  console.log('   • На 1 шаг назад:           npm run rollback (или npm run rollback -- -1)');
  console.log('   • На 2 шага назад:          npm run rollback -- -2');
  console.log('   • На 3 шага назад:          npm run rollback -- -3');
  console.log('   • К конкретному шагу №X:    npm run rollback -- <номер_шага>');
}

// CLI-роутер команд
const command = process.argv[2] || 'watch';
const arg = process.argv[3] || null;
const isHeadedFlag = process.argv.includes('--headed');
const forceAutoRollbackFlag = process.argv.includes('--auto-rollback');

switch (command) {
  case 'init':
    initGoldenMaster().catch(console.error);
    break;
  case 'snapshot':
    createSnapshot(arg || 'Ручная контрольная точка').catch(console.error);
    break;
  case 'rollback':
    rollbackToStep(arg, false).catch(console.error);
    break;
  case 'back':
    // Специальная команда для отката ровно на N шагов назад (по умолчанию 1)
    rollbackToStep(arg || '1', true).catch(console.error);
    break;
  case 'reset':
    resetToGoldenMaster().catch(console.error);
    break;
  case 'verify':
    verifySiteRender({ autoRollback: forceAutoRollbackFlag, isHeaded: isHeadedFlag }).catch(
      console.error
    );
    break;
  case 'list':
    listHistory().catch(console.error);
    break;
  case 'watch':
  default:
    startWatchdog().catch(console.error);
    break;
}