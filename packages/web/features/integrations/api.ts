import type { IntegrationTransport, ToolPolicy } from "@claudebot/contract/events";

import { act, post } from "@/host/api.ts";

export const setIntegrationEnabled = (id: string, enabled: boolean) =>
  act("/api/integrations/set-enabled", { id, enabled });

export const probe = (id: string) => act("/api/integrations/probe", { id });

export const resetPolicies = (id: string) => act("/api/integrations/reset-policies", { id });

export const setPolicy = (id: string, tool: string, policy: ToolPolicy) =>
  act("/api/integrations/set-policy", { id, tool, policy });

export const setSkillEnabled = (id: string, skill: string, enabled: boolean) =>
  act("/api/integrations/set-skill-enabled", { id, skill, enabled });

export const disconnect = (id: string) => act("/api/integrations/disconnect", { id });

export const removeIntegration = (id: string) => act("/api/integrations/remove", { id });

export const connectOauth = (id: string, client?: { clientId: string; clientSecret: string }) =>
  post("/api/integrations/connect-oauth", { id, ...client });

export const setBearer = (id: string, token: string) =>
  post("/api/integrations/set-bearer", { id, token });

export type CustomIntegration =
  | {
      name: string;
      transport: "stdio";
      command: string;
      args: string[];
      env: Record<string, string>;
      skillsDir: string;
    }
  | {
      name: string;
      transport: Exclude<IntegrationTransport["type"], "stdio">;
      url: string;
      token: string | undefined;
      oauth: boolean;
      skillsDir: string;
    };

export const addCustomIntegration = (integration: CustomIntegration) =>
  post("/api/integrations/add-custom", integration);
