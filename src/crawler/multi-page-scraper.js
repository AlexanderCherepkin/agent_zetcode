import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import { URL } from 'url';
import axios from 'axios';
import { pipeline } from 'stream/promises';
import * as cheerio from 'cheerio';

const args = process.argv.slice(2);
const startUrl = args.find(arg => !arg.startsWith('--')) || 'https://example.com';

const config = {
  skipVideo: args.includes('--no-video'),
  skipImages: args.includes('--no-images'),
  skipFonts: args.includes('--no-fonts')
};

const MAX_PAGES = 30;
const outputDir = path.resolve('output', 'site_clone');
const cssDir = path.join(outputDir, 'css');
const jsDir = path.join(outputDir, 'js');
const specsDir = path.join(outputDir, 'specs');
const assetsDir = path.join(outputDir, 'assets');
const fontsDir = path.join(assetsDir, 'fonts');
const imagesDir = path.join(assetsDir, 'images');
const mediaDir = path.join(assetsDir, 'media');

const visitedUrls = new Set();
const urlsToVisit = [startUrl];
const baseHostname = new URL(startUrl).hostname;
const baseOrigin = new URL(startUrl).origin;

// Глобальные счетчики ассетов
let globalFontIdx = 0;
let globalImgIdx = 0;
let globalMediaIdx = 0;
let globalCssIdx = 0;
let globalJsIdx = 0;
const downloadedMap = new Map();

// Глобальная карта контента и счетчики элементов
const globalContentMap = { texts: {}, images: {}, videos: {}, backgrounds: {}, _originalTexts: {} };
let globalTextIdx = 0;
let globalContentImgIdx = 0;
let globalVidIdx = 0;
let globalBgIdx = 0;

// Карта маршрутов для навигации
const visitedMap = new Map();

// Имитируем реальный браузер для обхода защиты
const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8'
};

// --- УПРАВЛЕНИЕ URL И МАРШРУТИЗАЦИЕЙ (ПЛОСКАЯ СТРУКТУРА) ---
function urlToLocalFilename(normalizedUrl, baseOriginStr) {
  try {
    const parsed = new URL(normalizedUrl, baseOriginStr);
    let pathname = decodeURIComponent(parsed.pathname || '/');
    if (pathname.endsWith('.html') || pathname.endsWith('.htm')) {
      pathname = pathname.replace(/\.html?$/i, '');
    }
    const cleanSegments = pathname
      .split('/')
      .filter(Boolean)
      .map((seg) =>
        seg
          .toLowerCase()
          .replace(/[^a-z0-9а-яё_-]/gi, '_')
          .replace(/_+/g, '_')
          .replace(/^_|_$/g, '')
      )
      .filter(Boolean);

    let baseName = cleanSegments.length === 0 ? 'index' : cleanSegments.join('__');

    if (parsed.search) {
      const cleanQuery = parsed.search
        .slice(1)
        .replace(/[^a-z0-9_-]/gi, '_')
        .replace(/_+/g, '_')
        .slice(0, 30);
      if (cleanQuery && baseName !== 'index') {
        baseName += `_${cleanQuery}`;
      }
    }

    if (baseName.length > 90) {
      baseName = baseName.slice(0, 90);
    }

    return `${baseName}.html`;
  } catch {
    return 'index.html';
  }
}

function resolveExtension(rawUrl, contentType = '', fallbackExt = '.bin') {
  try {
    const ext = path.extname(new URL(rawUrl).pathname).toLowerCase().split('?')[0];
    if (['.woff2', '.woff', '.ttf', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.mp4', '.webm', '.css', '.js'].includes(ext)) return ext;
  } catch {}
  const ct = contentType.toLowerCase();
  if (ct.includes('woff2')) return '.woff2';
  if (ct.includes('webp')) return '.webp';
  if (ct.includes('mp4')) return '.mp4';
  if (ct.includes('webm')) return '.webm';
  if (ct.includes('svg')) return '.svg';
  if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg';
  if (ct.includes('png')) return '.png';
  if (ct.includes('css')) return '.css';
  if (ct.includes('javascript')) return '.js';
  return fallbackExt;
}

function makeSafeFilename(rawUrl, index, ext) {
  try {
    let base = path.basename(new URL(rawUrl).pathname).replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.[a-zA-Z0-9]{2,5}$/, '');
    if (!base || base === '_') base = 'asset';
    return `${String(index).padStart(3, '0')}_${base.slice(-45)}${ext}`;
  } catch {
    return `${String(index).padStart(3, '0')}_asset${ext}`;
  }
}

async function localizeAsset(rawUrl, baseUrl, forcedCategory = null) {
  if (!rawUrl || typeof rawUrl !== 'string' || rawUrl.startsWith('data:') || rawUrl.startsWith('#')) return null;
  let absoluteUrl;
  try { absoluteUrl = new URL(rawUrl.replace(/^['"]|['"]$/g, ''), baseUrl).href; } catch { return null; }

  if (downloadedMap.has(absoluteUrl)) return downloadedMap.get(absoluteUrl);

  const initialExt = resolveExtension(absoluteUrl, '', forcedCategory === 'font' ? '.woff2' : forcedCategory === 'media' ? '.mp4' : '.webp');
  const isMediaCat = forcedCategory === 'media' || ['.mp4', '.webm'].includes(initialExt);
  const isImageCat = forcedCategory === 'image' || ['.png', '.jpg', '.webp', '.svg'].includes(initialExt);
  const isFontCat = forcedCategory === 'font' || ['.woff2', '.woff', '.ttf'].includes(initialExt);

  if ((config.skipVideo && isMediaCat) || (config.skipImages && isImageCat) || (config.skipFonts && isFontCat)) return null;

  let subFolder = isFontCat ? 'fonts' : isMediaCat ? 'media' : 'images';
  let targetDir = isFontCat ? fontsDir : isMediaCat ? mediaDir : imagesDir;
  let fileIndex = isFontCat ? ++globalFontIdx : isMediaCat ? ++globalMediaIdx : ++globalImgIdx;

  let fileName = makeSafeFilename(absoluteUrl, fileIndex, initialExt);
  let fullDiskPath = path.join(targetDir, fileName);
  let actualExt = initialExt;

  try {
    const response = await axios({
      method: 'GET',
      url: absoluteUrl,
      responseType: 'stream',
      headers: { ...DEFAULT_HEADERS, Referer: baseUrl },
      timeout: isMediaCat ? 120000 : 30000
    });
    
    const contentType = response.headers['content-type'] || '';
    if ((config.skipVideo && contentType.includes('video')) || (config.skipImages && contentType.includes('image'))) return null;

    actualExt = resolveExtension(absoluteUrl, contentType, initialExt);
    fileName = makeSafeFilename(absoluteUrl, fileIndex, actualExt);
    fullDiskPath = path.join(targetDir, fileName);

    const writer = createWriteStream(fullDiskPath);
    await pipeline(response.data, writer);
  } catch (e) {
    return null; 
  }

  const paths = {
    originalUrl: absoluteUrl,
    htmlRelPath: `./assets/${subFolder}/${fileName}`,
    cssRelPath: `../assets/${subFolder}/${fileName}`
  };
  
  downloadedMap.set(absoluteUrl, paths);
  return paths;
}

async function localizeCssUrls(cssText, cssBaseUrl) {
  const urlRegex = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  let updatedCss = cssText;
  for (const match of Array.from(cssText.matchAll(urlRegex))) {
    const rawUrl = match[2].trim();
    if (rawUrl.startsWith('data:') || rawUrl.startsWith('#')) continue;
    const localized = await localizeAsset(rawUrl, cssBaseUrl, 'image');
    if (localized) updatedCss = updatedCss.split(match[0]).join(`url("${localized.cssRelPath}")`);
  }
  return updatedCss;
}

async function processOfflineHtml(rawHtml, pageUrl) {
  const $ = cheerio.load(rawHtml);

  // 1. Безопасное извлечение текстов
  $('h1, h2, h3, h4, p, a, button, li, span').each((_, el) => {
    if ($(el).closest('svg, script, style, noscript').length > 0) return;
    const text = $(el).text().trim();
    if (text && text.length > 2) {
      const key = `txt_${++globalTextIdx}`;
      globalContentMap.texts[key] = text;
      globalContentMap._originalTexts[key] = text;
      $(el).attr('data-agent-text', key);
    }
  });

  // 2. Локализация картинок
  const imgPromises = $('img').map(async (_, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src');
    if (src) {
      const key = `img_${++globalContentImgIdx}`;
      globalContentMap.images[key] = { src, alt: $(el).attr('alt') || '' };
      $(el).attr('data-agent-img', key);
      const loc = await localizeAsset(src, pageUrl, 'image');
      if (loc) {
        $(el).attr('src', loc.htmlRelPath);
        $(el).removeAttr('srcset');
        globalContentMap.images[key].src = loc.htmlRelPath;
      }
    }
  }).get();
  await Promise.all(imgPromises);

  // 3. Локализация видео
  const vidPromises = $('video').map(async (_, el) => {
    const src = $(el).attr('src') || $(el).find('source').attr('src');
    const poster = $(el).attr('poster');
    if (src) {
      const key = `vid_${++globalVidIdx}`;
      globalContentMap.videos[key] = { src, poster: poster || '', autoplay: $(el).attr('autoplay') !== undefined };
      $(el).attr('data-agent-video', key);
      
      const locVid = await localizeAsset(src, pageUrl, 'media');
      if (locVid) {
        $(el).attr('src', locVid.htmlRelPath);
        $(el).find('source').attr('src', locVid.htmlRelPath);
        globalContentMap.videos[key].src = locVid.htmlRelPath;
      }
      
      if (poster) {
        const locPoster = await localizeAsset(poster, pageUrl, 'image');
        if (locPoster) {
          $(el).attr('poster', locPoster.htmlRelPath);
          globalContentMap.videos[key].poster = locPoster.htmlRelPath;
        }
      }
    }
  }).get();
  await Promise.all(vidPromises);

  // 4. Локализация фонов
  const bgPromises = $('section, div, header, footer, a, span').map(async (_, el) => {
    const style = $(el).attr('style');
    if (style && style.includes('background-image')) {
       const match = style.match(/url\(['"]?([^'"]+)['"]?\)/);
       if (match && match[1] && !match[1].startsWith('data:')) {
          const key = `bg_${++globalBgIdx}`;
          globalContentMap.backgrounds[key] = { src: match[1] };
          $(el).attr('data-agent-bg', key);
          const locBg = await localizeAsset(match[1], pageUrl, 'image');
          if(locBg) {
             $(el).css('background-image', `url("${locBg.htmlRelPath}")`);
             globalContentMap.backgrounds[key].src = locBg.htmlRelPath;
          }
       }
    }
  }).get();
  await Promise.all(bgPromises);

  // 5. Локализация CSS
  const cssPromises = $('link[rel="stylesheet"]').map(async (_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    try {
      const absoluteCssUrl = new URL(href, pageUrl).href;
      const response = await axios.get(absoluteCssUrl, { headers: DEFAULT_HEADERS, timeout: 15000 });
      let cssContent = response.data;
      if (cssContent && typeof cssContent === 'string') {
        const locCss = await localizeCssUrls(cssContent, absoluteCssUrl);
        const fileName = makeSafeFilename(absoluteCssUrl, ++globalCssIdx, '.css');
        await fs.writeFile(path.join(cssDir, fileName), locCss, 'utf-8');
        $(el).attr('href', `./css/${fileName}`);
        $(el).removeAttr('integrity');
      }
    } catch(e) {}
  }).get();
  await Promise.all(cssPromises);

  // 6. Локализация JS
  const jsPromises = $('script[src]').map(async (_, el) => {
    const src = $(el).attr('src');
    if (!src || src.includes('google-analytics') || src.includes('yandex')) {
      $(el).remove(); // Вырезаем трекеры на лету
      return;
    }
    try {
      const absoluteJsUrl = new URL(src, pageUrl).href;
      const response = await axios.get(absoluteJsUrl, { headers: DEFAULT_HEADERS, timeout: 15000 });
      if (response.data && typeof response.data === 'string') {
        const fileName = makeSafeFilename(absoluteJsUrl, ++globalJsIdx, '.js');
        await fs.writeFile(path.join(jsDir, fileName), response.data, 'utf-8');
        $(el).attr('src', `./js/${fileName}`);
        $(el).removeAttr('integrity');
      }
    } catch(e) {}
  }).get();
  await Promise.all(jsPromises);

  // 7. Перезапись ссылок на локальные файлы (Плоская структура)
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && !href.startsWith('#') && !href.startsWith('mailto:') && !href.startsWith('javascript:')) {
      try {
        const u = new URL(href, pageUrl);
        if (u.origin === baseOrigin) {
          const targetFile = urlToLocalFilename(u.href, baseOrigin);
          $(el).attr('data-agent-orig-href', href);
          $(el).attr('href', `./${targetFile}${u.hash}`);
        }
      } catch (e) {}
    }
  });

  // Внедряем скрипт-мост
  $('body').append('<script src="./js/agent-content-bridge.js" defer></script>');

  return { cleanHtml: $.html() };
}

// ГЕНЕРАЦИЯ AGENT-CONTENT-BRIDGE (С ПЕРЕХВАТЧИКОМ ССЫЛОК)
async function writeBridgeAndRoutingFiles(baseOriginStr, crawledPagesMap) {
  const routeMapObj = {
    baseOrigin: baseOriginStr,
    routes: {}
  };

  for (const [normUrl, fileName] of crawledPagesMap.entries()) {
    try {
      const parsed = new URL(normUrl);
      const pathname = parsed.pathname || '/';
      routeMapObj.routes[normUrl] = `./${fileName}`;
      routeMapObj.routes[pathname] = `./${fileName}`;
      if (pathname.length > 1) {
        routeMapObj.routes[`${pathname}/`] = `./${fileName}`;
      }

      if (pathname !== '/' && !pathname.includes('.')) {
        const subDir = path.join(outputDir, ...pathname.split('/').filter(Boolean));
        await fs.mkdir(subDir, { recursive: true });
        const depth = pathname.split('/').filter(Boolean).length;
        const prefix = '../'.repeat(depth);
        const redirectHtml = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>Redirecting...</title>
  <meta http-equiv="refresh" content="0;url=${prefix}${fileName}">
  <script>window.location.replace("${prefix}${fileName}" + window.location.hash);</script>
</head>
<body></body>
</html>`;
        await fs.writeFile(path.join(subDir, 'index.html'), redirectHtml, 'utf-8');
      }
    } catch {}
  }

  await fs.writeFile(
    path.join(outputDir, 'pages-map.json'),
    JSON.stringify(routeMapObj, null, 2),
    'utf-8'
  );

  const bridgeScriptContent = `/**
 * Agent Content & Multi-Page Navigation Bridge
 */
(async function applyAgentContentAndRouting() {
  let routeData = { baseOrigin: '', routes: {} };
  try {
    const rRes = await fetch('./pages-map.json?_t=' + Date.now(), { cache: 'no-store' });
    if (rRes.ok) routeData = await rRes.json();
  } catch {}

  const resolveLocalTarget = (rawHref) => {
    if (!rawHref || typeof rawHref !== 'string') return null;
    const trimmed = rawHref.trim();
    if (
      !trimmed ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('mailto:') ||
      trimmed.startsWith('tel:') ||
      trimmed.startsWith('javascript:')
    ) {
      return null;
    }
    if (trimmed.startsWith('./') && trimmed.includes('.html')) return trimmed;

    try {
      const base = routeData.baseOrigin || window.location.origin;
      const parsed = new URL(trimmed, base);
      if (
        routeData.baseOrigin &&
        parsed.origin !== routeData.baseOrigin &&
        parsed.origin !== window.location.origin
      ) {
        return null;
      }
      const hash = parsed.hash || '';
      let cleanPath = parsed.pathname || '/';
      if (cleanPath.length > 1 && cleanPath.endsWith('/')) {
        cleanPath = cleanPath.slice(0, -1);
      }

      if (routeData.routes && routeData.routes[cleanPath]) {
        return routeData.routes[cleanPath] + hash;
      }
      const fullKey = (routeData.baseOrigin || '') + cleanPath;
      if (routeData.routes && routeData.routes[fullKey]) {
        return routeData.routes[fullKey] + hash;
      }
    } catch {}
    return null;
  };

  const rewriteLinks = () => {
    document.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href');
      const localTarget = resolveLocalTarget(href);
      if (localTarget && href !== localTarget) {
        a.setAttribute('href', localTarget);
        a.removeAttribute('target');
      }
    });
  };

  window.addEventListener('click', (e) => {
    const anchor = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!anchor) return;
    const href = anchor.getAttribute('href') || '';
    const origHref = anchor.getAttribute('data-agent-orig-href') || href;
    const localTarget = resolveLocalTarget(href) || resolveLocalTarget(origHref);

    if (localTarget) {
      e.preventDefault();
      e.stopPropagation();
      window.location.href = localTarget;
      return;
    }
  }, true);

  try {
    const res = await fetch('./content.json?_t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) {
      rewriteLinks();
      return;
    }
    const data = await res.json();

    const syncDOM = () => {
      rewriteLinks();

      if (data.texts) {
        Object.entries(data.texts).forEach(([key, val]) => {
          document.querySelectorAll('[data-agent-text="' + key + '"]').forEach((el) => {
             if (el.textContent.trim() !== val) el.textContent = val;
          });
        });
      }

      if (data.images) {
        Object.entries(data.images).forEach(([key, imgData]) => {
          document.querySelectorAll('[data-agent-img="' + key + '"]').forEach((img) => {
            if (imgData.src && img.getAttribute('src') !== imgData.src) {
              img.setAttribute('src', imgData.src);
              img.removeAttribute('srcset');
              img.removeAttribute('data-src');
            }
            if (imgData.alt !== undefined) img.alt = imgData.alt;
          });
        });
      }

      if (data.videos) {
        Object.entries(data.videos).forEach(([key, vidData]) => {
          document.querySelectorAll('[data-agent-video="' + key + '"]').forEach((video) => {
            if (vidData.src && video.getAttribute('data-agent-applied-vid') !== vidData.src) {
              video.setAttribute('data-agent-applied-vid', vidData.src);
              video.setAttribute('src', vidData.src);
              video.querySelectorAll('source').forEach((s) => s.setAttribute('src', vidData.src));
              if (vidData.poster) video.setAttribute('poster', vidData.poster);
              video.load();
              if (vidData.autoplay) video.play().catch(() => {});
            }
          });
        });
      }
      
      if (data.backgrounds) {
        Object.entries(data.backgrounds).forEach(([key, bgData]) => {
          const bgUrl = typeof bgData === 'string' ? bgData : bgData.src;
          if (!bgUrl) return;
          document.querySelectorAll('[data-agent-bg="' + key + '"]').forEach((el) => {
            const expected = 'url("' + bgUrl + '")';
            if (el.style.backgroundImage !== expected) {
              el.style.backgroundImage = expected;
            }
          });
        });
      }
    };

    syncDOM();
    [150, 500, 1500].forEach((ms) => setTimeout(syncDOM, ms));
  } catch (err) {
    rewriteLinks();
  }
})();
`;
  await fs.writeFile(path.join(jsDir, 'agent-content-bridge.js'), bridgeScriptContent, 'utf-8');
}

async function runCrawler() {
  console.log(`[Crawler] Запуск АБСОЛЮТНОГО (Node.js/Axios) парсинга. Старт: ${startUrl}`);
  
  await fs.mkdir(cssDir, { recursive: true });
  await fs.mkdir(jsDir, { recursive: true });
  await fs.mkdir(specsDir, { recursive: true });
  await fs.mkdir(fontsDir, { recursive: true });
  await fs.mkdir(imagesDir, { recursive: true });
  await fs.mkdir(mediaDir, { recursive: true });

  let pagesScraped = 0;

  try {
    visitedMap.set(startUrl, 'index.html');

    while (urlsToVisit.length > 0 && pagesScraped < MAX_PAGES) {
      const currentUrl = urlsToVisit.shift();
      const cleanUrl = currentUrl.split('#')[0].split('?')[0];
      if (visitedUrls.has(cleanUrl)) continue;

      visitedUrls.add(cleanUrl);
      const isMainPage = pagesScraped === 0;
      const localFileName = isMainPage ? 'index.html' : urlToLocalFilename(cleanUrl, baseOrigin);
      
      visitedMap.set(cleanUrl, localFileName);
      console.log(`\n📄 [${pagesScraped + 1}/${MAX_PAGES}] Извлечение страницы: ${cleanUrl} -> ${localFileName}`);

      try {
        // 1. ПОЛУЧАЕМ HTML НАПРЯМУЮ, БЕЗ БРАУЗЕРА!
        const response = await axios.get(cleanUrl, { headers: DEFAULT_HEADERS, timeout: 30000 });
        const rawHtml = response.data;
        
        // 2. ПАРСИМ И ЛОКАЛИЗУЕМ ФАЙЛЫ
        const { cleanHtml } = await processOfflineHtml(rawHtml, cleanUrl);

        // 3. СОХРАНЯЕМ HTML (ПЛОСКАЯ СТРУКТУРА)
        const savePath = path.join(outputDir, localFileName);
        await fs.writeFile(savePath, cleanHtml, 'utf-8');
        
        console.log(`   ✅ Сохранен HTML и медиа`);

        // 4. ИЩЕМ НОВЫЕ ССЫЛКИ
        const $ = cheerio.load(rawHtml);
        $('a[href]').each((_, el) => {
          const h = $(el).attr('href');
          if (h && !h.startsWith('javascript:') && !h.startsWith('#') && !h.startsWith('mailto:')) {
            try {
              const u = new URL(h, cleanUrl);
              if (u.hostname === baseHostname) {
                const link = u.href.split('#')[0].split('?')[0];
                if (!visitedUrls.has(link) && !urlsToVisit.includes(link)) {
                  urlsToVisit.push(link);
                }
              }
            } catch {}
          }
        });

      } catch (err) {
        console.error(`   ❌ Ошибка обработки ${cleanUrl}:`, err.message);
      } 
      
      pagesScraped++;
    }
    
    // 5. ФИНАЛЬНАЯ ЗАПИСЬ КОНТЕНТА, СПЕЦИФИКАЦИЙ И СКРИПТА НАВИГАЦИИ
    console.log('\n[Финал] Запись единого content.json, карты маршрутов pages-map.json и скрипта моста...');
    await fs.writeFile(path.join(outputDir, 'content.json'), JSON.stringify(globalContentMap, null, 2), 'utf-8');
    await fs.writeFile(path.join(specsDir, 'pages-manifest.json'), JSON.stringify(Object.fromEntries(visitedMap), null, 2), 'utf-8');
    await writeBridgeAndRoutingFiles(baseOrigin, visitedMap);

    console.log(`\n🎉 Обход завершен! Успешно обработано страниц: ${pagesScraped}`);
    console.log(`   ├── content.json (текстов=${Object.keys(globalContentMap.texts).length}, картинок=${Object.keys(globalContentMap.images).length})`);
    console.log('   └── Плоская структура HTML-файлов создана в output/site_clone');
  } catch(fatalErr) {
    console.error(`Критическая ошибка:`, fatalErr);
  }
}

runCrawler().catch(console.error);