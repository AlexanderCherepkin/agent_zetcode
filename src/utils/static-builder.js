import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';

const SITE_DIR = path.resolve('output', 'site_clone');
const DIST_DIR = path.resolve('output', 'dist');

async function buildStaticProduction() {
  console.log('\n🚀 =============================================================');
  console.log('🚀 СБОРКА ПРОДАКШЕН-ВЕРСИИ САЙТА (STATIC BUILDER)');
  console.log('🚀 Вшивание content.json в HTML, очистка служебных меток data-agent-*');
  console.log('🚀 =============================================================\n');

  if (!fsSync.existsSync(SITE_DIR)) {
    console.error('❌ Папка output/site_clone не найдена! Сначала выполните: npm run extract <URL>');
    return;
  }

  // 1. Очищаем и создаем папку output/dist/
  console.log('[1/4] Подготовка папки output/dist/...');
  await fs.rm(DIST_DIR, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(DIST_DIR, { recursive: true });

  // 2. Читаем глобальную базу данных content.json
  console.log('[2/4] Чтение актуальной базы данных content.json...');
  const jsonPath = path.join(SITE_DIR, 'content.json');

  if (!fsSync.existsSync(jsonPath)) {
    console.error('❌ Отсутствует content.json в папке site_clone.');
    return;
  }

  const contentData = JSON.parse(await fs.readFile(jsonPath, 'utf-8'));
  const texts = contentData.texts || {};
  const images = contentData.images || {};
  const videos = contentData.videos || {};
  const backgrounds = contentData.backgrounds || {};

  // Получаем список всех HTML файлов в плоской структуре
  const allFiles = await fs.readdir(SITE_DIR);
  const htmlFiles = allFiles.filter(file => file.endsWith('.html') && file !== 'raw_template.html');

  if (htmlFiles.length === 0) {
    console.warn('⚠️ В папке site_clone не найдено HTML-файлов для сборки.');
  }

  // 3. Обрабатываем каждый HTML файл
  console.log(`[3/4] Вшивание данных и очистка разметки (${htmlFiles.length} HTML файлов)...`);

  for (const htmlFile of htmlFiles) {
    const htmlPath = path.join(SITE_DIR, htmlFile);
    const htmlContent = await fs.readFile(htmlPath, 'utf-8');
    const $ = cheerio.load(htmlContent);

    // 3.1 Тексты и SplitText
    Object.entries(texts).forEach(([key, val]) => {
      $(`[data-agent-text="${key}"]`).each((_, el) => {
        const $el = $(el);
        if ($el.attr('data-agent-split-text') === 'chars') {
          // Если это был побуквенный SplitText, собираем чистые спаны с новым текстом
          const sampleChar = $el.find('span span, div span, span').first();
          const charClass = sampleChar.length ? sampleChar.attr('class') || '' : '';
          const charStyle = sampleChar.length ? sampleChar.attr('style') || '' : '';

          $el.empty();
          Array.from(val).forEach((ch) => {
            const spanChar = $('<span></span>');
            if (charClass) spanChar.attr('class', charClass);
            if (charStyle) spanChar.attr('style', charStyle);
            spanChar.css('display', 'inline-block');
            spanChar.text(ch === ' ' ? '\u00A0' : ch);
            $el.append(spanChar);
          });
        } else {
          $el.text(val);
        }
      });
    });

    // 3.2 Картинки <img>
    Object.entries(images).forEach(([key, imgObj]) => {
      if (imgObj.src) {
        $(`[data-agent-img="${key}"]`).each((_, el) => {
          const $el = $(el);
          $el.attr('src', imgObj.src);
          $el.removeAttr('srcset');
          if (imgObj.alt !== undefined) $el.attr('alt', imgObj.alt);
        });
      }
    });

    // 3.3 Видеоролики <video>
    Object.entries(videos).forEach(([key, vidObj]) => {
      if (vidObj.src) {
        $(`[data-agent-video="${key}"]`).each((_, el) => {
          const $el = $(el);
          $el.attr('src', vidObj.src);
          $el.find('source').attr('src', vidObj.src);
          if (vidObj.poster) $el.attr('poster', vidObj.poster);
        });
      }
    });

    // 3.4 Фоновые изображения background-image
    Object.entries(backgrounds).forEach(([key, bgData]) => {
      const bgUrl = typeof bgData === 'string' ? bgData : bgData.src;
      if (bgUrl) {
        $(`[data-agent-bg="${key}"]`).each((_, el) => {
          const $el = $(el);
          const currentStyle = $el.attr('style') || '';
          const newBgRule = `background-image: url("${bgUrl}")`;
          if (currentStyle.includes('background-image')) {
            $el.attr(
              'style',
              currentStyle.replace(/background-image:[^;]+(;|$)/i, newBgRule + ';')
            );
          } else {
            $el.attr('style', `${currentStyle}; ${newBgRule};`);
          }
        });
      }
    });

    // 3.5 Удаляем все служебные атрибуты агента и наш скрипт-мост agent-content-bridge.js
    $('[data-agent-text]').removeAttr('data-agent-text');
    $('[data-agent-img]').removeAttr('data-agent-img');
    $('[data-agent-video]').removeAttr('data-agent-video');
    $('[data-agent-bg]').removeAttr('data-agent-bg');
    $('[data-agent-split-text]').removeAttr('data-agent-split-text');
    $('[data-agent-applied-text]').removeAttr('data-agent-applied-text');
    
    // В продакшене мост-роутер больше не нужен, браузер сам перейдет по ссылке <a href="./page.html">
    $('script[src*="agent-content-bridge.js"]').remove();

    // Сохраняем итоговый чистый HTML в output/dist/
    await fs.writeFile(path.join(DIST_DIR, htmlFile), $.html(), 'utf-8');
    console.log(`   ✅ Обработан и сохранен: ${htmlFile}`);
  }

  // 4. Копируем папки assets/, css/ и нужные js/ в output/dist/
  console.log('[4/4] Копирование ассетов (assets/, css/, js/) в production-папку...');
  
  for (const folderName of ['assets', 'css', 'js']) {
    const srcPath = path.join(SITE_DIR, folderName);
    const destPath = path.join(DIST_DIR, folderName);
    if (fsSync.existsSync(srcPath)) {
      await fs.cp(srcPath, destPath, { recursive: true, force: true });
    }
  }

  // Удаляем bridge-скрипт из папки js/ в продакшене, если он там остался
  const distBridgeJs = path.join(DIST_DIR, 'js', 'agent-content-bridge.js');
  if (fsSync.existsSync(distBridgeJs)) {
    await fs.rm(distBridgeJs).catch(() => {});
  }

  console.log('\n✅ СБОРКА УСПЕШНО ЗАВЕРШЕНА!');
  console.log(`📦 Готовый к деплою многостраничный сайт лежит в папке: output/dist/`);
  console.log(`👉 Все тексты вшиты, служебные атрибуты удалены, навигация переведена на нативные ссылки.\n`);
}

buildStaticProduction().catch(console.error);