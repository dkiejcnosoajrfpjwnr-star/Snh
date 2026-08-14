const PER_PAGE = 5;
const HADITH_PAGE_CHARS = 2800;
const VERDICT_LABEL = "خلاصة حكم المحدث";

const META_LABELS = [
  "خلاصة حكم المحدث",
  "الراوي",
  "المحدث",
  "المصدر",
  "الصفحة أو الرقم",
  "التصنيف الموضوعي",
  "التصنيف",
  "أحاديث مشابهة",
  "شرح الحديث",
  "أصول الحديث",
  "تراجم الرواة",
];

const META_KEYS = {
  "خلاصة حكم المحدث": "verdict",
  الراوي: "rawi",
  المحدث: "muhadith",
  المصدر: "masdar",
  "الصفحة أو الرقم": "page_num",
};

// The buttons are short-lived, so an in-memory store is sufficient.
const sessions = new Map();

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Telegram bot is running.", { status: 200 });
    }

    if (!env.TELEGRAM_BOT_TOKEN) {
      return new Response("Missing TELEGRAM_BOT_TOKEN.", { status: 500 });
    }

    try {
      const update = await request.json();

      if (update.callback_query) {
        await handleCallback(update.callback_query, env);
      } else if (update.message) {
        await handleMessage(update.message, env);
      }

      return new Response("ok", { status: 200 });
    } catch (error) {
      console.error("Webhook error:", error);
      return new Response("ok", { status: 200 });
    }
  },
};

async function telegram(method, body, env) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    console.error(`Telegram ${method} failed: ${response.status}`);
  }

  return response;
}

async function handleMessage(message, env) {
  if (!message.chat || !message.text) return;

  // Only group and supergroup messages are accepted.
  if (!["group", "supergroup"].includes(message.chat.type)) return;

  // Accept exactly: بحث سنة <query> or بحث سنه <query>.
  const match = message.text.trim().match(/^بحث\s+سن[هة]\s+(.+)$/s);
  if (!match) return;

  const query = match[1].trim();
  if (!query) return;

  const chatId = message.chat.id;
  const results = await searchDorar(query);

  if (!results.length) {
    await telegram(
      "sendMessage",
      {
        chat_id: chatId,
        reply_to_message_id: message.message_id,
        parse_mode: "HTML",
        text: `❌ لم أجد نتائج لـ: <b>${escapeHtml(query)}</b>`,
      },
      env,
    );
    return;
  }

  const [text, replyMarkup] = buildListView(query, results, 0);
  const response = await telegram(
    "sendMessage",
    {
      chat_id: chatId,
      reply_to_message_id: message.message_id,
      parse_mode: "HTML",
      text,
      reply_markup: replyMarkup,
    },
    env,
  );

  if (!response.ok) return;

  const data = await response.json();
  const sentMessage = data?.result;
  if (!sentMessage?.message_id) return;

  sessions.set(String(sentMessage.message_id), {
    userId: message.from?.id,
    query,
    results,
    page: 0,
  });

  removeOldSessions();
}

async function handleCallback(callbackQuery, env) {
  const message = callbackQuery.message;
  if (!message?.chat) return;
  if (!["group", "supergroup"].includes(message.chat.type)) return;

  const session = sessions.get(String(message.message_id));
  if (!session) {
    await telegram(
      "answerCallbackQuery",
      {
        callback_query_id: callbackQuery.id,
        text: "انتهت جلسة البحث، ابدأ بحثًا جديدًا.",
        show_alert: true,
      },
      env,
    );
    return;
  }

  if (callbackQuery.from?.id !== session.userId) {
    await telegram(
      "answerCallbackQuery",
      {
        callback_query_id: callbackQuery.id,
        text: "هذا البحث ليس لك، ابدأ بحثًا خاصًا بك.",
        show_alert: true,
      },
      env,
    );
    return;
  }

  await telegram(
    "answerCallbackQuery",
    { callback_query_id: callbackQuery.id },
    env,
  );

  const data = callbackQuery.data || "";
  const chatId = message.chat.id;
  const messageId = message.message_id;

  if (data.startsWith("p:")) {
    const page = Number(data.slice(2));
    if (!Number.isInteger(page) || page < 0) return;

    session.page = page;
    const [text, replyMarkup] = buildListView(
      session.query,
      session.results,
      page,
    );
    await editMessage(chatId, messageId, text, replyMarkup, env);
    return;
  }

  let index;
  let part = 0;

  if (data.startsWith("h:")) {
    index = Number(data.slice(2));
  } else if (data.startsWith("hp:")) {
    const [, indexText, partText] = data.split(":");
    index = Number(indexText);
    part = Number(partText);
  } else {
    return;
  }

  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= session.results.length ||
    !Number.isInteger(part) ||
    part < 0
  ) {
    return;
  }

  const pages = buildHadithPages(
    session.results[index],
    index,
    session.page,
  );
  if (!pages.length) return;

  const selectedPart = Math.min(part, pages.length - 1);
  const [text, replyMarkup] = pages[selectedPart];
  await editMessage(chatId, messageId, text, replyMarkup, env);
}

async function editMessage(chatId, messageId, text, replyMarkup, env) {
  await telegram(
    "editMessageText",
    {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text,
      reply_markup: replyMarkup,
    },
    env,
  );
}

async function searchDorar(query) {
  const url = `https://dorar.net/hadith/search?q=${encodeURIComponent(
    query,
  )}&searchType=word&st=w`;

  try {
    const response = await fetch(url, {
      headers: {
        accept: "text/html,application/xhtml+xml,*/*;q=0.9",
        "accept-language": "ar-AE,ar;q=0.9,en;q=0.7",
        referer: "https://dorar.net/hadith",
      },
    });

    if (!response.ok) return [];

    const html = await response.text();
    const pageText = clean(stripHtml(html));
    const segments = pageText.split(VERDICT_LABEL);
    const results = [];
    const seen = new Set();

    for (let index = 1; index < segments.length; index += 1) {
      const candidate =
        segments[index - 1].slice(-1400) +
        " " +
        VERDICT_LABEL +
        " " +
        segments[index].slice(0, 5000);
      const item = parseBlock(candidate);

      if (!item || seen.has(item.text)) continue;
      seen.add(item.text);
      results.push(item);

      if (results.length >= 50) break;
    }

    return results;
  } catch (error) {
    console.error("Dorar search failed:", error);
    return [];
  }
}

function parseBlock(fullText) {
  const text = clean(fullText);
  if (!text.includes(VERDICT_LABEL)) return null;

  let firstMetaPosition = text.length;
  for (const label of META_LABELS) {
    const position = text.indexOf(label);
    if (position >= 0) {
      firstMetaPosition = Math.min(firstMetaPosition, position);
    }
  }

  const hadithText = text.slice(0, firstMetaPosition).trim();
  if (hadithText.length < 15) return null;

  const item = parseMetadata(text.slice(firstMetaPosition));
  item.text = hadithText;
  return item;
}

function parseMetadata(metaText) {
  const result = Object.fromEntries(
    Object.values(META_KEYS).map((key) => [key, ""]),
  );
  const positions = [];
  const claimed = [];

  for (const label of [...META_LABELS].sort((a, b) => b.length - a.length)) {
    const position = metaText.indexOf(label);
    if (position < 0) continue;
    if (claimed.some(([start, end]) => position >= start && position < end)) {
      continue;
    }
    positions.push([position, label]);
    claimed.push([position, position + label.length]);
  }

  positions.sort((a, b) => a[0] - b[0]);

  for (let index = 0; index < positions.length; index += 1) {
    const [position, label] = positions[index];
    const key = META_KEYS[label];
    if (!key) continue;

    const nextPosition =
      index + 1 < positions.length ? positions[index + 1][0] : metaText.length;
    const value = metaText
      .slice(position + label.length, nextPosition)
      .replace(/^[\s:؛،\[\]]+/, "")
      .replace(/[|،\[\]]+$/, "")
      .trim()
      .slice(0, 300);

    if (value) result[key] = value;
  }

  return result;
}

function buildListView(query, results, page) {
  const totalPages = Math.ceil(results.length / PER_PAGE);
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const start = safePage * PER_PAGE;
  const rows = results
    .slice(start, start + PER_PAGE)
    .map((item, offset) => {
      const index = start + offset;
      const text =
        item.text.length > 65
          ? `${item.text.slice(0, 65).trimEnd()}…`
          : item.text;
      return [{ text, callback_data: `h:${index}` }];
    });

  const navigation = [];
  if (safePage > 0) {
    navigation.push({ text: "السابق", callback_data: `p:${safePage - 1}` });
  }
  if (safePage < totalPages - 1) {
    navigation.push({ text: "التالي", callback_data: `p:${safePage + 1}` });
  }
  if (navigation.length) rows.push(navigation);

  return [
    `🔍 <b>نتائج البحث عن:</b> ${escapeHtml(query)}\n📊 ${
      results.length
    } نتيجة | الصفحة ${safePage + 1} من ${totalPages}`,
    { inline_keyboard: rows },
  ];
}

function buildHadithPages(item, index, resultsPage) {
  const chunks = splitText(item.text, HADITH_PAGE_CHARS);
  const metadata = buildMetadata(item);

  return chunks.map((chunk, partIndex) => {
    const isLast = partIndex === chunks.length - 1;
    const partInfo =
      chunks.length > 1 ? ` — جزء ${partIndex + 1}/${chunks.length}` : "";
    const content = [
      `📖 <b>الحديث ${index + 1}${partInfo}</b>`,
      `<blockquote>${escapeHtml(chunk)}</blockquote>`,
    ];

    if (isLast && metadata) content.push(metadata);

    const navigation = [];
    if (partIndex > 0) {
      navigation.push({
        text: "الجزء السابق",
        callback_data: `hp:${index}:${partIndex - 1}`,
      });
    }
    if (!isLast) {
      navigation.push({
        text: "الجزء التالي",
        callback_data: `hp:${index}:${partIndex + 1}`,
      });
    }

    const rows = [];
    if (navigation.length) rows.push(navigation);
    rows.push([{ text: "رجوع للنتائج", callback_data: `p:${resultsPage}` }]);

    return [content.join("\n"), { inline_keyboard: rows }];
  });
}

function buildMetadata(item) {
  const lines = [];

  if (item.verdict) {
    lines.push(
      `📌 <b>خلاصة حكم المحدث :</b> ${escapeHtml(item.verdict)}`,
    );
  }

  const details = [];
  if (item.rawi) details.push(`الراوي : ${escapeHtml(item.rawi)}`);
  if (item.muhadith) details.push(`المحدث : ${escapeHtml(item.muhadith)}`);
  if (item.masdar) details.push(`المصدر : ${escapeHtml(item.masdar)}`);
  if (details.length) lines.push(details.join("  |  "));
  if (item.page_num) {
    lines.push(`الصفحة أو الرقم : ${escapeHtml(item.page_num)}`);
  }

  return lines.length ? `<blockquote>${lines.join("\n")}</blockquote>` : "";
}

function splitText(text, maxChars) {
  if (text.length <= maxChars) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }

    let cut = remaining.lastIndexOf(" ", maxChars);
    if (cut <= 0) cut = maxChars;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  return chunks;
}

function stripHtml(value) {
  return value
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, entity) => {
      if (entity[0] === "#") {
        const number =
          entity[1].toLowerCase() === "x"
            ? parseInt(entity.slice(2), 16)
            : parseInt(entity.slice(1), 10);
        return Number.isFinite(number) ? String.fromCodePoint(number) : " ";
      }

      const named = {
        amp: "&",
        apos: "'",
        gt: ">",
        lt: "<",
        nbsp: " ",
        quot: '"',
      };
      return named[entity.toLowerCase()] || " ";
    });
}

function clean(value) {
  return value.replace(/\s+/g, " ").trim();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function removeOldSessions() {
  if (sessions.size <= 500) return;
  const firstKey = sessions.keys().next().value;
  if (firstKey !== undefined) sessions.delete(firstKey);
}