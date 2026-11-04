import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { URL } from 'url';
import * as cheerio from 'cheerio';

const SITE_DIR = path.resolve('output', 'site_clone');
const SPECS_DIR = path.join(SITE_DIR, 'specs');
const GENERATED_DIR = path.resolve('output', 'generated_nextjs_project');

// Вспомогательная функция: нормализует пути ./assets/... -> /assets/... для Next.js public/
function normalizeAssetPathsForNext(contentObj) {
  const clone = JSON.parse(JSON.stringify(contentObj));

  const fixPath = (p) => {
    if (!p || typeof p !== 'string') return p;
    // Обязательно переводим пути в абсолютные от корня (для многостраничности)
    if (p.startsWith('./assets/')) return p.replace('./assets/', '/assets/');
    return p;
  };

  if (clone.images) {
    Object.values(clone.images).forEach((img) => {
      if (img && img.src) img.src = fixPath(img.src);
    });
  }
  if (clone.videos) {
    Object.values(clone.videos).forEach((vid) => {
      if (vid) {
        if (vid.src) vid.src = fixPath(vid.src);
        if (vid.poster) vid.poster = fixPath(vid.poster);
      }
    });
  }
  if (clone.backgrounds) {
    Object.keys(clone.backgrounds).forEach((k) => {
      const bg = clone.backgrounds[k];
      if (typeof bg === 'string') {
        clone.backgrounds[k] = { src: fixPath(bg) };
      } else if (bg && bg.src) {
        bg.src = fixPath(bg.src);
      }
    });
  }

  return clone;
}

// Конвертация атрибутов HTML -> React camelCase
function attrToCamelCase(attr) {
  if (attr.startsWith('data-') || attr.startsWith('aria-')) return attr;
  const specialMap = {
    'class': 'className', 'for': 'htmlFor', 'viewbox': 'viewBox', 'fill-rule': 'fillRule',
    'clip-rule': 'clipRule', 'stroke-width': 'strokeWidth', 'stroke-linecap': 'strokeLinecap',
    'stroke-linejoin': 'strokeLinejoin', 'stroke-miterlimit': 'strokeMiterlimit',
    'stroke-dasharray': 'strokeDasharray', 'stroke-dashoffset': 'strokeDashoffset',
    'xmlns:xlink': 'xmlnsXlink', 'xml:space': 'xmlSpace', 'tabindex': 'tabIndex',
    'readonly': 'readOnly', 'maxlength': 'maxLength', 'cellspacing': 'cellSpacing',
    'cellpadding': 'cellPadding', 'colspan': 'colSpan', 'rowspan': 'rowSpan',
    'datetime': 'dateTime', 'srcset': 'srcSet', 'playsinline': 'playsInline',
    'autoplay': 'autoPlay', 'crossorigin': 'crossOrigin'
  };
  if (specialMap[attr.toLowerCase()]) return specialMap[attr.toLowerCase()];
  return attr.replace(/-([a-z])/g, g => g[1].toUpperCase());
}

// Парсинг CSS-строки в объект React style
function parseStyleToReact(styleStr) {
  const styles = {};
  styleStr.split(';').forEach(rule => {
    const idx = rule.indexOf(':');
    if (idx === -1) return;
    const key = rule.slice(0, idx).trim();
    const val = rule.slice(idx + 1).trim();
    if (key && val) {
      let camelKey = key.replace(/-([a-z])/g, g => g[1].toUpperCase());
      if (camelKey === 'float') camelKey = 'cssFloat';
      if (camelKey.startsWith('--')) camelKey = key; 
      styles[camelKey] = val;
    }
  });
  return styles;
}

// Рекурсивный транслятор DOM в JSX
function nodeToJsx(node) {
  if (node.type === 'text') {
    const text = node.data;
    if (!text.trim()) return text;
    return text.replace(/{/g, '&#123;').replace(/}/g, '&#125;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  if (node.type === 'comment' || node.name === 'script') return '';
  if (node.type !== 'tag' && node.type !== 'style') return '';

  let tag = node.name;
  let childrenJsx = '';
  const isTextAgent = node.attribs && node.attribs['data-agent-text'];
  const isImgAgent = node.attribs && node.attribs['data-agent-img'];
  const isVideoAgent = node.attribs && node.attribs['data-agent-video'];
  const isBgAgent = node.attribs && node.attribs['data-agent-bg'];
  const isSplit = node.attribs && node.attribs['data-agent-split-text'] === 'chars';

  if (isTextAgent) {
    const txtKey = node.attribs['data-agent-text'];
    if (isSplit) {
      childrenJsx = `{String(content.texts['${txtKey}'] || '').split('').map((char, i) => <span key={i} style={{display: 'inline-block'}}>{char === ' ' ? '\\u00A0' : char}</span>)}`;
    } else {
      childrenJsx = `{content.texts['${txtKey}'] || ''}`;
    }
  } else if (node.children) {
    childrenJsx = node.children.map(nodeToJsx).join('');
  }

  let propsStr = '';
  let hasStyle = false;
  let styles = {};

  if (node.attribs) {
    if (node.attribs.style) {
      styles = parseStyleToReact(node.attribs.style);
      hasStyle = true;
    }
    if (isBgAgent) hasStyle = true;

    for (const [key, val] of Object.entries(node.attribs)) {
      if (key === 'style') continue;
      if (['data-agent-text', 'data-agent-applied-text', 'data-agent-img', 'data-agent-video', 'data-agent-bg', 'data-agent-split-text'].includes(key)) continue;
      
      let reactKey = attrToCamelCase(key);
      if (reactKey.startsWith('on')) continue;
      
      if (val === '' || val === key) {
        propsStr += ` ${reactKey}`;
      } else {
        propsStr += ` ${reactKey}="${val.replace(/"/g, '&quot;')}"`;
      }
    }
  }

  if (hasStyle) {
    let inlineStyle = Object.entries(styles).map(([k,v]) => `'${k}': '${v.replace(/'/g, "\\'")}'`).join(', ');
    if (isBgAgent) {
      const bgKey = node.attribs['data-agent-bg'];
      propsStr += ` style={{ ${inlineStyle}${inlineStyle ? ', ' : ''}backgroundImage: \`url(\${content.backgrounds['${bgKey}']?.src || content.backgrounds['${bgKey}'] || ''})\` }}`;
    } else {
      propsStr += ` style={{ ${inlineStyle} }}`;
    }
  }

  if (isImgAgent) {
    const key = node.attribs['data-agent-img'];
    propsStr += ` src={content.images['${key}']?.src || ''} alt={content.images['${key}']?.alt || ''}`;
  }
  if (isVideoAgent) {
    const key = node.attribs['data-agent-video'];
    propsStr += ` src={content.videos['${key}']?.src || ''} poster={content.videos['${key}']?.poster || undefined}`;
  }

  const voidElements = ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'];
  if (voidElements.includes(tag)) {
    return `<${tag}${propsStr} />`;
  }

  if (tag === 'style') {
    return `<style dangerouslySetInnerHTML={{ __html: \`${childrenJsx.replace(/`/g, '\\`')}\` }} />`;
  }

  return `<${tag}${propsStr}>${childrenJsx}</${tag}>`;
}

// Генерация шаблона страницы для Next.js
function generatePageCode(pageJsx) {
  return `import content from '@/data/content.json';
import choreography from '@/data/scroll-choreography.json';
import ScrollEffectsHandler from '@/components/ScrollEffectsHandler';

export default function Page() {
  return (
    <main className="min-h-screen bg-[#0A0A0C] text-white overflow-x-hidden relative">
      <ScrollEffectsHandler />
      ${pageJsx}
    </main>
  );
}
`;
}

async function synthesizeProject() {
  console.log('[1/7] Сканирование структуры многостраничного сайта...');
  
  if (!fsSync.existsSync(SITE_DIR)) {
    console.error('❌ Ошибка: Папка site_clone не найдена. Сначала запустите краулер.');
    return;
  }

  // Считываем маршруты из pages-manifest.json
  const manifestPath = path.join(SPECS_DIR, 'pages-manifest.json');
  let pagesManifest = {};
  try {
    if (fsSync.existsSync(manifestPath)) {
      pagesManifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
    } else {
      pagesManifest = { "http://localhost/": "index.html" };
    }
  } catch (e) {
    pagesManifest = { "http://localhost/": "index.html" };
  }

  const pages = Object.keys(pagesManifest).map(urlStr => {
    try {
      const parsedUrl = new URL(urlStr);
      let route = parsedUrl.pathname;
      if (route.endsWith('/') && route.length > 1) route = route.slice(0, -1);
      return { route, url: urlStr };
    } catch {
      return { route: '/', url: urlStr };
    }
  });

  // Убираем возможные дубликаты роутов
  const uniquePages = [];
  const seenRoutes = new Set();
  for (const p of pages) {
    if (!seenRoutes.has(p.route)) {
      seenRoutes.add(p.route);
      uniquePages.push(p);
    }
  }

  console.log(`   ✅ Найдено маршрутов для генерации: ${uniquePages.length} (${uniquePages.map(p => p.route).join(', ')})`);

  let choreography = {};
  let cssArch = {};
  let effectsSpec = {};
  let stackSpec = {};

  try {
    choreography = JSON.parse(await fs.readFile(path.join(SPECS_DIR, 'scroll-choreography.json'), 'utf-8'));
    cssArch = JSON.parse(await fs.readFile(path.join(SPECS_DIR, 'css-architecture.json'), 'utf-8'));
    effectsSpec = JSON.parse(await fs.readFile(path.join(SPECS_DIR, 'effects-spec.json'), 'utf-8'));
    stackSpec = JSON.parse(await fs.readFile(path.join(SPECS_DIR, 'stack-frameworks.json'), 'utf-8'));
  } catch (e) {
    console.warn(`   ⚠️ Спецификации не найдены или повреждены. Будут использованы базовые параметры.`);
  }

  console.log('[2/7] Создание структуры проекта Next.js (app, components, data, shaders, public)...');
  await fs.rm(GENERATED_DIR, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(path.join(GENERATED_DIR, 'app'), { recursive: true });
  await fs.mkdir(path.join(GENERATED_DIR, 'components'), { recursive: true });
  await fs.mkdir(path.join(GENERATED_DIR, 'data'), { recursive: true });
  await fs.mkdir(path.join(GENERATED_DIR, 'shaders'), { recursive: true });
  await fs.mkdir(path.join(GENERATED_DIR, 'public'), { recursive: true });

  // Копируем локальные ассеты
  const sourceAssetsDir = path.join(SITE_DIR, 'assets');
  const targetPublicAssetsDir = path.join(GENERATED_DIR, 'public', 'assets');
  try {
    if (fsSync.existsSync(sourceAssetsDir)) {
      await fs.cp(sourceAssetsDir, targetPublicAssetsDir, { recursive: true });
      console.log('   ✅ Локальные шрифты, картинки и видео скопированы в public/assets/');
    }
  } catch {
    console.warn('   ⚠️ Папка assets/ пуста или ещё не создана, пропускаем копирование медиа.');
  }

  // Нормализация и сохранение единого глобального data/content.json
  const globalContentPath = path.join(SITE_DIR, 'content.json');
  let normalizedContent = {};
  if (fsSync.existsSync(globalContentPath)) {
    const rawContent = JSON.parse(await fs.readFile(globalContentPath, 'utf-8'));
    normalizedContent = normalizeAssetPathsForNext(rawContent);
  }
  await fs.writeFile(path.join(GENERATED_DIR, 'data', 'content.json'), JSON.stringify(normalizedContent, null, 2), 'utf-8');

  // Сохраняем глобальную хореографию в data/
  await fs.writeFile(
    path.join(GENERATED_DIR, 'data', 'scroll-choreography.json'),
    JSON.stringify(choreography, null, 2),
    'utf-8'
  );

  // Сохраняем перехваченные WebGL (GLSL) и WebGPU (WGSL) шейдеры
  const webglShaders = effectsSpec.capturedWebGLShaders || [];
  for (let i = 0; i < webglShaders.length; i++) {
    const sh = webglShaders[i];
    const code = typeof sh === 'string' ? sh : sh.source || '';
    if (code) {
      await fs.writeFile(path.join(GENERATED_DIR, 'shaders', `shader_${String(i + 1).padStart(2, '0')}.glsl`), code, 'utf-8');
    }
  }

  const webgpuShaders = effectsSpec.capturedWebGPUShaders || [];
  for (let i = 0; i < webgpuShaders.length; i++) {
    const code = webgpuShaders[i];
    if (code) {
      await fs.writeFile(path.join(GENERATED_DIR, 'shaders', `shader_${String(i + 1).padStart(2, '0')}.wgsl`), code, 'utf-8');
    }
  }

  console.log('[3/7] Генерация маршрутов и трансляция реального DOM в JSX...');
  for (const page of uniquePages) {
    const isHome = page.route === '/';
    const routeParts = page.route.split('/').filter(Boolean);
    const appRouteDir = isHome ? path.join(GENERATED_DIR, 'app') : path.join(GENERATED_DIR, 'app', ...routeParts);

    await fs.mkdir(appRouteDir, { recursive: true });

    let pageJsx = '<div className="min-h-screen flex items-center justify-center">Пустая страница</div>';
    const htmlFileName = pagesManifest[page.url] || (isHome ? 'index.html' : 'page.html');
    const htmlPath = path.join(SITE_DIR, htmlFileName);
    
    if (fsSync.existsSync(htmlPath)) {
      const rawHtml = await fs.readFile(htmlPath, 'utf-8');
      const $ = cheerio.load(rawHtml);
      $('script[src*="agent-content-bridge.js"]').remove();
      
      const bodyNodes = $('body').contents().toArray();
      pageJsx = bodyNodes.map(node => nodeToJsx(node)).join('\n      ');
    }

    const pageCode = generatePageCode(pageJsx);
    await fs.writeFile(path.join(appRouteDir, 'page.jsx'), pageCode, 'utf-8');
    
    console.log(`   📄 Создан маршрут из реального DOM: ${isHome ? '/ (Главная)' : page.route}`);
  }

  console.log('[4/7] Генерация глобальных стилей (app/globals.css) с CSS-переменными и @keyframes...');
  const rootVarsEntries = Object.entries(effectsSpec.rootVariables || {})
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n');

  const keyframesCss = (effectsSpec.cssKeyframes || [])
    .slice(0, 30)
    .map((kf) => kf.cssText)
    .join('\n\n');

  const globalsCssContent = `@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --bg-primary: #0A0A0C;
  --bg-surface: #121318;
  --accent-gold: #D4AF37;
${rootVarsEntries}
}

html, body {
  background-color: var(--bg-primary);
  color: #ffffff;
  overflow-x: hidden;
  scroll-behavior: smooth;
}

/* Перенесенные @keyframes с сайта-донора */
${keyframesCss}
`;
  await fs.writeFile(path.join(GENERATED_DIR, 'app', 'globals.css'), globalsCssContent, 'utf-8');

  console.log('[5/7] Синтез движка параллакса и хореографии (components/ScrollEffectsHandler.jsx)...');
  const scrollEffectsComponent = `'use client';
import { useEffect } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import choreography from '@/data/scroll-choreography.json';

gsap.registerPlugin(ScrollTrigger);

export default function ScrollEffectsHandler() {
  useEffect(() => {
    const ctx = gsap.context(() => {
      // ============================================================================
      // 1. ИСТИННЫЙ СКРОЛЛ-ПАРАЛЛАКС (Вертикальный, Горизонтальный влево/вправо, Масштаб)
      // Работает как по селекторам донора из trueParallaxElements, так и по [data-parallax-item]
      // ============================================================================
      const parallaxRules = choreography.trueParallaxElements || [];

      // 1.1 Применяем правила к секциям, размеченным атрибутами [data-parallax-index]
      document.querySelectorAll('[data-parallax-index]').forEach((el) => {
        const idx = Number(el.getAttribute('data-parallax-index'));
        const spec = parallaxRules[idx] || {
          deltaTranslateYPx: -90,
          deltaTranslateXPx: 0,
          parallaxSpeedRatioY: -0.18
        };

        const dy =
          spec.deltaTranslateYPx && Math.abs(spec.deltaTranslateYPx) > 5
            ? spec.deltaTranslateYPx
            : Math.round((spec.parallaxSpeedRatioY || -0.15) * 500);
        const dx = spec.deltaTranslateXPx || 0;
        const scaleEnd =
          Array.isArray(spec.scaleRange) && spec.scaleRange.length === 2
            ? spec.scaleRange[1]
            : 1;

        gsap.fromTo(
          el,
          { x: 0, y: 0, scale: Array.isArray(spec.scaleRange) ? spec.scaleRange[0] : 1 },
          {
            x: dx,
            y: dy,
            scale: scaleEnd,
            ease: 'none',
            scrollTrigger: {
              trigger: el,
              start: 'top bottom',
              end: 'bottom top',
              scrub: 1.1
            }
          }
        );
      });

      // 1.2 Если в DOM присутствуют оригинальные селекторы донора — анимируем их напрямую
      parallaxRules.forEach((spec) => {
        if (!spec.selector) return;
        try {
          const targets = document.querySelectorAll(spec.selector);
          targets.forEach((el) => {
            if (el.hasAttribute('data-parallax-index')) return;
            gsap.to(el, {
              x: spec.deltaTranslateXPx || 0,
              y: spec.deltaTranslateYPx || -80,
              ease: 'none',
              scrollTrigger: {
                trigger: el,
                start: 'top bottom',
                end: 'bottom top',
                scrub: true
              }
            });
          });
        } catch {}
      });

      // ============================================================================
      // 2. MOUSE PARALLAX (2D/3D сдвиг слоев при движении мыши влево/вправо и вверх/вниз)
      // ============================================================================
      const mouseRules = choreography.mouseParallaxElements || [];
      const mouseBindList = [];

      document.querySelectorAll('[data-mouse-parallax-index]').forEach((el) => {
        const idx = Number(el.getAttribute('data-mouse-parallax-index'));
        const spec = mouseRules[idx] || { mouseShiftX: 28, mouseShiftY: 18 };
        mouseBindList.push({
          el,
          shiftX: spec.mouseShiftX || 25,
          shiftY: spec.mouseShiftY || 18,
          quickX: gsap.quickTo(el, 'x', { duration: 0.65, ease: 'power3.out' }),
          quickY: gsap.quickTo(el, 'y', { duration: 0.65, ease: 'power3.out' })
        });
      });

      mouseRules.forEach((spec) => {
        if (!spec.selector) return;
        try {
          document.querySelectorAll(spec.selector).forEach((el) => {
            if (el.hasAttribute('data-mouse-parallax-index')) return;
            mouseBindList.push({
              el,
              shiftX: spec.mouseShiftX || 20,
              shiftY: spec.mouseShiftY || 20,
              quickX: gsap.quickTo(el, 'x', { duration: 0.65, ease: 'power3.out' }),
              quickY: gsap.quickTo(el, 'y', { duration: 0.65, ease: 'power3.out' })
            });
          });
        } catch {}
      });

      const handleMouseMove = (e) => {
        const normX = e.clientX / window.innerWidth - 0.5;  // от -0.5 до +0.5
        const normY = e.clientY / window.innerHeight - 0.5; // от -0.5 до +0.5
        mouseBindList.forEach((item) => {
          item.quickX(normX * item.shiftX * 2);
          item.quickY(normY * item.shiftY * 2);
        });
      };

      if (mouseBindList.length > 0) {
        window.addEventListener('mousemove', handleMouseMove, { passive: true });
      }

      // ============================================================================
      // 3. ГОРИЗОНТАЛЬНЫЙ СКРОЛЛ ВЛЕВО/ВПРАВО ПРИ ПРОКРУТКЕ ВНИЗ (Horizontal Pin Track)
      // ============================================================================
      const horizontalSpecs = choreography.horizontalScrollContainers || [];
      document.querySelectorAll('.horizontal-scroll-section').forEach((section, idx) => {
        const track = section.querySelector('.horizontal-scroll-track');
        if (!track) return;
        const spec = horizontalSpecs[idx];

        const getScrollAmount = () => {
          const naturalWidth = track.scrollWidth - window.innerWidth;
          if (naturalWidth > 100) return -naturalWidth;
          return spec?.horizontalDeltaPx || -900;
        };

        gsap.to(track, {
          x: getScrollAmount,
          ease: 'none',
          scrollTrigger: {
            trigger: section,
            pin: true,
            scrub: 1,
            invalidateOnRefresh: true,
            end: () => '+=' + Math.max(window.innerWidth, Math.abs(getScrollAmount()))
          }
        });
      });

      // ============================================================================
      // 4. PARALLAX-IN + FADE-IN + CLIP-PATH REVEAL (Плавный выезд карточек и текста)
      // ============================================================================
      document.querySelectorAll('[data-reveal-item]').forEach((el) => {
        gsap.fromTo(
          el,
          { opacity: 0, y: 56, scale: 0.96 },
          {
            opacity: 1,
            y: 0,
            scale: 1,
            duration: 1.05,
            ease: 'power3.out',
            scrollTrigger: {
              trigger: el,
              start: 'top 86%',
              toggleActions: 'play none none reverse'
            }
          }
        );
      });

      // ============================================================================
      // 5. НАЕЗЖАЮЩИЕ СЛОИ (Stacking Overlapping Cards с эффектом глубины)
      // ============================================================================
      const stackCards = gsap.utils.toArray('[data-stack-card]');
      stackCards.forEach((card, index) => {
        if (index === stackCards.length - 1) return;
        gsap.to(card, {
          scale: 0.93,
          opacity: 0.55,
          ease: 'none',
          scrollTrigger: {
            trigger: stackCards[index + 1],
            start: 'top bottom',
            end: 'top 20%',
            scrub: true
          }
        });
      });

      // ============================================================================
      // 6. ВИДЕО, УПРАВЛЯЕМЫЕ СКРОЛЛОМ (Scroll-Scrubbed Videos)
      // ============================================================================
      document.querySelectorAll('video[data-scroll-scrub="true"]').forEach((video) => {
        ScrollTrigger.create({
          trigger: video,
          start: 'top bottom',
          end: 'bottom top',
          scrub: true,
          onUpdate: (self) => {
            if (video.duration && !Number.isNaN(video.duration)) {
              video.currentTime = self.progress * video.duration;
            }
          }
        });
      });

      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
      };
    });

    return () => ctx.revert();
  }, []);

  return null;
}
`;
  await fs.writeFile(
    path.join(GENERATED_DIR, 'components', 'ScrollEffectsHandler.jsx'),
    scrollEffectsComponent,
    'utf-8'
  );

  console.log('[6/7] Генерация app/layout.jsx ...');
  const layoutCode = `import './globals.css';

export const metadata = {
  title: 'Multi-Page Awwwards Clone',
  description: 'Generated by Site Clone Agent with GSAP Parallax & Choreography'
};

export default function RootLayout({ children }) {
  return (
    <html lang="ru">
      <body className="antialiased bg-[#0A0A0C] text-white selection:bg-[#D4AF37] selection:text-black">
        {children}
      </body>
    </html>
  );
}
`;
  await fs.writeFile(path.join(GENERATED_DIR, 'app', 'layout.jsx'), layoutCode, 'utf-8');

  console.log('[7/7] Запись конфигурационных файлов Next.js и Tailwind CSS...');
  
  // Создаем jsconfig.json для поддержки алиаса @/
  const jsConfig = { compilerOptions: { baseUrl: ".", paths: { "@/*": ["./*"] } } };
  await fs.writeFile(path.join(GENERATED_DIR, 'jsconfig.json'), JSON.stringify(jsConfig, null, 2), 'utf-8');

  const extractedPalette = (cssArch.colorPalette || []).slice(0, 6);
  const tailwindConfig = `/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#D4AF37',
          dark: '#0A0A0C',
          surface: '#121318',
        },
        donor: ${JSON.stringify(extractedPalette)}
      }
    },
  },
  plugins: [],
};
`;
  await fs.writeFile(path.join(GENERATED_DIR, 'tailwind.config.js'), tailwindConfig, 'utf-8');

  const postcssConfig = `module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
`;
  await fs.writeFile(path.join(GENERATED_DIR, 'postcss.config.js'), postcssConfig, 'utf-8');

  const nextConfig = `/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    unoptimized: true,
  },
};

module.exports = nextConfig;
`;
  await fs.writeFile(path.join(GENERATED_DIR, 'next.config.js'), nextConfig, 'utf-8');

  const packageJson = {
    name: 'generated-site-clone',
    version: '1.0.0',
    private: true,
    scripts: {
      dev: 'next dev -p 3001',
      build: 'next build',
      start: 'next start -p 3001'
    },
    dependencies: {
      gsap: '^3.12.5',
      next: '14.2.5',
      react: '^18.3.1',
      'react-dom': '^18.3.1'
    },
    devDependencies: {
      autoprefixer: '^10.4.19',
      postcss: '^8.4.38',
      tailwindcss: '^3.4.4'
    }
  };
  await fs.writeFile(
    path.join(GENERATED_DIR, 'package.json'),
    JSON.stringify(packageJson, null, 2),
    'utf-8'
  );

  console.log('\n🎉 Генерация многостраничного проекта завершена!');
  console.log(`   ├── Создано маршрутов: ${uniquePages.length}`);
  console.log('   ├── data/ (распределенные content.json для каждой страницы)');
  console.log('   ├── components/ScrollEffectsHandler.jsx (GSAP ScrollTrigger + Mouse quickTo)');
  console.log('   ├── jsconfig.json (настроен абсолютный импорт @/)');
  console.log('   └── public/assets/ (все локальные шрифты, картинки и видео)');
}

synthesizeProject().catch(console.error);