/**
 * Thin Discord REST v10 client — only the four calls intake needs.
 * Message content coming back from here is UNTRUSTED DATA. It is never
 * concatenated into an instruction position in any prompt.
 */

const API = "https://discord.com/api/v10";

export interface DiscordMessage {
  id: string;
  channel_id: string;
  content: string;
  timestamp: string;
  author: { id: string; username: string; bot?: boolean };
  referenced_message?: { id: string; content: string; author: { username: string } } | null;
  mentions?: Array<{ id: string; username: string }>;
  attachments?: Array<{ filename: string; content_type?: string; url: string }>;
  /** Link previews, and the cards Discord builds for a forwarded link. */
  embeds?: Array<{ title?: string; description?: string; url?: string }>;
  /**
   * Discord's forward feature. The carrier message has empty content and the
   * real text lives in here — so a report forwarded rather than retyped is
   * invisible to anything reading only `content`.
   */
  message_snapshots?: Array<{
    message?: {
      content?: string;
      attachments?: Array<{ filename: string }>;
      embeds?: Array<{ title?: string; description?: string; url?: string }>;
    };
  }>;
}

export class DiscordClient {
  constructor(private readonly token: string) {}

  /**
   * A dropped network is the common failure here, not a broken request, and it
   * comes back on its own — so a blip costs a couple of seconds rather than a
   * whole tick. Only connection-level failures and 5xx are retried; a 4xx is an
   * answer, and repeating it would just be slower.
   */
  private async request<T>(path: string, init: RequestInit = {}, attempt = 1): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bot ${this.token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    }).catch(async (error: Error) => {
      if (attempt >= 3) throw error;
      await new Promise((r) => setTimeout(r, attempt * 1500));
      return { __retry: true } as unknown as Response;
    });
    if ((res as unknown as { __retry?: boolean }).__retry) {
      return this.request<T>(path, init, attempt + 1);
    }
    if (res.status >= 500 && attempt < 3) {
      await new Promise((r) => setTimeout(r, attempt * 1500));
      return this.request<T>(path, init, attempt + 1);
    }
    if (res.status === 429) {
      const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
      const waitMs = Math.ceil((body.retry_after ?? 1) * 1000) + 250;
      await new Promise((r) => setTimeout(r, waitMs));
      return this.request<T>(path, init);
    }
    if (!res.ok) {
      throw new Error(`Discord ${init.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  /**
   * Messages after `afterId`, oldest first. Discord returns newest-first
   * regardless of the `after` parameter, so we always re-sort by snowflake.
   */
  async fetchMessages(channelId: string, afterId: string | null, limit: number): Promise<DiscordMessage[]> {
    const params = new URLSearchParams({ limit: String(Math.min(limit, 100)) });
    if (afterId) params.set("after", afterId);
    const messages = await this.request<DiscordMessage[]>(
      `/channels/${channelId}/messages?${params.toString()}`,
    );
    return [...messages].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  }

  async channelName(channelId: string): Promise<string> {
    const channel = await this.request<{ name?: string }>(`/channels/${channelId}`).catch(
      (): { name?: string } => ({}),
    );
    return channel.name ? `#${channel.name}` : "Discord";
  }

  /** Returns the new message's id, so a long-running job can edit it later. */
  async sendMessage(channelId: string, content: string, replyToId?: string): Promise<string | null> {
    const sent = await this.request<{ id?: string }>(`/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        content: content.slice(0, 1900),
        ...(replyToId ? { message_reference: { message_id: replyToId, fail_if_not_exists: false } } : {}),
      }),
    });
    return sent?.id ?? null;
  }

  /**
   * Rewrite a message in place. A run posts once and edits as it goes, so a
   * twenty-minute job leaves one line in the channel instead of four — the
   * reports people actually came to read stay readable.
   */
  async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
    await this.request<unknown>(`/channels/${channelId}/messages/${messageId}`, {
      method: "PATCH",
      body: JSON.stringify({ content: content.slice(0, 1900) }),
    }).catch(() => undefined); // an edit that fails must not take the run with it
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.request<void>(
      `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
      { method: "PUT" },
    );
  }

  async removeOwnReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.request<void>(
      `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
      { method: "DELETE" },
    ).catch(() => undefined); // absent reaction is not an error worth failing a tick over
  }
}

export function messageUrl(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}
