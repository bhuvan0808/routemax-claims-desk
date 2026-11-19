/**
 * Groq (OpenAI-compatible) client + the LLM extractor and drafter.
 * Workers-compatible: global fetch / AbortController only. The API key is passed in, never logged,
 * and scrubbed from every error message.
 */
import { z } from "zod";
import { appConfig } from "../config";
import {
  ExtractionSchema,
  type DraftInput,
  type Drafter,
  type Extraction,
  type Extractor,
  type ParsedEmail,
} from "../types";
import { detectConsequentialLoss, findShipmentMentions, mockExtract, shipmentKey } from "./mock";
import {
  DRAFT_SYSTEM_PROMPT,
  EXTRACT_SYSTEM_PROMPT,
  EXTRACTION_RESPONSE_FORMAT,
  JSON_OBJECT_RESPONSE_FORMAT,
  buildDraftRetryMessage,
  buildDraftUserMessage,
  buildExtractRetryMessage,
  buildExtractUserMessage,
} from "./prompts";
import { renderTemplateReply, validateDraft } from "./template";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GroqClientOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs: number;
}

export class GroqHttpError extends Error {
  readonly status: number;
  constructor(status: number, snippet: string) {
    super(`groq HTTP ${status}${snippet ? `: ${snippet}` : ""}`);
    this.name = "GroqHttpError";
    this.status = status;
  }
}

export class GroqClient {
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: GroqClientOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    // Wrapped so the global fetch keeps its `this` in Workers.
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs;
  }

  /** Never let the key reach an error message, whatever the upstream echoes back. */
  private scrub(text: string): string {
    return this.apiKey ? text.split(this.apiKey).join("[redacted]") : text;
  }

  async chat(messages: ChatMessage[], responseFormat?: unknown, maxTokens = 2048): Promise<string> {
    const payload: Record<string, unknown> = {
      model: this.model,
      temperature: appConfig.temperature,
      max_completion_tokens: maxTokens,
      messages,
    };
    if (responseFormat) payload.response_format = responseFormat;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) throw new Error(`groq request timed out after ${this.timeoutMs}ms`);
        throw new Error(`groq request failed: ${this.scrub(errorText(err)).slice(0, 200)}`);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new GroqHttpError(res.status, this.scrub(body.replace(/\s+/g, " ").trim().slice(0, 200)));
      }
      let data: unknown;
      try {
        data = await res.json();
      } catch {
        if (controller.signal.aborted) throw new Error(`groq request timed out after ${this.timeoutMs}ms`);
        throw new Error("groq response was not JSON");
      }
      const content = (data as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message
        ?.content;
      if (typeof content !== "string" || content.trim() === "") {
        throw new Error("groq response had no message content");
      }
      return content;
    } finally {
      clearTimeout(timer);
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ------------------------------------------------------------------ extract */

function stripToJson(content: string): string {
  let s = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);
  if (fence) s = fence[1].trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first > 0 && last > first) s = s.slice(first, last + 1);
  return s;
}

function describeParseError(err: unknown): string {
  if (err instanceof z.ZodError) {
    return (
      "JSON does not match the schema: " +
      err.issues
        .slice(0, 6)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")
    );
  }
  return `invalid JSON: ${errorText(err)}`.slice(0, 300);
}

function parseExtraction(content: string): Extraction {
  const parsed = ExtractionSchema.parse(JSON.parse(stripToJson(content)));
  if (parsed.is_claim && parsed.claims.length === 0) {
    throw new Error("is_claim is true but claims is empty; a claim needs one entry per shipment");
  }
  return parsed;
}

/**
 * Deterministic post-processing of LLM output. Every step either restores what the customer
 * literally wrote or makes the outcome stricter; none can make a claim more payable.
 */
export function postProcessExtraction(extraction: Extraction, email: ParsedEmail): Extraction {
  if (!extraction.is_claim) return { ...extraction, claims: [] };
  const text = `${email.subject}\n${email.body}`;
  const mentions = findShipmentMentions(text);
  const heuristic = mockExtract(email);
  const consequential = detectConsequentialLoss(text);

  const claims = extraction.claims.map((claim) => {
    let raw = claim.shipment_id_raw === null ? null : claim.shipment_id_raw.trim();
    if (raw === "") raw = null;
    if (raw !== null && !text.toLowerCase().includes(raw.toLowerCase())) {
      // The model "fixed" the id (SHP-1O10 -> SHP-1010). Put back exactly what the customer wrote.
      const fixedKey = shipmentKey(raw);
      const written = mentions.find((m) => m.key === fixedKey);
      if (written) raw = written.raw;
    }
    // The heuristic extractor's view of the same shipment, used only to OR-in the stricter "no photo" flag.
    const key = raw === null ? null : shipmentKey(raw);
    const twin =
      key === null
        ? heuristic.claims.length === 1 && extraction.claims.length === 1
          ? heuristic.claims[0]
          : undefined
        : heuristic.claims.find((c) => c.shipment_id_raw !== null && shipmentKey(c.shipment_id_raw) === key);
    return {
      ...claim,
      shipment_id_raw: raw,
      customer_states_no_photos: claim.customer_states_no_photos || (twin?.customer_states_no_photos ?? false),
      consequential_loss_mentioned: claim.consequential_loss_mentioned || consequential,
    };
  });
  return { ...extraction, claims };
}

export class GroqExtractor implements Extractor {
  readonly mode = "groq" as const;
  readonly model: string;

  constructor(private readonly client: GroqClient) {
    this.model = client.model;
  }

  async extract(email: ParsedEmail): Promise<Extraction> {
    const base: ChatMessage[] = [
      { role: "system", content: EXTRACT_SYSTEM_PROMPT },
      { role: "user", content: buildExtractUserMessage(email) },
    ];
    let messages = base;
    let useSchema = true;
    let lastError = "no attempt made";

    for (let attempt = 0; attempt < 2; attempt++) {
      let content: string;
      try {
        try {
          content = await this.client.chat(
            messages,
            useSchema ? EXTRACTION_RESPONSE_FORMAT : JSON_OBJECT_RESPONSE_FORMAT,
            4096,
          );
        } catch (err) {
          if (!(useSchema && err instanceof GroqHttpError && err.status === 400)) throw err;
          // Model / account does not accept json_schema: fall back to JSON object mode for this call.
          useSchema = false;
          content = await this.client.chat(messages, JSON_OBJECT_RESPONSE_FORMAT, 4096);
        }
      } catch (err) {
        throw new Error(`extraction failed: ${errorText(err)}`);
      }

      try {
        return postProcessExtraction(parseExtraction(content), email);
      } catch (err) {
        lastError = describeParseError(err);
        messages = [
          ...base,
          { role: "assistant", content: content.slice(0, 1500) },
          { role: "user", content: buildExtractRetryMessage(lastError) },
        ];
      }
    }
    throw new Error(`extraction failed: ${lastError}`);
  }
}

/* -------------------------------------------------------------------- draft */

function cleanDraft(content: string): string {
  let s = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fence = /^```[a-z]*\s*([\s\S]*?)\s*```$/i.exec(s);
  if (fence) s = fence[1].trim();
  return s;
}

export class GroqDrafter implements Drafter {
  readonly mode = "groq" as const;
  readonly model: string;

  constructor(private readonly client: GroqClient) {
    this.model = client.model;
  }

  /** Never throws: any failure (network, timeout, a draft that fails the reply check twice) returns the template. */
  async draft(input: DraftInput): Promise<string> {
    try {
      const base: ChatMessage[] = [
        { role: "system", content: DRAFT_SYSTEM_PROMPT },
        { role: "user", content: buildDraftUserMessage(input) },
      ];
      const first = cleanDraft(await this.client.chat(base));
      const check = validateDraft(first, input);
      if (check.ok) return first;

      const second = cleanDraft(
        await this.client.chat([
          ...base,
          { role: "assistant", content: first.slice(0, 2500) },
          { role: "user", content: buildDraftRetryMessage(check.problems) },
        ]),
      );
      if (validateDraft(second, input).ok) return second;
    } catch {
      // fall through to the deterministic template
    }
    return renderTemplateReply(input);
  }
}
