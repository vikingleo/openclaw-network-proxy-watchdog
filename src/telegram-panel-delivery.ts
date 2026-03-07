import { ProxyAgent } from "undici";

export interface TelegramPanelTarget {
  chatId: string;
  threadId: number | null;
}

export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data: string;
}

export type TelegramReplyMarkup = {
  inline_keyboard: TelegramInlineKeyboardButton[][];
};

export interface TelegramPanelMessage {
  text: string;
  replyMarkup?: TelegramReplyMarkup;
}

export class TelegramPanelDelivery {
  private readonly apiBaseUrl: string;
  private readonly botToken: string;
  private readonly requestTimeoutMs: number;
  private readonly proxyDispatcher: ProxyAgent | null;

  constructor(params: {
    botToken: string;
    apiBaseUrl?: string;
    requestTimeoutMs?: number;
    proxyUrl?: string | null;
  }) {
    this.botToken = params.botToken;
    this.apiBaseUrl = (params.apiBaseUrl ?? "https://api.telegram.org").replace(/\/$/, "");
    this.requestTimeoutMs = params.requestTimeoutMs ?? 15_000;
    this.proxyDispatcher = params.proxyUrl ? new ProxyAgent(params.proxyUrl) : null;
  }

  async sendMessage(target: TelegramPanelTarget, message: TelegramPanelMessage): Promise<{ messageId: number }> {
    const result = await this.callTelegram<{ result: { message_id: number } }>("sendMessage", {
      chat_id: normalizeChatId(target.chatId),
      text: message.text,
      ...(target.threadId ? { message_thread_id: target.threadId } : {}),
      ...(message.replyMarkup ? { reply_markup: message.replyMarkup } : {}),
    });
    return { messageId: result.result.message_id };
  }

  async editMessage(target: TelegramPanelTarget, messageId: number, message: TelegramPanelMessage): Promise<void> {
    try {
      await this.callTelegram("editMessageText", {
        chat_id: normalizeChatId(target.chatId),
        message_id: messageId,
        text: message.text,
        ...(message.replyMarkup ? { reply_markup: message.replyMarkup } : {}),
      });
    } catch (error) {
      if (String(error).includes("message is not modified")) {
        return;
      }
      throw error;
    }
  }

  private async callTelegram<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await fetch(`${this.apiBaseUrl}/bot${this.botToken}/${method}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        ...(this.proxyDispatcher ? { dispatcher: this.proxyDispatcher } : {}),
      } as RequestInit & { dispatcher?: ProxyAgent });

      const payload = await response.json() as { ok?: boolean; description?: string } & T;
      if (!response.ok || payload.ok === false) {
        throw new Error(`Telegram API ${method} failed: ${payload.description ?? `HTTP ${response.status}`}`);
      }
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function parseTelegramTarget(raw: string | undefined, fallbackThreadId?: number): TelegramPanelTarget | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return null;
  }

  const withPrefix = trimmed.match(/^telegram:(-?\d+)(?::topic:(\d+))?$/i);
  if (withPrefix) {
    return {
      chatId: withPrefix[1],
      threadId: normalizeThreadId(withPrefix[2]) ?? normalizeThreadId(fallbackThreadId),
    };
  }

  if (/^-?\d+$/.test(trimmed)) {
    return {
      chatId: trimmed,
      threadId: normalizeThreadId(fallbackThreadId),
    };
  }

  return null;
}

function normalizeChatId(chatId: string): string | number {
  return /^-?\d+$/.test(chatId) ? Number(chatId) : chatId;
}

function normalizeThreadId(value: string | number | null | undefined): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return null;
}
