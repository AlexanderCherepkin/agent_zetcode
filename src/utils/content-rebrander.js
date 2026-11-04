import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import * as cheerio from 'cheerio';

const SITE_DIR = path.resolve('output', 'site_clone');
const SITE_CONTENT_PATH = path.resolve('output', 'site_clone', 'content.json');
const NEXT_CONTENT_PATH = path.resolve('output', 'generated_nextjs_project', 'data', 'content.json');
const CONFIG_PATH = path.resolve('rebrand-config.json');

const LLM_API_URL = process.env.LLM_API_URL || 'http://127.0.0.1:8080/v1/chat/completions';
const LLM_MODEL = 'gemma-4-12b-it';

// Шаблон конфигурации по умолчанию (создается автоматически при первом запуске)
const DEFAULT_REBRAND_CONFIG = {
  targetTheme: 'Премиальный сервис: индивидуальный подбор, проверка и доставка автомобилей под ключ',
  brandName: 'AERO MOTORS',
  toneOfVoice: 'Премиальный, уверенный, лаконичный, без воды и штампов (стиль Awwwards)',
  keepLengthStrict: true,
  maxLengthDeviationRatio: 1.35,
  generateSEO: true, // Включает автогенерацию мета-тегов
  formWebhookUrl: 'https://api.telegram.org/bot<TOKEN>/sendMessage', // Webhook для всех форм
  exactReplacements: {
    'Example': 'AERO MOTORS',
    '+1 (000) 000-0000': '+375 (29) 000-00-00',
    'info@example.com': 'vip@aeromotors.by'
  },
  customImageReplacements: {
    // Например: "img_1": "./assets/images/my_custom_hero.webp"
  },
  customVideoReplacements: {
    // Например: "vid_1": "./assets/media/my_custom_reel.mp4"
  }
};

// Проверка, нужно ли вообще отправлять строку в ИИ (пропускаем голые цифры, артикулы, знаки)
function shouldRewriteText(str) {
  if (!str || typeof str !== 'string') return false;
  const trimmed = str.trim();
  if (trimmed.length < 2) return false;
  // Если строка состоит только из цифр, знаков препинания или валют — не трогаем
  if (/^[\d\s.,:%$€£₽+-/()]+$/.test(trimmed)) return false;
  return true;
}

// 1. Применение жесткого словаря замен (exactReplacements)
function applyExactDictionary(text, dictionary) {
  let result = text;
  for (const [fromWord, toWord] of Object.entries(dictionary || {})) {
    if (!fromWord) continue;
    const escaped = fromWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(escaped, 'gi'), toWord);
  }
  return result;
}

// 2. Извлечение чистого JSON из ответа локальной LLM
function parseJsonSafely(rawText) {
  const cleaned = rawText
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error('В ответе LLM не найден JSON-объект');
  }
  return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
}

// 3. Отправка пачки текстов (батча) в локальный llama-server с учетом метаданных (контекста)
async function rewriteBatchWithLLM(batchObj, metaObj, cfg) {
  // Формируем подсказку с ограничением длины и типом тега для каждого ключа
  const annotatedBatch = {};
  for (const [key, val] of Object.entries(batchObj)) {
    annotatedBatch[key] = {
      original: val,
      maxChars: Math.max(val.length + 6, Math.round(val.length * (cfg.maxLengthDeviationRatio || 1.35))),
      tag: metaObj?.[key]?.tag || 'unknown',
      context: metaObj?.[key]?.section || 'general'
    };
  }

  const systemPrompt = `Ты — главный креативный копирайтер премиальных сайтов Awwwards.
Твоя задача — переписать значения текстовых узлов сайта на новую тематику, полностью изменив формулировки (чтобы текст на 100% отличался от оригинала), но СОХРАНИВ их роль в интерфейсе (заголовок остается заголовком, кнопка — кнопкой, пункт меню — пунктом меню).

ЖЁСТКИЕ ПРАВИЛА:
1. Новая тематика сайта: "${cfg.targetTheme}".
2. Название бренда: "${cfg.brandName}".
3. Стиль текста (Tone of Voice): "${cfg.toneOfVoice}".
4. Язык результата: Русский.
5. КРИТИЧЕСКИ ВАЖНО: Учитывай поле "tag"! Если это "h1" — это главный оффер. Если "a" или "button" — это призыв к действию (CTA), он должен быть коротким. Если "p" — это абзац.
6. Длина нового текста для каждого ключа НЕ ДОЛЖНА превышать параметр "maxChars" (иначе сломается анимация SplitText и сетка сайта!).
7. Верни ТОЛЬКО валидный плоский JSON-объект формата {"txt_1": "новый текст", "txt_2": "новый текст"} без пояснений и без markdown-оберток.`;

  const userPrompt = `Перепиши следующие элементы под тематику "${cfg.targetTheme}" (бренд "${cfg.brandName}"):\n${JSON.stringify(
    annotatedBatch,
    null,
    2
  )}`;

  const response = await fetch(LLM_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.35,
      max_tokens: 2500
    })
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} от локального LLM-сервера`);
  }

  const data = await response.json();
  const contentStr = data.choices?.[0]?.message?.content || '';
  return parseJsonSafely(contentStr);
}

// 4. ИИ-Генератор SEO
async function generateSEOWithLLM(cfg) {
  const systemPrompt = `Ты — SEO-специалист премиальных брендов. 
Тематика сайта: "${cfg.targetTheme}". Бренд: "${cfg.brandName}".
Сгенерируй мета-теги для главной страницы.
Верни ТОЛЬКО валидный плоский JSON: { "title": "...", "description": "...", "og_title": "...", "og_description": "..." } без пояснений.`;

  try {
    const response = await fetch(LLM_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [{ role: 'system', content: systemPrompt }],
        temperature: 0.4,
        max_tokens: 500
      })
    });
    if (!response.ok) throw new Error('HTTP Error');
    const data = await response.json();
    return parseJsonSafely(data.choices[0].message.content);
  } catch (err) {
    console.warn('   ⚠️ Не удалось сгенерировать SEO через ИИ, применяю базовый шаблон.');
    return {
      title: `${cfg.brandName} — ${cfg.targetTheme.split(':')[0]}`,
      description: cfg.targetTheme,
      og_title: `${cfg.brandName} — ${cfg.targetTheme.split(':')[0]}`,
      og_description: cfg.targetTheme
    };
  }
}

// 5. Внедрение SEO и перехватчика форм во все HTML
async function injectSeoAndFormsToHtml(cfg, seoData) {
  const files = await fs.readdir(SITE_DIR);
  const htmlFiles = files.filter(f => f.endsWith('.html') && f !== 'raw_template.html');

  const formHandlerScript = `
<!-- Интеграция универсального обработчика заявок Agent -->
<script id="agent-form-handler">
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('form').forEach(form => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = form.querySelector('button[type="submit"], input[type="submit"]');
        const originalText = btn ? (btn.innerText || btn.value) : '';
        if (btn) btn.innerText = 'Отправка...';
        
        const formData = new FormData(form);
        const data = Object.fromEntries(formData.entries());
        data._brand = "${cfg.brandName}";
        data._sourceUrl = window.location.href;
        
        try {
          await fetch("${cfg.formWebhookUrl}", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
          });
          if (btn) btn.innerText = 'Успешно!';
          form.reset();
          setTimeout(() => { if (btn) btn.innerText = originalText; }, 3000);
        } catch (err) {
          if (btn) btn.innerText = 'Ошибка';
          setTimeout(() => { if (btn) btn.innerText = originalText; }, 3000);
        }
      });
    });
  });
</script>
`;

  let updatedFiles = 0;
  for (const file of htmlFiles) {
    const htmlPath = path.join(SITE_DIR, file);
    const rawHtml = await fs.readFile(htmlPath, 'utf-8');
    const $ = cheerio.load(rawHtml);

    // Подмена SEO
    if (seoData) {
      if ($('title').length) $('title').text(seoData.title);
      else $('head').append(`<title>${seoData.title}</title>`);
      
      if ($('meta[name="description"]').length) $('meta[name="description"]').attr('content', seoData.description);
      else $('head').append(`<meta name="description" content="${seoData.description}">`);
      
      if ($('meta[property="og:title"]').length) $('meta[property="og:title"]').attr('content', seoData.og_title);
      else $('head').append(`<meta property="og:title" content="${seoData.og_title}">`);
      
      if ($('meta[property="og:description"]').length) $('meta[property="og:description"]').attr('content', seoData.og_description);
      else $('head').append(`<meta property="og:description" content="${seoData.og_description}">`);
    }

    // Внедрение скрипта форм
    $('#agent-form-handler').remove(); // защита от дублей
    if ($('body').length) $('body').append(formHandlerScript);
    else $.root().append(formHandlerScript);

    await fs.writeFile(htmlPath, $.html(), 'utf-8');
    updatedFiles++;
  }
  return updatedFiles;
}

// 6. Главная функция трансформации content.json
async function runContentRebrander() {
  const args = process.argv.slice(2);
  const dictOnlyMode = args.includes('--dict-only');
  const cliThemeArg = args.find((a) => !a.startsWith('--'));

  // Если файла rebrand-config.json ещё нет — создаем его
  if (!fsSync.existsSync(CONFIG_PATH)) {
    await fs.writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_REBRAND_CONFIG, null, 2), 'utf-8');
    console.log('📝 Создан шаблон настроек ребрендинга: rebrand-config.json');
  }

  const cfg = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf-8'));
  if (cliThemeArg) {
    cfg.targetTheme = cliThemeArg;
    // Сохраняем новую тему в конфиг для удобства
    await fs.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
  }

  if (!fsSync.existsSync(SITE_CONTENT_PATH)) {
    console.error('❌ Файл output/site_clone/content.json не найден! Сначала спарсите сайт.');
    return;
  }

  // Делаем страховочный снапшот через нашего Стража (Guardian) перед началом
  try {
    execSync('node src/utils/agent-guardian.js snapshot "Перед запуском Content Rebrander"', {
      stdio: 'ignore'
    });
  } catch {}

  console.log('\n🎨 =============================================================');
  console.log('🎨 ЗАПУСК ТРАНСФОРМАТОРА КОНТЕНТА (CONTENT REBRANDER)');
  console.log(`🎨 • Тематика: ${cfg.targetTheme}`);
  console.log(`🎨 • Бренд:    ${cfg.brandName}`);
  console.log(`🎨 • Режим:    ${dictOnlyMode ? 'Только словарь (--dict-only)' : 'Словарь + ИИ-рерайт + SEO'}`);
  console.log('🎨 =============================================================\n');

  const content = JSON.parse(await fs.readFile(SITE_CONTENT_PATH, 'utf-8'));
  const texts = content.texts || {};
  const meta = content._meta || {}; // Метаданные тегов (h1, a, button) если они собраны парсером
  const allKeys = Object.keys(texts);

  // Сохраняем оригинальный текст в отдельное поле _originalTexts (если ещё не сохранено),
  // чтобы всегда видеть, что было на доноре
  if (!content._originalTexts) {
    content._originalTexts = { ...texts };
  }

  // ШАГ 1: Применяем точный словарь замен ко всем текстам
  let dictReplacedCount = 0;
  for (const key of allKeys) {
    const updated = applyExactDictionary(texts[key], cfg.exactReplacements);
    if (updated !== texts[key]) {
      texts[key] = updated;
      dictReplacedCount++;
    }
  }
  console.log(`[1/4] Точных замен по словарю выполнено: ${dictReplacedCount}`);

  // ШАГ 2: Пакетный ИИ-рерайт через локальный llama-server (если не включен флаг --dict-only)
  if (!dictOnlyMode) {
    const keysToRewrite = allKeys.filter((k) => shouldRewriteText(texts[k]));
    const BATCH_SIZE = 18; // Оптимальный размер пачки для 12B модели без потери ключей
    let rewrittenCount = 0;

    console.log(
      `[2/4] Отправка ${keysToRewrite.length} текстовых блоков в локальную LLM пачками по ${BATCH_SIZE} шт...`
    );

    for (let i = 0; i < keysToRewrite.length; i += BATCH_SIZE) {
      const batchKeys = keysToRewrite.slice(i, i + BATCH_SIZE);
      const batchPayload = {};
      batchKeys.forEach((k) => {
        batchPayload[k] = texts[k];
      });

      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(keysToRewrite.length / BATCH_SIZE);
      console.log(`   ⏳ Рерайт пачки [${batchNum}/${totalBatches}] (${batchKeys[0]} .. ${batchKeys[batchKeys.length - 1]})...`);

      try {
        const aiResult = await rewriteBatchWithLLM(batchPayload, meta, cfg);

        for (const k of batchKeys) {
          const candidate = aiResult[k];
          if (typeof candidate === 'string' && candidate.trim().length > 0) {
            const origLen = texts[k].length;
            const maxAllowed = Math.max(origLen + 15, Math.round(origLen * 1.65));

            // Защита от галлюцинаций длины: если модель написала целый абзац вместо кнопки — аккуратно обрезаем по смыслу или оставляем безопасный вариант
            if (cfg.keepLengthStrict && candidate.length > maxAllowed && origLen < 35) {
              console.warn(
                `      ⚠️ Ключ ${k}: ИИ превысил длину для короткой кнопки (${candidate.length} > ${origLen}). Сохранен компактный срез.`
              );
              texts[k] = candidate.split(/[.,!?;—-]/)[0].trim().slice(0, maxAllowed);
            } else {
              texts[k] = candidate.trim();
            }
            rewrittenCount++;
          }
        }
      } catch (err) {
        console.warn(`   ⚠️ Пачка #${batchNum} пропущена (${err.message}). Проверьте, запущен ли llama-server на порту 8080.`);
        break;
      }
    }
    console.log(`   ✅ Переписано текстовых узлов через ИИ: ${rewrittenCount}`);
  } else {
    console.log('[2/4] ИИ-рерайт пропущен (активен режим --dict-only).');
  }

  // ШАГ 3: Обновление путей к картинкам, видео и SEO alt-тегов из конфига
  console.log('[3/4] Обновление SEO-тегов, медиа и внедрение обработчика форм...');
  if (content.images) {
    Object.entries(content.images).forEach(([imgKey, imgObj], idx) => {
      if (cfg.customImageReplacements && cfg.customImageReplacements[imgKey]) {
        imgObj.src = cfg.customImageReplacements[imgKey];
      }
      imgObj.alt = `${cfg.brandName} — ${cfg.targetTheme} #${idx + 1}`;
    });
  }

  if (content.videos && cfg.customVideoReplacements) {
    Object.entries(content.videos).forEach(([vidKey, vidObj]) => {
      if (cfg.customVideoReplacements[vidKey]) {
        vidObj.src = cfg.customVideoReplacements[vidKey];
      }
    });
  }

  // Генерация SEO и интеграция форм в HTML файлы
  let seoData = null;
  if (!dictOnlyMode && cfg.generateSEO) {
    seoData = await generateSEOWithLLM(cfg);
    content.seo = seoData; // Сохраняем сгенерированное SEO в стейт
  }

  const updatedHtmlCount = await injectSeoAndFormsToHtml(cfg, seoData);
  console.log(`   ✅ SEO-теги и логика форм внедрены в ${updatedHtmlCount} HTML-файлов.`);

  // ШАГ 4: Запись обновленного content.json в клон и в проект Next.js + фиксация снапшота
  console.log('[4/4] Сохранение обновленного content.json и проверка целостности...');
  await fs.writeFile(SITE_CONTENT_PATH, JSON.stringify(content, null, 2), 'utf-8');

  if (fsSync.existsSync(path.dirname(NEXT_CONTENT_PATH))) {
    // Для Next.js нормализуем ./assets/ -> /assets/
    const nextCopy = JSON.parse(JSON.stringify(content));
    if (nextCopy.images) {
      Object.values(nextCopy.images).forEach((img) => {
        if (img.src?.startsWith('./assets/')) img.src = img.src.replace('./assets/', '/assets/');
      });
    }
    await fs.writeFile(NEXT_CONTENT_PATH, JSON.stringify(nextCopy, null, 2), 'utf-8');
    console.log('   ✅ Синхронизировано с output/generated_nextjs_project/data/content.json');
  }

  try {
    execSync(`node src/utils/agent-guardian.js snapshot "Ребрендинг контента: ${cfg.brandName}"`, {
      stdio: 'ignore'
    });
  } catch {}

  console.log('\n🎉 ИИ-ребрендинг, генерация SEO и прошивка форм успешно завершены!');
  console.log('👉 Запусти npm start (или обнови вкладку http://localhost:3000), чтобы увидеть новый сайт с сохраненными эффектами!');
}

runContentRebrander().catch(console.error);