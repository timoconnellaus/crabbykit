import type { CapabilityStorage } from "@crabbykit/agent-runtime";
import type { TelegramAccount } from "./types.js";

/**
 * Persistent store of Telegram accounts configured at runtime.
 *
 * Each DO / agent has its own set of accounts. Accounts are added by the
 * agent (via the `telegram-accounts` config namespace) or by a human
 * sitting in the UI (via `capability_action`). They are NOT loaded from
 * env vars anywhere in the runtime — the env-var path of the previous
 * design has been removed.
 *
 * **Keys** (scoped under the capability's own `CapabilityStorage`, which
 * already prefixes everything with the capability id):
 * - `account:<accountId>` → `TelegramAccount` JSON (includes token +
 *   webhookSecret in plaintext — DO SQLite storage is encrypted at rest
 *   by Cloudflare so this is not a leak)
 * - `accounts:index` → `string[]` of account ids
 *
 * The index lives alongside the per-account rows so `list()` can return
 * all accounts with two reads instead of a prefix scan. This matches the
 * pattern used by `packages/skills`.
 */
export class TelegramAccountStore {
  private readonly storage: CapabilityStorage;

  constructor(storage: CapabilityStorage) {
    this.storage = storage;
  }

  /** Return a single account by id, or `null` if none is stored. */
  async get(id: string): Promise<TelegramAccount | null> {
    const account = await this.storage.get<TelegramAccount>(`account:${id}`);
    return account ?? null;
  }

  /** Return every stored account. Order matches the index (insertion order). */
  async list(): Promise<TelegramAccount[]> {
    const ids = (await this.storage.get<string[]>("accounts:index")) ?? [];
    const accounts: TelegramAccount[] = [];
    for (const id of ids) {
      const account = await this.storage.get<TelegramAccount>(`account:${id}`);
      // Defend against a torn index (index has an id whose row was
      // deleted out-of-band) by skipping missing rows rather than
      // returning nulls.
      if (account) accounts.push(account);
    }
    return accounts;
  }

  /**
   * Insert or overwrite an account. Adds the id to the index the first
   * time it is seen. Idempotent when the same account is put twice.
   */
  async put(account: TelegramAccount): Promise<void> {
    await this.storage.put(`account:${account.id}`, account);
    const ids = (await this.storage.get<string[]>("accounts:index")) ?? [];
    if (!ids.includes(account.id)) {
      ids.push(account.id);
      await this.storage.put("accounts:index", ids);
    }
  }

  /**
   * Remove an account and its index entry. Returns `true` if an account
   * was actually deleted, `false` if the id was not present.
   */
  async delete(id: string): Promise<boolean> {
    const deleted = await this.storage.delete(`account:${id}`);
    const ids = (await this.storage.get<string[]>("accounts:index")) ?? [];
    const next = ids.filter((existing) => existing !== id);
    if (next.length !== ids.length) {
      await this.storage.put("accounts:index", next);
    }
    return deleted;
  }
}
