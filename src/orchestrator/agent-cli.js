import { chromium } from 'playwright';
import { spawn } from 'child_process';
import readline from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = process.argv.slice(2);
const targetUrl = args.find(arg => !arg.startsWith('--'));
const flags = args.filter(arg => arg.startsWith('--'));

if (!targetUrl) {
  console.error('❌ Ошибка: Укажите URL для сканирования. Пример: npm run agent -- https://site.com');
  process.exit(1);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function quickScan(url) {
  console.log(`\n🔍 [Scanner] Быстрый анализ архитектуры сайта: ${url}...`);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000); // Даем время на инициализацию скриптов

    const analysis = await page.evaluate(() => {
      const hasCanvas = document.querySelectorAll('canvas').length > 0;
      const hasGsap = !!window.gsap || !!window.ScrollTrigger;
      const hasThree = !!window.THREE;
      const hasWebGL = hasCanvas && (!!document.createElement('canvas').getContext('webgl') || !!document.createElement('canvas').getContext('webgl2'));
      
      const internalLinks = new Set();
      document.querySelectorAll('a[href]').forEach(a => {
        try {
          const u = new URL(a.href, window.location.origin);
          if (u.hostname === window.location.hostname) internalLinks.add(u.pathname);
        } catch {}
      });

      const textContent = document.body.innerText.toLowerCase();
      const isEcommerce = /cart|checkout|add to cart|корзина|оформить|купить|в корзину/.test(textContent);

      return {
        isHeavyAnimation: hasCanvas || hasGsap || hasThree || hasWebGL,
        internalPagesCount: internalLinks.size,
        isEcommerce
      };
    });

    return analysis;
  } catch (error) {
    console.warn('⚠️ Ошибка быстрого сканирования, продолжаем в ручном режиме.', error.message);
    return { isHeavyAnimation: false, internalPagesCount: 0, isEcommerce: false };
  } finally {
    await browser.close();
  }
}

function runScraper(scriptPath) {
  console.log(`\n🚀 Запуск модуля: ${path.basename(scriptPath)}`);
  
  const child = spawn('node', [scriptPath, targetUrl, ...flags], {
    stdio: 'inherit',
    cwd: path.resolve(__dirname, '../../') // Запуск из корня проекта
  });

  child.on('close', code => {
    console.log(`\n✅ Процесс завершен с кодом ${code}`);
    process.exit(code);
  });
}

async function startDispatcher() {
  const analysis = await quickScan(targetUrl);
  
  console.log('\n📊 РЕЗУЛЬТАТЫ АНАЛИЗА:');
  console.log(`   • Сложные анимации (WebGL/GSAP): ${analysis.isHeavyAnimation ? '✅ Да' : '❌ Нет'}`);
  console.log(`   • Внутренних уникальных ссылок: ~${analysis.internalPagesCount}`);
  console.log(`   • Признаки E-commerce: ${analysis.isEcommerce ? '✅ Да' : '❌ Нет'}`);

  let recommendedMode = '1';
  let recommendationText = 'Глубокий одностраничный реверс-инжиниринг (идеально для лендингов с анимацией)';

  if (analysis.internalPagesCount > 10 || analysis.isEcommerce) {
    recommendedMode = '2';
    recommendationText = 'Многостраничный потоковый краулер (идеально для магазинов и порталов)';
  }

  console.log(`\n💡 РЕКОМЕНДАЦИЯ СИСТЕМЫ: Выберите вариант [${recommendedMode}] - ${recommendationText}`);

  console.log('\nДоступные режимы:');
  console.log('  [1] Глубокий клон (Одиночная страница + GSAP/WebGL хореография)');
  console.log('  [2] Массовый краулер (Многостраничный обход + скачивание медиа)');
  
  rl.question('\nВведите номер режима (1 или 2): ', (answer) => {
    rl.close();
    
    if (answer.trim() === '1') {
      runScraper(path.resolve(__dirname, '../extractor/playwright-scraper.js'));
    } else if (answer.trim() === '2') {
      runScraper(path.resolve(__dirname, '../crawler/multi-page-scraper.js'));
    } else {
      console.log('❌ Неверный ввод. Запуск отменен.');
      process.exit(1);
    }
  });
}

startDispatcher();