import { act, post } from "@/host/api.ts";

export type CredentialFields = { label: string; signInUrl: string; username: string; password: string };

export const addCredential = (fields: CredentialFields) => post("/api/credentials/add", fields);

export const updateCredential = (id: string, fields: CredentialFields) => post("/api/credentials/update", { id, ...fields });

export const removeCredential = (id: string) => act("/api/credentials/remove", { id });

export const revokeCredential = (botId: string, id: string) => act("/api/credentials/revoke", { botId, id });
