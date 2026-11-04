import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';

// Настройки локального сервера llama.cpp (OpenAI API format)
const LLM_API_URL = 'http://127.0.0.1:8080/v1/chat/completions';
const LLM_MODEL = 'gemma-4-12b-vision';

const SITE_DIR = path.resolve('output', 'site_clone');
const GENERATED_DIR = path.resolve('output', 'generated_nextjs_project');
const COMPONENTS_DIR = path.join(GENERATED_DIR, 'components', 'sections');
const APP_DIR = path.join(GENERATED_DIR, 'app');

// Вспомогательная функция для извлечения JSX-кода из ответа LLM
function extractCodeBlock(text) {
  const match = text.match(/```(?:jsx|javascript|js|tsx)\n([\s\S]*?)```/);
  return match ? match[1].trim() : text.trim();
}

// Конвертация картинки в Base64 для Vision
async function getBase64Image(filePath) {
  try {
    if (!fsSync.existsSync(filePath)) return null;
    const data = await fs.readFile(filePath);
    return `data:image/png;base64,${data.toString('base64')}`;
  } catch (e) {
    return null;
  }
}

// Сжатие HTML для экономии токенов контекста LLM
function compressHtml(rawHtml) {
  const $ = cheerio.load(rawHtml, null, false);
  
  // Урезаем гигантские SVG-пути, которые съедают тысячи токенов
  $('path, polygon, polyline').each((_, el) => {
    if ($(el).attr('d') && $(el).attr('d').length > 60) $(el).attr('d', '...');
    if ($(el).attr('points') && $(el).attr('points').length > 60) $(el).attr('points', '...');
  });
  
  // Удаляем мусорные стили и скрипты, если они случайно попали в блок
  $('script, style, noscript').remove();
  
  // Убираем множественные пробелы и переносы
  return $.html().replace(/\s{2,}/g, ' ').replace(/\n\s*\n/g, '\n').trim();
}

// Финальная сборка page.jsx
async function assemblePage() {
  console.log('\n[4/5] Автоматическая сборка app/page.jsx из сгенерированных компонентов...');
  
  try {
    const files = await fs.readdir(COMPONENTS_DIR);
    const sectionFiles = files.filter(f => f.startsWith('Section_') && f.endsWith('.jsx')).sort();

    if (sectionFiles.length === 0) {
      console.log('   ⚠️ Компоненты не найдены. Пропускаю сборку page.jsx.');
      return;
    }

    let importsCode = `import ScrollEffectsHandler from '@/components/ScrollEffectsHandler';\n`;
    let jsxCallsCode = '';

    sectionFiles.forEach((file) => {
      const componentName = file.replace('.jsx', '');
      importsCode += `import ${componentName} from '@/components/sections/${componentName}';\n`;
      jsxCallsCode += `      <${componentName} />\n`;
    });

    const pageCode = `${importsCode}
export default function Page() {
  return (
    <main className="min-h-screen bg-[#0A0A0C] text-white overflow-x-hidden relative">
      <ScrollEffectsHandler />
      
      {/* Динамически собранные секции */}
${jsxCallsCode}
    </main>
  );
}
`;

    await fs.writeFile(path.join(APP_DIR, 'page.jsx'), pageCode, 'utf-8');
    console.log(`   ✅ Собрано ${sectionFiles.length} секций в итоговый app/page.jsx!`);

  } catch (err) {
    console.error('   ❌ Ошибка при сборке page.jsx:', err.message);
  }
}

async function buildComponentsWithLLM() {
  console.log('[1/5] Подготовка директорий и чтение слепка...');
  await fs.mkdir(COMPONENTS_DIR, { recursive: true });

  const htmlContent = await fs.readFile(path.join(SITE_DIR, 'index.html'), 'utf-8');
  let choreography = {};
  try {
    choreography = JSON.parse(await fs.readFile(path.join(SITE_DIR, 'specs', 'scroll-choreography.json'), 'utf-8'));
  } catch {}

  const $ = cheerio.load(htmlContent);
  const chunks = [];

  // УМНЫЙ ПОИСК ОБЕРТКИ (исправление проблемы с #__next, .smooth-wrapper и т.д.)
  let $mainWrapper = $('#__next, #root, #app, .smooth-wrapper, [data-scroll-container], main').first();
  if ($mainWrapper.length === 0) {
    $mainWrapper = $('body');
  }

  // Берем только крупные структурные элементы внутри найденной обертки
  $mainWrapper.children('header, section, footer, div, article, nav').each((i, el) => {
    const outerHtml = $.html(el);
    // Игнорируем мелкие технические дивы и мосты
    if (outerHtml.length > 200 && !outerHtml.includes('Agent Content Bridge') && !$(el).attr('id')?.includes('preloader')) {
      chunks.push({
        name: `Section_${String(chunks.length + 1).padStart(2, '0')}`,
        html: outerHtml,
        index: chunks.length + 1
      });
    }
  });

  console.log(`[2/5] HTML разбит на ${chunks.length} секций. Запуск локальной LLM...`);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const minifiedHtml = compressHtml(chunk.html);
    
    console.log(`\n⏳ Генерация [${i + 1}/${chunks.length}]: ${chunk.name} (Оригинал: ${chunk.html.length} симв. -> Сжато: ${minifiedHtml.length} симв.)...`);

    // Динамический поиск скриншота секции (если есть) с фоллбэком на общий reference.png
    let targetImagePath = path.join(SITE_DIR, `section_${String(chunk.index).padStart(2, '0')}.png`);
    if (!fsSync.existsSync(targetImagePath)) {
      targetImagePath = path.join(SITE_DIR, 'reference.png');
    }
    const referenceImageBase64 = await getBase64Image(targetImagePath);

    const systemPrompt = `Ты — Senior Frontend Developer (React, Next.js, Tailwind CSS).
Твоя задача — преобразовать грязный HTML-фрагмент сайта в чистый, изолированный React-компонент.

ЖЕСТКИЕ ПРАВИЛА:
1. Используй Tailwind CSS для стилей.
2. Замени тексты и картинки на вызовы из глобального объекта \`content\`. 
   Например, если в HTML написано data-agent-text="txt_1", преврати это в \`{content.texts?.txt_1}\`. 
   Для data-agent-img="img_1" делай \`src={content.images?.img_1?.src}\`.
3. Сохрани ВСЕ классы и data-атрибуты, отвечающие за GSAP-анимации и параллакс (например, data-parallax, data-speed, data-scroll, data-reveal-item).
4. Верни ТОЛЬКО готовый валидный JSX код внутри блока \`\`\`jsx ... \`\`\`. Не пиши никаких пояснений.

ДАННЫЕ ХОРЕОГРАФИИ САЙТА (Используются движком ScrollEffectsHandler):
${JSON.stringify(choreography, null, 2)}
Если видишь элементы, которые совпадают с селекторами из хореографии, обязательно сохраняй их структуру!`;

    const userPrompt = `
Создай компонент ${chunk.name}.

HTML секции:
\`\`\`html
${minifiedHtml}
\`\`\`
`;

    const payload = {
      model: LLM_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: userPrompt },
            ...(referenceImageBase64 ? [{ type: 'image_url', image_url: { url: referenceImageBase64 } }] : [])
          ]
        }
      ],
      temperature: 0.1,
      max_tokens: 4000 // Токенов хватит, так как мы сжали HTML (SVG пути)
    };

    try {
      const response = await fetch(LLM_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

      const data = await response.json();
      const rawCode = data.choices[0].message.content;
      let finalCode = extractCodeBlock(rawCode);

      // Проверяем наличие импорта content, если LLM забыла его добавить
      if (!finalCode.includes('import content')) {
        finalCode = `import content from '@/data/content.json';\n\n${finalCode}`;
      }

      await fs.writeFile(path.join(COMPONENTS_DIR, `${chunk.name}.jsx`), finalCode, 'utf-8');
      console.log(`   ✅ Сохранен: ${chunk.name}.jsx`);

    } catch (err) {
      console.error(`   ❌ Ошибка генерации ${chunk.name}:`, err.message);
    }
  }

  // Вызов сборщика страницы после успешной генерации всех компонентов
  await assemblePage();

  console.log('\n[5/5] Пайплайн LLM завершен!');
  console.log(`👉 Проект готов к запуску в output/generated_nextjs_project/`);
}

buildComponentsWithLLM().catch(console.error);