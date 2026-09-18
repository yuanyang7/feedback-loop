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
}

export class DiscordClient {
  constructor(private readonly token: string) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bot ${this.token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
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
