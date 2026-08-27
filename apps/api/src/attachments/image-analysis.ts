import { Injectable } from '@nestjs/common';
import { AiRuntimeApplicationService } from '../ai/ai-runtime-application.service';

export const IMAGE_ANALYZER = Symbol('IMAGE_ANALYZER');

export type ImageScene =
  | 'PRODUCT_DAMAGE'
  | 'PRODUCT_APPEARANCE'
  | 'SHIPPING_LABEL'
  | 'ORDER_SCREENSHOT'
  | 'UNRELATED'
  | 'UNKNOWN';

/** The structured, bounded output accepted by the AI runtime. */
export type ImageAnalysis = {
  scene: ImageScene;
  observations: string[];
  confidence: number;
  containsPII?: boolean;
  recommendedIntent?: string;
  requiresHuman: boolean;
};

/**
 * The runtime's ImageAnalysis schema accepts a string for backwards
 * compatibility, but attachment metadata and later AI context must only ever
 * retain a frozen intent code.  The first fourteen values mirror the core
 * IntentPlan enum; GENERAL_IMAGE_REVIEW is the image-only conservative
 * fallback used by the deterministic analyzer.
 */
const SAFE_IMAGE_RECOMMENDED_INTENTS = new Set([
  'FAQ_QUERY',
  'PRODUCT_QUERY',
  'INVENTORY_QUERY',
  'SIZE_RECOMMENDATION',
  'SHIPPING_POLICY',
  'ORDER_QUERY',
  'LOGISTICS_QUERY',
  'AFTER_SALES_QUERY',
  'REFUND_REQUEST',
  'EXCHANGE_REQUEST',
  'PRODUCT_RECOMMENDATION',
  'HUMAN_REQUEST',
  'COMPLAINT',
  'UNKNOWN',
  'GENERAL_IMAGE_REVIEW',
]);

/** Never return untrusted model text as an intent value. */
export function sanitizeImageRecommendedIntent(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_IMAGE_RECOMMENDED_INTENTS.has(value) ? value : undefined;
}

export type ImageAnalysisInput = {
  workspaceId: string;
  tenantId: string;
  shopId: string;
  conversationId?: string;
  /** The bytes are supplied to a local implementation only; never log them. */
  bytes: Buffer;
  mimeType: string;
  size: number;
};

export interface ImageAnalyzer {
  analyze(input: ImageAnalysisInput): Promise<ImageAnalysis>;
}

/**
 * Raw images are untrusted and may contain PII. External multimodal analysis
 * is therefore disabled unless this server-only flag is exactly `true`.
 */
export function isExternalImageAnalysisOptedIn(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.AI_EXTERNAL_IMAGE_ANALYSIS_OPT_IN === 'true';
}

/**
 * Nest's IMAGE_ANALYZER provider uses this boundary rather than wiring the
 * runtime adapter directly. Keep the safe local analyzer as the default even
 * when a general external AI provider is configured.
 */
export function createImageAnalyzer(
  runtime: AiRuntimeApplicationService,
  environment: NodeJS.ProcessEnv = process.env,
): ImageAnalyzer {
  return isExternalImageAnalysisOptedIn(environment)
    ? new RuntimeImageAnalyzer(runtime)
    : new SyntheticImageAnalyzer();
}

/** Production image-analysis adapter. Raw bytes live only in the transient,
 * sanitized provider request; invocation storage contains metadata and usage. */
@Injectable()
export class RuntimeImageAnalyzer implements ImageAnalyzer {
  constructor(private readonly runtime: AiRuntimeApplicationService) {}

  async analyze(input: ImageAnalysisInput): Promise<ImageAnalysis> {
    const result = await this.runtime.runStructured<ImageAnalysis>(
      {
        workspaceId: input.workspaceId,
        tenantId: input.tenantId,
        shopId: input.shopId,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      },
      {
        purpose: 'IMAGE_ANALYSIS',
        schema: 'ImageAnalysis',
        context: {
          image: {
            mimeType: input.mimeType,
            size: input.size,
            base64: input.bytes.toString('base64'),
          },
        },
        allowedDataClasses: ['image'],
        promptVersion: 'image-analysis-v1',
      },
    );
    return result.output;
  }
}

/**
 * Deterministic local implementation used by the demo.  It deliberately does
 * not call a hosted model or inspect an external platform.  Real image
 * interpretation can be plugged in behind ImageAnalyzer in a later phase.
 */
@Injectable()
export class SyntheticImageAnalyzer implements ImageAnalyzer {
  async analyze(input: ImageAnalysisInput): Promise<ImageAnalysis> {
    // Do not persist or log the bytes in synthetic mode.  Keeping the
    // parameters in the interface lets a real local analyzer be swapped in
    // without changing the attachment boundary. The two explicit markers
    // below are test fixtures, not OCR. This keeps
    // E020/E021 deterministic and guarantees ordinary images remain UNKNOWN.
    if (input.bytes.includes(Buffer.from('AICS_FIXTURE:DAMAGED_SLEEVE', 'utf8'))) {
      return {
        scene: 'PRODUCT_DAMAGE',
        observations: ['疑似商品破损'],
        confidence: 0.98,
        containsPII: false,
        recommendedIntent: 'AFTER_SALES_QUERY',
        requiresHuman: true,
      };
    }
    if (input.bytes.includes(Buffer.from('AICS_FIXTURE:SHIPPING_LABEL', 'utf8'))) {
      return {
        scene: 'SHIPPING_LABEL',
        observations: ['图片可能包含物流标签信息，已进行脱敏处理。'],
        confidence: 0.98,
        containsPII: true,
        recommendedIntent: 'ORDER_QUERY',
        requiresHuman: true,
      };
    }
    void input;
    return {
      scene: 'UNKNOWN',
      observations: ['Synthetic multimodal analysis: visual interpretation is unavailable in demo mode.'],
      confidence: 0,
      containsPII: false,
      recommendedIntent: 'GENERAL_IMAGE_REVIEW',
      requiresHuman: true,
    };
  }
}
