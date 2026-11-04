import * as cheerio from 'cheerio';

export function cleanHtml(htmlContent) {
  const $ = cheerio.load(htmlContent);

  // 1. УДАЛЕНИЕ ТРЕКЕРОВ И АНАЛИТИКИ
  // Проходим по всем тегам <script> и удаляем те, которые связаны с известными трекерами
  $('script').each((_, el) => {
    const src = $(el).attr('src') || '';
    const content = JSON.stringify(el.attribs || {}) + ($(el).html() || '');
    
    const isTracker = 
      /googletagmanager|google-analytics|mc\.yandex|connect\.facebook|hotjar|amplitude|mixpanel|segment|metrika|counter/i.test(src) ||
      /gtag|ga\(|ym\(|fbq\(|_hjid|_ym|yaCounter/i.test(content);

    if (isTracker) {
      $(el).remove();
    }
  });

  // Удаляем пиксели аналитики внутри тегов <noscript> (например, Яндекс.Метрика noscript)
  $('noscript').each((_, el) => {
    const content = $(el).html() || '';
    if (/mc\.yandex|googletagmanager|facebook\.com/i.test(content)) {
      $(el).remove();
    }
  });

  // 2. УДАЛЕНИЕ БЛОКИРОВЩИКОВ КОНТЕКСТНОГО МЕНЮ И ВЫДЕЛЕНИЯ ТЕКСТА
  // Очищаем inline-атрибуты, запрещающие действия пользователя
  $('[oncontextmenu], [onselectstart], [oncopy], [oncut], [onpaste]').removeAttr('oncontextmenu onselectstart oncopy oncut onpaste');

  // Добавляем универсальный CSS-стиль, принудительно разрешающий выделение текста и контекстное меню,
  // если они были заблокированы через стили (user-select: none)
  const antiBlockerStyle = `
    <style id="agent-anti-blocker">
      * {
        -webkit-user-select: auto !important;
        -moz-user-select: auto !important;
        -ms-user-select: auto !important;
        user-select: auto !important;
      }
    </style>
  `;
  
  if ($('head').length > 0) {
    $('head').append(antiBlockerStyle);
  } else {
    $.root().prepend(antiBlockerStyle);
  }

  return $.html();
}