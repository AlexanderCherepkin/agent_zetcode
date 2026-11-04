import { chromium, firefox } from 'playwright';
import fs from 'fs/promises';
import { createWriteStream, existsSync } from 'fs';
import path from 'path';
import axios from 'axios';
import { pipeline } from 'stream/promises';
import { cleanHtml } from '../utils/dom-cleaner.js';

// --- ПАРСИНГ АРГУМЕНТОВ КОМАНДНОЙ СТРОКИ (ГИБРИД: ВАРИАНТ А + ВАРИАНТ Б) ---
const args = process.argv.slice(2);
const nonFlagArgs = args.filter((arg) => !arg.startsWith('--'));
const targetUrl = nonFlagArgs[0] || 'https://example.com';

// Дополнительные страницы, переданные напрямую через пробел (Вариант Б)
const cliExtraUrls = nonFlagArgs.slice(1);

// Дополнительные страницы через флаг --pages=/catalog,/about,/contacts (Вариант Б)
const pagesFlag = args.find((arg) => arg.startsWith('--pages='))?.split('=')[1] || '';
const flagExtraUrls = pagesFlag
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const depthArg = args.find((arg) => arg.startsWith('--depth='))?.split('=')[1];
const maxPagesArg = args.find((arg) => arg.startsWith('--max-pages='))?.split('=')[1];
const engineArg = args.find((arg) => arg.startsWith('--engine='))?.split('=')[1];
const isSinglePageOnly = args.includes('--single');

const config = {
  skipVideo: args.includes('--no-video'),
  skipImages: args.includes('--no-images'),
  skipFonts: args.includes('--no-fonts'),
  forceFirefox: args.includes('--firefox') || engineArg === 'firefox',
  maxDepth: isSinglePageOnly ? 0 : depthArg !== undefined ? Number(depthArg) : 1,
  maxPages: isSinglePageOnly ? 1 : maxPagesArg !== undefined ? Number(maxPagesArg) : 15,
  explicitTargets: [...cliExtraUrls, ...flagExtraUrls]
};

const outputDir = path.resolve('output', 'site_clone');
const cssDir = path.join(outputDir, 'css');
const jsDir = path.join(outputDir, 'js');
const specsDir = path.join(outputDir, 'specs');
const assetsDir = path.join(outputDir, 'assets');
const fontsDir = path.join(assetsDir, 'fonts');
const imagesDir = path.join(assetsDir, 'images');
const mediaDir = path.join(assetsDir, 'media');

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: '*/*',
  'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'
};

// Защитная обертка над cleanHtml: предотвращает падение с ошибкой "Unexpected type of selector"
function safeCleanHtml(rawHtml) {
  if (!rawHtml || typeof rawHtml !== 'string') return '';
  try {
    return cleanHtml(rawHtml);
  } catch (err) {
    console.warn(`   ⚠️ Внешний dom-cleaner пропущен (${err.message}). Применена встроенная очистка.`);
    return rawHtml
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, (match) => {
        if (/googletagmanager|google-analytics|mc\.yandex|metrika|fbevents|hotjar/i.test(match)) {
          return '';
        }
        return match;
      })
      .replace(/<meta[^>]*http-equiv=["']?Content-Security-Policy["']?[^>]*>/gi, '');
  }
}

// Определяет расширение файла по URL или Content-Type
function resolveExtension(rawUrl, contentType = '', fallbackExt = '.bin') {
  try {
    const pathname = new URL(rawUrl).pathname;
    const ext = path.extname(pathname).toLowerCase().split('?')[0];
    if (
      [
        '.woff2', '.woff', '.ttf', '.otf', '.eot',
        '.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.svg', '.ico',
        '.mp4', '.webm', '.ogg', '.mov'
      ].includes(ext)
    ) {
      return ext;
    }
  } catch {}

  const ct = (contentType || '').toLowerCase();
  if (ct.includes('woff2')) return '.woff2';
  if (ct.includes('woff')) return '.woff';
  if (ct.includes('truetype') || ct.includes('ttf')) return '.ttf';
  if (ct.includes('opentype') || ct.includes('otf')) return '.otf';
  if (ct.includes('webp')) return '.webp';
  if (ct.includes('avif')) return '.avif';
  if (ct.includes('png')) return '.png';
  if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg';
  if (ct.includes('svg')) return '.svg';
  if (ct.includes('gif')) return '.gif';
  if (ct.includes('webm')) return '.webm';
  if (ct.includes('mp4')) return '.mp4';

  return fallbackExt;
}

// Формирует безопасное имя файла для ассетов
function makeSafeFilename(rawUrl, index, ext) {
  try {
    const parsed = new URL(rawUrl);
    let base = path.basename(parsed.pathname).replace(/[^a-zA-Z0-9._-]/g, '_');
    base = base.replace(/\.[a-zA-Z0-9]{2,5}$/, '');
    if (!base || base === '_') base = 'asset';
    if (base.length > 45) base = base.slice(-45);
    return `${String(index).padStart(3, '0')}_${base}${ext}`;
  } catch {
    return `${String(index).padStart(3, '0')}_asset${ext}`;
  }
}

// --- УПРАВЛЕНИЕ URL И МАРШРУТИЗАЦИЕЙ МНОГОСТРАНИЧНОГО КЛОНА ---
function normalizePageUrl(rawUrl, baseOrigin) {
  try {
    const parsed = new URL(rawUrl, baseOrigin);
    if (parsed.origin !== baseOrigin) return null;
    if (['mailto:', 'tel:', 'javascript:', 'blob:', 'data:'].includes(parsed.protocol)) {
      return null;
    }
    const ext = path.extname(parsed.pathname).toLowerCase();
    if (
      [
        '.jpg', '.jpeg', '.png', '.webp', '.svg', '.gif', '.avif', '.ico',
        '.mp4', '.webm', '.mov', '.mp3', '.wav', '.pdf', '.zip', '.rar',
        '.css', '.js', '.json', '.xml', '.txt', '.woff', '.woff2', '.ttf'
      ].includes(ext)
    ) {
      return null;
    }

    parsed.hash = '';
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'yclid'].forEach(
      (param) => parsed.searchParams.delete(param)
    );

    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.href;
  } catch {
    return null;
  }
}

function urlToLocalFilename(normalizedUrl, baseOrigin) {
  try {
    const parsed = new URL(normalizedUrl, baseOrigin);
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

async function discoverInternalLinks(page, baseOrigin) {
  try {
    const rawLinks = await page.evaluate(() => {
      const found = new Set();
      document.querySelectorAll('a[href], [data-href]').forEach((el) => {
        const href = el.getAttribute('href') || el.getAttribute('data-href');
        if (href && typeof href === 'string') {
          found.add(href.trim());
        }
      });
      return Array.from(found);
    });

    const normalizedSet = new Set();
    for (const raw of rawLinks) {
      if (!raw || raw.startsWith('#') || raw.startsWith('javascript:')) continue;
      const norm = normalizePageUrl(raw, baseOrigin);
      if (norm) normalizedSet.add(norm);
    }
    return Array.from(normalizedSet);
  } catch {
    return [];
  }
}

// 0.1. ОЖИДАНИЕ ПОЛНОЙ ЗАГРУЗКИ СТРАНИЦЫ И ПРЕЛОАДЕРОВ
async function waitForFullPageReady(page, isFirstPage = true) {
  await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});

  await page
    .evaluate(async () => {
      const delay = (ms) => new Promise((r) => setTimeout(r, ms));

      if (document.fonts && document.fonts.ready) {
        await Promise.race([document.fonts.ready, delay(4000)]);
      }

      const preloaderSelectors = [
        '#preloader', '.preloader', '#loader', '.loader', '.page-loader',
        '[class*="preloader"]', '[id*="preloader"]', '[data-preloader]'
      ];

      for (let attempt = 0; attempt < 12; attempt++) {
        const activePreloader = preloaderSelectors
          .map((sel) => {
            try {
              return document.querySelector(sel);
            } catch {
              return null;
            }
          })
          .find((el) => {
            if (!el) return false;
            try {
              const s = window.getComputedStyle(el);
              const rect = el.getBoundingClientRect();
              return (
                s.display !== 'none' &&
                s.visibility !== 'hidden' &&
                parseFloat(s.opacity) > 0.1 &&
                rect.width > window.innerWidth * 0.5 &&
                rect.height > window.innerHeight * 0.5
              );
            } catch {
              return false;
            }
          });

        if (!activePreloader) break;
        await delay(450);
      }
    })
    .catch(() => {});

  await page.waitForTimeout(isFirstPage ? 2500 : 1200).catch(() => {});
}

// 0.2. АВТО-КЛИКЕР COOKIES И ПОЛИТИКИ
async function dismissCookiesAndEntryGates(page) {
  try {
    const clickedInfo = await page.evaluate(async () => {
      const delay = (ms) => new Promise((r) => setTimeout(r, ms));
      const clickedButtons = [];

      const isVisible = (el) => {
        if (!el) return false;
        try {
          const s = window.getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) < 0.05) {
            return false;
          }
          const r = el.getBoundingClientRect();
          return r.width > 10 && r.height > 10;
        } catch {
          return false;
        }
      };

      const knownCmpSelectors = [
        '#onetrust-accept-btn-handler',
        '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
        '#CybotCookiebotDialogBodyButtonAccept',
        '[data-testid="uc-accept-all-button"]',
        '#didomi-notice-agree-button',
        '.cc-btn.cc-allow',
        '.cc-accept',
        '.cmplz-accept',
        '#wt-cli-accept-all-btn',
        '.js-cookie-consent-agree',
        '[data-cookiebanner="accept_button"]',
        'button[id*="cookie"][id*="accept" i]',
        'button[class*="cookie"][class*="accept" i]',
        'button[class*="consent"][class*="accept" i]'
      ];

      for (const sel of knownCmpSelectors) {
        try {
          const btn = document.querySelector(sel);
          if (btn && isVisible(btn)) {
            btn.click();
            clickedButtons.push(`CMP:${sel}`);
            await delay(400);
          }
        } catch {}
      }

      const exactAcceptRegex =
        /^(accept|accept all|accept cookies|allow|allow all|allow cookies|i agree|agree|got it|ok|okay|understand|continue|принять|принять все|принять всё|принять куки|согласен|хорошо|понятно|разрешить|продолжить)$/i;

      const contextualAcceptRegex =
        /(accept|allow|agree|got it|understand|принять|соглас|хорошо|понятн|разреш)/i;

      const containerKeywordsRegex =
        /(cookie|consent|gdpr|privacy|policy|terms|banner|notice|куки|политик|услови|соглаш)/i;

      const candidates = Array.from(
        document.querySelectorAll(
          'button, [role="button"], input[type="button"], input[type="submit"], div[class*="btn" i], span[class*="btn" i]'
        )
      );

      for (const el of candidates) {
        if (!isVisible(el)) continue;

        const rawText = (
          el.innerText ||
          el.textContent ||
          el.getAttribute('aria-label') ||
          el.value ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim();

        if (!rawText || rawText.length > 40) continue;

        if (
          /(decline|reject|deny|manage|settings|preferences|more info|policy|отказ|отклон|настройк|подробн|войти|login|sign in|регистрац|заказать|купить|звонок)/i.test(
            rawText
          ) &&
          !/(accept|agree|allow|принять|соглас)/i.test(rawText)
        ) {
          continue;
        }

        let parentContext = null;
        try {
          parentContext =
            el.closest(
              '[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [id*="gdpr" i], [class*="gdpr" i], [id*="privacy" i], [class*="privacy" i]'
            ) || el.parentElement;
        } catch {
          parentContext = el.parentElement;
        }

        const parentSignature = parentContext
          ? `${parentContext.id || ''} ${parentContext.className || ''} ${
              parentContext.textContent?.slice(0, 250) || ''
            }`
          : '';

        const isExactMatch = exactAcceptRegex.test(rawText);
        const isContextualMatch =
          contextualAcceptRegex.test(rawText) && containerKeywordsRegex.test(parentSignature);

        if (isExactMatch || isContextualMatch) {
          try {
            el.click();
            clickedButtons.push(`Text:"${rawText}"`);
            await delay(400);
          } catch {}
        }
      }

      if (clickedButtons.length > 0) {
        await delay(300);
        try {
          if (window.getComputedStyle(document.body).overflow === 'hidden') {
            document.body.style.overflow = 'visible';
            document.documentElement.style.overflow = 'visible';
          }
        } catch {}
      }

      return clickedButtons;
    });

    if (clickedInfo && clickedInfo.length > 0) {
      console.log(`   👉 Закрыты баннеры cookie: ${clickedInfo.join(', ')}`);
      await page.waitForTimeout(800);
    }
  } catch {}
}

// 1. МЕНЕДЖЕР ПОТОКОВОГО СКАЧИВАНИЯ И ДЕДУПЛИКАЦИИ АССЕТОВ
function createAssetLocalizer(getCurrentPageUrl, networkCache, cfg) {
  const downloadedMap = new Map();
  let fontIdx = 0;
  let imgIdx = 0;
  let mediaIdx = 0;

  async function localizeAsset(rawUrl, baseUrl, forcedCategory = null) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    const trimmed = rawUrl.trim().replace(/^['"]|['"]$/g, '');
    if (
      !trimmed ||
      trimmed.startsWith('data:') ||
      trimmed.startsWith('blob:') ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('mailto:') ||
      trimmed.startsWith('tel:') ||
      trimmed.startsWith('./assets/') ||
      trimmed.startsWith('../assets/')
    ) {
      return null;
    }

    let absoluteUrl;
    try {
      absoluteUrl = new URL(trimmed, baseUrl).href;
    } catch {
      return null;
    }

    if (downloadedMap.has(absoluteUrl)) {
      return downloadedMap.get(absoluteUrl);
    }

    const initialExt = resolveExtension(
      absoluteUrl,
      '',
      forcedCategory === 'font' ? '.woff2' : forcedCategory === 'media' ? '.mp4' : '.webp'
    );

    const cached = networkCache.binary.get(absoluteUrl);
    let buffer = cached?.buffer || null;
    let contentType = cached?.contentType || '';

    const isFontCat =
      forcedCategory === 'font' ||
      ['.woff2', '.woff', '.ttf', '.otf', '.eot'].includes(initialExt) ||
      contentType.includes('font');
    const isMediaCat =
      forcedCategory === 'media' ||
      ['.mp4', '.webm', '.ogg', '.mov'].includes(initialExt) ||
      contentType.includes('video') ||
      contentType.includes('audio');
    const isImageCat =
      forcedCategory === 'image' ||
      ['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.svg', '.ico'].includes(initialExt) ||
      contentType.includes('image');

    if (
      (cfg.skipVideo && isMediaCat) ||
      (cfg.skipImages && isImageCat) ||
      (cfg.skipFonts && isFontCat)
    ) {
      return null;
    }

    if (!buffer) {
      try {
        const currentUrl = getCurrentPageUrl();
        const pageOrigin = new URL(currentUrl).origin;
        const response = await axios({
          method: 'GET',
          url: absoluteUrl,
          responseType: 'stream',
          headers: {
            ...DEFAULT_HEADERS,
            Referer: currentUrl,
            Origin: pageOrigin
          },
          timeout: isMediaCat ? 120000 : 25000,
          maxContentLength: Infinity,
          maxBodyLength: Infinity
        });

        contentType = response.headers['content-type'] || '';

        if (
          (cfg.skipVideo && contentType.includes('video')) ||
          (cfg.skipImages && contentType.includes('image')) ||
          (cfg.skipFonts && contentType.includes('font'))
        ) {
          response.data.destroy();
          return null;
        }

        const actualExt = resolveExtension(absoluteUrl, contentType, initialExt);
        const isFont =
          forcedCategory === 'font' ||
          ['.woff2', '.woff', '.ttf', '.otf', '.eot'].includes(actualExt) ||
          contentType.includes('font');
        const isMedia =
          forcedCategory === 'media' ||
          ['.mp4', '.webm', '.ogg', '.mov'].includes(actualExt) ||
          contentType.includes('video') ||
          contentType.includes('audio');

        let subFolder = 'images';
        let targetDir = imagesDir;
        let fileIndex = ++imgIdx;

        if (isFont) {
          subFolder = 'fonts';
          targetDir = fontsDir;
          fileIndex = ++fontIdx;
        } else if (isMedia) {
          subFolder = 'media';
          targetDir = mediaDir;
          fileIndex = ++mediaIdx;
        }

        const fileName = makeSafeFilename(absoluteUrl, fileIndex, actualExt);
        const fullDiskPath = path.join(targetDir, fileName);

        const writer = createWriteStream(fullDiskPath);
        await pipeline(response.data, writer);

        const paths = {
          originalUrl: absoluteUrl,
          htmlRelPath: `./assets/${subFolder}/${fileName}`,
          cssRelPath: `../assets/${subFolder}/${fileName}`
        };
        downloadedMap.set(absoluteUrl, paths);
        return paths;
      } catch {
        return null;
      }
    }

    const ext = resolveExtension(absoluteUrl, contentType, initialExt);
    const isFont =
      forcedCategory === 'font' ||
      ['.woff2', '.woff', '.ttf', '.otf', '.eot'].includes(ext) ||
      contentType.includes('font');
    const isMedia =
      forcedCategory === 'media' ||
      ['.mp4', '.webm', '.ogg', '.mov'].includes(ext) ||
      contentType.includes('video') ||
      contentType.includes('audio');

    let subFolder = 'images';
    let targetDir = imagesDir;
    let fileIndex = ++imgIdx;

    if (isFont) {
      subFolder = 'fonts';
      targetDir = fontsDir;
      fileIndex = ++fontIdx;
    } else if (isMedia) {
      subFolder = 'media';
      targetDir = mediaDir;
      fileIndex = ++mediaIdx;
    }

    const fileName = makeSafeFilename(absoluteUrl, fileIndex, ext);
    const fullDiskPath = path.join(targetDir, fileName);

    try {
      await fs.writeFile(fullDiskPath, buffer);
      const paths = {
        originalUrl: absoluteUrl,
        htmlRelPath: `./assets/${subFolder}/${fileName}`,
        cssRelPath: `../assets/${subFolder}/${fileName}`
      };
      downloadedMap.set(absoluteUrl, paths);
      return paths;
    } catch {
      return null;
    }
  }

  async function localizeCssUrls(cssText, cssBaseUrl) {
    if (!cssText || typeof cssText !== 'string') return cssText;
    const urlRegex = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
    const matches = Array.from(cssText.matchAll(urlRegex));
    if (matches.length === 0) return cssText;

    let updatedCss = cssText;
    for (const match of matches) {
      const fullMatch = match[0];
      const rawUrl = match[2].trim();
      if (rawUrl.startsWith('data:') || rawUrl.startsWith('#')) continue;

      const localized = await localizeAsset(rawUrl, cssBaseUrl);
      if (localized) {
        updatedCss = updatedCss.split(fullMatch).join(`url("${localized.cssRelPath}")`);
      } else {
        try {
          const abs = new URL(rawUrl, cssBaseUrl).href;
          updatedCss = updatedCss.split(fullMatch).join(`url("${abs}")`);
        } catch {}
      }
    }
    return updatedCss;
  }

  return {
    localizeAsset,
    localizeCssUrls,
    getStats: () => ({ fonts: fontIdx, images: imgIdx, media: mediaIdx })
  };
}

// 2. ПЛАВНЫЙ СКРОЛЛ СТРАНИЦЫ (ДЛЯ ПОДГРУЗКИ LAZY-LOAD КАРТИНОК И PARALLAX)
async function autoScrollAndRecordChoreography(page, isMainPage = true) {
  try {
    return await page.evaluate(async (fullAnalysis) => {
      const delay = (ms) => new Promise((r) => setTimeout(r, ms));

      const getSelector = (el) => {
        if (!el || !el.tagName || typeof el.tagName !== 'string') return 'div';
        try {
          const tag = el.tagName.toLowerCase();
          const id = el.id ? `#${el.id}` : '';
          const cls =
            el.className && typeof el.className === 'string'
              ? '.' + el.className.trim().split(/\s+/).slice(0, 3).filter(Boolean).join('.')
              : '';
          return `${tag}${id}${cls}`;
        } catch {
          return 'div';
        }
      };

      const parseTransform = (transformStr) => {
        if (!transformStr || transformStr === 'none') return { tx: 0, ty: 0, scale: 1 };
        try {
          const match2d = transformStr.match(/matrix\(([^)]+)\)/);
          if (match2d) {
            const parts = match2d[1].split(',').map((n) => parseFloat(n.trim()));
            return { tx: parts[4] || 0, ty: parts[5] || 0, scale: parts[0] || 1 };
          }
          const match3d = transformStr.match(/matrix3d\(([^)]+)\)/);
          if (match3d) {
            const parts = match3d[1].split(',').map((n) => parseFloat(n.trim()));
            return { tx: parts[12] || 0, ty: parts[13] || 0, scale: parts[0] || 1 };
          }
        } catch {}
        return { tx: 0, ty: 0, scale: 1 };
      };

      if (!fullAnalysis) {
        let scrolled = 0;
        const step = 450;
        const maxH = Math.min(18000, document.body?.scrollHeight || 6000);
        while (scrolled < maxH) {
          window.scrollBy(0, step);
          window.dispatchEvent(new WheelEvent('wheel', { deltaY: step, bubbles: true }));
          scrolled += step;
          await delay(140);
        }
        window.scrollTo(0, 0);
        await delay(400);
        return {
          trueParallaxElements: [],
          horizontalScrollContainers: [],
          mouseParallaxElements: [],
          fadeInAndRevealElements: [],
          stackingOverlappingCards: [],
          scrollScrubbedVideos: []
        };
      }

      let candidates = [];
      try {
        candidates = Array.from(
          document.querySelectorAll(
            'section, main > div, article, [data-scroll], [data-speed], [data-parallax], [data-depth], [class*="parallax" i], [class*="layer" i], video, img, canvas, h1, h2, h3'
          )
        ).slice(0, 120);
      } catch {}

      const history = new Map();
      candidates.forEach((el, idx) => {
        try {
          history.set(idx, {
            selector: getSelector(el),
            tag: el.tagName ? el.tagName.toLowerCase() : 'div',
            dataParallaxAttr:
              el.getAttribute('data-speed') ||
              el.getAttribute('data-parallax') ||
              el.getAttribute('data-scroll-speed') ||
              null,
            samples: []
          });
        } catch {}
      });

      const recordSnapshot = (currentScrollY) => {
        candidates.forEach((el, idx) => {
          try {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            if (rect.bottom >= -400 && rect.top <= window.innerHeight + 400) {
              const histItem = history.get(idx);
              if (histItem) {
                histItem.samples.push({
                  scrollY: Math.round(currentScrollY),
                  top: Math.round(rect.top),
                  transform: style.transform !== 'none' ? style.transform : null,
                  opacity: parseFloat(style.opacity),
                  position: style.position
                });
              }
            }
          } catch {}
        });
      };

      let totalScrolledY = 0;
      const stepDistanceY = 300;
      const maxScrollY = 20000;
      recordSnapshot(0);

      while (totalScrolledY < maxScrollY) {
        const scrollHeight = Math.max(
          document.body?.scrollHeight || 0,
          document.documentElement?.scrollHeight || 0,
          window.innerHeight * 2
        );
        window.scrollBy(0, stepDistanceY);
        window.dispatchEvent(new WheelEvent('wheel', { deltaY: stepDistanceY, bubbles: true }));
        totalScrolledY += stepDistanceY;
        await delay(180);
        recordSnapshot(window.scrollY || totalScrolledY);
        if (totalScrolledY >= scrollHeight - window.innerHeight) break;
      }

      await delay(500);
      window.scrollTo(0, 0);
      await delay(500);

      const choreography = {
        trueParallaxElements: [],
        horizontalScrollContainers: [],
        mouseParallaxElements: [],
        fadeInAndRevealElements: [],
        stackingOverlappingCards: [],
        scrollScrubbedVideos: []
      };

      history.forEach((item) => {
        try {
          const s = item.samples;
          if (!s || s.length < 2) return;
          const first = s[0];
          const last = s[s.length - 1];
          const firstT = parseTransform(first.transform);
          const lastT = parseTransform(last.transform);
          const deltaScrollY = Math.max(1, Math.abs(last.scrollY - first.scrollY));
          const deltaTx = Math.round(lastT.tx - firstT.tx);
          const deltaTy = Math.round(lastT.ty - firstT.ty);
          const uniqueTransforms = new Set(s.map((x) => x.transform).filter(Boolean)).size;

          if ((uniqueTransforms >= 3 && (Math.abs(deltaTy) >= 15 || Math.abs(deltaTx) >= 15)) || item.dataParallaxAttr) {
            choreography.trueParallaxElements.push({
              selector: item.selector,
              tag: item.tag,
              parallaxSpeedRatioY: Number((deltaTy / deltaScrollY).toFixed(3)),
              deltaTranslateYPx: deltaTy
            });
          }

          // Дополнительная эвристика: Горизонтальный скролл
          if (Math.abs(deltaTx) > 100 && Math.abs(deltaTy) < 50 && uniqueTransforms >= 3) {
            choreography.horizontalScrollContainers.push({
              selector: item.selector,
              horizontalDeltaPx: deltaTx
            });
          }

          // Дополнительная эвристика: Sticky / Наезжающие карточки
          if (first.position === 'sticky' || last.position === 'sticky') {
            choreography.stackingOverlappingCards.push({
              selector: item.selector
            });
          }

          // Дополнительная эвристика: Fade In / Reveal
          if ((last.opacity - first.opacity) > 0.4 && first.opacity < 0.3) {
            choreography.fadeInAndRevealElements.push({ selector: item.selector });
          }

          // Дополнительная эвристика: Scroll-Scrubbed Videos (нет автоплея)
          if (item.tag === 'video') {
            try {
              const vid = document.querySelector(item.selector);
              if (vid && !vid.autoplay && vid.duration > 1) {
                choreography.scrollScrubbedVideos.push({ selector: item.selector });
                vid.setAttribute('data-scroll-scrub', 'true');
              }
            } catch {}
          }

          // Дополнительная эвристика: Mouse Parallax
          if (item.selector.includes('mouse') || item.selector.includes('depth') || (document.querySelector(item.selector) && document.querySelector(item.selector).hasAttribute('data-depth'))) {
             choreography.mouseParallaxElements.push({ selector: item.selector, mouseShiftX: 25, mouseShiftY: 25 });
          }

        } catch {}
      });

      return choreography;
    }, isMainPage);
  } catch {
    return {
      trueParallaxElements: [],
      horizontalScrollContainers: [],
      mouseParallaxElements: [],
      fadeInAndRevealElements: [],
      stackingOverlappingCards: [],
      scrollScrubbedVideos: []
    };
  }
}

// 3. ГЛОБАЛЬНЫЙ ЭКСТРАКТОР КОНТЕНТА (СКВОЗНАЯ НУМЕРАЦИЯ + СБОР МЕТАДАННЫХ _meta ДЛЯ ИИ-РЕБРЕНДЕРА)
function createGlobalContentExtractor(assetLocalizer) {
  const globalContentMap = {
    texts: {},
    images: {},
    videos: {},
    backgrounds: {},
    _originalTexts: {},
    _meta: {}
  };

  let textIdx = 0;
  let imgIdx = 0;
  let vidIdx = 0;
  let bgIdx = 0;

  async function extractPageContent(page) {
    const pageBatch = await page.evaluate(
      ({ startText, startImg, startVid, startBg }) => {
        let tIdx = startText;
        let iIdx = startImg;
        let vIdx = startVid;
        let bIdx = startBg;

        const batch = { texts: {}, images: {}, videos: {}, backgrounds: {}, meta: {} };

        // Определяет семантический тег и секцию элемента для точного ИИ-рерайта
        const getElementMeta = (el) => {
          let tag = el.tagName ? el.tagName.toLowerCase() : 'div';
          if (el.closest('button, [role="button"]')) {
            tag = 'button';
          } else if (el.closest('a')) {
            tag = 'a';
          } else if (el.closest('h1, h2, h3, h4, h5, h6')) {
            const headingEl = el.closest('h1, h2, h3, h4, h5, h6');
            if (headingEl && headingEl.tagName) tag = headingEl.tagName.toLowerCase();
          }

          let section = 'general';
          if (el.closest('nav, [role="navigation"]')) {
            section = 'nav';
          } else if (el.closest('header')) {
            section = 'header';
          } else if (el.closest('footer')) {
            section = 'footer';
          } else if (el.closest('form')) {
            section = 'form';
          } else {
            const secEl = el.closest('section, article, [data-section], main > div');
            if (secEl) {
              const idOrClass = (secEl.id || (typeof secEl.className === 'string' ? secEl.className : '') || '').toLowerCase();
              if (/hero|banner|intro|first|top/.test(idOrClass)) {
                section = 'hero';
              } else if (secEl.id) {
                section = secEl.id.slice(0, 30);
              } else {
                const rect = secEl.getBoundingClientRect();
                if (rect.top >= 0 && rect.top < window.innerHeight * 0.75) {
                  section = 'hero';
                } else {
                  section = 'content_section';
                }
              }
            }
          }

          return { tag, section };
        };

        try {
          const splitCandidates = document.querySelectorAll('h1, h2, h3, h4, p, [data-splitting]');
          splitCandidates.forEach((el) => {
            const childSpans = el.querySelectorAll('span, div');
            if (childSpans.length >= 4) {
              const singleCharCount = Array.from(childSpans).filter(
                (s) => s.children.length === 0 && s.textContent.trim().length === 1
              ).length;

              if (singleCharCount >= 4) {
                const fullText = (el.getAttribute('aria-label') || el.textContent || '')
                  .replace(/\s+/g, ' ')
                  .trim();
                if (fullText.length > 0) {
                  const key = `txt_${++tIdx}`;
                  batch.texts[key] = fullText;
                  batch.meta[key] = getElementMeta(el);
                  el.setAttribute('data-agent-text', key);
                  el.setAttribute('data-agent-split-text', 'chars');
                  childSpans.forEach((s) => s.setAttribute('data-agent-ignore-text', 'true'));
                }
              }
            }
          });
        } catch {}

        try {
          const textElements = document.querySelectorAll(
            'h1, h2, h3, h4, h5, h6, p, span, a, button, li, label, td, th, div'
          );
          textElements.forEach((el) => {
            if (
              el.hasAttribute('data-agent-text') ||
              el.hasAttribute('data-agent-ignore-text') ||
              el.closest('[data-agent-split-text]') ||
              el.closest('svg') ||
              el.closest('script') ||
              el.closest('style')
            ) {
              return;
            }

            let directText = '';
            el.childNodes.forEach((node) => {
              if (node.nodeType === Node.TEXT_NODE) {
                const text = node.textContent.trim();
                if (text.length > 0) directText += text + ' ';
              }
            });

            directText = directText.trim();
            if (directText.length > 0) {
              const key = `txt_${++tIdx}`;
              batch.texts[key] = directText;
              batch.meta[key] = getElementMeta(el);
              el.setAttribute('data-agent-text', key);
            }
          });
        } catch {}

        try {
          document.querySelectorAll('[data-agent-ignore-text]').forEach((el) => {
            el.removeAttribute('data-agent-ignore-text');
          });
        } catch {}

        try {
          document.querySelectorAll('img').forEach((img) => {
            const src =
              img.getAttribute('data-src') ||
              img.getAttribute('data-lazy-src') ||
              img.getAttribute('data-original') ||
              img.currentSrc ||
              img.src;
            if (src) {
              const key = `img_${++iIdx}`;
              batch.images[key] = { src, alt: img.alt || '' };
              img.setAttribute('data-agent-img', key);
            }
          });
        } catch {}

        try {
          document.querySelectorAll('video').forEach((video) => {
            const sourceEl = video.querySelector('source');
            const src =
              video.currentSrc ||
              video.src ||
              video.getAttribute('data-src') ||
              video.getAttribute('data-video-src') ||
              (sourceEl ? sourceEl.src || sourceEl.getAttribute('data-src') : '');
            if (src) {
              const key = `vid_${++vIdx}`;
              batch.videos[key] = {
                src,
                poster: video.poster || video.getAttribute('data-poster') || '',
                autoplay: video.autoplay,
                loop: video.loop,
                muted: video.muted
              };
              video.setAttribute('data-agent-video', key);
            }
          });
        } catch {}

        try {
          document.querySelectorAll('section, div, header, footer, a, span').forEach((el) => {
            const bg = window.getComputedStyle(el).backgroundImage;
            if (bg && bg !== 'none' && bg.includes('url(') && !bg.includes('data:image')) {
              const match = bg.match(/url\(['"]?([^'"]+)['"]?\)/);
              if (match && match[1]) {
                const key = `bg_${++bIdx}`;
                batch.backgrounds[key] = { src: match[1] };
                el.setAttribute('data-agent-bg', key);
              }
            }
          });
        } catch {}

        return { batch, nextCounts: { tIdx, iIdx, vIdx, bIdx } };
      },
      { startText: textIdx, startImg: imgIdx, startVid: vidIdx, startBg: bgIdx }
    );

    textIdx = pageBatch.nextCounts.tIdx;
    imgIdx = pageBatch.nextCounts.iIdx;
    vidIdx = pageBatch.nextCounts.vIdx;
    bgIdx = pageBatch.nextCounts.bIdx;

    const currentPageUrl = page.url();
    const { batch } = pageBatch;

    for (const [key, imgObj] of Object.entries(batch.images)) {
      const loc = await assetLocalizer.localizeAsset(imgObj.src, currentPageUrl, 'image');
      if (loc) {
        imgObj.originalSrc = imgObj.src;
        imgObj.src = loc.htmlRelPath;
        await page.evaluate(
          ({ k, localSrc }) => {
            document.querySelectorAll(`[data-agent-img="${k}"]`).forEach((img) => {
              img.setAttribute('src', localSrc);
              img.removeAttribute('srcset');
              img.removeAttribute('data-src');
              img.removeAttribute('data-lazy-src');
              const pic = img.closest('picture');
              if (pic) pic.querySelectorAll('source').forEach((s) => s.remove());
            });
          },
          { k: key, localSrc: loc.htmlRelPath }
        );
      }
    }

    for (const [key, vidObj] of Object.entries(batch.videos)) {
      const locVid = await assetLocalizer.localizeAsset(vidObj.src, currentPageUrl, 'media');
      if (locVid) {
        vidObj.originalSrc = vidObj.src;
        vidObj.src = locVid.htmlRelPath;
      }
      if (vidObj.poster) {
        const locPoster = await assetLocalizer.localizeAsset(vidObj.poster, currentPageUrl, 'image');
        if (locPoster) {
          vidObj.originalPoster = vidObj.poster;
          vidObj.poster = locPoster.htmlRelPath;
        }
      }
      await page.evaluate(
        ({ k, localSrc, localPoster }) => {
          document.querySelectorAll(`[data-agent-video="${k}"]`).forEach((video) => {
            if (localSrc) {
              video.setAttribute('src', localSrc);
              video.removeAttribute('data-src');
              video.removeAttribute('data-video-src');
              video.querySelectorAll('source').forEach((s) => {
                s.setAttribute('src', localSrc);
                s.removeAttribute('data-src');
              });
            }
            if (localPoster) video.setAttribute('poster', localPoster);
          });
        },
        { k: key, localSrc: vidObj.src, localPoster: vidObj.poster }
      );
    }

    for (const [key, bgObj] of Object.entries(batch.backgrounds)) {
      const locBg = await assetLocalizer.localizeAsset(bgObj.src, currentPageUrl, 'image');
      if (locBg) {
        bgObj.originalSrc = bgObj.src;
        bgObj.src = locBg.htmlRelPath;
        await page.evaluate(
          ({ k, localSrc }) => {
            document.querySelectorAll(`[data-agent-bg="${k}"]`).forEach((el) => {
              el.style.backgroundImage = `url("${localSrc}")`;
            });
          },
          { k: key, localSrc: locBg.htmlRelPath }
        );
      }
    }

    Object.assign(globalContentMap.texts, batch.texts);
    Object.assign(globalContentMap._originalTexts, batch.texts);
    Object.assign(globalContentMap._meta, batch.meta);
    Object.assign(globalContentMap.images, batch.images);
    Object.assign(globalContentMap.videos, batch.videos);
    Object.assign(globalContentMap.backgrounds, batch.backgrounds);
  }

  return {
    extractPageContent,
    getContentMap: () => globalContentMap
  };
}

// 4. ПЕРЕЗАПИСЬ ВСЕХ ВНУТРЕННИХ ССЫЛОК В DOM НА ЛОКАЛЬНЫЕ .HTML ФАЙЛЫ
async function rewriteLinksInDom(page, baseOrigin, knownPagesMap) {
  const routeEntries = Array.from(knownPagesMap.entries());
  await page.evaluate(
    ({ origin, entries }) => {
      const urlToFile = new Map(entries);

      const normalizeInBrowser = (rawHref) => {
        try {
          const parsed = new URL(rawHref, origin);
          if (parsed.origin !== origin) return null;
          const hash = parsed.hash || '';
          parsed.hash = '';
          ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'yclid'].forEach(
            (p) => parsed.searchParams.delete(p)
          );
          if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
            parsed.pathname = parsed.pathname.slice(0, -1);
          }
          return { normalizedUrl: parsed.href, pathname: parsed.pathname || '/', hash };
        } catch {
          return null;
        }
      };

      const buildFallbackFilename = (pathname) => {
        let p = decodeURIComponent(pathname || '/').replace(/\.html?$/i, '');
        const segs = p
          .split('/')
          .filter(Boolean)
          .map((s) =>
            s
              .toLowerCase()
              .replace(/[^a-z0-9а-яё_-]/gi, '_')
              .replace(/_+/g, '_')
              .replace(/^_|_$/g, '')
          )
          .filter(Boolean);
        return (segs.length === 0 ? 'index' : segs.join('__')) + '.html';
      };

      document.querySelectorAll('a[href]').forEach((a) => {
        const rawHref = (a.getAttribute('href') || '').trim();
        if (
          !rawHref ||
          rawHref.startsWith('#') ||
          rawHref.startsWith('mailto:') ||
          rawHref.startsWith('tel:') ||
          rawHref.startsWith('javascript:')
        ) {
          return;
        }

        const info = normalizeInBrowser(rawHref);
        if (!info) return;

        const targetFile =
          urlToFile.get(info.normalizedUrl) || buildFallbackFilename(info.pathname);

        a.setAttribute('data-agent-orig-href', rawHref);
        a.setAttribute('href', `./${targetFile}${info.hash}`);
        a.removeAttribute('target');
      });

      document.querySelectorAll('form[action]').forEach((form) => {
        const action = form.getAttribute('action') || '';
        if (action.startsWith('http') || action.startsWith('/')) {
          form.setAttribute('data-agent-orig-action', action);
          form.setAttribute('action', 'javascript:void(0)');
        }
      });
    },
    { origin: baseOrigin, entries: routeEntries }
  );
}

// 5. ВЫГРУЗКА CSS И JS С ДЕДУПЛИКАЦИЕЙ МЕЖДУ СТРАНИЦАМИ
function createHtmlCssJsSeparator(networkCache, assetLocalizer) {
  const downloadedCssMap = new Map();
  const downloadedJsMap = new Map();
  const allDownloadedCssTexts = [];
  let cssCounter = 0;
  let jsCounter = 0;
  let inlineCounter = 0;

  async function separatePageHtmlCssJs(page) {
    const assetsInfo = await page.evaluate(() => {
      let stylesheets = [];
      try {
        stylesheets = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map(
          (link, idx) => {
            link.setAttribute('data-agent-css-idx', String(idx));
            return { idx, href: link.href };
          }
        );
      } catch {}

      const inlineStyles = [];
      try {
        document.querySelectorAll('style').forEach((styleEl, idx) => {
          let cssText = styleEl.textContent || '';
          if (!cssText.trim() && styleEl.sheet) {
            try {
              cssText = Array.from(styleEl.sheet.cssRules)
                .map((r) => r.cssText)
                .join('\n');
            } catch {}
          }
          if (cssText.trim()) {
            inlineStyles.push(`/* === Inline Style Block #${idx + 1} === */\n${cssText.trim()}`);
          }
          styleEl.remove();
        });
      } catch {}

      const scripts = [];
      try {
        document.querySelectorAll('script[src]').forEach((script, idx) => {
          const src = script.src || '';
          if (
            /googletagmanager|google-analytics|mc\.yandex|connect\.facebook|hotjar|amplitude|mixpanel|segment|metrika|counter/i.test(
              src
            )
          ) {
            script.remove();
            return;
          }
          script.setAttribute('data-agent-js-idx', String(idx));
          scripts.push({ idx, src });
        });
      } catch {}

      try {
        document
          .querySelectorAll('meta[http-equiv="Content-Security-Policy"], base')
          .forEach((m) => m.remove());
      } catch {}

      return { stylesheets, inlineStyles, scripts };
    });

    for (const item of assetsInfo.stylesheets) {
      if (!item.href) continue;

      let fileName = downloadedCssMap.get(item.href);
      if (!fileName) {
        let cssContent = networkCache.css.get(item.href);
        if (!cssContent) {
          try {
            const res = await page.request.get(item.href, { timeout: 15000 });
            if (res.ok()) cssContent = await res.text();
          } catch {}
        }

        if (cssContent) {
          cssCounter++;
          const localizedCss = await assetLocalizer.localizeCssUrls(cssContent, item.href);
          allDownloadedCssTexts.push(localizedCss);

          fileName = makeSafeFilename(item.href, cssCounter, '.css');
          await fs.writeFile(path.join(cssDir, fileName), localizedCss, 'utf-8');
          downloadedCssMap.set(item.href, fileName);
        }
      }

      if (fileName) {
        await page.evaluate(
          ({ idx, localHref }) => {
            const link = document.querySelector(`link[data-agent-css-idx="${idx}"]`);
            if (link) {
              link.setAttribute('href', localHref);
              link.removeAttribute('integrity');
              link.removeAttribute('crossorigin');
            }
          },
          { idx: item.idx, localHref: `./css/${fileName}` }
        );
      }
    }

    if (assetsInfo.inlineStyles.length > 0) {
      inlineCounter++;
      const localizedInlineCss = await assetLocalizer.localizeCssUrls(
        assetsInfo.inlineStyles.join('\n\n'),
        page.url()
      );
      allDownloadedCssTexts.push(localizedInlineCss);

      const inlineFileName =
        inlineCounter === 1
          ? '99_inline_extracted.css'
          : `99_inline_page_${inlineCounter}.css`;
      await fs.writeFile(path.join(cssDir, inlineFileName), localizedInlineCss, 'utf-8');

      await page.evaluate((localHref) => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = localHref;
        document.head.appendChild(link);
      }, `./css/${inlineFileName}`);
    }

    for (const item of assetsInfo.scripts) {
      if (!item.src) continue;

      let fileName = downloadedJsMap.get(item.src);
      if (!fileName) {
        let jsContent = networkCache.js.get(item.src);
        if (!jsContent) {
          try {
            const res = await page.request.get(item.src, { timeout: 15000 });
            if (res.ok()) jsContent = await res.text();
          } catch {}
        }

        if (jsContent) {
          jsCounter++;
          fileName = makeSafeFilename(item.src, jsCounter, '.js');
          await fs.writeFile(path.join(jsDir, fileName), jsContent, 'utf-8');
          downloadedJsMap.set(item.src, fileName);
        }
      }

      if (fileName) {
        await page.evaluate(
          ({ idx, localSrc }) => {
            const script = document.querySelector(`script[data-agent-js-idx="${idx}"]`);
            if (script) {
              script.setAttribute('src', localSrc);
              script.removeAttribute('integrity');
              script.removeAttribute('crossorigin');
            }
          },
          { idx: item.idx, localSrc: `./js/${fileName}` }
        );
      }
    }

    await page.evaluate(() => {
      if (!document.querySelector('script[src*="agent-content-bridge.js"]')) {
        const bridgeScript = document.createElement('script');
        bridgeScript.src = './js/agent-content-bridge.js';
        bridgeScript.defer = true;
        document.body.appendChild(bridgeScript);
      }
    });

    const rawSeparatedHtml =
      '<!DOCTYPE html>\n' + (await page.evaluate(() => document.documentElement.outerHTML));
    return safeCleanHtml(rawSeparatedHtml);
  }

  return {
    separatePageHtmlCssJs,
    getAllDownloadedCssTexts: () => allDownloadedCssTexts
  };
}

// 6. ГЕНЕРАЦИЯ AGENT-CONTENT-BRIDGE С ПЕРЕХВАТЧИКОМ ССЫЛОК ДЛЯ МНОГОСТРАНИЧНОСТИ
async function writeBridgeAndRoutingFiles(baseOrigin, crawledPagesMap) {
  const routeMapObj = {
    baseOrigin,
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
    if (trimmed.startsWith('./') && trimmed.includes('.html')) {
      return trimmed;
    }

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

  window.addEventListener(
    'click',
    (e) => {
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

      if (routeData.baseOrigin && (href.startsWith(routeData.baseOrigin) || origHref.startsWith(routeData.baseOrigin))) {
        e.preventDefault();
        e.stopPropagation();
        console.warn('[Agent Bridge] Страница не скачана локально:', origHref);
      }
    },
    true
  );

  try {
    const res = await fetch('./content.json?_t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) {
      rewriteLinks();
      return;
    }
    const data = await res.json();

    const rebuildSplitText = (el, newText) => {
      if (el.getAttribute('data-agent-applied-text') === newText) return;
      el.setAttribute('data-agent-applied-text', newText);

      const sampleChar = el.querySelector('span span, div span, span');
      const charClass = sampleChar ? sampleChar.className : '';
      const charStyle = sampleChar ? sampleChar.getAttribute('style') || '' : '';

      el.innerHTML = '';
      Array.from(newText).forEach((ch) => {
        const span = document.createElement('span');
        if (charClass) span.className = charClass;
        if (charStyle) span.setAttribute('style', charStyle);
        span.style.display = 'inline-block';
        span.textContent = ch === ' ' ? '\\u00A0' : ch;
        el.appendChild(span);
      });
    };

    const syncDOM = () => {
      rewriteLinks();

      if (data.texts) {
        Object.entries(data.texts).forEach(([key, val]) => {
          document.querySelectorAll('[data-agent-text="' + key + '"]').forEach((el) => {
            if (el.hasAttribute('data-agent-split-text')) {
              rebuildSplitText(el, val);
            } else if (el.textContent.trim() !== val) {
              el.textContent = val;
            }
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
    const observer = new MutationObserver(() => syncDOM());
    observer.observe(document.body, { childList: true, subtree: true });
  } catch (err) {
    rewriteLinks();
    console.warn('[Agent Bridge] Ошибка автоподгрузки content.json', err);
  }
})();
`;

  await fs.writeFile(path.join(jsDir, 'agent-content-bridge.js'), bridgeScriptContent, 'utf-8');
}

// 7. СБОР СПЕЦИФИКАЦИЙ (CSS, ФРЕЙМВОРКИ, ЭФФЕКТЫ)
async function extractCssArchitecture(page, downloadedCssTexts) {
  try {
    const domCssAnalysis = await page.evaluate(() => {
      const colors = new Set();
      const fonts = new Set();
      const typography = {};

      ['body', 'h1', 'h2', 'h3', 'h4', 'p', 'a', 'button'].forEach((tag) => {
        try {
          const el = document.querySelector(tag);
          if (el) {
            const s = window.getComputedStyle(el);
            typography[tag] = {
              fontFamily: s.fontFamily,
              fontSize: s.fontSize,
              fontWeight: s.fontWeight,
              lineHeight: s.lineHeight,
              color: s.color
            };
          }
        } catch {}
      });

      document.querySelectorAll('*').forEach((el) => {
        try {
          const s = window.getComputedStyle(el);
          if (s.color && s.color !== 'rgba(0, 0, 0, 0)') colors.add(s.color);
          if (s.backgroundColor && s.backgroundColor !== 'rgba(0, 0, 0, 0)') {
            colors.add(s.backgroundColor);
          }
          if (s.fontFamily) {
            fonts.add(s.fontFamily.split(',')[0].replace(/['"]/g, '').trim());
          }
        } catch {}
      });

      return {
        fonts: Array.from(fonts),
        colorPalette: Array.from(colors).slice(0, 60),
        typography
      };
    });

    const mediaQueries = new Set();
    const allCssCombined = downloadedCssTexts.join('\n');
    const mediaRegex = /@media\s*([^{]+)\{/gi;
    let match;
    while ((match = mediaRegex.exec(allCssCombined)) !== null) {
      mediaQueries.add(match[1].trim());
    }

    return {
      ...domCssAnalysis,
      mediaBreakpoints: Array.from(mediaQueries).slice(0, 50)
    };
  } catch {
    return { fonts: [], colorPalette: [], typography: {}, mediaBreakpoints: [] };
  }
}

async function detectFrameworks(page) {
  try {
    return await page.evaluate(() => {
      const html = document.documentElement.outerHTML || '';
      const scripts = Array.from(document.querySelectorAll('script[src]')).map((s) => s.src);
      return {
        frontendFrameworks: {
          nextjs: !!window.__NEXT_DATA__ || scripts.some((s) => s.includes('/_next/')),
          react: !!window.React || !!document.querySelector('[data-reactroot], [id^="__next"]'),
          vue: !!window.Vue || !!window.__VUE__,
          nuxt: !!window.__NUXT__ || scripts.some((s) => s.includes('/_nuxt/')),
          webflow: !!window.Webflow || html.includes('data-wf-site')
        },
        awwwardsAnimationStack: {
          gsap: !!window.gsap,
          scrollTrigger: !!(window.ScrollTrigger || window.gsap?.plugins?.scrollTrigger),
          lenisSmoothScroll: !!window.lenis || html.includes('lenis'),
          threejsWebGL: !!window.THREE || document.querySelectorAll('canvas').length > 0
        }
      };
    });
  } catch {
    return { frontendFrameworks: {}, awwwardsAnimationStack: {} };
  }
}

async function extractEffects(page) {
  try {
    return await page.evaluate(() => {
      const rootVariables = {};
      const cssKeyframes = [];

      try {
        for (const sheet of Array.from(document.styleSheets)) {
          try {
            for (const rule of Array.from(sheet.cssRules)) {
              if (rule.type === CSSRule.KEYFRAMES_RULE) {
                cssKeyframes.push({ name: rule.name, cssText: rule.cssText });
              } else if (rule.type === CSSRule.STYLE_RULE && rule.selectorText === ':root') {
                for (let i = 0; i < rule.style.length; i++) {
                  const propName = rule.style[i];
                  if (propName.startsWith('--')) {
                    rootVariables[propName] = rule.style.getPropertyValue(propName).trim();
                  }
                }
              }
            }
          } catch (e) {} // Игнорируем CORS-ошибки
        }
      } catch (e) {}

      return {
        capturedWebGLShaders: window.__CAPTURED_SHADERS__ || [],
        capturedWebGPUShaders: window.__CAPTURED_WGSL_SHADERS__ || [],
        gsapDetected: !!window.gsap,
        rootVariables,
        cssKeyframes
      };
    });
  } catch {
    return { capturedWebGLShaders: [], capturedWebGPUShaders: [], gsapDetected: false, rootVariables: {}, cssKeyframes: [] };
  }
}

// 8. ОСНОВНОЙ ДВИЖОК МНОГОСТРАНИЧНОГО ОБХОДА И ИЗВЛЕЧЕНИЯ
async function runWithEngine(engineType, startUrl, cfg) {
  const isChromium = engineType === 'chromium';
  console.log(
    `[2/9] Запуск браузера (${isChromium ? 'Chromium (Native Stealth)' : 'Firefox'}) и старт с: ${startUrl}`
  );

  // На Windows запускаем чистый Chromium без конфликтующих sandbox-флагов и без устаревшего StealthPlugin
  const browser = isChromium
    ? await chromium.launch({
        headless: false,
        args: ['--disable-blink-features=AutomationControlled']
      })
    : await firefox.launch({ headless: false });

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      ignoreHTTPSErrors: true,
      userAgent: DEFAULT_HEADERS['User-Agent']
    });

    await context.addInitScript(() => {
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.__CAPTURED_SHADERS__ = [];
        window.__CAPTURED_WGSL_SHADERS__ = [];

        const origWebGL = WebGLRenderingContext.prototype.shaderSource;
        WebGLRenderingContext.prototype.shaderSource = function(shader, source) {
          if (source && typeof source === 'string') window.__CAPTURED_SHADERS__.push(source);
          return origWebGL.apply(this, arguments);
        };

        if (typeof WebGL2RenderingContext !== 'undefined') {
          const origWebGL2 = WebGL2RenderingContext.prototype.shaderSource;
          WebGL2RenderingContext.prototype.shaderSource = function(shader, source) {
            if (source && typeof source === 'string') window.__CAPTURED_SHADERS__.push(source);
            return origWebGL2.apply(this, arguments);
          };
        }

        if (navigator.gpu) {
          const origGPUShader = GPUDevice.prototype.createShaderModule;
          GPUDevice.prototype.createShaderModule = function(descriptor) {
            if (descriptor && descriptor.code) {
              window.__CAPTURED_WGSL_SHADERS__.push(descriptor.code);
            }
            return origGPUShader.apply(this, arguments);
          };
        }
      } catch {}
    });

    const networkCache = {
      css: new Map(),
      js: new Map(),
      binary: new Map()
    };

    const attachNetworkListeners = (targetPage) => {
      targetPage.on('response', async (response) => {
        try {
          if (!response.ok()) return;
          const resUrl = response.url();
          const type = response.request().resourceType();
          const contentType = response.headers()['content-type'] || '';

          if (cfg.skipVideo && (type === 'media' || contentType.includes('video'))) return;
          if (cfg.skipImages && (type === 'image' || contentType.includes('image'))) return;
          if (cfg.skipFonts && (type === 'font' || contentType.includes('font'))) return;

          if (type === 'stylesheet' || contentType.includes('text/css')) {
            const text = await response.text();
            networkCache.css.set(resUrl, text);
          } else if (type === 'script' || contentType.includes('javascript')) {
            const text = await response.text();
            networkCache.js.set(resUrl, text);
          } else if (
            ['font', 'image'].includes(type) ||
            contentType.includes('font') ||
            contentType.includes('image')
          ) {
            const buffer = await response.body();
            networkCache.binary.set(resUrl, { buffer, contentType });
          }
        } catch {}
      });
    };

    let page = await context.newPage();
    attachNetworkListeners(page);

    const baseOrigin = new URL(startUrl).origin;
    const normalizedRoot = normalizePageUrl(startUrl, baseOrigin) || startUrl;

    const queue = [{ url: normalizedRoot, depth: 0, priority: true }];
    const queuedSet = new Set([normalizedRoot]);
    const visitedMap = new Map();

    visitedMap.set(normalizedRoot, 'index.html');

    for (const rawTarget of cfg.explicitTargets) {
      const norm = normalizePageUrl(rawTarget, baseOrigin);
      if (norm && !queuedSet.has(norm)) {
        queuedSet.add(norm);
        visitedMap.set(norm, urlToLocalFilename(norm, baseOrigin));
        queue.push({ url: norm, depth: 0, priority: true });
      }
    }

    let currentActiveUrl = normalizedRoot;
    const assetLocalizer = createAssetLocalizer(() => currentActiveUrl, networkCache, cfg);
    const contentExtractor = createGlobalContentExtractor(assetLocalizer);
    const separator = createHtmlCssJsSeparator(networkCache, assetLocalizer);

    let mainScrollChoreography = {
      trueParallaxElements: [],
      horizontalScrollContainers: [],
      mouseParallaxElements: [],
      fadeInAndRevealElements: [],
      stackingOverlappingCards: [],
      scrollScrubbedVideos: []
    };
    let mainFrameworks = {};
    let mainEffects = {};
    let savedPagesCount = 0;

    // --- ГЛАВНЫЙ ЦИКЛ ОБХОДА СТРАНИЦ ---
    while (queue.length > 0 && savedPagesCount < cfg.maxPages) {
      const currentItem = queue.shift();
      const pageUrl = currentItem.url;
      const isMainPage = savedPagesCount === 0;
      const localFileName = isMainPage
        ? 'index.html'
        : visitedMap.get(pageUrl) || urlToLocalFilename(pageUrl, baseOrigin);

      visitedMap.set(pageUrl, localFileName);
      currentActiveUrl = pageUrl;

      console.log(
        `\n🌐 [Страница ${savedPagesCount + 1}/${Math.min(
          cfg.maxPages,
          savedPagesCount + queue.length + 1
        )}] Обработка: ${pageUrl} -> ${localFileName} (глубина: ${currentItem.depth})`
      );

      try {
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 65000 });
      } catch (navErr) {
        // КРИТИЧНО: Если упала главная страница (Page crashed / Target crashed),
        // пробрасываем ошибку наверх, чтобы extractSite мгновенно переключился на Firefox!
        if (isMainPage) {
          throw new Error(`Сбой загрузки главной страницы (${navErr.message})`);
        }

        console.warn(`   ⚠️ Не удалось загрузить ${pageUrl}: ${navErr.message}`);
        // Если вкладка упала на внутренней странице — пересоздаем вкладку и идем дальше
        if (/crashed|closed|Target/i.test(navErr.message)) {
          try {
            await page.close().catch(() => {});
            page = await context.newPage();
            attachNetworkListeners(page);
          } catch {}
        }
        continue;
      }

      if (isMainPage) {
        console.log('[3/9] Ожидание полной загрузки шрифтов, медиа и завершения прелоадеров...');
      }
      await waitForFullPageReady(page, isMainPage);

      if (isMainPage) {
        console.log('[4/9] Проверка и закрытие баннеров Cookie...');
      }
      await dismissCookiesAndEntryGates(page);

      // Вариант А: Автоматический поиск внутренних ссылок на странице
      const discoveredLinks = await discoverInternalLinks(page, baseOrigin);
      let newlyAdded = 0;
      for (const linkUrl of discoveredLinks) {
        if (!visitedMap.has(linkUrl)) {
          visitedMap.set(linkUrl, urlToLocalFilename(linkUrl, baseOrigin));
        }

        if (
          currentItem.depth < cfg.maxDepth &&
          !queuedSet.has(linkUrl) &&
          queuedSet.size < cfg.maxPages
        ) {
          queuedSet.add(linkUrl);
          queue.push({ url: linkUrl, depth: currentItem.depth + 1, priority: false });
          newlyAdded++;
        }
      }
      if (newlyAdded > 0) {
        console.log(`   🔍 Краулер обнаружил и добавил в очередь ещё ${newlyAdded} внутр. страниц(ы).`);
      }

      if (isMainPage) {
        console.log('[5/9] Прокрутка страницы и распознавание анимаций/ленивых изображений...');
      }
      const choreography = await autoScrollAndRecordChoreography(page, isMainPage);

      if (isMainPage) {
        mainScrollChoreography = choreography;
        const rawHtml = await page.content();
        await fs.writeFile(
          path.join(outputDir, 'raw_template.html'),
          safeCleanHtml(rawHtml),
          'utf-8'
        );

        console.log('[6/9] Детекция Awwwards-стека и перехват шейдеров/анимаций...');
        mainFrameworks = await detectFrameworks(page);
        mainEffects = await extractEffects(page);
        console.log('[7/9] Извлечение контента и скачивание картинок/видео/фонов в ./assets/...');
      }

      await contentExtractor.extractPageContent(page);

      // Переписываем все внутренние ссылки <a href="..."> на локальные .html файлы
      await rewriteLinksInDom(page, baseOrigin, visitedMap);

      if (isMainPage) {
        console.log('[8/9] Выгрузка CSS/JS, очистка трекеров и локализация ссылок...');
      }
      const cleanPageHtml = await separator.separatePageHtmlCssJs(page);

      await fs.writeFile(path.join(outputDir, localFileName), cleanPageHtml, 'utf-8');
      savedPagesCount++;
      console.log(`   💾 Сохранен локальный файл: output/site_clone/${localFileName}`);

      if (isMainPage) {
        try {
          await page.screenshot({
            path: path.join(outputDir, 'reference.png'),
            fullPage: false
          });
        } catch {}
      }
    }

    // Финальная проверка: был ли реально создан index.html
    const indexPath = path.join(outputDir, 'index.html');
    if (savedPagesCount === 0 || !existsSync(indexPath)) {
      throw new Error('Ни одна страница не была сохранена (index.html отсутствует)');
    }

    console.log('\n[9/9] Запись единого content.json, карты маршрутов pages-map.json и спецификаций...');
    const finalContentMap = contentExtractor.getContentMap();
    const downloadedCssTexts = separator.getAllDownloadedCssTexts();
    const cssArchitecture = await extractCssArchitecture(page, downloadedCssTexts);

    await writeBridgeAndRoutingFiles(baseOrigin, visitedMap);

    await fs.writeFile(
      path.join(outputDir, 'content.json'),
      JSON.stringify(finalContentMap, null, 2),
      'utf-8'
    );

    await fs.writeFile(
      path.join(specsDir, 'pages-manifest.json'),
      JSON.stringify(Object.fromEntries(visitedMap), null, 2),
      'utf-8'
    );
    await fs.writeFile(
      path.join(specsDir, 'scroll-choreography.json'),
      JSON.stringify(mainScrollChoreography, null, 2),
      'utf-8'
    );
    await fs.writeFile(
      path.join(specsDir, 'css-architecture.json'),
      JSON.stringify(cssArchitecture, null, 2),
      'utf-8'
    );
    await fs.writeFile(
      path.join(specsDir, 'effects-spec.json'),
      JSON.stringify(mainEffects, null, 2),
      'utf-8'
    );
    await fs.writeFile(
      path.join(specsDir, 'stack-frameworks.json'),
      JSON.stringify(mainFrameworks, null, 2),
      'utf-8'
    );

    const stats = assetLocalizer.getStats();
    console.log('\n✅ Готово! Многостраничный автономный клон сохранен в output/site_clone:');
    console.log(`   ├── Скачано HTML-страниц: ${savedPagesCount}`);
    console.log(
      `   ├── assets/ (шрифтов=${stats.fonts}, картинок=${stats.images}, видео=${stats.media})`
    );
    console.log(
      `   ├── content.json (текстов=${Object.keys(finalContentMap.texts).length}, мета-тегов=${
        Object.keys(finalContentMap._meta).length
      }, картинок=${Object.keys(finalContentMap.images).length})`
    );
    console.log('   ├── pages-map.json (карта локальной навигации между страницами)');
    console.log('   ├── index.html + внутренние страницы (*.html)');
    console.log('   └── css/ и js/ (общие стили, скрипты и agent-content-bridge.js)');
  } finally {
    await browser.close().catch(() => {});
  }
}

async function extractSite(url, cfg) {
  console.log(`[1/9] Подготовка модульной структуры папок в: ${outputDir}`);
  console.log(
    `   ⚙️ Режим обхода: глубина=${cfg.maxDepth}, макс. страниц=${cfg.maxPages}, явных целей=${cfg.explicitTargets.length}`
  );

  await fs.mkdir(cssDir, { recursive: true });
  await fs.mkdir(jsDir, { recursive: true });
  await fs.mkdir(specsDir, { recursive: true });
  await fs.mkdir(fontsDir, { recursive: true });
  await fs.mkdir(imagesDir, { recursive: true });
  await fs.mkdir(mediaDir, { recursive: true });

  if (cfg.forceFirefox) {
    await runWithEngine('firefox', url, cfg);
    return;
  }

  try {
    await runWithEngine('chromium', url, cfg);
  } catch (error) {
    console.warn(
      `\n⚠️ Chromium завершился с ошибкой (${error.message}). Переключаюсь на Firefox...\n`
    );
    try {
      await runWithEngine('firefox', url, cfg);
    } catch (ffError) {
      console.error('❌ Критическая ошибка во время выполнения:', ffError.message);
      process.exitCode = 1;
    }
  }
}

extractSite(targetUrl, config).catch(console.error);