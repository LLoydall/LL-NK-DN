import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Embeddings } from "@langchain/core/embeddings";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatVertexAI, VertexAIEmbeddings } from "@langchain/google-vertexai";
import { ChatOpenAI } from "@langchain/openai";
import { GoogleAuth } from "google-auth-library";
import type { AppConfig } from "../config.js";

export class MissingCredentialError extends Error {
  constructor(envVar: string, provider: string) {
    super(
      `${envVar} is not configured. Set it in the server environment to use the "${provider}" model provider.`,
    );
    this.name = "MissingCredentialError";
  }
}

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

/**
 * Sync best-effort check for status reporting. On GCP the metadata server
 * provides credentials with no env var at all, so this can report false while
 * calls still succeed — treat it as a hint, not a gate.
 */
export function hasCredentials(config: AppConfig): boolean {
  if (config.GOOGLE_APPLICATION_CREDENTIALS) return true;
  // gcloud CLI application-default credentials (local dev).
  return existsSync(
    path.join(os.homedir(), ".config", "gcloud", "application_default_credentials.json"),
  );
}

/** Model names as actually used, for status reporting and chat metadata. */
export function resolvedModelNames(config: AppConfig): { chat: string; embeddings: string } {
  return { chat: config.VERTEX_CHAT_MODEL, embeddings: config.VERTEX_EMBEDDING_MODEL };
}

/**
 * Vertex AI Model Garden open models expose an OpenAI-compatible chat
 * endpoint per project/location; a dedicated endpoint id replaces the shared
 * "openapi" route when one is deployed.
 */
export function vertexOpenAIBaseURL(config: AppConfig): string {
  const endpointId = config.VERTEX_CHAT_ENDPOINT_ID ?? "openapi";
  const host = `${config.VERTEX_LOCATION}-aiplatform.googleapis.com`;
  return `https://${host}/v1beta1/projects/${config.GCP_PROJECT_ID}/locations/${config.VERTEX_LOCATION}/endpoints/${endpointId}`;
}

/** Mint a short-lived access token from Application Default Credentials. */
async function accessToken(): Promise<string> {
  try {
    const auth = new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
    const token = await auth.getAccessToken();
    if (!token) throw new Error("empty access token");
    return token;
  } catch (error) {
    throw new MissingCredentialError("GOOGLE_APPLICATION_CREDENTIALS", "vertex");
  }
}

/**
 * Chat model factory. Two paths:
 * - Default: first-party Gemini publisher models via ChatVertexAI — no
 *   deployment required, ADC handled by the client library. This is what the
 *   hackathon lab projects support (no Model Garden deploy quota).
 * - When VERTEX_CHAT_ENDPOINT_ID is set: a deployed Model Garden open model
 *   (e.g. Qwen) via its OpenAI-compatible endpoint; the ADC access token is
 *   captured at construction time (~1h lifetime), acceptable at hackathon scale.
 */
export async function createChatModel(config: AppConfig): Promise<BaseChatModel> {
  if (config.VERTEX_CHAT_ENDPOINT_ID) {
    return new ChatOpenAI({
      apiKey: await accessToken(),
      model: config.VERTEX_CHAT_MODEL,
      temperature: 0,
      configuration: { baseURL: vertexOpenAIBaseURL(config) },
    });
  }
  return new ChatVertexAI({
    model: config.VERTEX_CHAT_MODEL,
    temperature: 0,
    location: config.VERTEX_LOCATION,
    authOptions: { projectId: config.GCP_PROJECT_ID },
  });
}

export function createEmbeddings(config: AppConfig): Embeddings {
  return new VertexAIEmbeddings({
    model: config.VERTEX_EMBEDDING_MODEL,
    location: config.VERTEX_LOCATION,
    authOptions: { projectId: config.GCP_PROJECT_ID },
  });
}
