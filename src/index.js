import http from 'http';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';

const PORT = 3000;
const SITE_DIR = path.resolve('output', 'site_clone');

const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
};

// Автоматический поиск главного HTML-файла
function resolveMainHtmlRelPath() {
  if (fsSync.existsSync(path.join(SITE_DIR, 'index.html'))) {
    return '/index.html';
  }
  if (fsSync.existsSync(path.join(SITE_DIR, 'index', 'index.html'))) {
    return '/index/index.html';
  }
  if (fsSync.existsSync(path.join(SITE_DIR, 'raw_template.html'))) {
    return '/raw_template.html';
  }
  return '/index.html';
}

function getPagePaths(urlPathname) {
  let cleanPath = urlPathname;
  if (cleanPath === '/' || cleanPath === '' || cleanPath === '/index.html') {
    cleanPath = resolveMainHtmlRelPath();
  } else {
    cleanPath = cleanPath.replace(/\/$/, '/index.html');
    if (!cleanPath.endsWith('.html')) cleanPath += '/index.html';
  }

  return {
    htmlPath: path.join(SITE_DIR, cleanPath),
    contentJsonPath: path.join(SITE_DIR, path.dirname(cleanPath), 'content.json')
  };
}

async function updateHtmlFromContent(htmlPath, contentJsonPath) {
  try {
    if (!fsSync.existsSync(contentJsonPath) || !fsSync.existsSync(htmlPath)) return;
    const rawContent = await fs.readFile(contentJsonPath, 'utf-8');
    const content = JSON.parse(rawContent);
    const htmlStr = await fs.readFile(htmlPath, 'utf-8');
    
    const $ = cheerio.load(htmlStr);

    // 1. Обновляем тексты
    Object.entries(content.texts || {}).forEach(([key, val]) => {
      $(`[data-agent-text="${key}"]`).each((_, el) => {
        const $el = $(el);
        if ($el.attr('data-agent-split-text') === 'chars') {
          // Восстанавливаем структуру SplitText
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
          const newTextWithBr = val.replace(/\n/g, '<br>');
          $el.html(newTextWithBr);
        }
      });
    });

    // 2. Обновляем картинки
    Object.entries(content.images || {}).forEach(([key, imgObj]) => {
      if (imgObj.src) {
        $(`[data-agent-img="${key}"]`).each((_, el) => {
          const $el = $(el);
          $el.attr('src', imgObj.src);
          $el.removeAttr('srcset');
          if (imgObj.alt !== undefined) $el.attr('alt', imgObj.alt);
        });
      }
    });

    // 3. Обновляем видео
    Object.entries(content.videos || {}).forEach(([key, vidObj]) => {
      if (vidObj.src) {
        $(`[data-agent-video="${key}"]`).each((_, el) => {
          const $el = $(el);
          $el.attr('src', vidObj.src);
          $el.find('source').attr('src', vidObj.src);
          if (vidObj.poster) $el.attr('poster', vidObj.poster);
        });
      }
    });

    // 4. Обновляем фоны
    Object.entries(content.backgrounds || {}).forEach(([key, bgData]) => {
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

    await fs.writeFile(htmlPath, $.html(), 'utf-8');
  } catch (err) {
    console.warn('Не удалось обновить HTML:', err.message);
  }
}

// Если запущен с флагом --sync-only (npm run sync)
if (process.argv.includes('--sync-only')) {
  // В плоской структуре контент лежит в корне site_clone
  const contentJsonPath = path.join(SITE_DIR, 'content.json');
  
  (async () => {
    try {
      const allFiles = await fs.readdir(SITE_DIR);
      const htmlFiles = allFiles.filter(file => file.endsWith('.html') && file !== 'raw_template.html');
      
      for (const htmlFile of htmlFiles) {
        const htmlPath = path.join(SITE_DIR, htmlFile);
        await updateHtmlFromContent(htmlPath, contentJsonPath);
        console.log(`✅ Контент синхронизирован с HTML: ${htmlFile}`);
      }
      process.exit(0);
    } catch (e) {
      console.error(e);
      process.exit(1);
    }
  })();
} else {
  const VISUAL_EDITOR_INJECTED_SCRIPT = `
<script>
(function() {
  const badge = document.createElement('div');
  badge.innerHTML = '✏️ Режим визуального редактора активен';
  badge.style.cssText = 'position:fixed;bottom:15px;right:15px;background:#121318;color:#D4AF37;padding:10px 16px;border-radius:8px;font-family:sans-serif;font-size:13px;z-index:999999;box-shadow:0 4px 20px rgba(0,0,0,0.5);border:1px solid #D4AF37;pointer-events:none;';
  document.body.appendChild(badge);

  const style = document.createElement('style');
  style.innerHTML = \`
    [data-agent-text]:hover, 
    [data-agent-img]:hover, 
    [data-agent-video]:hover, 
    [data-agent-bg]:hover { 
        outline: 2px dashed #D4AF37 !important; 
        cursor: pointer !important; 
    }
    #preloader-outer, #preloader-wrapper, .preloader, [id*="preloader"],
    [data-c8-experience-loader="true"],
    [aria-busy="true"] { 
        display: none !important; 
        opacity: 0 !important; 
        visibility: hidden !important; 
        pointer-events: none !important;
    }
    body, main, #main-content, [data-c8-experience] { 
        opacity: 1 !important; 
        visibility: visible !important; 
    }
  \`;
  document.head.appendChild(style);

  async function saveToServer(payload) {
    payload.pathname = window.location.pathname; 
    try {
      const res = await fetch('/api/update-content', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        badge.style.background = '#1a3a2a';
        badge.innerHTML = '✅ Сохранено!';
        setTimeout(() => {
          badge.style.background = '#121318';
          badge.innerHTML = '✏️ Режим визуального редактора активен';
        }, 1500);
      }
    } catch (e) { console.error(e); }
  }

  document.addEventListener('click', function(e) {
    // Редактирование Текста
    const textEl = e.target.closest('[data-agent-text]');
    if (textEl && !e.target.closest('input, textarea, a')) {
      e.preventDefault();
      e.stopPropagation();
      const key = textEl.getAttribute('data-agent-text');
      const currentText = textEl.textContent.trim();
      const newText = prompt('Редактировать текст (' + key + '):', currentText);

      if (newText !== null && newText !== currentText) {
        textEl.textContent = newText;
        saveToServer({ type: 'text', key, value: newText });
      }
      return;
    }

    // Редактирование Картинок
    const imgEl = e.target.closest('[data-agent-img]');
    if (imgEl && !e.target.closest('a')) {
      e.preventDefault();
      e.stopPropagation();
      const key = imgEl.getAttribute('data-agent-img');
      const currentSrc = imgEl.getAttribute('src');
      const newSrc = prompt('Новый путь для картинки (' + key + '):', currentSrc);

      if (newSrc !== null && newSrc !== currentSrc) {
        imgEl.setAttribute('src', newSrc);
        saveToServer({ type: 'image', key, value: newSrc });
      }
      return;
    }

    // Редактирование Видео
    const vidEl = e.target.closest('[data-agent-video]');
    if (vidEl && !e.target.closest('a')) {
      e.preventDefault();
      e.stopPropagation();
      const key = vidEl.getAttribute('data-agent-video');
      const currentSrc = vidEl.getAttribute('src') || '';
      const newSrc = prompt('Новый путь для видео (' + key + '):', currentSrc);

      if (newSrc !== null && newSrc !== currentSrc) {
        vidEl.setAttribute('src', newSrc);
        saveToServer({ type: 'video', key, value: newSrc });
      }
      return;
    }

    // Редактирование Фонов
    const bgEl = e.target.closest('[data-agent-bg]');
    if (bgEl && !e.target.closest('a')) {
      e.preventDefault();
      e.stopPropagation();
      const key = bgEl.getAttribute('data-agent-bg');
      const bgStyle = bgEl.style.backgroundImage;
      const currentUrl = bgStyle.match(/url\\(['"]?([^'"]+)['"]?\\)/)?.[1] || '';
      const newUrl = prompt('Новый путь для фона (' + key + '):', currentUrl);

      if (newUrl !== null && newUrl !== currentUrl) {
        bgEl.style.backgroundImage = \`url("\${newUrl}")\`;
        saveToServer({ type: 'background', key, value: newUrl });
      }
      return;
    }

  }, true);
})();
</script>
`;

  const server = http.createServer(async (req, res) => {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    let pathname = decodeURIComponent(urlObj.pathname);

    if (
      req.method === 'POST' &&
      (pathname === '/api/update-content' || pathname === '/api/update-html-from-content')
    ) {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          // В плоской структуре берем глобальный content.json
          const contentJsonPath = path.join(SITE_DIR, 'content.json');
          const { htmlPath } = getPagePaths(data.pathname || '/');

          if (pathname === '/api/update-content' && fsSync.existsSync(contentJsonPath)) {
            const rawContent = await fs.readFile(contentJsonPath, 'utf-8');
            const content = JSON.parse(rawContent);

            if (data.type === 'text' && content.texts) {
              content.texts[data.key] = data.value;
            } else if (data.type === 'image' && content.images && content.images[data.key]) {
              content.images[data.key].src = data.value;
            } else if (data.type === 'video' && content.videos && content.videos[data.key]) {
              content.videos[data.key].src = data.value;
            } else if (data.type === 'background' && content.backgrounds && content.backgrounds[data.key]) {
              if (typeof content.backgrounds[data.key] === 'string') {
                content.backgrounds[data.key] = data.value;
              } else {
                content.backgrounds[data.key].src = data.value;
              }
            }
            await fs.writeFile(contentJsonPath, JSON.stringify(content, null, 2), 'utf-8');
          }

          await updateHtmlFromContent(htmlPath, contentJsonPath);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    try {
      if (pathname === '/' || pathname === '/index.html') {
        pathname = resolveMainHtmlRelPath();
      } else if (pathname.endsWith('/')) {
        pathname += 'index.html';
      }

      let filePath = path.join(SITE_DIR, pathname);
      const stats = await fs.stat(filePath).catch(() => null);
      if (stats && stats.isDirectory()) {
        pathname = path.posix.join(pathname, 'index.html');
        filePath = path.join(SITE_DIR, pathname);
      }

      let content = await fs.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();

      if (ext === '.html') {
        let htmlStr = content.toString('utf-8');

        if (htmlStr.includes('</body>')) {
          htmlStr = htmlStr.replace('</body>', VISUAL_EDITOR_INJECTED_SCRIPT + '</body>');
        } else {
          htmlStr += VISUAL_EDITOR_INJECTED_SCRIPT;
        }
        content = Buffer.from(htmlStr, 'utf-8');
      }

      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
      res.end(content);
    } catch (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=UTF-8' });
      res.end(
        `404 Not Found: ${pathname}\nПроверьте наличие файла index.html в папке: ${SITE_DIR}`
      );
    }
  });

  server.listen(PORT, () => {
    const activeHtml = resolveMainHtmlRelPath();
    console.log(`\n🚀 Локальный сервер запущен!`);
    console.log(`📄 Главный файл: output/site_clone${activeHtml}`);
    console.log(`👉 Открой в браузере: http://localhost:${PORT}`);
  });
}
```<FollowUp></FollowUp>
<ElicitationsGroup></ElicitationsGroup> ```