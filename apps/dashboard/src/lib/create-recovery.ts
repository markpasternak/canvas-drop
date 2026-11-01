import type { CreateAudienceState } from "./create-audience.js";

export type CreateMethod = "paste" | "upload" | "api";
export type SelectedUpload = { kind: "folder" | "zip"; files: File[]; paths: string[] };
export interface PendingCreateDraft {
  canvas: { id: string; url: string; apiKey?: string };
  files: Array<{ path: string; body: Blob }>;
  next: number;
  uncertain: boolean;
}
export interface CreateRecovery {
  method: CreateMethod;
  title: string;
  titleEdited: boolean;
  html: string;
  slug: string;
  workspace: string | null | undefined;
  backendEnabled: boolean;
  audience: Omit<CreateAudienceState, "password">;
  upload: SelectedUpload | null;
  pending?: PendingCreateDraft | null;
}

// One tab, one verified account, no browser storage. Account changes invalidate
// rather than merely hide the old copy. File objects survive SPA navigation only.
let account: string | undefined;
let draft: CreateRecovery | undefined;

export function readCreateRecovery(accountId: string | undefined): CreateRecovery | undefined {
  if (account !== accountId) {
    account = accountId;
    draft = undefined;
  }
  return accountId ? draft : undefined;
}

export function writeCreateRecovery(accountId: string | undefined, value: CreateRecovery) {
  readCreateRecovery(accountId);
  if (accountId) {
    // Explicit projection means a future caller cannot accidentally retain a password
    // or key simply by passing a wider object with the same TypeScript interface.
    draft = {
      method: value.method,
      title: value.title,
      titleEdited: value.titleEdited,
      html: value.html,
      slug: value.slug,
      workspace: value.workspace,
      backendEnabled: value.backendEnabled,
      upload: value.upload,
      pending: value.pending
        ? {
            canvas: { id: value.pending.canvas.id, url: value.pending.canvas.url },
            files: value.pending.files,
            next: value.pending.next,
            uncertain: value.pending.uncertain,
          }
        : null,
      audience: {
        choice: value.audience.choice,
        listed: value.audience.listed,
        requirePassword: value.audience.requirePassword,
      },
    };
  }
}

export function clearCreateRecovery() {
  draft = undefined;
}
